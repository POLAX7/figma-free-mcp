import { describe, expect, test } from 'vitest';
import { effectiveChildIds, expandLocalInstances, hashToHex, normalizeDocument, resolveNodeReference } from '../src/normalize/document.js';
import { buildNodeContext } from '../src/context/node-context.js';
import { inspectNode } from '../src/context/inspect-node.js';

const document = normalizeDocument([
  { guid: { sessionID: 1, localID: 1 }, type: 'DOCUMENT', name: 'Document' },
  { guid: { sessionID: 1, localID: 2 }, type: 'FRAME', name: 'Hero', parentIndex: 0, size: { x: 100, y: 50 } },
  { guid: { sessionID: 1, localID: 3 }, type: 'TEXT', name: 'Title', parentIndex: 1, textData: { characters: 'Hello' } }
]);

describe('normalized document', () => {
  test('exposes stable component metadata and resolved child access', () => {
    const normalized = normalizeDocument([
      { guid: { sessionID: 10, localID: 1 }, type: 'INSTANCE', name: 'Alert', symbolData: { symbolID: { sessionID: 20, localID: 1 } } },
      { guid: { sessionID: 20, localID: 1 }, type: 'SYMBOL', name: 'Alert Variant' },
      { guid: { sessionID: 20, localID: 2 }, type: 'TEXT', name: 'Title', parentIndex: 1, textData: { characters: 'Title' } }
    ]);
    const expanded = expandLocalInstances(normalized);
    const instance = expanded.nodesById['10:1']!;
    expect(instance.node_id).toBe('10:1');
    expect(instance.main_component_id).toBe('20:1');
    expect(effectiveChildIds(instance)).toEqual(instance.resolvedChildIds);
  });

  test('stops nested expansion when a component cycle is encountered', () => {
    const normalized = normalizeDocument([
      { guid: { sessionID: 1, localID: 1 }, type: 'INSTANCE', name: 'A', symbolData: { symbolID: { sessionID: 2, localID: 1 } } },
      { guid: { sessionID: 2, localID: 1 }, type: 'SYMBOL', name: 'A Symbol' },
      { guid: { sessionID: 2, localID: 2 }, type: 'INSTANCE', name: 'B', parentIndex: 1, symbolData: { symbolID: { sessionID: 2, localID: 1 } } }
    ]);
    const expanded = expandLocalInstances(normalized);
    expect(Object.keys(expanded.nodesById).length).toBeLessThan(20);
  });

  test('reports component identity and expansion state in bounded inspection', () => {
    const normalized = normalizeDocument([
      { guid: { sessionID: 30, localID: 1 }, type: 'INSTANCE', symbolData: { symbolID: { sessionID: 40, localID: 1 } } },
      { guid: { sessionID: 40, localID: 1 }, type: 'SYMBOL' },
      { guid: { sessionID: 40, localID: 2 }, type: 'TEXT', parentIndex: 1, textData: { characters: 'Label' } }
    ]);
    const node = expandLocalInstances(normalized).nodesById['30:1']!;
    expect(inspectNode(expandLocalInstances(normalized), node).selection.component).toEqual({ type: 'INSTANCE', mainComponentId: '40:1', expanded: true });
  });

  test('expands an empty instance from its local symbol definition without changing raw children', () => {
    const normalized = normalizeDocument([
      { guid: { sessionID: 10, localID: 1 }, type: 'INSTANCE', name: 'Alert', symbolData: { symbolID: { sessionID: 20, localID: 1 }, symbolOverrides: [{ textData: { characters: '刪除範本' } }, { textData: { characters: '刪除範本後將無法再恢復，確定要刪除嗎？' } }, { textData: { characters: '刪除' } }] } },
      { guid: { sessionID: 20, localID: 1 }, type: 'SYMBOL', name: 'Alert Variant', parentIndex: undefined },
      { guid: { sessionID: 20, localID: 2 }, type: 'TEXT', name: 'Title', parentIndex: 1, textData: { characters: 'Title here' } },
      { guid: { sessionID: 20, localID: 3 }, type: 'TEXT', name: 'Description', parentIndex: 1, textData: { characters: 'Content here' } },
      { guid: { sessionID: 20, localID: 4 }, type: 'TEXT', name: 'Button', parentIndex: 1, textData: { characters: 'Button here' } }
    ]);

    const expanded = expandLocalInstances(normalized);
    const instance = expanded.nodesById['10:1']!;
    expect(instance.childIds).toEqual([]);
    expect(instance.resolvedChildIds).toHaveLength(3);
    expect(instance.resolvedComponentId).toBe('20:1');
    expect(instance.resolvedChildIds.map((id) => expanded.nodesById[id]!.text)).toEqual(['刪除範本', '刪除範本後將無法再恢復，確定要刪除嗎？', '刪除']);
  });

  test('applies remaining instance text overrides to nested component text', () => {
    const normalized = normalizeDocument([
      { guid: { sessionID: 11, localID: 1 }, type: 'INSTANCE', name: 'Alert', symbolData: { symbolID: { sessionID: 21, localID: 1 }, symbolOverrides: [{ textData: { characters: '標題' } }, { textData: { characters: '主按鈕' } }] } },
      { guid: { sessionID: 21, localID: 1 }, type: 'SYMBOL', name: 'Alert Variant', parentIndex: undefined },
      { guid: { sessionID: 21, localID: 2 }, type: 'TEXT', name: 'Title', parentIndex: 1, textData: { characters: 'Title here' } },
      { guid: { sessionID: 21, localID: 3 }, type: 'INSTANCE', name: 'Button', parentIndex: 1, symbolData: { symbolID: { sessionID: 31, localID: 1 }, symbolOverrides: [] } },
      { guid: { sessionID: 31, localID: 1 }, type: 'SYMBOL', name: 'Button Variant', parentIndex: undefined },
      { guid: { sessionID: 31, localID: 2 }, type: 'TEXT', name: 'Label', parentIndex: 4, textData: { characters: 'Confirm' } }
    ]);

    const expanded = expandLocalInstances(normalized);
    const texts: string[] = [];
    const visit = (id: string) => { const node = expanded.nodesById[id]!; if (node.text !== undefined) texts.push(node.text); for (const childId of node.resolvedChildIds ?? node.childIds) visit(childId); };
    for (const id of expanded.nodesById['11:1']!.resolvedChildIds ?? []) visit(id);
    expect(texts).toEqual(['標題', '主按鈕']);
  });

  test('maps text overrides by their guidPath target instead of array order', () => {
    const normalized = normalizeDocument([
      { guid: { sessionID: 50, localID: 1 }, type: 'INSTANCE', symbolData: { symbolID: { sessionID: 60, localID: 1 }, symbolOverrides: [
        { guidPath: { guids: [{ sessionID: 60, localID: 3 }] }, textData: { characters: 'Description override' } },
        { guidPath: { guids: [{ sessionID: 60, localID: 2 }] }, textData: { characters: 'Title override' } }
      ] } },
      { guid: { sessionID: 60, localID: 1 }, type: 'SYMBOL' },
      { guid: { sessionID: 60, localID: 2 }, type: 'TEXT', name: 'Title', parentIndex: 1, textData: { characters: 'Title' } },
      { guid: { sessionID: 60, localID: 3 }, type: 'TEXT', name: 'Description', parentIndex: 1, textData: { characters: 'Description' } }
    ]);
    const expanded = expandLocalInstances(normalized);
    const instance = expanded.nodesById['50:1']!;
    const texts = (instance.resolvedChildIds ?? []).map((id) => expanded.nodesById[id]!.text);
    expect(texts).toEqual(['Title override', 'Description override']);
  });

  test('scopes identical component child IDs independently for each instance', () => {
    const normalized = normalizeDocument([
      { guid: { sessionID: 70, localID: 1 }, type: 'INSTANCE', symbolData: { symbolID: { sessionID: 80, localID: 1 } } },
      { guid: { sessionID: 70, localID: 2 }, type: 'INSTANCE', symbolData: { symbolID: { sessionID: 80, localID: 1 } } },
      { guid: { sessionID: 80, localID: 1 }, type: 'SYMBOL' },
      { guid: { sessionID: 80, localID: 2 }, type: 'TEXT', parentIndex: 2, textData: { characters: 'Shared' } }
    ]);
    const expanded = expandLocalInstances(normalized);
    const first = expanded.nodesById['70:1']!.resolvedChildIds ?? [];
    const second = expanded.nodesById['70:2']!.resolvedChildIds ?? [];
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(first[0]).not.toBe(second[0]);
    expect(new Set(Object.keys(expanded.nodesById)).size).toBe(Object.keys(expanded.nodesById).length);
  });

  test('builds stable IDs, hierarchy, and text context', () => {
    expect(document.nodesById['1:2']).toMatchObject({ id: '1:2', type: 'FRAME', childIds: ['1:3'] });
    expect(document.nodesById['1:3']).toMatchObject({ text: 'Hello', parentId: '1:2' });
  });

  test.each(['1:3', '1-3', 'https://www.figma.com/design/file/name?node-id=1-3'])
  ('resolves %s', (reference) => expect(resolveNodeReference(document, reference).id).toBe('1:3'));

  test('resolves expanded instance child reference with ::', () => {
    const doc = {
      contractVersion: '1' as const,
      rootIds: ['1:1'],
      nodesById: {
        '1:1::1:2': { id: '1:1::1:2', name: 'Child', type: 'RECTANGLE', childIds: [], zIndex: 0, assetRefs: [] }
      }
    };
    expect(resolveNodeReference(doc, '1:1::1:2').id).toBe('1:1::1:2');
    expect(resolveNodeReference(doc, '1-1::1-2').id).toBe('1:1::1:2');
  });

  test('rejects a Figma URL for another file key', () => {
    const keyed = normalizeDocument([], { originFileKey: 'local-file' });
    expect(() => resolveNodeReference(keyed, 'https://www.figma.com/design/other-file/name?node-id=1-3')).toThrow(/bundle is for local-file/);
  });

  test('links an image fill to its extracted asset path', () => {
    const hash = Uint8Array.from({ length: 20 }, (_value, index) => index);
    const normalized = normalizeDocument([{ guid: { sessionID: 2, localID: 4 }, fillPaints: [{ type: 'IMAGE', image: { hash } }] }], { assetPaths: { [hashToHex(hash)!]: 'assets/images/example.png' } });
    expect(normalized.nodesById['2:4']!.assetRefs).toEqual([{ hash: hashToHex(hash), path: 'assets/images/example.png', kind: 'image-fill' }]);
  });

  test('preserves a vector-network blob reference', () => {
    const normalized = normalizeDocument([{ guid: { sessionID: 2, localID: 5 }, vectorData: { vectorNetworkBlob: 7 } }], { vectorPaths: { 7: 'assets/vectors/vector-network-7.bin.gz' }, vectorSvgPaths: { 7: 'assets/vectors/vector-network-7.svg' } });
    expect(normalized.nodesById['2:5']!.vectorRef).toEqual({ blobId: 7, path: 'assets/vectors/vector-network-7.bin.gz', format: 'kiwi-vector-network', compression: 'gzip', svgPath: 'assets/vectors/vector-network-7.svg' });
  });

  test('collects every descendant text and asset for a frame context', () => {
    const normalized = normalizeDocument([
      { guid: { sessionID: 4, localID: 1 }, type: 'FRAME' },
      { guid: { sessionID: 4, localID: 2 }, type: 'TEXT', parentIndex: 0, textData: { characters: 'Nested' } },
      { guid: { sessionID: 4, localID: 3 }, type: 'RECTANGLE', parentIndex: 1, fillPaints: [{ type: 'IMAGE', image: { hash: Uint8Array.from({ length: 20 }, () => 1) } }] }
    ], { assetPaths: { ['01'.repeat(20)]: 'assets/images/nested.png' } });
    const context = buildNodeContext(normalized, normalized.nodesById['4:1']!);
    expect(context.nodeIds).toEqual(['4:1', '4:2', '4:3']);
    expect(context.text).toEqual([expect.objectContaining({ id: '4:2', text: 'Nested' })]);
    expect(context.assets).toEqual([{ hash: '01'.repeat(20), path: 'assets/images/nested.png', kind: 'image-fill' }]);
  });

  test('lists maximal vector groups in a packed node context', () => {
    const normalized = normalizeDocument([
      { guid: { sessionID: 7, localID: 1 }, type: 'FRAME', size: { x: 100, y: 50 } },
      { guid: { sessionID: 7, localID: 2 }, type: 'FRAME', parentIndex: 0, name: 'Artwork', size: { x: 20, y: 10 } },
      { guid: { sessionID: 7, localID: 3 }, type: 'VECTOR', parentIndex: 1, size: { x: 20, y: 10 }, vectorData: { vectorNetworkBlob: 9 } },
      { guid: { sessionID: 7, localID: 4 }, type: 'TEXT', parentIndex: 0, textData: { characters: 'Caption' } }
    ], { vectorPaths: { 9: 'assets/vectors/vector-network-9.bin.gz' }, vectorSvgPaths: { 9: 'assets/vectors/vector-network-9.svg' } });

    expect(buildNodeContext(normalized, normalized.nodesById['7:1']!)).toMatchObject({
      vectorGroups: [{ nodeId: '7:2', name: 'Artwork', bounds: { x: 20, y: 10 }, vectorCount: 1 }]
    });
  });

  test('does not list a group without a vector asset reference', () => {
    const normalized = normalizeDocument([
      { guid: { sessionID: 8, localID: 1 }, type: 'FRAME', size: { x: 20, y: 10 } },
      { guid: { sessionID: 8, localID: 2 }, type: 'VECTOR', parentIndex: 0, size: { x: 20, y: 10 }, vectorData: { vectorNetworkBlob: 1 } }
    ]);

    expect(buildNodeContext(normalized, normalized.nodesById['8:1']!).vectorGroups).toEqual([]);
  });

  test('retains Figma-computed text layout and visibility fields', () => {
    const normalized = normalizeDocument([{ guid: { sessionID: 5, localID: 1 }, type: 'TEXT', visible: false, opacity: 0.6, textData: { characters: 'Measured' }, derivedTextData: { layoutSize: { x: 80, y: 20 }, baselines: [{ position: { x: 0, y: 14 } }], glyphs: [{ commandsBlob: 99 }] } }]);
    expect(normalized.nodesById['5:1']).toMatchObject({ visible: false, opacity: 0.6, textLayout: { layoutSize: { x: 80, y: 20 }, baselines: [{ position: { x: 0, y: 14 } }] } });
    expect(normalized.nodesById['5:1']!.textLayout).not.toHaveProperty('glyphs');
  });

  test('groups text style overrides into resolved character runs', () => {
    const normalized = normalizeDocument([{
      guid: { sessionID: 9, localID: 1 },
      type: 'TEXT',
      textData: {
        characters: 'Hi all',
        characterStyleIDs: [7, 7, 0, 9, 9, 9],
        styleOverrideTable: [
          { styleID: 7, fontName: { family: 'Inter', style: 'Bold' }, fillPaints: [{ type: 'SOLID', color: { r: 1 } }] },
          { styleID: 9, textDecoration: 'UNDERLINE' }
        ]
      },
      fontName: { family: 'Inter', style: 'Regular' },
      fontSize: 16,
      textDecoration: 'NONE'
    }]);

    expect(normalized.nodesById['9:1']!.textSegments).toEqual([
      { start: 0, end: 2, text: 'Hi', styleId: 7, typography: { fontName: { family: 'Inter', style: 'Bold' }, fontSize: 16, textDecoration: 'NONE' }, fills: [{ type: 'SOLID', color: { r: 1 } }] },
      { start: 2, end: 3, text: ' ', styleId: 0, typography: { fontName: { family: 'Inter', style: 'Regular' }, fontSize: 16, textDecoration: 'NONE' } },
      { start: 3, end: 6, text: 'all', styleId: 9, typography: { fontName: { family: 'Inter', style: 'Regular' }, fontSize: 16, textDecoration: 'UNDERLINE' } }
    ]);
  });

  test('retains mask and frame clipping flags for SVG composition', () => {
    const normalized = normalizeDocument([{ guid: { sessionID: 6, localID: 1 }, type: 'FRAME', mask: true, frameMaskDisabled: false }]);
    expect(normalized.nodesById['6:1']).toMatchObject({ mask: true, frameMaskDisabled: false });
  });

  test('preserves sourceLibraryKey and componentKey from external library components', () => {
    const normalized = normalizeDocument([
      {
        guid: { sessionID: 1, localID: 10 },
        type: 'SYMBOL',
        name: 'External Icon',
        sourceLibraryKey: 'lk-external-library-key',
        componentKey: 'comp-uuid-12345'
      }
    ]);
    expect(normalized.nodesById['1:10']).toMatchObject({
      sourceLibraryKey: 'lk-external-library-key',
      componentKey: 'comp-uuid-12345'
    });
  });

  test('applies symbolOverrides for fills, strokes, and size to matched descendant by overrideKey', () => {
    const normalized = normalizeDocument([
      {
        guid: { sessionID: 1522, localID: 58069 },
        type: 'INSTANCE',
        name: 'Star',
        symbolData: {
          symbolID: { sessionID: 40, localID: 13664 },
          symbolOverrides: [
            {
              guidPath: { guids: [{ sessionID: 101, localID: 15797 }] },
              fillPaints: [{ type: 'SOLID', color: { r: 1, g: 0.823529, b: 0.039215 }, visible: true }],
              strokePaints: [{ type: 'SOLID', color: { r: 1, g: 0.647058, b: 0.270588 }, visible: true }]
            }
          ]
        }
      },
      {
        guid: { sessionID: 40, localID: 13664 },
        type: 'SYMBOL',
        name: 'Star Component',
        overrideKey: { sessionID: 101, localID: 15796 }
      },
      {
        guid: { sessionID: 40, localID: 13665 },
        type: 'VECTOR',
        name: 'Vector',
        parentIndex: 1,
        overrideKey: { sessionID: 101, localID: 15797 },
        strokePaints: [{ type: 'SOLID', color: { r: 0.2, g: 0.2, b: 0.2 }, visible: true }]
      }
    ]);

    const expanded = expandLocalInstances(normalized);
    const starInstance = expanded.nodesById['1522:58069']!;
    expect(starInstance.resolvedChildIds).toHaveLength(1);
    const childVector = expanded.nodesById[starInstance.resolvedChildIds![0]!]!;
    expect(childVector.name).toBe('Vector');
    expect(childVector.fills).toEqual([
      { type: 'SOLID', color: { r: 1, g: 0.823529, b: 0.039215 }, visible: true }
    ]);
    expect(childVector.strokes).toEqual([
      { type: 'SOLID', color: { r: 1, g: 0.647058, b: 0.270588 }, visible: true }
    ]);
  });

  test('resolves colorVar variable aliases in fills and strokes to true color value', () => {
    const normalized = normalizeDocument([
      {
        guid: { sessionID: 1522, localID: 58065 },
        type: 'INSTANCE',
        name: 'Star Disabled',
        symbolData: {
          symbolID: { sessionID: 40, localID: 13664 },
          symbolOverrides: [
            {
              guidPath: { guids: [{ sessionID: 101, localID: 15797 }] },
              fillPaints: [{
                type: 'SOLID',
                color: { r: 0.85, g: 0.85, b: 0.85 },
                colorVar: { value: { alias: { assetRef: { key: 'white-var-key', version: '990:1339' } } }, dataType: 'ALIAS', resolvedDataType: 'COLOR' }
              }],
              strokePaints: [{
                type: 'SOLID',
                color: { r: 0.5, g: 0.5, b: 0.5 },
                colorVar: { value: { alias: { assetRef: { key: 'orange-var-key', version: '997:69' } } }, dataType: 'ALIAS', resolvedDataType: 'COLOR' }
              }]
            }
          ]
        }
      },
      {
        guid: { sessionID: 40, localID: 13664 },
        type: 'SYMBOL',
        overrideKey: { sessionID: 101, localID: 15796 }
      },
      {
        guid: { sessionID: 40, localID: 13665 },
        type: 'VECTOR',
        name: 'Vector',
        parentIndex: 1,
        overrideKey: { sessionID: 101, localID: 15797 }
      },
      {
        guid: { sessionID: 9, localID: 1 },
        type: 'VARIABLE',
        name: 'Color/Icon/inverse',
        key: 'white-var-key',
        version: '990:1339',
        variableResolvedType: 'COLOR',
        variableDataValues: {
          entries: [{ modeID: { sessionID: 95, localID: 0 }, variableData: { value: { alias: { assetRef: { key: 'base-white-key' } } }, dataType: 'ALIAS', resolvedDataType: 'COLOR' } }]
        }
      },
      {
        guid: { sessionID: 9, localID: 2 },
        type: 'VARIABLE',
        name: 'System/Base/White',
        key: 'base-white-key',
        variableResolvedType: 'COLOR',
        variableDataValues: {
          entries: [{ modeID: { sessionID: 95, localID: 0 }, variableData: { value: { colorValue: { r: 1, g: 1, b: 1, a: 1 } }, dataType: 'COLOR', resolvedDataType: 'COLOR' } }]
        }
      },
      {
        guid: { sessionID: 9, localID: 3 },
        type: 'VARIABLE',
        name: 'System/Secondary/Orange/400',
        key: 'orange-var-key',
        version: '997:69',
        variableResolvedType: 'COLOR',
        variableDataValues: {
          entries: [{ modeID: { sessionID: 95, localID: 0 }, variableData: { value: { colorValue: { r: 1, g: 0.7137, b: 0.4118, a: 1 } }, dataType: 'COLOR', resolvedDataType: 'COLOR' } }]
        }
      }
    ]);

    const expanded = expandLocalInstances(normalized);
    const star = expanded.nodesById['1522:58065']!;
    const vector = expanded.nodesById[star.resolvedChildIds![0]!]!;
    const fills = vector.fills as Array<{ color: { r: number; g: number; b: number } }>;
    const strokes = vector.strokes as Array<{ color: { r: number; g: number; b: number } }>;
    expect(fills[0]!.color).toEqual({ r: 1, g: 1, b: 1, a: 1 });
    expect(strokes[0]!.color).toEqual({ r: 1, g: 0.7137, b: 0.4118, a: 1 });
  });
});
