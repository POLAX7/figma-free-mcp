import { expect, test } from 'vitest';
import { vectorNetworkToSvg } from '../src/vectors/svg.js';

test('converts a closed Figma vector-network into a portable SVG', () => {
  const bytes = new Uint8Array(12 + 3 * 12 + 3 * 28 + 8 + 4 + 3 * 4);
  const view = new DataView(bytes.buffer);
  let offset = 0;
  view.setUint32(offset, 3, true); offset += 4;
  view.setUint32(offset, 3, true); offset += 4;
  view.setUint32(offset, 1, true); offset += 4;
  for (const [x, y] of [[0, 0], [24, 0], [12, 18]]) {
    view.setUint32(offset, 0, true); offset += 4;
    view.setFloat32(offset, x, true); offset += 4;
    view.setFloat32(offset, y, true); offset += 4;
  }
  for (const [start, end] of [[0, 1], [1, 2], [2, 0]]) {
    view.setUint32(offset, 0, true); offset += 4;
    view.setUint32(offset, start, true); offset += 4;
    view.setFloat32(offset, 0, true); offset += 4;
    view.setFloat32(offset, 0, true); offset += 4;
    view.setUint32(offset, end, true); offset += 4;
    view.setFloat32(offset, 0, true); offset += 4;
    view.setFloat32(offset, 0, true); offset += 4;
  }
  view.setUint32(offset, 0, true); offset += 4;
  view.setUint32(offset, 1, true); offset += 4;
  view.setUint32(offset, 3, true); offset += 4;
  for (const index of [0, 1, 2]) { view.setUint32(offset, index, true); offset += 4; }

  expect(vectorNetworkToSvg(bytes, { x: 24, y: 18 })).toBe(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 18"><path d="M 0 0 L 24 0 L 12 18 L 0 0 Z" fill="currentColor" fill-rule="evenodd"/></svg>'
  );
});

test('rejects malformed vector-network bytes instead of producing invalid SVG', () => {
  expect(vectorNetworkToSvg(Uint8Array.from([1, 2, 3]), { x: 1, y: 1 })).toBeUndefined();
});

test('fits vector geometry that exceeds the declared node size inside the SVG viewBox', () => {
  const bytes = new Uint8Array(12 + 2 * 12 + 28);
  const view = new DataView(bytes.buffer);
  let offset = 0;
  view.setUint32(offset, 2, true); offset += 4;
  view.setUint32(offset, 1, true); offset += 4;
  view.setUint32(offset, 0, true); offset += 4;
  for (const [x, y] of [[0, 0], [24, 24]]) {
    view.setUint32(offset, 0, true); offset += 4;
    view.setFloat32(offset, x, true); offset += 4;
    view.setFloat32(offset, y, true); offset += 4;
  }
  view.setUint32(offset, 0, true); offset += 4;
  view.setUint32(offset, 0, true); offset += 4;
  view.setFloat32(offset, 0, true); offset += 4;
  view.setFloat32(offset, 0, true); offset += 4;
  view.setUint32(offset, 1, true); offset += 4;
  view.setFloat32(offset, 0, true); offset += 4;
  view.setFloat32(offset, 0, true);

  expect(vectorNetworkToSvg(bytes, { x: 16, y: 16 })).toContain('d="M 0 0 L 16 16"');
});

test('preserves disconnected segments when a vector network has no regions', () => {
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

  const svg = vectorNetworkToSvg(bytes, { x: 16, y: 16 });

  expect(svg).toContain('M 0 0 L 16 16');
  expect(svg).toContain('M 16 0 L 0 16');
});

