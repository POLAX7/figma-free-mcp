import { describe, expect, test } from 'vitest';
import { buildNodeContext } from '../src/context/node-context.js';

describe('buildNodeContext vector groups', () => {
  test('keeps binary-only vectors because bundle rendering can hydrate their SVG', () => {
    const document = {
      contractVersion: '1' as const,
      rootIds: ['1:1'],
      nodesById: {
        '1:1': { id: '1:1', name: 'Icon', type: 'FRAME', childIds: ['1:2'], zIndex: 0, bounds: { x: 24, y: 24 }, assetRefs: [] },
        '1:2': {
          id: '1:2', name: 'Vector', type: 'VECTOR', parentId: '1:1', childIds: [], zIndex: 1,
          bounds: { x: 24, y: 24 }, assetRefs: [],
          vectorRef: { blobId: 7, path: 'assets/vectors/vector-network-7.bin.gz', format: 'kiwi-vector-network' as const, compression: 'gzip' as const }
        }
      }
    };

    const context = buildNodeContext(document, document.nodesById['1:1']);

    expect(context.vectorGroups).toHaveLength(1);
    expect(context.vectorGroups[0]?.nodeId).toBe('1:1');
  });
});
