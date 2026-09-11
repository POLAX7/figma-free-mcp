import { FigctxError } from '../errors.js';

export interface AgentNode {
  id: string;
  /** Original Figma node ID; remains stable for materialized descendants. */
  node_id?: string;
  /** Original component ID referenced by an INSTANCE, when available. */
  main_component_id?: string;
  name: string;
  type: string;
  parentId?: string;
  childIds: string[];
  resolvedChildIds?: string[];
  resolvedComponentId?: string;
  instanceTextOverrides?: string[];
  instanceTextOverridesByNodeId?: Record<string, string>;
  zIndex: number;
  text?: string;
  textSegments?: TextSegment[];
  bounds?: unknown;
  transform?: unknown;
  constraints?: { horizontal?: unknown; vertical?: unknown };
  layout?: Record<string, unknown>;
  fills?: unknown;
  strokes?: unknown;
  strokeWeight?: number;
  strokeAlign?: string;
  effects?: unknown;
  typography?: Record<string, unknown>;
  styleRefs?: StyleReferences;
  variableBindings?: VariableBinding[];
  textLayout?: Record<string, unknown>;
  visible?: boolean;
  opacity?: number;
  blendMode?: unknown;
  mask?: boolean;
  frameMaskDisabled?: boolean;
  resizeToFit?: boolean;
  cornerRadius?: number;
  assetRefs: AssetReference[];
  vectorRef?: VectorReference;
  /** originFileKey of the external library this component was imported from. */
  sourceLibraryKey?: string;
  /** Cross-file unique component identifier for resolving external library components. */
  componentKey?: string;
  overrideKey?: string;
  symbolOverrides?: Array<Record<string, unknown>>;
}

export interface TextSegment { start: number; end: number; text: string; styleId: number; typography: Record<string, unknown>; fills?: unknown; }
export interface StyleReferences { text?: string; effects?: string; strokeFill?: string; }
export interface VariableBinding { field: string; variableId: string; resolvedType?: string; }
export interface AssetReference { hash: string; path: string; kind: 'image-fill'; }
export interface VectorReference { blobId: number; path: string; format: 'kiwi-vector-network'; compression: 'gzip'; svgPath?: string; }

export type VariableColorResolver = (ref: unknown) => { r: number; g: number; b: number; a?: number } | undefined;

export interface AgentDocument {
  contractVersion: '1';
  originFileKey?: string;
  rootIds: string[];
  nodesById: Record<string, AgentNode>;
  variableResolver?: VariableColorResolver;
}

export interface NormalizeOptions {
  originFileKey?: string;
  assetPaths?: Readonly<Record<string, string>>;
  vectorPaths?: Readonly<Record<number, string>>;
  vectorSvgPaths?: Readonly<Record<number, string>>;
  variableResolver?: VariableColorResolver;
}

export function normalizeDocument(changes: readonly Record<string, unknown>[], options: NormalizeOptions = {}): AgentDocument {
  const resolveVar = options.variableResolver ?? buildVariableColorResolver(changes);
  const nodes = changes.map((change, zIndex) => normalizeNode(change, zIndex, options.assetPaths, options.vectorPaths, options.vectorSvgPaths, resolveVar));
  const nodesById = Object.fromEntries(nodes.map((node) => [node.id, node]));
  const roots: string[] = [];
  changes.forEach((change, index) => {
    const parentIndex = typeof change.parentIndex === 'number' ? change.parentIndex : undefined;
    const node = nodes[index]!;
    const parentRef = record(change.parentIndex);
    const parentId = parentRef?.guid === undefined ? undefined : idFromGuid(parentRef.guid, -1);
    const parent = parentIndex === undefined ? (parentId ? nodesById[parentId] : undefined) : nodes[parentIndex];
    if (!parent || parent.id === node.id) roots.push(node.id);
    else { node.parentId = parent.id; parent.childIds.push(node.id); }
  });
  return { contractVersion: '1', ...(options.originFileKey ? { originFileKey: options.originFileKey } : {}), rootIds: roots, nodesById, ...(resolveVar ? { variableResolver: resolveVar } : {}) };
}

/** Returns the child IDs consumers should traverse after local expansion. */
export function effectiveChildIds(node: AgentNode): string[] {
  return node.resolvedChildIds ?? node.childIds;
}