test('preserves separate regions and uses evenodd fill for holes', () => {
  const bytes = new Uint8Array(12 + 4 * 12 + 4 * 28 + 2 * (8 + 4 + 4 * 4));
  const view = new DataView(bytes.buffer);
  let offset = 0;
  view.setUint32(offset, 4, true); offset += 4;
  view.setUint32(offset, 4, true); offset += 4;
  view.setUint32(offset, 2, true); offset += 4;
  for (const [x, y] of [[0, 0], [20, 0], [20, 20], [0, 20]]) {
    view.setUint32(offset, 0, true); offset += 4;
    view.setFloat32(offset, x, true); offset += 4;
    view.setFloat32(offset, y, true); offset += 4;
  }
  for (const [start, end] of [[0, 1], [1, 2], [2, 3], [3, 0]]) {
    view.setUint32(offset, 0, true); offset += 4;
    view.setUint32(offset, start, true); offset += 4;
    view.setFloat32(offset, 0, true); offset += 4;
    view.setFloat32(offset, 0, true); offset += 4;
    view.setUint32(offset, end, true); offset += 4;
    view.setFloat32(offset, 0, true); offset += 4;
    view.setFloat32(offset, 0, true); offset += 4;
  }
  for (const indices of [[0, 1, 2, 3], [0, 1, 2, 3]]) {
    view.setUint32(offset, 0, true); offset += 4;
    view.setUint32(offset, 1, true); offset += 4;
    view.setUint32(offset, indices.length, true); offset += 4;
    for (const index of indices) { view.setUint32(offset, index, true); offset += 4; }
  }

  const svg = vectorNetworkToSvg(bytes, { x: 20, y: 20 });
  expect(svg?.match(/fill-rule="evenodd"/g)).toHaveLength(2);
  expect(svg?.match(/<path /g)).toHaveLength(2);
});

test('reconnects region segments when the vector network loop is unordered', () => {
  const bytes = new Uint8Array(12 + 3 * 12 + 3 * 28 + 8 + 4 + 3 * 4);
  const view = new DataView(bytes.buffer);
  let offset = 0;
  view.setUint32(offset, 3, true); offset += 4;
  view.setUint32(offset, 3, true); offset += 4;
  view.setUint32(offset, 1, true); offset += 4;
  for (const [x, y] of [[0, 0], [24, 0], [12, 18]]) {
    view.setUint32(offset, 0, true); offset += 4;
    view.setFloat32(offset, x, true); offset += 4;
    view.setFloat32(offset, y, true); offset += 4;
  }
  for (const [start, end] of [[0, 1], [1, 2], [2, 0]]) {
    view.setUint32(offset, 0, true); offset += 4;
    view.setUint32(offset, start, true); offset += 4;
    view.setFloat32(offset, 0, true); offset += 4;
    view.setFloat32(offset, 0, true); offset += 4;
    view.setUint32(offset, end, true); offset += 4;
    view.setFloat32(offset, 0, true); offset += 4;
    view.setFloat32(offset, 0, true); offset += 4;
  }
  view.setUint32(offset, 0, true); offset += 4;
  view.setUint32(offset, 1, true); offset += 4;
  view.setUint32(offset, 3, true); offset += 4;
  for (const index of [1, 0, 2]) { view.setUint32(offset, index, true); offset += 4; }

  expect(vectorNetworkToSvg(bytes, { x: 24, y: 18 })).toContain(
    'd="M 24 0 L 12 18 L 0 0 L 24 0 Z"'
  );
});

test('exports outline vector styles as strokes instead of filled paths', () => {
  const bytes = new Uint8Array(12 + 2 * 12 + 1 * 28 + 8 + 4 + 2 * 4);
  const view = new DataView(bytes.buffer);
  let offset = 0;
  view.setUint32(offset, 2, true); offset += 4;
  view.setUint32(offset, 1, true); offset += 4;
  view.setUint32(offset, 1, true); offset += 4;
  for (const [x, y] of [[0, 0], [10, 0]]) {
    view.setUint32(offset, 0, true); offset += 4;
    view.setFloat32(offset, x, true); offset += 4;
    view.setFloat32(offset, y, true); offset += 4;
  }
  view.setUint32(offset, 0, true); offset += 4;
  view.setUint32(offset, 0, true); offset += 4;
  view.setFloat32(offset, 0, true); offset += 4;
  view.setFloat32(offset, 0, true); offset += 4;
  view.setUint32(offset, 1, true); offset += 4;
  view.setFloat32(offset, 0, true); offset += 4;
  view.setFloat32(offset, 0, true); offset += 4;
  view.setUint32(offset, 0, true); offset += 4;
  view.setUint32(offset, 1, true); offset += 4;
  view.setUint32(offset, 1, true); offset += 4;
  view.setUint32(offset, 0, true);

  expect(vectorNetworkToSvg(bytes, { x: 10, y: 10 }, {
    fills: null,
    strokes: [{}],
    strokeWeight: 1.8,
    strokeCap: 'ROUND',
    strokeJoin: 'ROUND'
  })).toContain('fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"');
});

