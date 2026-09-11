import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { expect, test } from 'vitest';
import * as frameSvg from '../src/vectors/frame.js';

const { composeBundleVectorGroupSvg, composeFrameSvg, composeVectorGroupSvg } = frameSvg;

test('composes descendant vector paths with their Figma transforms and fills', () => {
  const document = {
    contractVersion: '1' as const,
    rootIds: ['1:1'],
    nodesById: {
      '1:1': { id: '1:1', name: 'Card', type: 'FRAME', childIds: ['1:2'], zIndex: 0, bounds: { x: 100, y: 80 }, transform: { m00: 1, m01: 0, m02: 200, m10: 0, m11: 1, m12: 300 }, assetRefs: [] },
      '1:2': { id: '1:2', name: 'Star', type: 'VECTOR', childIds: [], zIndex: 1, bounds: { x: 10, y: 10 }, transform: { m00: 1, m01: 0, m02: 12, m10: 0, m11: 1, m12: 8 }, fills: [{ type: 'SOLID', color: { r: 1, g: 0.5, b: 0 } }], assetRefs: [], vectorRef: { blobId: 7, path: 'assets/vectors/vector-network-7.bin.gz', format: 'kiwi-vector-network' as const, compression: 'gzip', svgPath: 'assets/vectors/vector-network-7.svg' } }
    }
  };

  expect(composeFrameSvg(document, '1:1', new Map([[7, '<svg><path d="M 0 0 L 10 0 Z" fill="currentColor"/></svg>']]))).toBe(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 80"><path d="M 0 0 L 10 0 Z" fill="#ff8000" transform="matrix(1 0 0 1 12 8)"/></svg>'
  );
});

