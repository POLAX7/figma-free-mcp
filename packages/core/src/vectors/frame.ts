import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import type { AgentDocument, AgentNode } from '../normalize/document.js';
import { vectorNetworkToSvg } from './svg.js';

type Matrix = readonly [number, number, number, number, number, number];

interface SkippedLayer {
  nodeId: string;
  name: string;
  type: string;
  reason: string;
}

interface Composition {
  readonly vectorSvgs: ReadonlyMap<number, string>;
  readonly defs: string[];
  nextDefinitionId: number;
  readonly skipped: SkippedLayer[];
}

export interface VectorGroup {
  nodeId: string;
  name: string;
  bounds: { x: number; y: number };
  vectorCount: number;
}

/** Creates one SVG for a frame, preserving Figma frame clips and sibling masks. */
export function composeFrameSvg(document: AgentDocument, frameId: string, vectorSvgs: ReadonlyMap<number, string>): string | undefined {
  const frame = document.nodesById[frameId];
  const size = sizeOf(frame);
  if (!frame || !size) return undefined;

  const composition: Composition = { vectorSvgs, defs: [], nextDefinitionId: 0, skipped: [] };
  const content = renderContainer(document, frame, identity, composition, false);
  if (!content) return undefined;
  const defs = composition.defs.length ? `<defs>${composition.defs.join('')}</defs>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${number(size.x)} ${number(size.y)}">${defs}${content}</svg>`;
}

/** Lists the largest vector-only groups beneath a node without duplicating nested artwork. */
export function findVectorGroups(document: AgentDocument, rootId: string): VectorGroup[] {
  if (!document.nodesById[rootId]) return [];
  const statusById = new Map<string, VectorStatus>();
  const status = (nodeId: string): VectorStatus => {
    const cached = statusById.get(nodeId);
    if (cached) return cached;
    const node = document.nodesById[nodeId];
    if (!node || node.visible === false) return { vectorOnly: true, vectorCount: 0 };
    const childIds = node.resolvedChildIds && node.resolvedChildIds.length ? node.resolvedChildIds : node.childIds;
    const children = childIds.map(status);
    const ownVector = Boolean(node.vectorRef) || isVectorShape(node);
    const value = {
      vectorOnly: !node.text && !node.assetRefs.length && supportedStyle(node) && (ownVector || children.some((child) => child.vectorCount > 0)) && children.every((child) => child.vectorOnly),
      vectorCount: (ownVector ? 1 : 0) + children.reduce((sum, child) => sum + child.vectorCount, 0)
    };
    statusById.set(nodeId, value);
    return value;
  };
  const groups: VectorGroup[] = [];
  const visit = (nodeId: string, parentVectorOnly: boolean) => {
    const node = document.nodesById[nodeId];
    if (!node || node.visible === false) return;
    const value = status(nodeId);
    const size = renderSizeOf(document, node);
    if (value.vectorOnly && value.vectorCount && !parentVectorOnly && size) groups.push({ nodeId, name: node.name, bounds: size, vectorCount: value.vectorCount });
    else {
      const childIds = node.resolvedChildIds && node.resolvedChildIds.length ? node.resolvedChildIds : node.childIds;
      for (const childId of childIds) visit(childId, value.vectorOnly);
    }
  };
  visit(rootId, false);
  return groups;
}

/** Composes one vector-only group into a self-contained SVG. */
export function composeVectorGroupSvg(document: AgentDocument, nodeId: string, vectorSvgs: ReadonlyMap<number, string>, warnings?: string[]): string | undefined {
  const root = document.nodesById[nodeId];
  const size = renderSizeOf(document, root);
  if (!root || !size) return undefined;
  const composition: Composition = { vectorSvgs, defs: [], nextDefinitionId: 0, skipped: [] };
  const content = withOpacity(renderContainer(document, root, identity, composition, true), root.opacity);
  if (!content) return undefined;
  if (warnings && composition.skipped.length) {
    for (const item of composition.skipped) {
      warnings.push(`${item.name} (${item.nodeId}, ${item.type}): ${item.reason}`);
    }
  }
  const defs = composition.defs.length ? `<defs>${composition.defs.join('')}</defs>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${number(size.x)} ${number(size.y)}">${defs}${content}</svg>`;
}