test('uses rounded stroke geometry when Figma provides vector corner radius', () => {
  const bytes = new Uint8Array(12 + 2 * 12 + 1 * 28 + 8 + 4 + 2 * 4);
  const view = new DataView(bytes.buffer);
  let offset = 0;
  view.setUint32(offset, 2, true); offset += 4;
  view.setUint32(offset, 1, true); offset += 4;
  view.setUint32(offset, 0, true); offset += 4;
  for (const [x, y] of [[0, 0], [10, 0]]) {
    view.setUint32(offset, 0, true); offset += 4;
    view.setFloat32(offset, x, true); offset += 4;
    view.setFloat32(offset, y, true); offset += 4;
  }
  view.setUint32(offset, 0, true); offset += 4;
  view.setUint32(offset, 0, true); offset += 4;
  view.setFloat32(offset, 0, true); offset += 4;
  view.setFloat32(offset, 0, true); offset += 4;
  view.setUint32(offset, 1, true); offset += 4;
  view.setFloat32(offset, 0, true); offset += 4;
  view.setFloat32(offset, 0, true); offset += 4;
  const svg = vectorNetworkToSvg(bytes, { x: 10, y: 10 }, {
    strokes: [{}],
    strokeWeight: 1.4,
    cornerRadius: 2
  });
  expect(svg).toContain('stroke-linecap="round" stroke-linejoin="round"');
});

test('corner radius overrides inherited miter joins for rounded Figma vectors', () => {
  const bytes = new Uint8Array(12 + 2 * 12 + 1 * 28 + 8 + 4 + 2 * 4);
  const view = new DataView(bytes.buffer);
  let offset = 0;
  view.setUint32(offset, 2, true); offset += 4;
  view.setUint32(offset, 1, true); offset += 4;
  view.setUint32(offset, 0, true); offset += 4;
  for (const [x, y] of [[0, 0], [10, 0]]) {
    view.setUint32(offset, 0, true); offset += 4;
    view.setFloat32(offset, x, true); offset += 4;
    view.setFloat32(offset, y, true); offset += 4;
  }
  view.setUint32(offset, 0, true); offset += 4;
  view.setUint32(offset, 0, true); offset += 4;
  view.setFloat32(offset, 0, true); offset += 4;
  view.setFloat32(offset, 0, true); offset += 4;
  view.setUint32(offset, 1, true); offset += 4;
  view.setFloat32(offset, 0, true); offset += 4;
  view.setFloat32(offset, 0, true); offset += 4;
  const svg = vectorNetworkToSvg(bytes, { x: 10, y: 10 }, {
    strokes: [{}],
    strokeWeight: 1.4,
    strokeJoin: 'MITER',
    cornerRadius: 2
  });
  expect(svg).toContain('stroke-linejoin="round"');
});

test('preserves standalone segments outside filled region loops', () => {
  const bytes = new Uint8Array(12 + 12 * 12 + 6 * 28 + 8 + 4 + 4 * 4);
  const view = new DataView(bytes.buffer);
  let offset = 0;
  view.setUint32(offset, 12, true); offset += 4;
  view.setUint32(offset, 6, true); offset += 4;
  view.setUint32(offset, 1, true); offset += 4;
  const vertices = [
    [0, 0], [10, 0], [10, 10], [0, 10],
    [20, 20], [30, 20], [20, 30], [30, 30],
    [2, 2], [2, 8], [8, 2], [8, 8]
  ];
  for (const [x, y] of vertices) {
    view.setUint32(offset, 0, true); offset += 4;
    view.setFloat32(offset, x, true); offset += 4;
    view.setFloat32(offset, y, true); offset += 4;
  }
  const segments = [
    [0, 1], [1, 2], [2, 3], [3, 0],
    [8, 9], [10, 11]
  ];
  for (const [start, end] of segments) {
    view.setUint32(offset, 0, true); offset += 4;
    view.setUint32(offset, start, true); offset += 4;
    view.setFloat32(offset, 0, true); offset += 4;
    view.setFloat32(offset, 0, true); offset += 4;
    view.setUint32(offset, end, true); offset += 4;
    view.setFloat32(offset, 0, true); offset += 4;
    view.setFloat32(offset, 0, true); offset += 4;
  }
  view.setUint32(offset, 0, true); offset += 4;
  view.setUint32(offset, 1, true); offset += 4;
  view.setUint32(offset, 4, true); offset += 4;
  for (const index of [0, 1, 2, 3]) { view.setUint32(offset, index, true); offset += 4; }

  const svg = vectorNetworkToSvg(bytes, { x: 30, y: 30 });
  expect(svg).toContain('M 2 2 L 2 8');
  expect(svg).toContain('M 8 2 L 8 8');
});