/** Expands local component instances while preserving the raw instance hierarchy. */
export function expandLocalInstances(document: AgentDocument, assetPaths?: Readonly<Record<string, string>>, variableResolver?: VariableColorResolver): AgentDocument {
  const resolveVar = variableResolver ?? document.variableResolver;
  const nodesById = { ...document.nodesById };
  const pending: Array<{ node: AgentNode; componentPath: Set<string> }> = Object.values(document.nodesById).map((node) => ({ node, componentPath: new Set<string>() }));
  for (let index = 0; index < pending.length; index += 1) {
    const { node: instance, componentPath } = pending[index]!;
    if (instance.type !== 'INSTANCE' || instance.childIds.length || instance.resolvedChildIds || !instance.resolvedComponentId) continue;
    const component = document.nodesById[instance.resolvedComponentId];
    if (!component) continue;
    if (componentPath.has(instance.resolvedComponentId)) continue;
    const nextPath = new Set(componentPath).add(instance.resolvedComponentId);
    const textOverrides = instance.instanceTextOverrides ?? [];
    const sourceTexts = descendantIds(document, component.childIds).map((id) => document.nodesById[id]).filter((node): node is AgentNode => Boolean(node?.text !== undefined));
    const textBySourceId = new Map(sourceTexts.map((node, index) => [node.id, textOverrides[index]]));
    Object.entries(instance.instanceTextOverridesByNodeId ?? {}).forEach(([sourceId, text]) => textBySourceId.set(sourceId, text));
    const clone = (sourceId: string, parentId: string): string => {
      const source = document.nodesById[sourceId]!;
      const id = `${instance.id}::${source.id}`;
      // Clone the component definition's raw tree. A source node may already
      // carry resolved children from another instance and must not leak that
      // expansion into this instance.
      const childIds = source.childIds.map((childId) => clone(childId, id));
      const text = textBySourceId.get(source.id);
      nodesById[id] = { ...source, id, parentId, childIds, ...(text === undefined ? {} : { text }) };
      if (nodesById[id]!.type === 'INSTANCE' && nodesById[id]!.resolvedComponentId && !nextPath.has(nodesById[id]!.resolvedComponentId!)) pending.push({ node: nodesById[id]!, componentPath: nextPath });
      return id;
    };
    instance.resolvedChildIds = component.childIds.map((childId) => clone(childId, instance.id));
  }
  for (const instance of Object.values(document.nodesById)) {
    if (instance.type !== 'INSTANCE' || !instance.resolvedChildIds || !instance.resolvedComponentId) continue;
    const component = document.nodesById[instance.resolvedComponentId];
    const directTextCount = component ? descendantIds(document, component.childIds).filter((id) => document.nodesById[id]?.text !== undefined).length : 0;
    const remainingOverrides = (instance.instanceTextOverrides ?? []).slice(directTextCount);
    if (!remainingOverrides.length) continue;
    const expandedTextIds = resolvedDescendantIds(nodesById, instance.resolvedChildIds).filter((id) => nodesById[id]?.text !== undefined);
    const targets = expandedTextIds.slice(Math.max(0, expandedTextIds.length - remainingOverrides.length));
    remainingOverrides.slice(-targets.length).forEach((text, offset) => {
      const targetId = targets[offset];
      if (targetId) nodesById[targetId] = { ...nodesById[targetId]!, text };
    });
  }

  const instanceDepth = (node: AgentNode): number => {
    let depth = 0;
    let curr: AgentNode | undefined = node;
    while (curr?.parentId && nodesById[curr.parentId]) {
      depth += 1;
      curr = nodesById[curr.parentId];
    }
    return depth;
  };

  const instancesWithOverrides = Object.values(nodesById)
    .filter((n) => n.type === 'INSTANCE' && Array.isArray(n.symbolOverrides) && n.symbolOverrides.length > 0)
    .sort((a, b) => instanceDepth(b) - instanceDepth(a));

  for (const instance of instancesWithOverrides) {
    for (const override of instance.symbolOverrides!) {
      const guids = record(override.guidPath)?.guids;
      if (!Array.isArray(guids) || !guids.length) continue;
      const pathGuids = guids.map(guidId).filter((g): g is string => typeof g === 'string');
      if (!pathGuids.length) continue;

      const target = findOverrideTarget(instance, pathGuids, nodesById);
      if (target) {
        applyOverride(target, override, assetPaths, resolveVar);
      }
    }
  }

  return { ...document, nodesById };
}