/** Reads only a group's extracted SVG fragments and composes them on demand. */
export async function composeBundleVectorGroupSvg(bundleRoot: string, document: AgentDocument, nodeId: string, warnings?: string[]): Promise<string | undefined> {
  const vectorPaths = new Map<number, { node: AgentNode; path?: string; binaryPath?: string }>();
  const visit = (id: string) => {
    const node = document.nodesById[id];
    if (!node) return;
    if (node.vectorRef) vectorPaths.set(node.vectorRef.blobId, { node, path: node.vectorRef.svgPath, binaryPath: node.vectorRef.path });
    const childIds = node.resolvedChildIds && node.resolvedChildIds.length ? node.resolvedChildIds : node.childIds;
    for (const childId of childIds) visit(childId);
  };
  visit(nodeId);
  const vectorSvgs = new Map(await Promise.all([...vectorPaths].map(async ([blobId, source]) => {
    try {
      if (source.path) return [blobId, await readFile(join(bundleRoot, source.path), 'utf8')] as const;
      if (!source.binaryPath) return [blobId, ''] as const;
      const bytes = gunzipSync(await readFile(join(bundleRoot, source.binaryPath)));
      const size = renderSizeOf(document, source.node);
      const svg = size ? vectorNetworkToSvg(bytes, size, {
        fills: source.node.fills as readonly unknown[] | null | undefined,
        strokes: source.node.strokes as readonly unknown[] | null | undefined,
        strokeWeight: source.node.strokeWeight
      }) : undefined;
      return [blobId, svg ?? ''] as const;
    } catch {
      return [blobId, ''] as const;
    }
  })));
  return composeVectorGroupSvg(document, nodeId, vectorSvgs, warnings);
}

function renderNode(document: AgentDocument, node: AgentNode, parentMatrix: Matrix, composition: Composition): string {
  if (node.visible === false) return '';
  const rendered = withOpacity(renderContainer(document, node, multiply(parentMatrix, matrixOf(node)), composition, true), node.opacity);
  if (!rendered && node.type !== 'FRAME' && node.type !== 'GROUP' && node.type !== 'INSTANCE' && node.type !== 'COMPONENT') {
    composition.skipped.push({
      nodeId: node.id,
      name: node.name,
      type: node.type,
      reason: 'Unsupported layer type or missing vector data'
    });
  }
  return rendered;
}

function renderContainer(document: AgentDocument, node: AgentNode, matrix: Matrix, composition: Composition, includeOwnVector: boolean): string {
  const clipId = clipsContents(node) ? defineClip(node, matrix, composition) : undefined;
  const ownPath = includeOwnVector ? vectorPath(node, matrix, composition.vectorSvgs, fillOf(node), strokeOf(node)) : '';
  const children = renderChildren(document, node, matrix, composition);
  const content = `${ownPath}${children}`;
  return clipId && content ? `<g clip-path="url(#${clipId})">${content}</g>` : content;
}

function renderChildren(document: AgentDocument, parent: AgentNode, parentMatrix: Matrix, composition: Composition): string {
  let activeMaskId: string | undefined;
  const output: string[] = [];
  const childIds = parent.resolvedChildIds && parent.resolvedChildIds.length ? parent.resolvedChildIds : parent.childIds;
  for (const childId of childIds) {
    const child = document.nodesById[childId];
    if (!child || child.visible === false) continue;
    if (child.mask) {
      activeMaskId = defineMask(document, child, parentMatrix, composition);
      continue;
    }
    const content = renderNode(document, child, parentMatrix, composition);
    if (content) output.push(activeMaskId ? `<g mask="url(#${activeMaskId})">${content}</g>` : content);
  }
  return output.join('');
}

function defineClip(node: AgentNode, matrix: Matrix, composition: Composition): string | undefined {
  const size = sizeOf(node);
  if (!size) return undefined;
  const id = `clip-${composition.nextDefinitionId++}`;
  composition.defs.push(`<clipPath id="${id}">${rectPath(size, matrix, '#ffffff')}</clipPath>`);
  return id;
}

function defineMask(document: AgentDocument, node: AgentNode, parentMatrix: Matrix, composition: Composition): string {
  const id = `mask-${composition.nextDefinitionId++}`;
  const paths = maskPaths(document, node, parentMatrix, composition.vectorSvgs);
  const fallback = paths.length ? '' : rectPath(sizeOf(node), multiply(parentMatrix, matrixOf(node)), '#ffffff');
  composition.defs.push(`<mask id="${id}" maskUnits="userSpaceOnUse" maskContentUnits="userSpaceOnUse"><rect width="100%" height="100%" fill="#000000"/>${paths.join('') || fallback}</mask>`);
  return id;
}