test('prefers the complete binary vector network over an incomplete materialized SVG', async () => {
  const bundleRoot = await mkdtemp(join(tmpdir(), 'figctx-vector-priority-'));
  const vectorDirectory = join(bundleRoot, 'assets', 'vectors');
  await mkdir(vectorDirectory, { recursive: true });
  const bytes = new Uint8Array(12 + 4 * 12 + 2 * 28);
  const view = new DataView(bytes.buffer);
  let offset = 0;
  view.setUint32(offset, 4, true); offset += 4;
  view.setUint32(offset, 2, true); offset += 4;
  view.setUint32(offset, 0, true); offset += 4;
  for (const [x, y] of [[0, 0], [16, 16], [16, 0], [0, 16]]) {
    view.setUint32(offset, 0, true); offset += 4;
    view.setFloat32(offset, x, true); offset += 4;
    view.setFloat32(offset, y, true); offset += 4;
  }
  for (const [start, end] of [[0, 1], [2, 3]]) {
    view.setUint32(offset, 0, true); offset += 4;
    view.setUint32(offset, start, true); offset += 4;
    view.setFloat32(offset, 0, true); offset += 4;
    view.setFloat32(offset, 0, true); offset += 4;
    view.setUint32(offset, end, true); offset += 4;
    view.setFloat32(offset, 0, true); offset += 4;
    view.setFloat32(offset, 0, true); offset += 4;
  }
  await writeFile(join(vectorDirectory, 'vector-network-1.bin.gz'), gzipSync(bytes));
  await writeFile(join(vectorDirectory, 'vector-network-1.svg'), '<svg><path d="M 0 0 L 16 16"/></svg>');

  const document = {
    contractVersion: '1' as const,
    rootIds: ['1:1'],
    nodesById: {
      '1:1': { id: '1:1', name: 'X', type: 'VECTOR', childIds: [], zIndex: 0, bounds: { x: 16, y: 16 }, assetRefs: [], vectorRef: { blobId: 1, path: 'assets/vectors/vector-network-1.bin.gz', svgPath: 'assets/vectors/vector-network-1.svg', format: 'kiwi-vector-network' as const, compression: 'gzip' as const } }
    }
  };

  const svg = await composeBundleVectorGroupSvg(bundleRoot, document, '1:1');

  expect(svg).toContain('M 0 0 L 16 16');
  expect(svg).toContain('M 16 0 L 0 16');
});
test('clips frame contents and applies a mask to following sibling layers', () => {
  const document = {
    contractVersion: '1' as const,
    rootIds: ['1:1'],
    nodesById: {
      '1:1': { id: '1:1', name: 'Card', type: 'FRAME', childIds: ['1:2', '1:3'], zIndex: 0, bounds: { x: 100, y: 80 }, transform: { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 }, frameMaskDisabled: false, assetRefs: [] },
      '1:2': { id: '1:2', name: 'Mask', type: 'VECTOR', childIds: [], zIndex: 1, bounds: { x: 20, y: 20 }, transform: { m00: 1, m01: 0, m02: 10, m10: 0, m11: 1, m12: 10 }, mask: true, assetRefs: [], vectorRef: { blobId: 7, path: 'assets/vectors/vector-network-7.bin.gz', format: 'kiwi-vector-network' as const, compression: 'gzip' } },
      '1:3': { id: '1:3', name: 'Artwork', type: 'VECTOR', childIds: [], zIndex: 2, bounds: { x: 20, y: 20 }, transform: { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 }, fills: [{ type: 'SOLID', color: { r: 0, g: 1, b: 0 } }], assetRefs: [], vectorRef: { blobId: 8, path: 'assets/vectors/vector-network-8.bin.gz', format: 'kiwi-vector-network' as const, compression: 'gzip' } }
    }
  };

  const svg = composeFrameSvg(document, '1:1', new Map([
    [7, '<svg><path d="M 0 0 H 20 V 20 Z"/></svg>'],
    [8, '<svg><path d="M -10 -10 H 40 V 40 Z"/></svg>']
  ]));

  expect(svg).toContain('<clipPath id="clip-0"><path d="M 0 0 H 100 V 80 H 0 Z" fill="#ffffff" transform="matrix(1 0 0 1 0 0)"/></clipPath>');
  expect(svg).toContain('<mask id="mask-1" maskUnits="userSpaceOnUse" maskContentUnits="userSpaceOnUse"><rect width="100%" height="100%" fill="#000000"/><path d="M 0 0 H 20 V 20 Z" fill="#ffffff" transform="matrix(1 0 0 1 10 10)"/></mask>');
  expect(svg).toContain('<g mask="url(#mask-1)"><path d="M -10 -10 H 40 V 40 Z" fill="#00ff00" transform="matrix(1 0 0 1 0 0)"/></g>');
});

