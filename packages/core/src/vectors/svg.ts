export interface VectorSize { x: number; y: number; }

export interface VectorStyle {
  fills?: readonly unknown[] | null;
  strokes?: readonly unknown[] | null;
  strokeWeight?: number;
  strokeCap?: string | null;
  strokeJoin?: string | null;
  cornerRadius?: number;
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
  const effectiveRadius = typeof style?.cornerRadius === 'number' && style.cornerRadius > 0 ? style.cornerRadius * fitted.scale : undefined;
  const paths = buildPaths(fitted.vertices, fitted.segments, regions, effectiveRadius);
  if (!paths.length) return undefined;
  const pathAttributes = outlineAttributes(style);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${number(size.x)} ${number(size.y)}">${paths.map((path) => `<path d="${path}" ${pathAttributes}/>`).join('')}</svg>`;
}

function fitGeometryToSize(vertices: readonly Vertex[], segments: readonly Segment[], size: VectorSize): { vertices: Vertex[]; segments: Segment[]; scale: number } {
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
  const hasX = maxX > 0.001 && size.x > 0.001;
  const hasY = maxY > 0.001 && size.y > 0.001;
  let scale = 1;
  if (hasX && hasY) {
    scale = Math.min(size.x / maxX, size.y / maxY);
  } else if (hasX) {
    scale = size.x / maxX;
  } else if (hasY) {
    scale = size.y / maxY;
  }
  if (!Number.isFinite(scale) || Math.abs(scale - 1) < 0.0001) return { vertices: [...vertices], segments: [...segments], scale: 1 };
  return {
    vertices: vertices.map((vertex) => ({ x: vertex.x * scale, y: vertex.y * scale })),
    segments: segments.map((segment) => ({
      ...segment,
      tangentStartX: segment.tangentStartX * scale,
      tangentStartY: segment.tangentStartY * scale,
      tangentEndX: segment.tangentEndX * scale,
      tangentEndY: segment.tangentEndY * scale
    })),
    scale
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

function isCurved(s: Segment): boolean {
  return Math.abs(s.tangentStartX) > .001 || Math.abs(s.tangentStartY) > .001 || Math.abs(s.tangentEndX) > .001 || Math.abs(s.tangentEndY) > .001;
}

function renderContour(ordered: readonly Segment[], vertices: readonly Vertex[], isClosed: boolean, cornerRadius?: number): string {
  if (!ordered.length) return '';
  const first = ordered[0]!;

  if (!cornerRadius || cornerRadius <= 0) {
    const parts: string[] = [`M ${point(vertices[first.start]!)}`];
    let previousEnd = first.start;
    for (const segment of ordered) {
      if (segment.start !== previousEnd) parts.push(`M ${point(vertices[segment.start]!)}`);
      previousEnd = segment.end;
      const start = vertices[segment.start]!;
      const end = vertices[segment.end]!;
      parts.push(isCurved(segment)
        ? `C ${number(start.x + segment.tangentStartX)} ${number(start.y + segment.tangentStartY)} ${number(end.x + segment.tangentEndX)} ${number(end.y + segment.tangentEndY)} ${point(end)}`
        : `L ${point(end)}`);
    }
    if (isClosed) parts.push('Z');
    return parts.join(' ');
  }

  let contiguous = true;
  for (let i = 1; i < ordered.length; i += 1) {
    if (ordered[i]!.start !== ordered[i - 1]!.end) { contiguous = false; break; }
  }
  if (!contiguous) {
    return renderContour(ordered, vertices, isClosed, undefined);
  }

  const k = ordered.length;
  const closed = isClosed || ordered[k - 1]!.end === ordered[0]!.start;
  const corners = new Map<number, { pStart: Vertex; pEnd: Vertex; sweep: number; r: number }>();

  const count = closed ? k : k - 1;
  for (let i = 0; i < count; i += 1) {
    const cornerIdx = closed ? i : i + 1;
    const prevSeg = closed ? ordered[(i - 1 + k) % k]! : ordered[i]!;
    const nextSeg = closed ? ordered[i]! : ordered[i + 1]!;

    if (isCurved(prevSeg) || isCurved(nextSeg)) continue;

    const pPrev = vertices[prevSeg.start]!;
    const pCurr = vertices[prevSeg.end]!;
    const pNext = vertices[nextSeg.end]!;

    const vIn = { x: pPrev.x - pCurr.x, y: pPrev.y - pCurr.y };
    const vOut = { x: pNext.x - pCurr.x, y: pNext.y - pCurr.y };
    const lenIn = Math.hypot(vIn.x, vIn.y);
    const lenOut = Math.hypot(vOut.x, vOut.y);
    if (lenIn < 0.001 || lenOut < 0.001) continue;

    const uIn = { x: vIn.x / lenIn, y: vIn.y / lenIn };
    const uOut = { x: vOut.x / lenOut, y: vOut.y / lenOut };
    const dot = Math.max(-1, Math.min(1, uIn.x * uOut.x + uIn.y * uOut.y));
    const angle = Math.acos(dot);
    if (angle < 0.01 || angle > Math.PI - 0.01) continue;

    const cross = uIn.x * uOut.y - uIn.y * uOut.x;
    const t = Math.min(lenIn / 2, lenOut / 2, cornerRadius * Math.tan(angle / 2));
    if (t < 0.001) continue;

    const pStart = { x: pCurr.x + uIn.x * t, y: pCurr.y + uIn.y * t };
    const pEnd = { x: pCurr.x + uOut.x * t, y: pCurr.y + uOut.y * t };
    const sweep = cross > 0 ? 0 : 1;
    corners.set(cornerIdx, { pStart, pEnd, sweep, r: cornerRadius });
  }

  const parts: string[] = [];
  if (closed) {
    const c0 = corners.get(0);
    parts.push(`M ${point(c0 ? c0.pEnd : vertices[ordered[0]!.start]!)}`);
    for (let i = 0; i < k; i += 1) {
      const seg = ordered[i]!;
      const nextCornerIdx = (i + 1) % k;
      const cNext = corners.get(nextCornerIdx);
      if (isCurved(seg)) {
        const start = vertices[seg.start]!;
        const end = vertices[seg.end]!;
        parts.push(`C ${number(start.x + seg.tangentStartX)} ${number(start.y + seg.tangentStartY)} ${number(end.x + seg.tangentEndX)} ${number(end.y + seg.tangentEndY)} ${point(end)}`);
      } else {
        parts.push(`L ${point(cNext ? cNext.pStart : vertices[seg.end]!)}`);
      }
      if (cNext) {
        parts.push(`A ${number(cNext.r)} ${number(cNext.r)} 0 0 ${cNext.sweep} ${point(cNext.pEnd)}`);
      }
    }
    parts.push('Z');
  } else {
    parts.push(`M ${point(vertices[ordered[0]!.start]!)}`);
    for (let i = 0; i < k; i += 1) {
      const seg = ordered[i]!;
      const corner = corners.get(i + 1);
      if (isCurved(seg)) {
        const start = vertices[seg.start]!;
        const end = vertices[seg.end]!;
        parts.push(`C ${number(start.x + seg.tangentStartX)} ${number(start.y + seg.tangentStartY)} ${number(end.x + seg.tangentEndX)} ${number(end.y + seg.tangentEndY)} ${point(end)}`);
      } else {
        parts.push(`L ${point(corner ? corner.pStart : vertices[seg.end]!)}`);
      }
      if (corner) {
        parts.push(`A ${number(corner.r)} ${number(corner.r)} 0 0 ${corner.sweep} ${point(corner.pEnd)}`);
      }
    }
  }
  return parts.join(' ');
}

function buildPaths(vertices: readonly Vertex[], segments: readonly Segment[], regions: readonly number[][][], cornerRadius?: number): string[] {
  const paths: string[] = [];
  const usedSegments = new Set<number>();
  const groups = regions.length ? regions : [disconnectedSegmentGroups(segments)];
  for (const region of groups) {
    const regionPath: string[] = [];
    for (const group of region) {
      for (const index of group) usedSegments.add(index);
      const ordered = orderSegments(group, segments);
      if (!ordered.length) continue;
      const path = renderContour(ordered, vertices, Boolean(regions.length), cornerRadius);
      if (path) regionPath.push(path);
    }
    if (regionPath.length) paths.push(regionPath.join(' '));
  }
  if (regions.length) {
    for (let index = 0; index < segments.length; index += 1) {
      if (usedSegments.has(index)) continue;
      const ordered = orderSegments([index], segments);
      if (!ordered.length) continue;
      const path = renderContour(ordered, vertices, false, cornerRadius);
      if (path) paths.push(path);
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
    if (nextIndex < 0) {
      const next = remaining.shift()!;
      ordered.push(next);
      end = next.end;
      continue;
    }
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
  const rounded = typeof style.cornerRadius === 'number' && style.cornerRadius > 0;
  const cap = svgLineValue(style.strokeCap, rounded ? 'round' : 'butt');
  const sourceJoin = svgLineValue(style.strokeJoin, 'miter');
  const join = rounded && sourceJoin === 'miter' ? 'round' : sourceJoin;
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