function maskPaths(document: AgentDocument, node: AgentNode, parentMatrix: Matrix, vectorSvgs: ReadonlyMap<number, string>): string[] {
  if (node.visible === false) return [];
  const matrix = multiply(parentMatrix, matrixOf(node));
  const stroke = strokeOf(node) !== 'none' ? '#ffffff' : 'none';
  const paths = vectorPath(node, matrix, vectorSvgs, '#ffffff', stroke);
  const result = paths ? [paths] : [];
  const childIds = node.resolvedChildIds && node.resolvedChildIds.length ? node.resolvedChildIds : node.childIds;
  for (const childId of childIds) {
    const child = document.nodesById[childId];
    if (child) result.push(...maskPaths(document, child, matrix, vectorSvgs));
  }
  return result;
}

function vectorPath(node: AgentNode, matrix: Matrix, vectorSvgs: ReadonlyMap<number, string>, fill: string, stroke: string): string {
  const fillOpacity = fillOpacityOf(node);
  const strokeWeight = strokeWeightOf(node);
  if (!isVectorShape(node) && node.vectorRef) {
    const svg = vectorSvgs.get(node.vectorRef.blobId);
    if (svg) return pathElements(svg, matrix, fill, stroke, fillOpacity, strokeWeight);
  }
  const size = sizeOf(node);
  if (!size) return '';
  const transform = ` transform="matrix(${matrix.map(number).join(' ')})"`;
  const fillOpacityAttr = typeof fillOpacity === 'number' && fillOpacity < 1 && fill !== 'none' ? ` fill-opacity="${number(fillOpacity)}"` : '';
  const fillAttr = fill !== 'none' ? ` fill="${fill}"${fillOpacityAttr}` : ' fill="none"';
  const swAttr = strokeWeight && stroke !== 'none' ? ` stroke-width="${number(strokeWeight)}"` : '';
  const strokeAttr = stroke !== 'none' ? ` stroke="${stroke}"${swAttr}` : '';

  if (fill === 'none' && stroke === 'none') return '';

  if (node.type === 'ELLIPSE') {
    const sw = (stroke !== 'none' && typeof strokeWeight === 'number') ? strokeWeight : 0;
    const isInside = node.strokeAlign === 'INSIDE';
    const isOutside = node.strokeAlign === 'OUTSIDE';
    const rx = number(isInside ? Math.max(0, (size.x - sw) / 2) : isOutside ? (size.x + sw) / 2 : size.x / 2);
    const ry = number(isInside ? Math.max(0, (size.y - sw) / 2) : isOutside ? (size.y + sw) / 2 : size.y / 2);
    const cx = number(size.x / 2);
    const cy = number(size.y / 2);
    return `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}"${fillAttr}${strokeAttr}${transform}/>`;
  }

  if (node.type === 'RECTANGLE' || node.type === 'ROUNDED_RECTANGLE' || node.type === 'FRAME') {
    const sw = (stroke !== 'none' && typeof strokeWeight === 'number') ? strokeWeight : 0;
    const isInside = node.strokeAlign === 'INSIDE';
    const isOutside = node.strokeAlign === 'OUTSIDE';
    const x = isInside ? sw / 2 : isOutside ? -sw / 2 : 0;
    const y = isInside ? sw / 2 : isOutside ? -sw / 2 : 0;
    const w = isInside ? Math.max(0, size.x - sw) : isOutside ? size.x + sw : size.x;
    const h = isInside ? Math.max(0, size.y - sw) : isOutside ? size.y + sw : size.y;
    const xAttr = x !== 0 ? ` x="${number(x)}"` : '';
    const yAttr = y !== 0 ? ` y="${number(y)}"` : '';
    const radius = typeof node.cornerRadius === 'number'
      ? node.cornerRadius
      : (node.type === 'ROUNDED_RECTANGLE' ? Math.min(size.x, size.y) / 2 : undefined);
    const renderedRadius = typeof radius === 'number' && isOutside ? radius + sw / 2 : radius;
    const rx = typeof renderedRadius === 'number' && renderedRadius > 0 ? ` rx="${number(renderedRadius)}"` : '';
    return `<rect${xAttr}${yAttr} width="${number(w)}" height="${number(h)}"${rx}${fillAttr}${strokeAttr}${transform}/>`;
  }

  return '';
}

