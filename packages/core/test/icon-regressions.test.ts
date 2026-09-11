import { expect, test } from 'vitest';
import { expandLocalInstances, normalizeDocument } from '../src/normalize/document.js';
import { vectorNetworkToSvg } from '../src/vectors/svg.js';

test('instance property swaps replace default icons without leaking between instances', () => {
  const guid = (localID: number) => ({ sessionID: 1, localID });
  const document = normalizeDocument([
    { guid: guid(1), type: 'SYMBOL' },
    { guid: guid(2), type: 'INSTANCE', parentIndex: 0, symbolData: { symbolID: guid(3) }, componentPropRefs: [{ defID: guid(8), componentPropNodeField: 'OVERRIDDEN_SYMBOL_ID' }] },
    { guid: guid(3), type: 'SYMBOL' },
    { guid: guid(4), type: 'VECTOR', parentIndex: 2 },
    { guid: guid(5), type: 'SYMBOL' },
    { guid: guid(6), type: 'VECTOR', parentIndex: 4 },
    { guid: guid(7), type: 'INSTANCE', symbolData: { symbolID: guid(1) }, componentPropAssignments: [{ defID: guid(8), varValue: { value: { symbolIdValue: { guid: guid(5) } } } }] },
    { guid: guid(9), type: 'INSTANCE', symbolData: { symbolID: guid(1) } }
  ]);
  const expanded = expandLocalInstances(document);
  expect(expanded.nodesById['1:7::1:2'].resolvedComponentId).toBe('1:5');
  expect(expanded.nodesById['1:7::1:2'].resolvedChildIds).toEqual(['1:7::1:2::1:6']);
  expect(expanded.nodesById['1:9::1:2'].resolvedComponentId).toBe('1:3');
});

test('branched open vectors retain every arrowhead segment', () => {
  const bytes = new Uint8Array(12 + 4 * 12 + 3 * 28);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 4, true); view.setUint32(4, 3, true);
  [[0, 5], [5, 5], [10, 0], [10, 10]].forEach(([x, y], i) => {
    view.setFloat32(16 + i * 12, x, true); view.setFloat32(20 + i * 12, y, true);
  });
  [[0, 1], [1, 2], [1, 3]].forEach(([start, end], i) => {
    view.setUint32(64 + i * 28, start, true); view.setUint32(76 + i * 28, end, true);
  });
  const svg = vectorNetworkToSvg(bytes, { x: 10, y: 10 }, { strokes: [{}] });
  expect(svg?.match(/ L /g)).toHaveLength(3);
  expect(svg).toContain('M 5 5 L 10 10');
});

test('preserves round caps and joins from the source vector', () => {
  const normalized = normalizeDocument([{ guid: { sessionID: 7, localID: 1 }, type: 'VECTOR', strokeCap: 'ROUND', strokeJoin: 'ROUND' }]);
  expect(normalized.nodesById['7:1']).toMatchObject({ strokeCap: 'ROUND', strokeJoin: 'ROUND' });
});