test('finds a maximal vector group and composes every descendant path once', () => {
  expect(frameSvg).toHaveProperty('findVectorGroups');
  expect(frameSvg).toHaveProperty('composeVectorGroupSvg');

  const document = {
    contractVersion: '1' as const,
    rootIds: ['1:1'],
    nodesById: {
      '1:1': { id: '1:1', name: 'Card', type: 'FRAME', childIds: ['1:2', '1:5'], zIndex: 0, bounds: { x: 100, y: 80 }, assetRefs: [] },
      '1:2': { id: '1:2', name: 'Illustration', type: 'FRAME', parentId: '1:1', childIds: ['1:3', '1:4'], zIndex: 1, bounds: { x: 40, y: 30 }, assetRefs: [] },
      '1:3': { id: '1:3', name: 'Circle', type: 'VECTOR', parentId: '1:2', childIds: [], zIndex: 2, bounds: { x: 10, y: 10 }, transform: { m00: 1, m01: 0, m02: 2, m10: 0, m11: 1, m12: 3 }, opacity: 0.5, fills: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0 } }], assetRefs: [], vectorRef: { blobId: 7, path: 'assets/vectors/vector-network-7.bin.gz', format: 'kiwi-vector-network' as const, compression: 'gzip' } },
      '1:4': { id: '1:4', name: 'Dot', type: 'VECTOR', parentId: '1:2', childIds: [], zIndex: 3, bounds: { x: 10, y: 10 }, transform: { m00: 1, m01: 0, m02: 20, m10: 0, m11: 1, m12: 4 }, fills: [{ type: 'SOLID', color: { r: 0, g: 0, b: 1 } }], assetRefs: [], vectorRef: { blobId: 8, path: 'assets/vectors/vector-network-8.bin.gz', format: 'kiwi-vector-network' as const, compression: 'gzip' } },
      '1:5': { id: '1:5', name: 'Label', type: 'TEXT', parentId: '1:1', childIds: [], zIndex: 4, text: 'Not SVG', assetRefs: [] }
    }
  };

  const groups = (frameSvg as typeof frameSvg & { findVectorGroups: (document: typeof document, rootId: string) => Array<{ nodeId: string }> }).findVectorGroups(document, '1:1');
  expect(groups).toEqual([{ nodeId: '1:2', name: 'Illustration', bounds: { x: 40, y: 30 }, vectorCount: 2 }]);

  const svg = (frameSvg as typeof frameSvg & { composeVectorGroupSvg: (document: typeof document, nodeId: string, vectors: ReadonlyMap<number, string>) => string | undefined }).composeVectorGroupSvg(document, '1:2', new Map([
    [7, '<svg><path d="M 0 0 H 10 V 10 Z" fill="currentColor"/></svg>'],
    [8, '<svg><path d="M 0 0 H 4 V 4 Z" fill="currentColor"/><path d="M 1 1 H 3 V 3 Z" fill="currentColor" fill-rule="evenodd"/></svg>']
  ]));

  expect(svg).toContain('viewBox="0 0 40 30"');
  expect(svg?.match(/<path /g)).toHaveLength(3);
  expect(svg).toContain('<g opacity="0.5">');
  expect(svg).toContain('fill="#ff0000" transform="matrix(1 0 0 1 2 3)"');
  expect(svg).toContain('fill="#0000ff" transform="matrix(1 0 0 1 20 4)"');
  expect(svg).toContain('fill-rule="evenodd"');
});

test('loads a selected vector group from its bundle SVG files', async () => {
  expect(frameSvg).toHaveProperty('composeBundleVectorGroupSvg');
  const bundle = await mkdtemp(join(tmpdir(), 'figctx-vector-group-'));
  await writeFile(join(bundle, 'vector.svg'), '<svg><path d="M 0 0 H 5 V 5 Z" fill="currentColor"/></svg>');
  const document = {
    contractVersion: '1' as const,
    rootIds: ['2:1'],
    nodesById: {
      '2:1': { id: '2:1', name: 'Icon', type: 'FRAME', childIds: ['2:2'], zIndex: 0, bounds: { x: 5, y: 5 }, assetRefs: [] },
      '2:2': { id: '2:2', name: 'Path', type: 'VECTOR', parentId: '2:1', childIds: [], zIndex: 1, bounds: { x: 5, y: 5 }, fills: [{ type: 'SOLID', color: { r: 0, g: 1, b: 0 } }], assetRefs: [], vectorRef: { blobId: 3, path: 'vector.bin.gz', svgPath: 'vector.svg', format: 'kiwi-vector-network' as const, compression: 'gzip' } }
    }
  };

  const svg = await (frameSvg as typeof frameSvg & { composeBundleVectorGroupSvg: (bundle: string, document: typeof document, nodeId: string) => Promise<string | undefined> }).composeBundleVectorGroupSvg(bundle, document, '2:1');
  expect(svg).toContain('fill="#00ff00"');
});