function withOpacity(content: string, opacity: number | undefined): string {
  return content && typeof opacity === 'number' && opacity >= 0 && opacity < 1 ? `<g opacity="${number(opacity)}">${content}</g>` : content;
}

function clipsContents(node: AgentNode): boolean { return node.frameMaskDisabled === false && node.type === 'FRAME' && !node.resizeToFit; }
function pathElements(svg: string, matrix: Matrix, fill: string, stroke: string, fillOpacity?: number, strokeWeight?: number): string {
  const transform = ` transform="matrix(${matrix.map(number).join(' ')})"`;
  return (svg.match(/<path\b[^>]*>/g) ?? []).map((path) => {
    let colored = path;
    if (colored.includes('fill="currentColor"')) {
      colored = colored.replace('fill="currentColor"', `fill="${fill}"`);
    } else if (fill !== 'none' && colored.includes('fill="none"')) {
      colored = colored.replace('fill="none"', `fill="${fill}"`);
    } else if (!colored.includes(' fill=') && !colored.includes('fill="none"')) {
      colored = colored.replace(/\/?>(?=$)/, ` fill="${fill}"$&`);
    }
    if (typeof fillOpacity === 'number' && fillOpacity < 1 && fill !== 'none' && !colored.includes('fill-opacity=')) {
      colored = colored.replace(/\/?>(?=$)/, ` fill-opacity="${number(fillOpacity)}"$&`);
    }
    if (colored.includes('stroke="currentColor"')) {
      colored = colored.replace('stroke="currentColor"', `stroke="${stroke}"`);
    } else if (stroke !== 'none' && colored.includes('stroke="none"')) {
      colored = colored.replace('stroke="none"', `stroke="${stroke}"`);
    } else if (stroke !== 'none' && !colored.includes(' stroke=')) {
      colored = colored.replace(/\/?>(?=$)/, ` stroke="${stroke}"$&`);
    }
    if (typeof strokeWeight === 'number' && stroke !== 'none') {
      if (colored.includes('stroke-width="')) {
        colored = colored.replace(/stroke-width="[^"]*"/, `stroke-width="${number(strokeWeight)}"`);
      } else if (!colored.includes(' stroke-width=')) {
        colored = colored.replace(/\/?>(?=$)/, ` stroke-width="${number(strokeWeight)}"$&`);
      }
    }
    return colored.replace(/\/?>(?=$)/, `${transform}/>`);
  }).join('');
}
function sizeOf(node: AgentNode | undefined): { x: number; y: number } | undefined {
  const value = node?.bounds;
  return value && typeof value === 'object' && typeof (value as { x?: unknown }).x === 'number' && typeof (value as { y?: unknown }).y === 'number' && (value as { x: number }).x > 0 && (value as { y: number }).y > 0 ? value as { x: number; y: number } : undefined;
}
function renderSizeOf(document: AgentDocument, node: AgentNode | undefined, visited = new Set<string>()): { x: number; y: number } | undefined {
  if (!node || visited.has(node.id)) return undefined;
  visited.add(node.id);
  const raw = node.bounds;
  let x = raw && typeof raw === 'object' && typeof (raw as { x?: unknown }).x === 'number' ? Math.max(0, (raw as { x: number }).x) : 0;
  let y = raw && typeof raw === 'object' && typeof (raw as { y?: unknown }).y === 'number' ? Math.max(0, (raw as { y: number }).y) : 0;
  if (x <= 0.001 || y <= 0.001) {
    const stroke = strokeWeightOf(node) ?? 0;
    if (x <= 0.001 && stroke > 0) x = stroke;
    if (y <= 0.001 && stroke > 0) y = stroke;
    const childIds = node.resolvedChildIds && node.resolvedChildIds.length ? node.resolvedChildIds : node.childIds;
    for (const childId of childIds) {
      const childSize = renderSizeOf(document, document.nodesById[childId], new Set(visited));
      if (!childSize) continue;
      if (x <= 0.001) x = Math.max(x, childSize.x);
      if (y <= 0.001) y = Math.max(y, childSize.y);
    }
  }
  return x > 0.001 && y > 0.001 ? { x, y } : undefined;
}
function rectPath(size: { x: number; y: number } | undefined, matrix: Matrix, fill: string): string {
  return size ? `<path d="M 0 0 H ${number(size.x)} V ${number(size.y)} H 0 Z" fill="${fill}" transform="matrix(${matrix.map(number).join(' ')})"/>` : '';
}
function matrixOf(node: AgentNode): Matrix {
  const value = node.transform as Record<string, unknown> | undefined;
  return value && [value.m00, value.m10, value.m01, value.m11, value.m02, value.m12].every((entry) => typeof entry === 'number') ? [value.m00 as number, value.m10 as number, value.m01 as number, value.m11 as number, value.m02 as number, value.m12 as number] : identity;
}
function multiply([a, b, c, d, e, f]: Matrix, [g, h, i, j, k, l]: Matrix): Matrix { return [a * g + c * h, b * g + d * h, a * i + c * j, b * i + d * j, a * k + c * l + e, b * k + d * l + f]; }
function isBorderOrOutline(node: AgentNode): boolean {
  const name = node.name.toLowerCase();
  const hasStrokes = Array.isArray(node.strokes) && node.strokes.length > 0;
  return hasStrokes && (name.includes('border') || name.includes('outline'));
}
function fillOf(node: AgentNode): string {
  if (isBorderOrOutline(node)) return 'none';
  const paints = Array.isArray(node.fills) ? node.fills : [];
  const paint = paints.find((entry) => entry && typeof entry === 'object' && (entry as Record<string, unknown>).type === 'SOLID' && (entry as Record<string, unknown>).visible !== false) as Record<string, unknown> | undefined;
  const color = paint?.color as Record<string, unknown> | undefined;
  if (!color || !['r', 'g', 'b'].every((key) => typeof color[key] === 'number')) return 'none';
  return `#${[color.r, color.g, color.b].map((value) => Math.round((value as number) * 255).toString(16).padStart(2, '0')).join('')}`;
}
function fillOpacityOf(node: AgentNode): number | undefined {
  const paints = Array.isArray(node.fills) ? node.fills : [];
  const paint = paints.find((entry) => entry && typeof entry === 'object' && (entry as Record<string, unknown>).type === 'SOLID' && (entry as Record<string, unknown>).visible !== false) as Record<string, unknown> | undefined;
  if (typeof paint?.opacity === 'number' && paint.opacity >= 0 && paint.opacity < 1) {
    return paint.opacity;
  }
  return undefined;
}
function strokeOf(node: AgentNode): string {
  const paints = Array.isArray(node.strokes) ? node.strokes : [];
  const paint = paints.find((entry) => entry && typeof entry === 'object' && (entry as Record<string, unknown>).type === 'SOLID' && (entry as Record<string, unknown>).visible !== false) as Record<string, unknown> | undefined;
  const color = paint?.color as Record<string, unknown> | undefined;
  if (!color || !['r', 'g', 'b'].every((key) => typeof color[key] === 'number')) return 'none';
  return `#${[color.r, color.g, color.b].map((value) => Math.round((value as number) * 255).toString(16).padStart(2, '0')).join('')}`;
}
function strokeWeightOf(node: AgentNode): number | undefined {
  if (typeof node.strokeWeight === 'number' && node.strokeWeight > 0) {
    return node.strokeWeight;
  }
  const paints = Array.isArray(node.strokes) ? node.strokes : [];
  const paint = paints.find((entry) => entry && typeof entry === 'object' && (entry as Record<string, unknown>).type === 'SOLID' && (entry as Record<string, unknown>).visible !== false) as Record<string, unknown> | undefined;
  if (paint) {
    return 1;
  }
  return undefined;
}
function supportedStyle(node: AgentNode): boolean {
  const effects = Array.isArray(node.effects) ? node.effects : [];
  return !effects.length && (node.blendMode === undefined || node.blendMode === 'NORMAL' || node.blendMode === 'PASS_THROUGH');
}
function isVectorShape(node: AgentNode): boolean {
  return node.type === 'ELLIPSE' || node.type === 'RECTANGLE' || node.type === 'ROUNDED_RECTANGLE';
}
interface VectorStatus { vectorOnly: boolean; vectorCount: number; }
const identity: Matrix = [1, 0, 0, 1, 0, 0];
function number(value: number): string { return Number(value.toFixed(4)).toString(); }