function findOverrideTarget(
  instance: AgentNode,
  pathGuids: readonly string[],
  nodesById: Record<string, AgentNode>
): AgentNode | undefined {
  if (!pathGuids.length) return undefined;

  const matchesGuid = (node: AgentNode, guid: string): boolean => {
    return node.overrideKey === guid || node.node_id === guid || node.id === guid;
  };

  let current = instance;
  for (let i = 0; i < pathGuids.length; i += 1) {
    const guid = pathGuids[i]!;
    const childIds = current.resolvedChildIds ?? current.childIds ?? [];

    let nextNode: AgentNode | undefined;
    for (const childId of childIds) {
      const child = nodesById[childId];
      if (child && matchesGuid(child, guid)) {
        nextNode = child;
        break;
      }
    }

    if (!nextNode) {
      const allDescendantIds = resolvedDescendantIds(nodesById, childIds);
      for (const descId of allDescendantIds) {
        const desc = nodesById[descId];
        if (desc && matchesGuid(desc, guid)) {
          nextNode = desc;
          break;
        }
      }
    }

    if (!nextNode && i === 0 && pathGuids.length === 1) {
      if (matchesGuid(current, guid)) return current;
      if (current.resolvedComponentId) {
        const comp = nodesById[current.resolvedComponentId];
        if (comp && matchesGuid(comp, guid)) return current;
      }
    }

    if (!nextNode) return undefined;
    current = nextNode;
  }

  return current;
}

function applyOverride(target: AgentNode, override: Record<string, unknown>, assetPaths?: Readonly<Record<string, string>>, resolveVar?: VariableColorResolver): void {
  if (override.fillPaints !== undefined) {
    target.fills = resolvePaints(override.fillPaints, resolveVar);
    if (assetPaths) {
      target.assetRefs = assetReferences(target.fills, assetPaths);
    }
  }
  if (override.strokePaints !== undefined) {
    target.strokes = resolvePaints(override.strokePaints, resolveVar);
  }
  if (typeof override.strokeWeight === 'number') {
    target.strokeWeight = override.strokeWeight;
  }
  if (typeof override.strokeAlign === 'string') {
    target.strokeAlign = override.strokeAlign;
  }
  if (override.size !== undefined) {
    target.bounds = override.size;
  }
  if (typeof override.visible === 'boolean') {
    target.visible = override.visible;
  }
  if (typeof override.opacity === 'number') {
    target.opacity = override.opacity;
  }
  if (override.effects !== undefined) {
    target.effects = override.effects;
  }
  if (typeof override.cornerRadius === 'number') {
    target.cornerRadius = override.cornerRadius;
  }
  const text = overrideText(override);
  if (text !== undefined) {
    target.text = text;
  }
  const styles = styleReferences(override);
  if (styles) {
    target.styleRefs = { ...target.styleRefs, ...styles };
  }
  const bindings = variableBindings(override);
  if (bindings) {
    target.variableBindings = bindings;
  }
}

function descendantIds(document: AgentDocument, ids: readonly string[]): string[] {
  return ids.flatMap((id) => [id, ...descendantIds(document, document.nodesById[id]?.childIds ?? [])]);
}

function resolvedDescendantIds(nodesById: Record<string, AgentNode>, ids: readonly string[]): string[] {
  return ids.flatMap((id) => [id, ...resolvedDescendantIds(nodesById, nodesById[id]?.resolvedChildIds ?? nodesById[id]?.childIds ?? [])]);
}

export function resolveNodeReference(document: AgentDocument, reference: string): AgentNode {
  const urlFileKey = fileKeyFromReference(reference);
  if (urlFileKey && document.originFileKey && !document.originFileKey.startsWith('lk-') && urlFileKey !== document.originFileKey) throw new FigctxError('NODE_REFERENCE_FILE_MISMATCH', `Figma URL belongs to ${urlFileKey}, but this bundle is for ${document.originFileKey}.`);
  const id = canonicalNodeId(reference);
  const node = document.nodesById[id];
  if (!node) throw new FigctxError('NODE_NOT_FOUND', `No node matches ${reference}.`);
  return node;
}

export function canonicalNodeId(reference: string): string {
  const raw = reference.includes('://') ? extractUrlNodeId(reference) : reference;
  const decoded = decodeURIComponent(raw).trim();
  const parts = decoded.split('::');
  const canonicalParts = parts.map((part) => {
    const match = part.match(/^(\d+)[-:](\d+)$/);
    if (!match) throw new FigctxError('NODE_NOT_FOUND', `Invalid node reference: ${reference}`);
    return `${match[1]}:${match[2]}`;
  });
  return canonicalParts.join('::');
}