test('composes stroke-based vector groups with correct stroke color', () => {
  const document = {
    contractVersion: '1' as const,
    rootIds: ['3:1'],
    nodesById: {
      '3:1': { id: '3:1', name: 'OutlineIcon', type: 'FRAME', childIds: ['3:2'], zIndex: 0, bounds: { x: 24, y: 24 }, assetRefs: [] },
      '3:2': { id: '3:2', name: 'StarOutline', type: 'VECTOR', parentId: '3:1', childIds: [], zIndex: 1, bounds: { x: 18, y: 18 }, transform: { m00: 1, m01: 0, m02: 3, m10: 0, m11: 1, m12: 3 }, strokes: [{ type: 'SOLID', color: { r: 0.2157, g: 0.2314, b: 0.302 } }], assetRefs: [], vectorRef: { blobId: 9, path: 'star.bin.gz', svgPath: 'star.svg', format: 'kiwi-vector-network' as const, compression: 'gzip' } }
    }
  };

  const groups = (frameSvg as typeof frameSvg & { findVectorGroups: (doc: typeof document, rootId: string) => Array<{ nodeId: string }> }).findVectorGroups(document, '3:1');
  expect(groups).toEqual([{ nodeId: '3:1', name: 'OutlineIcon', bounds: { x: 24, y: 24 }, vectorCount: 1 }]);

  const svg = (frameSvg as typeof frameSvg & { composeVectorGroupSvg: (doc: typeof document, nodeId: string, vectors: ReadonlyMap<number, string>) => string | undefined }).composeVectorGroupSvg(document, '3:1', new Map([
    [9, '<svg viewBox="0 0 18 18"><path d="M 9 0 L 18 18 Z" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>']
  ]));

  expect(svg).toContain('viewBox="0 0 24 24"');
  expect(svg).toContain('stroke="#373b4d"');
  expect(svg).toContain('fill="none"');
  expect(svg).toContain('transform="matrix(1 0 0 1 3 3)"');
});

test('correctly multiplies nested affine matrices without mixing row and column factors', () => {
  // Parent matrix: [a=1, b=2, c=3, d=4, e=10, f=20]
  // Child matrix:  [g=5, h=6, i=7, j=8, k=1, l=2]
  // Expected product:
  // m00: a*g + c*h = 1*5 + 3*6 = 23
  // m10: b*g + d*h = 2*5 + 4*6 = 34
  // m01: a*i + c*j = 1*7 + 3*8 = 31
  // m11: b*i + d*j = 2*7 + 4*8 = 46  (with the old bug 'b*g + d*j', this was 2*5 + 4*8 = 42)
  // m02: a*k + c*l + e = 1*1 + 3*2 + 10 = 17
  // m12: b*k + d*l + f = 2*1 + 4*2 + 20 = 30
  const document = {
    contractVersion: '1' as const,
    rootIds: ['4:1'],
    nodesById: {
      '4:1': { id: '4:1', name: 'RootFrame', type: 'FRAME', childIds: ['4:2'], zIndex: 0, bounds: { x: 100, y: 100 }, assetRefs: [] },
      '4:2': {
        id: '4:2', name: 'ParentGroup', type: 'FRAME', parentId: '4:1', childIds: ['4:3'], zIndex: 1, bounds: { x: 50, y: 50 },
        transform: { m00: 1, m10: 2, m01: 3, m11: 4, m02: 10, m12: 20 }, assetRefs: []
      },
      '4:3': {
        id: '4:3', name: 'ChildVector', type: 'VECTOR', parentId: '4:2', childIds: [], zIndex: 2, bounds: { x: 10, y: 10 },
        transform: { m00: 5, m10: 6, m01: 7, m11: 8, m02: 1, m12: 2 },
        fills: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0 } }], assetRefs: [],
        vectorRef: { blobId: 10, path: 'rect.bin.gz', svgPath: 'rect.svg', format: 'kiwi-vector-network' as const, compression: 'gzip' }
      }
    }
  };

  const svg = composeFrameSvg(document, '4:1', new Map([
    [10, '<svg viewBox="0 0 10 10"><path d="M 0 0 H 10 V 10 Z" fill="currentColor"/></svg>']
  ]));

  expect(svg).toContain('transform="matrix(23 34 31 46 17 30)"');
});

