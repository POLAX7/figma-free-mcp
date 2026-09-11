export interface VectorSize { x: number; y: number; }

export interface VectorStyle {
  fills?: readonly unknown[] | null;
  strokes?: readonly unknown[] | null;
  strokeWeight?: number;
  strokeCap?: string | null;
  strokeJoin?: string | null;
}

interface Vertex { x: number; y: number; }
interface Segment { start: number; end: number; tangentStartX: number; tangentStartY: number; tangentEndX: number; tangentEndY: number; }

/** Converts Figma's local vector-network blob into a self-contained SVG. */
export function vectorNetworkToSvg(bytes: Uint8Array, size: VectorSize, style?: VectorStyle): string | undefined {
  if (bytes.byteLength < 12 || !isSize(size)) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  const vertexCount = view.getUint32(offset, true); offset += 4;
  const segmentCount = view.getUint32(offset, true); offset += 4;
  const regionCount = view.getUint32(offset, true); offset += 4;
  if (!vertexCount || !segmentCount || vertexCount > 100_000 || segmentCount > 100_000) return undefined;

  const vertices: Vertex[] = [];
  for (let index = 0; index < vertexCount; index += 1) {
    if (offset + 12 > bytes.byteLength) return undefined;
    offset += 4;
    vertices.push({ x: view.getFloat32(offset, true), y: view.getFloat32(offset + 4, true) });
    offset += 8;
  }

  const segments: Segment[] = [];
  for (let index = 0; index < segmentCount; index += 1) {
    if (offset + 28 > bytes.byteLength) return undefined;
    offset += 4;
    const start = view.getUint32(offset, true); offset += 4;
    const tangentStartX = view.getFloat32(offset, true); offset += 4;
    const tangentStartY = view.getFloat32(offset, true); offset += 4;
    const end = view.getUint32(offset, true); offset += 4;
    const tangentEndX = view.getFloat32(offset, true); offset += 4;
    const tangentEndY = view.getFloat32(offset, true); offset += 4;
    if (start >= vertexCount || end >= vertexCount) return undefined;
    segments.push({ start, end, tangentStartX, tangentStartY, tangentEndX, tangentEndY });
  }

  const regions = readRegions(view, offset, regionCount, bytes.byteLength);
  if (!regions) return undefined;
  const fitted = fitGeometryToSize(vertices, segments, size);
  const paths = buildPaths(fitted.vertices, fitted.segments, regions);
  if (!paths.length) return undefined;
  const pathAttributes = outlineAttributes(style);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${number(size.x)} ${number(size.y)}">${paths.map((path) => `<path d="${path}" ${pathAttributes}/>`).join('')}</svg>`;
}

function fitGeometryToSize(vertices: readonly Vertex[], segments: readonly Segment[], size: VectorSize): { vertices: Vertex[]; segments: Segment[] } {
  let maxX = 0;
  let maxY = 0;
  for (const vertex of vertices) {
    maxX = Math.max(maxX, vertex.x);
    maxY = Math.max(maxY, vertex.y);
  }
  for (const segment of segments) {
    const start = vertices[segment.start]!;
    const end = vertices[segment.end]!;
    maxX = Math.max(maxX, start.x + segment.tangentStartX, end.x + segment.tangentEndX);
    maxY = Math.max(maxY, start.y + segment.tangentStartY, end.y + segment.tangentEndY);
  }
  const scale = Math.min(1, size.x / maxX, size.y / maxY);
  if (!Number.isFinite(scale) || scale >= 1) return { vertices: [...vertices], segments: [...segments] };
  return {
    vertices: vertices.map((vertex) => ({ x: vertex.x * scale, y: vertex.y * scale })),
    segments: segments.map((segment) => ({
      ...segment,
      tangentStartX: segment.tangentStartX * scale,
      tangentStartY: segment.tangentStartY * scale,
      tangentEndX: segment.tangentEndX * scale,
      tangentEndY: segment.tangentEndY * scale
    }))
  };
}

function readRegions(view: DataView, initialOffset: number, regionCount: number, length: number): number[][][] | undefined {
  let offset = initialOffset;
  const regions: number[][][] = [];
  for (let region = 0; region < regionCount; region += 1) {
    if (offset + 8 > length) return undefined;
    offset += 4;
    const loopCount = view.getUint32(offset, true); offset += 4;
    const loops: number[][] = [];
    for (let loop = 0; loop < loopCount; loop += 1) {
      if (offset + 4 > length) return undefined;
      const segmentCount = view.getUint32(offset, true); offset += 4;
      if (offset + segmentCount * 4 > length) return undefined;
      const indices: number[] = [];
      for (let index = 0; index < segmentCount; index += 1) { indices.push(view.getUint32(offset, true)); offset += 4; }
      loops.push(indices);
    }
    regions.push(loops);
  }
  return regions;
}