function extractUrlNodeId(reference: string): string {
  const url = new URL(reference);
  const value = url.searchParams.get('node-id') ?? url.hash.match(/node-id=([^&]+)/)?.[1];
  if (!value) throw new FigctxError('NODE_NOT_FOUND', 'Figma URL has no node-id parameter.');
  return value;
}

function fileKeyFromReference(reference: string): string | undefined {
  if (!reference.includes('://')) return undefined;
  try { const match = new URL(reference).pathname.match(/\/(?:design|file)\/([^/?#]+)/i); return match?.[1] ? decodeURIComponent(match[1]) : undefined; } catch { return undefined; }
}

function normalizeNode(change: Record<string, unknown>, zIndex: number, assetPaths: Readonly<Record<string, string>> | undefined, vectorPaths: Readonly<Record<number, string>> | undefined, vectorSvgPaths: Readonly<Record<number, string>> | undefined, resolveVar?: VariableColorResolver): AgentNode {
  const id = idFromGuid(change.guid, zIndex);
  const textData = record(change.textData);
  const layoutKeys = ['stackMode', 'stackSpacing', 'stackHorizontalPadding', 'stackVerticalPadding', 'stackPrimaryAlignItems', 'stackCounterAlignItems'];
  const typographyKeys = ['fontName', 'fontSize', 'lineHeight', 'letterSpacing', 'textAlignHorizontal', 'textAlignVertical', 'fontVariantCommonLigatures', 'fontVariantContextualLigatures', 'fontVariations', 'textTracking', 'textCase', 'textDecoration'];
  const typography = pick(change, typographyKeys);
  const derivedTextData = record(change.derivedTextData);
  const textLayout = derivedTextData ? pick(derivedTextData, ['layoutSize', 'baselines', 'fontMetaData', 'truncationStartIndex', 'truncatedHeight', 'derivedLines']) : undefined;
  const fills = resolvePaints(change.fillPaints, resolveVar);
  const strokes = resolvePaints(change.strokePaints, resolveVar);
  const segments = textSegments(textData, typography, fills);
  const styles = styleReferences(change);
  const bindings = variableBindings(change);
  const symbolData = record(change.symbolData);
  const symbolId = record(symbolData?.symbolID);
  const overrides = Array.isArray(symbolData?.symbolOverrides) ? (symbolData.symbolOverrides as Array<Record<string, unknown>>) : [];
  const instanceTextOverrides = overrides.flatMap((override) => { const text = overrideText(override); return text === undefined ? [] : [text]; });
  const instanceTextOverridesByNodeId = Object.fromEntries(overrides.flatMap((override) => {
    const targetId = overrideTargetId(override); const text = overrideText(override);
    return targetId && text !== undefined ? [[targetId, text]] : [];
  }));
  const overrideKey = guidId(change.overrideKey);
  return {
    id, node_id: id, name: typeof change.name === 'string' ? change.name : id, type: typeof change.type === 'string' ? change.type : 'UNKNOWN', childIds: [], zIndex,
    ...(symbolId ? { resolvedComponentId: idFromGuid(symbolId, zIndex), main_component_id: guidId(symbolId), instanceTextOverrides, ...(Object.keys(instanceTextOverridesByNodeId).length ? { instanceTextOverridesByNodeId } : {}), ...(overrides.length ? { symbolOverrides: overrides } : {}) } : {}),
    ...(overrideKey ? { overrideKey } : {}),
    ...(typeof textData?.characters === 'string' ? { text: textData.characters } : {}), ...(segments ? { textSegments: segments } : {}), ...(textLayout && Object.keys(textLayout).length ? { textLayout } : {}),
    ...(change.size === undefined ? {} : { bounds: change.size }), ...(change.transform === undefined ? {} : { transform: change.transform }),
    ...(typeof change.visible === 'boolean' ? { visible: change.visible } : {}), ...(typeof change.opacity === 'number' ? { opacity: change.opacity } : {}), ...(change.blendMode === undefined ? {} : { blendMode: change.blendMode }), ...(typeof change.mask === 'boolean' ? { mask: change.mask } : {}), ...(typeof change.frameMaskDisabled === 'boolean' ? { frameMaskDisabled: change.frameMaskDisabled } : {}), ...(typeof change.resizeToFit === 'boolean' ? { resizeToFit: change.resizeToFit } : {}), constraints: { horizontal: change.horizontalConstraint, vertical: change.verticalConstraint },
    layout: pick(change, layoutKeys), fills, strokes, ...(typeof change.strokeWeight === 'number' ? { strokeWeight: change.strokeWeight } : {}), ...(typeof change.strokeAlign === 'string' ? { strokeAlign: change.strokeAlign } : {}), ...(typeof change.cornerRadius === 'number' ? { cornerRadius: change.cornerRadius } : {}), effects: change.effects, typography, ...(styles ? { styleRefs: styles } : {}), ...(bindings ? { variableBindings: bindings } : {}), assetRefs: assetReferences(fills, assetPaths), ...(vectorReference(change.vectorData, vectorPaths, vectorSvgPaths) ? { vectorRef: vectorReference(change.vectorData, vectorPaths, vectorSvgPaths) } : {}),
    ...(typeof change.sourceLibraryKey === 'string' ? { sourceLibraryKey: change.sourceLibraryKey } : {}), ...(typeof change.componentKey === 'string' ? { componentKey: change.componentKey } : {})
  };
}

function textSegments(textData: Record<string, unknown> | undefined, baseTypography: Record<string, unknown>, baseFills: unknown): TextSegment[] | undefined {
  if (!textData) return undefined;
  const text = typeof textData.characters === 'string' ? textData.characters : undefined;
  const styleIds = textData.characterStyleIDs;
  if (!text || !Array.isArray(styleIds) || styleIds.length !== text.length || !styleIds.some((styleId) => typeof styleId === 'number' && styleId !== 0)) return undefined;
  const overrides = new Map((Array.isArray(textData.styleOverrideTable) ? textData.styleOverrideTable : []).flatMap((entry) => {
    const style = record(entry); const styleId = style?.styleID;
    return typeof styleId === 'number' ? [[styleId, style] as const] : [];
  }));
  const typographyKeys = ['fontName', 'fontSize', 'lineHeight', 'letterSpacing', 'textAlignHorizontal', 'textAlignVertical', 'fontVariantCommonLigatures', 'fontVariantContextualLigatures', 'fontVariations', 'textTracking', 'textCase', 'textDecoration'];
  const segments: TextSegment[] = [];
  for (let start = 0; start < styleIds.length;) {
    const styleId = typeof styleIds[start] === 'number' ? styleIds[start] : 0;
    let end = start + 1;
    while (end < styleIds.length && styleIds[end] === styleId) end += 1;
    const override = overrides.get(styleId);
    segments.push({ start, end, text: text.slice(start, end), styleId, typography: { ...baseTypography, ...pick(override ?? {}, typographyKeys) }, ...((override?.fillPaints ?? baseFills) === undefined ? {} : { fills: override?.fillPaints ?? baseFills }) });
    start = end;
  }
  return segments;
}

function styleReferences(change: Record<string, unknown>): StyleReferences | undefined {
  const refs = {
    text: guidId(record(change.styleIdForText)?.guid),
    effects: guidId(record(change.styleIdForEffect)?.guid),
    strokeFill: guidId(record(change.styleIdForStrokeFill)?.guid)
  };
  return Object.values(refs).some(Boolean) ? refs : undefined;
}

function variableBindings(change: Record<string, unknown>): VariableBinding[] | undefined {
  const entries = record(change.variableConsumptionMap)?.entries;
  if (!Array.isArray(entries)) return undefined;
  const bindings = entries.flatMap((entry) => {
    const value = record(record(record(entry)?.variableData)?.value);
    const variableId = guidId(record(value?.alias)?.guid);
    const field = record(entry)?.variableField;
    const resolvedType = record(record(entry)?.variableData)?.resolvedDataType;
    return typeof field === 'string' && variableId ? [{ field, variableId, ...(typeof resolvedType === 'string' ? { resolvedType } : {}) }] : [];
  });
  return bindings.length ? bindings : undefined;
}
function vectorReference(value: unknown, vectorPaths: Readonly<Record<number, string>> | undefined, vectorSvgPaths: Readonly<Record<number, string>> | undefined): VectorReference | undefined {
  const blobId = record(value)?.vectorNetworkBlob;
  if (typeof blobId !== 'number') return undefined;
  const path = vectorPaths?.[blobId];
  return path ? { blobId, path, format: 'kiwi-vector-network', compression: 'gzip', ...(vectorSvgPaths?.[blobId] ? { svgPath: vectorSvgPaths[blobId] } : {}) } : undefined;
}
function assetReferences(value: unknown, assetPaths: Readonly<Record<string, string>> | undefined): AssetReference[] {
  if (!Array.isArray(value) || !assetPaths) return [];
  const refs: AssetReference[] = [];
  for (const paint of value) { const hash = hashToHex(record(record(paint)?.image)?.hash); if (!hash) continue; const path = assetPaths[hash]; if (path) refs.push({ hash, path, kind: 'image-fill' }); }
  return refs;
}
export function hashToHex(value: unknown): string | undefined {
  if (value instanceof Uint8Array) return Buffer.from(value).toString('hex');
  const bytes = record(value); if (!bytes) return undefined;
  const values = Object.keys(bytes).filter((key) => /^\d+$/.test(key)).sort((a, b) => Number(a) - Number(b)).map((key) => bytes[key]);
  return values.length === 20 && values.every((byte) => typeof byte === 'number' && byte >= 0 && byte <= 255) ? Buffer.from(values as number[]).toString('hex') : undefined;
}
function idFromGuid(value: unknown, fallback: number): string { const guid = record(value); return typeof guid?.sessionID === 'number' && typeof guid.localID === 'number' ? `${guid.sessionID}:${guid.localID}` : `index:${fallback}`; }
function guidId(value: unknown): string | undefined { const guid = record(value); return typeof guid?.sessionID === 'number' && typeof guid.localID === 'number' ? `${guid.sessionID}:${guid.localID}` : undefined; }
function overrideTargetId(value: unknown): string | undefined {
  const guids = record(value)?.guidPath;
  const entries = record(guids)?.guids;
  return Array.isArray(entries) ? guidId(entries.at(-1)) : undefined;
}
function overrideText(value: unknown): string | undefined {
  const override = record(value);
  const textData = record(override?.textData) ?? record(override?.textDataValue);
  if (typeof textData?.characters === 'string') return textData.characters;
  return typeof override?.characters === 'string' ? override.characters : undefined;
}
function record(value: unknown): Record<string, unknown> | undefined { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function pick(value: Record<string, unknown>, keys: string[]): Record<string, unknown> { return Object.fromEntries(keys.filter((key) => value[key] !== undefined).map((key) => [key, value[key]])); }

export function buildVariableColorResolver(
  changes: readonly Record<string, unknown>[]
): VariableColorResolver {
  const varByKey = new Map<string, Record<string, unknown>>();
  const varByVersion = new Map<string, Record<string, unknown>>();

  for (const c of changes) {
    if (c.type === 'VARIABLE') {
      if (typeof c.key === 'string') varByKey.set(c.key, c);
      if (typeof c.version === 'string') varByVersion.set(c.version, c);
    }
  }

  const resolve = (ref: unknown, depth = 0): { r: number; g: number; b: number; a?: number } | undefined => {
    if (depth > 10 || !ref || typeof ref !== 'object') return undefined;
    const r = ref as Record<string, unknown>;
    const key = typeof r.key === 'string' ? r.key : undefined;
    const version = typeof r.version === 'string' ? r.version : undefined;
    const v = (key ? varByKey.get(key) : undefined) ?? (version ? varByVersion.get(version) : undefined);
    if (!v) return undefined;
    const entries = record(v.variableDataValues)?.entries;
    if (!Array.isArray(entries) || !entries.length) return undefined;
    const data = record(record(entries[0])?.variableData);
    if (!data) return undefined;
    if (data.dataType === 'COLOR') {
      const color = record(record(data.value)?.colorValue);
      if (color && typeof color.r === 'number' && typeof color.g === 'number' && typeof color.b === 'number') {
        return { r: color.r, g: color.g, b: color.b, ...(typeof color.a === 'number' ? { a: color.a } : {}) };
      }
    }
    if (data.dataType === 'ALIAS') {
      const aliasRef = record(record(data.value)?.alias)?.assetRef;
      if (aliasRef) return resolve(aliasRef, depth + 1);
    }
    return undefined;
  };

  return resolve;
}

export function resolvePaints(
  paints: unknown,
  resolveVar?: VariableColorResolver
): unknown {
  if (!Array.isArray(paints) || !resolveVar) return paints;
  return paints.map((p) => {
    if (!p || typeof p !== 'object') return p;
    const paintObj = p as Record<string, unknown>;
    const colorVar = record(paintObj.colorVar);
    const assetRef = record(record(colorVar?.value)?.alias)?.assetRef;
    if (assetRef) {
      const resolved = resolveVar(assetRef);
      if (resolved) {
        return { ...paintObj, color: resolved };
      }
    }
    return p;
  });
}