test('composes geometric shapes and collects skipped layer warnings', () => {
  const document = {
    contractVersion: '1' as const,
    rootIds: ['5:1'],
    nodesById: {
      '5:1': { id: '5:1', name: 'Illustration', type: 'FRAME', childIds: ['5:2', '5:3', '5:4', '5:5'], zIndex: 0, bounds: { x: 100, y: 80 }, assetRefs: [] },
      '5:2': { id: '5:2', name: 'Backdrop', type: 'ELLIPSE', parentId: '5:1', childIds: [], zIndex: 1, bounds: { x: 80, y: 20 }, fills: [{ type: 'SOLID', color: { r: 0.8, g: 0.8, b: 0.9 } }], assetRefs: [] },
      '5:3': { id: '5:3', name: 'Badge', type: 'ROUNDED_RECTANGLE', parentId: '5:1', childIds: [], zIndex: 2, bounds: { x: 30, y: 10 }, fills: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0 } }], assetRefs: [] },
      '5:4': { id: '5:4', name: 'VectorDot', type: 'VECTOR', parentId: '5:1', childIds: [], zIndex: 3, bounds: { x: 5, y: 5 }, fills: [{ type: 'SOLID', color: { r: 0, g: 1, b: 0 } }], assetRefs: [], vectorRef: { blobId: 20, path: 'dot.bin.gz', svgPath: 'dot.svg', format: 'kiwi-vector-network' as const, compression: 'gzip' } },
      '5:5': { id: '5:5', name: 'Label', type: 'TEXT', parentId: '5:1', childIds: [], zIndex: 4, bounds: { x: 40, y: 12 }, text: 'Unsupported In Vector', assetRefs: [] }
    }
  };

  const warnings: string[] = [];
  const svg = composeVectorGroupSvg(document, '5:1', new Map([
    [20, '<svg viewBox="0 0 5 5"><path d="M 0 0 H 5 V 5 Z" fill="currentColor"/></svg>']
  ]), warnings);

  expect(svg).toBeDefined();
  expect(svg).toContain('<ellipse cx="40" cy="10" rx="40" ry="10" fill="#cccce6"');
  expect(svg).toContain('<rect width="30" height="10" rx="5" fill="#ff0000"');
  expect(svg).toContain('fill="#00ff00"');
  expect(warnings).toEqual([
    expect.stringContaining('Label (5:5, TEXT): Unsupported layer type or missing vector data')
  ]);
});

test('applies stroke and fill-opacity to paths even when svg fragment only had fill="currentColor"', () => {
  const document = {
    contractVersion: '1' as const,
    rootIds: ['6:1'],
    nodesById: {
      '6:1': { id: '6:1', name: 'LensContainer', type: 'FRAME', childIds: ['6:2'], zIndex: 0, bounds: { x: 44, y: 44 }, assetRefs: [] },
      '6:2': {
        id: '6:2', name: 'Lens', type: 'ELLIPSE', parentId: '6:1', childIds: [], zIndex: 1, bounds: { x: 44, y: 44 },
        strokeWeight: 4,
        fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 }, opacity: 0.5 }],
        strokes: [{ type: 'SOLID', color: { r: 0.45098, g: 0.46274, b: 0.52941 } }],
        assetRefs: [],
        vectorRef: { blobId: 30, path: 'circle.bin.gz', svgPath: 'circle.svg', format: 'kiwi-vector-network' as const, compression: 'gzip' }
      }
    }
  };

  const svg = composeVectorGroupSvg(document, '6:1', new Map([
    [30, '<svg viewBox="0 0 44 44"><path d="M 44 22 Z" fill="currentColor"/></svg>']
  ]));

  expect(svg).toContain('fill="#ffffff"');
  expect(svg).toContain('fill-opacity="0.5"');
  expect(svg).toContain('stroke="#737687"');
  expect(svg).toContain('stroke-width="4"');
});