function buildPaths(vertices: readonly Vertex[], segments: readonly Segment[], regions: readonly number[][][]): string[] {
  const paths: string[] = [];
  const usedSegments = new Set<number>();
  const groups = regions.length ? regions : [disconnectedSegmentGroups(segments)];
  for (const region of groups) {
    const regionPath: string[] = [];
    for (const group of region) {
      for (const index of group) usedSegments.add(index);
      const ordered = orderSegments(group, segments);
      const first = ordered[0];
      if (!first) continue;
      regionPath.push(`M ${point(vertices[first.start]!)}`);
      for (const segment of ordered) {
        const start = vertices[segment.start]!;
        const end = vertices[segment.end]!;
        const curved = Math.abs(segment.tangentStartX) > .001 || Math.abs(segment.tangentStartY) > .001 || Math.abs(segment.tangentEndX) > .001 || Math.abs(segment.tangentEndY) > .001;
        regionPath.push(curved ? `C ${number(start.x + segment.tangentStartX)} ${number(start.y + segment.tangentStartY)} ${number(end.x + segment.tangentEndX)} ${number(end.y + segment.tangentEndY)} ${point(end)}` : `L ${point(end)}`);
      }
      if (regions.length) regionPath.push('Z');
    }
    if (regionPath.length) paths.push(regionPath.join(' '));
  }
  if (regions.length) {
    for (let index = 0; index < segments.length; index += 1) {
      if (usedSegments.has(index)) continue;
      const ordered = orderSegments([index], segments);
      const first = ordered[0];
      if (!first) continue;
      const path = [`M ${point(vertices[first.start]!)}`];
      for (const segment of ordered) {
        const start = vertices[segment.start]!;
        const end = vertices[segment.end]!;
        const curved = Math.abs(segment.tangentStartX) > .001 || Math.abs(segment.tangentStartY) > .001 || Math.abs(segment.tangentEndX) > .001 || Math.abs(segment.tangentEndY) > .001;
        path.push(curved ? `C ${number(start.x + segment.tangentStartX)} ${number(start.y + segment.tangentStartY)} ${number(end.x + segment.tangentEndX)} ${number(end.y + segment.tangentEndY)} ${point(end)}` : `L ${point(end)}`);
      }
      paths.push(path.join(' '));
    }
  }
  return paths;
}

function disconnectedSegmentGroups(segments: readonly Segment[]): number[][] {
  const remaining = new Set(segments.map((_segment, index) => index));
  const groups: number[][] = [];
  while (remaining.size) {
    const first = remaining.values().next().value as number;
    remaining.delete(first);
    const group = [first];
    const endpoints = new Set([segments[first]!.start, segments[first]!.end]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const index of remaining) {
        const segment = segments[index]!;
        if (!endpoints.has(segment.start) && !endpoints.has(segment.end)) continue;
        remaining.delete(index);
        group.push(index);
        endpoints.add(segment.start);
        endpoints.add(segment.end);
        changed = true;
      }
    }
    groups.push(group);
  }
  return groups;
}

function orderSegments(group: readonly number[], segments: readonly Segment[]): Segment[] {
  const remaining = group.map((index) => segments[index]).filter((segment): segment is Segment => Boolean(segment));
  const first = remaining.shift();
  if (!first) return [];
  const ordered = [first];
  let end = first.end;
  while (remaining.length) {
    const nextIndex = remaining.findIndex((segment) => segment.start === end || segment.end === end);
    if (nextIndex < 0) break;
    const next = remaining.splice(nextIndex, 1)[0]!;
    const oriented = next.start === end ? next : reverseSegment(next);
    ordered.push(oriented);
    end = oriented.end;
  }
  return ordered;
}

function reverseSegment(segment: Segment): Segment {
  return { start: segment.end, end: segment.start, tangentStartX: segment.tangentEndX, tangentStartY: segment.tangentEndY, tangentEndX: segment.tangentStartX, tangentEndY: segment.tangentStartY };
}

function outlineAttributes(style: VectorStyle | undefined): string {
  if (!style || !hasVisiblePaint(style.strokes) || hasVisiblePaint(style.fills)) return 'fill="currentColor" fill-rule="evenodd"';
  const weight = typeof style.strokeWeight === 'number' && style.strokeWeight > 0 ? number(style.strokeWeight) : '1';
  const cap = svgLineValue(style.strokeCap, 'butt');
  const join = svgLineValue(style.strokeJoin, 'miter');
  return `fill="none" stroke="currentColor" stroke-width="${weight}" stroke-linecap="${cap}" stroke-linejoin="${join}"`;
}

function hasVisiblePaint(paints: readonly unknown[] | null | undefined): boolean {
  return Array.isArray(paints) && paints.some((paint) => paint && typeof paint === 'object' && (paint as Record<string, unknown>).visible !== false);
}

function svgLineValue(value: string | null | undefined, fallback: string): string {
  return typeof value === 'string' ? value.toLowerCase() : fallback;
}

function isSize(size: VectorSize): boolean { return Number.isFinite(size.x) && Number.isFinite(size.y) && size.x > 0 && size.y > 0; }
function point(value: Vertex): string { return `${number(value.x)} ${number(value.y)}`; }
function number(value: number): string { return Number(value.toFixed(4)).toString(); }