test('does not clip frame contents when resizeToFit is true (group container)', () => {
  const document = {
    contractVersion: '1' as const,
    rootIds: ['7:1'],
    nodesById: {
      '7:1': { id: '7:1', name: 'GroupContainer', type: 'FRAME', childIds: ['7:2'], zIndex: 0, bounds: { x: 50, y: 50 }, frameMaskDisabled: false, resizeToFit: true, assetRefs: [] },
      '7:2': { id: '7:2', name: 'ChildShape', type: 'ELLIPSE', parentId: '7:1', childIds: [], zIndex: 1, bounds: { x: 50, y: 50 }, fills: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0 } }], assetRefs: [] }
    }
  };

  const svg = composeFrameSvg(document, '7:1', new Map());
  expect(svg).toBeDefined();
  expect(svg).not.toContain('<clipPath');
  expect(svg).not.toContain('clip-path=');
});

test('handles strokeAlign INSIDE for ellipses and rectangles without bleeding outside bounds', () => {
  const document = {
    contractVersion: '1' as const,
    rootIds: ['8:1'],
    nodesById: {
      '8:1': { id: '8:1', name: 'Container', type: 'FRAME', childIds: ['8:2', '8:3'], zIndex: 0, bounds: { x: 100, y: 100 }, assetRefs: [] },
      '8:2': {
        id: '8:2', name: 'InnerRing', type: 'ELLIPSE', parentId: '8:1', childIds: [], zIndex: 1, bounds: { x: 44, y: 44 },
        strokeWeight: 4, strokeAlign: 'INSIDE',
        strokes: [{ type: 'SOLID', color: { r: 0.2, g: 0.2, b: 0.2 } }],
        assetRefs: []
      },
      '8:3': {
        id: '8:3', name: 'InnerCard', type: 'RECTANGLE', parentId: '8:1', childIds: [], zIndex: 2, bounds: { x: 50, y: 60 },
        strokeWeight: 2, strokeAlign: 'INSIDE', cornerRadius: 4,
        strokes: [{ type: 'SOLID', color: { r: 0.3, g: 0.3, b: 0.3 } }],
        assetRefs: []
      }
    }
  };

  const svg = composeFrameSvg(document, '8:1', new Map());
  expect(svg).toBeDefined();
  // For 44x44 ellipse with 4px INSIDE stroke: rx = (44 - 4) / 2 = 20, ry = 20, cx = 22, cy = 22
  expect(svg).toContain('<ellipse cx="22" cy="22" rx="20" ry="20" fill="none" stroke="#333333" stroke-width="4"');
  // For 50x60 rectangle with 2px INSIDE stroke: x = 1, y = 1, width = 48, height = 58, rx = 4
  expect(svg).toContain('<rect x="1" y="1" width="48" height="58" rx="4" fill="none" stroke="#4d4d4d" stroke-width="2"');
});

test('expands OUTSIDE strokes beyond rectangle and ellipse bounds without changing their center', () => {
  const document = {
    contractVersion: '1' as const,
    rootIds: ['10:1'],
    nodesById: {
      '10:1': { id: '10:1', name: 'Container', type: 'FRAME', childIds: ['10:2', '10:3'], zIndex: 0, bounds: { x: 100, y: 100 }, assetRefs: [] },
      '10:2': {
        id: '10:2', name: 'OutsideCard', type: 'RECTANGLE', parentId: '10:1', childIds: [], zIndex: 1, bounds: { x: 50, y: 60 },
        strokeWeight: 4, strokeAlign: 'OUTSIDE', strokes: [{ type: 'SOLID', color: { r: 0.2, g: 0.2, b: 0.2 } }], assetRefs: []
      },
      '10:3': {
        id: '10:3', name: 'OutsideRing', type: 'ELLIPSE', parentId: '10:1', childIds: [], zIndex: 2, bounds: { x: 40, y: 40 },
        strokeWeight: 4, strokeAlign: 'OUTSIDE', strokes: [{ type: 'SOLID', color: { r: 0.3, g: 0.3, b: 0.3 } }], assetRefs: []
      }
    }
  };

  const svg = composeFrameSvg(document, '10:1', new Map());
  expect(svg).toContain('<rect x="-2" y="-2" width="54" height="64" fill="none" stroke="#333333" stroke-width="4"');
  expect(svg).toContain('<ellipse cx="20" cy="20" rx="22" ry="22" fill="none" stroke="#4d4d4d" stroke-width="4"');
});

test('expands rounded-corner radius together with an OUTSIDE stroke', () => {
  const document = {
    contractVersion: '1' as const,
    rootIds: ['12:1'],
    nodesById: {
      '12:1': { id: '12:1', name: 'Container', type: 'FRAME', childIds: ['12:2'], zIndex: 0, bounds: { x: 100, y: 100 }, assetRefs: [] },
      '12:2': {
        id: '12:2', name: 'RoundedCard', type: 'ROUNDED_RECTANGLE', parentId: '12:1', childIds: [], zIndex: 1, bounds: { x: 30, y: 20 },
        cornerRadius: 5, strokeWeight: 4, strokeAlign: 'OUTSIDE',
        strokes: [{ type: 'SOLID', color: { r: 0.2, g: 0.2, b: 0.2 } }], assetRefs: []
      }
    }
  };

  const svg = composeFrameSvg(document, '12:1', new Map());
  expect(svg).toContain('<rect x="-2" y="-2" width="34" height="24" rx="7" fill="none" stroke="#333333" stroke-width="4"');
});

test('sets fill="none" for border or outline named shapes with strokes', () => {
  const document = {
    contractVersion: '1' as const,
    rootIds: ['9:1'],
    nodesById: {
      '9:1': { id: '9:1', name: 'Icon', type: 'FRAME', childIds: ['9:2'], zIndex: 0, bounds: { x: 44, y: 44 }, assetRefs: [] },
      '9:2': {
        id: '9:2', name: 'Lens-Border', type: 'ELLIPSE', parentId: '9:1', childIds: [], zIndex: 1, bounds: { x: 44, y: 44 },
        strokeWeight: 4, strokeAlign: 'INSIDE',
        fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 }, opacity: 0.5 }],
        strokes: [{ type: 'SOLID', color: { r: 0.45, g: 0.46, b: 0.53 } }],
        assetRefs: []
      }
    }
  };

  const svg = composeFrameSvg(document, '9:1', new Map());
  expect(svg).toBeDefined();
  expect(svg).toContain('fill="none"');
  expect(svg).not.toContain('fill="#ffffff"');
});

test('overrides default SVG stroke-width with explicit node.strokeWeight on vector layers', () => {
  const document = {
    contractVersion: '1' as const,
    rootIds: ['10:1'],
    nodesById: {
      '10:1': { id: '10:1', name: 'StarGroup', type: 'FRAME', childIds: ['10:2'], zIndex: 0, bounds: { x: 30, y: 30 }, assetRefs: [] },
      '10:2': {
        id: '10:2', name: 'StarVector', type: 'VECTOR', parentId: '10:1', childIds: [], zIndex: 1, bounds: { x: 22, y: 22 },
        strokeWeight: 1.8,
        strokes: [{ type: 'SOLID', color: { r: 0.2, g: 0.2, b: 0.3 } }],
        assetRefs: [],
        vectorRef: { blobId: 40, path: 'star.bin.gz', svgPath: 'star.svg', format: 'kiwi-vector-network' as const, compression: 'gzip' }
      }
    }
  };

  const svg = composeFrameSvg(document, '10:1', new Map([
    [40, '<svg viewBox="0 0 22 22"><path d="M 0 0 L 22 22 Z" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>']
  ]));

  expect(svg).toBeDefined();
  expect(svg).toContain('stroke-width="1.8"');
  expect(svg).not.toContain('stroke-width="1.2"');
  expect(svg).toContain('stroke="#33334d"');
});

test('replaces fill="none" with node fill when vector node has explicit solid fill', () => {
  const document = {
    contractVersion: '1' as const,
    rootIds: ['11:1'],
    nodesById: {
      '11:1': { id: '11:1', name: 'StarGroup', type: 'FRAME', childIds: ['11:2'], zIndex: 0, bounds: { x: 30, y: 30 }, assetRefs: [] },
      '11:2': {
        id: '11:2', name: 'StarVector', type: 'VECTOR', parentId: '11:1', childIds: [], zIndex: 1, bounds: { x: 22, y: 22 },
        strokeWeight: 1.8,
        fills: [{ type: 'SOLID', color: { r: 1, g: 0.823529, b: 0.039215 } }],
        strokes: [{ type: 'SOLID', color: { r: 1, g: 0.647058, b: 0.270588 } }],
        assetRefs: [],
        vectorRef: { blobId: 50, path: 'star.bin.gz', svgPath: 'star.svg', format: 'kiwi-vector-network' as const, compression: 'gzip' }
      }
    }
  };

  const svg = composeFrameSvg(document, '11:1', new Map([
    [50, '<svg viewBox="0 0 22 22"><path d="M 0 0 L 22 22 Z" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>']
  ]));

  expect(svg).toBeDefined();
  expect(svg).toContain('fill="#ffd20a"');
  expect(svg).toContain('stroke="#ffa545"');
  expect(svg).toContain('stroke-width="1.8"');
  expect(svg).not.toContain('fill="none"');
});

test('uses stroke width as the renderable size of a zero-height stroked vector', () => {
  const document = {
    contractVersion: '1' as const,
    rootIds: ['13:1'],
    nodesById: {
      '13:1': {
        id: '13:1', name: 'Line', type: 'VECTOR', childIds: [], zIndex: 0,
        bounds: { x: 197, y: 0.000001 }, strokeWeight: 3,
        strokes: [{ type: 'SOLID', color: { r: 0, g: 1, b: 0 } }], assetRefs: [],
        vectorRef: { blobId: 4058, path: 'line.bin.gz', svgPath: 'line.svg', format: 'kiwi-vector-network' as const, compression: 'gzip' }
      }
    }
  };

  const svg = composeVectorGroupSvg(document, '13:1', new Map([
    [4058, '<svg viewBox="0 0 197 0"><path d="M 0 0 L 197 0" fill="none" stroke="currentColor" stroke-width="3"/></svg>']
  ]));

  expect(svg).toContain('viewBox="0 0 197 3"');
  expect(svg).toContain('stroke="#00ff00"');
});

test('uses visible child size when a vector container has a zero dimension', () => {
  const document = {
    contractVersion: '1' as const,
    rootIds: ['14:1'],
    nodesById: {
      '14:1': { id: '14:1', name: 'Placeholder', type: 'FRAME', childIds: ['14:2'], zIndex: 0, bounds: { x: 0.000001, y: 27 }, assetRefs: [] },
      '14:2': {
        id: '14:2', name: 'Placeholder', type: 'VECTOR', parentId: '14:1', childIds: [], zIndex: 1,
        bounds: { x: 20, y: 0 }, strokeWeight: 1.2,
        strokes: [{ type: 'SOLID', color: { r: 0, g: 0, b: 1 } }], assetRefs: [],
        vectorRef: { blobId: 3400, path: 'line.bin.gz', svgPath: 'line.svg', format: 'kiwi-vector-network' as const, compression: 'gzip' }
      }
    }
  };

  const svg = composeVectorGroupSvg(document, '14:1', new Map([
    [3400, '<svg viewBox="0 0 20 0"><path d="M 0 0 L 20 0" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>']
  ]));

  expect(svg).toContain('viewBox="0 0 20 27"');
  expect(svg).toContain('stroke="#0000ff"');
});
