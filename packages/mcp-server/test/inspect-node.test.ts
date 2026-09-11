import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { expect, test } from 'vitest';

test('loads inspect_node and returns a bounded summary', async () => {
  const root = await mkdtemp(join(tmpdir(), 'figctx-mcp-'));
  const bundle = join(root, 'bundle');
  await mkdir(join(bundle, 'tokens'), { recursive: true });
  await Promise.all([
    writeFile(join(bundle, 'manifest.json'), '{}'),
    writeFile(join(bundle, 'document.agent.json'), JSON.stringify({ contractVersion: '1', rootIds: ['1:1'], nodesById: {
      '1:1': { id: '1:1', name: 'Frame', type: 'FRAME', childIds: ['1:2'], zIndex: 0, assetRefs: [] },
      '1:2': { id: '1:2', name: 'Text', type: 'TEXT', parentId: '1:1', childIds: [], zIndex: 1, assetRefs: [] }
    } })),
    ...['colors', 'typography', 'effects'].map((name) => writeFile(join(bundle, `tokens/${name}.json`), JSON.stringify({ tokens: [] }))),
    writeFile(join(bundle, 'tokens/fonts.json'), JSON.stringify({ fonts: [] }))
  ]);

  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../dist/main.js', import.meta.url)), '--root', bundle], stderr: 'pipe' });
  const client = new Client({ name: 'figctx-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual([
      'list_frames', 'list_frame_summaries', 'search_nodes', 'get_node_context', 'get_frame_bundle',
      'review_visual_match', 'get_vector_svg', 'get_style_tokens', 'get_asset', 'inspect_node'
    ]);
    const result = await client.callTool({ name: 'inspect_node', arguments: { reference: '1:1', depth: 0, maxChildren: 1 } });
    const content = result.content[0] as { type: string; text: string };
    expect(JSON.parse(content.text)).toMatchObject({ limits: { depth: 0, maxChildren: 1 }, selection: { id: '1:1', children: [] }, omitted: ['node 1:1: 1 children omitted by depth limit (0)'] });
  } finally {
    await client.close();
    await rm(root, { recursive: true, force: true });
  }
});
test('resolves nodes across peer bundles in the parent directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'figctx-mcp-peer-'));
  const primaryBundle = join(root, 'primary');
  const peerBundle = join(root, 'design-system');
  await mkdir(join(primaryBundle, 'tokens'), { recursive: true });
  await mkdir(join(peerBundle, 'tokens'), { recursive: true });
  await Promise.all([
    writeFile(join(primaryBundle, 'manifest.json'), JSON.stringify({ originFileKey: 'primary-key' })),
    writeFile(join(primaryBundle, 'document.agent.json'), JSON.stringify({ contractVersion: '1', rootIds: ['1:1'], nodesById: {
      '1:1': { id: '1:1', name: 'PrimaryFrame', type: 'FRAME', childIds: [], zIndex: 0, assetRefs: [] }
    } })),
    ...['colors', 'typography', 'effects'].map((name) => writeFile(join(primaryBundle, `tokens/${name}.json`), JSON.stringify({ tokens: [] }))),
    writeFile(join(primaryBundle, 'tokens/fonts.json'), JSON.stringify({ fonts: [] })),
    writeFile(join(peerBundle, 'manifest.json'), JSON.stringify({ originFileKey: 'peer-library-key' })),
    writeFile(join(peerBundle, 'document.agent.json'), JSON.stringify({ contractVersion: '1', originFileKey: 'peer-library-key', rootIds: ['101:15798'], nodesById: {
      '101:15798': { id: '101:15798', name: 'StarIcon', type: 'SYMBOL', childIds: [], zIndex: 0, assetRefs: [] }
    } })),
    ...['colors', 'typography', 'effects'].map((name) => writeFile(join(peerBundle, `tokens/${name}.json`), JSON.stringify({ tokens: [] }))),
    writeFile(join(peerBundle, 'tokens/fonts.json'), JSON.stringify({ fonts: [] }))
  ]);

  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../dist/main.js', import.meta.url)), '--root', primaryBundle], stderr: 'pipe' });
  const client = new Client({ name: 'figctx-peer-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    const result = await client.callTool({ name: 'inspect_node', arguments: { reference: '101:15798' } });
    const content = result.content[0] as { type: string; text: string };
    expect(JSON.parse(content.text)).toMatchObject({ selection: { id: '101:15798', name: 'StarIcon', type: 'SYMBOL' } });
  } finally {
    await client.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('cross-bundle component index enriches inspect_node and enables componentKey lookup and vector fallback', async () => {
  const root = await mkdtemp(join(tmpdir(), 'figctx-mcp-index-'));
  const primaryBundle = join(root, 'primary');
  const peerBundle = join(root, 'design-system');
  await mkdir(join(primaryBundle, 'tokens'), { recursive: true });
  await mkdir(join(peerBundle, 'tokens'), { recursive: true });
  await mkdir(join(peerBundle, 'assets/images'), { recursive: true });
  await writeFile(join(peerBundle, 'assets/images/0123456789abcdef0123456789abcdef01234567.png'), 'fake-png-bytes');

  await Promise.all([
    writeFile(join(primaryBundle, 'manifest.json'), JSON.stringify({ originFileKey: 'primary-key' })),
    writeFile(join(primaryBundle, 'document.agent.json'), JSON.stringify({
      contractVersion: '1',
      rootIds: ['1:1'],
      nodesById: {
        '1:1': { id: '1:1', name: 'Page', type: 'FRAME', childIds: ['1:2'], zIndex: 0, assetRefs: [] },
        '1:2': {
          id: '1:2', name: 'ChevronButton', type: 'INSTANCE', parentId: '1:1', childIds: ['1:3'], zIndex: 1,
          main_component_id: '9:4115', assetRefs: [], resolvedChildIds: ['1:3']
        },
        '1:3': { id: '1:3', name: 'Vector', type: 'VECTOR', parentId: '1:2', childIds: [], zIndex: 2, assetRefs: [] },
        '9:4115': {
          id: '9:4115', name: 'Chevron', type: 'SYMBOL', childIds: ['9:4116'], zIndex: 3,
          sourceLibraryKey: 'peer-library-key', componentKey: 'chevron-key-40hex', assetRefs: []
        },
        '9:4116': { id: '9:4116', name: 'Vector', type: 'VECTOR', parentId: '9:4115', childIds: [], zIndex: 4, assetRefs: [] }
      }
    })),
    ...['colors', 'typography', 'effects'].map((name) => writeFile(join(primaryBundle, `tokens/${name}.json`), JSON.stringify({ tokens: [] }))),
    writeFile(join(primaryBundle, 'tokens/fonts.json'), JSON.stringify({ fonts: [] })),

    writeFile(join(peerBundle, 'manifest.json'), JSON.stringify({ originFileKey: 'peer-library-key' })),
    writeFile(join(peerBundle, 'vector.svg'), '<svg viewBox="0 0 24 24"><path d="M 0 0 L 24 24 Z" stroke="currentColor"/></svg>'),
    writeFile(join(peerBundle, 'document.agent.json'), JSON.stringify({
      contractVersion: '1',
      originFileKey: 'peer-library-key',
      rootIds: ['2539:2562'],
      nodesById: {
        '2539:2562': {
          id: '2539:2562', name: 'Chevron', type: 'FRAME', childIds: ['2539:2563'], zIndex: 0,
          bounds: { x: 24, y: 24 }, componentKey: 'chevron-key-40hex', assetRefs: []
        },
        '2539:2563': {
          id: '2539:2563', name: 'Vector', type: 'VECTOR', parentId: '2539:2562', childIds: [], zIndex: 1,
          bounds: { x: 24, y: 24 }, strokes: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0 } }],
          vectorRef: { blobId: 230, path: 'vector.bin.gz', svgPath: 'vector.svg', format: 'kiwi-vector-network', compression: 'gzip' },
          assetRefs: []
        }
      }
    })),
    ...['colors', 'typography', 'effects'].map((name) => writeFile(join(peerBundle, `tokens/${name}.json`), JSON.stringify({ tokens: [] }))),
    writeFile(join(peerBundle, 'tokens/fonts.json'), JSON.stringify({ fonts: [] }))
  ]);

  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../dist/main.js', import.meta.url)), '--root', primaryBundle], stderr: 'pipe' });
  const client = new Client({ name: 'figctx-index-test', version: '1.0.0' });
  try {
    await client.connect(transport);

    // 1. inspect_node on shell instance 1:2 returns externalComponent with peer component info
    const inspectRes = await client.callTool({ name: 'inspect_node', arguments: { reference: '1:2' } });
    const inspectJson = JSON.parse((inspectRes.content[0] as { text: string }).text);
    expect(inspectJson.externalComponent).toMatchObject({
      componentKey: 'chevron-key-40hex',
      sourceLibraryKey: 'peer-library-key',
      originFileKey: 'peer-library-key',
      nodeId: '2539:2562',
      name: 'Chevron',
      hasVectors: true,
      isExternal: true
    });
    expect(inspectJson.externalComponent.resolvedPeerComponent).toMatchObject({
      id: '2539:2562',
      name: 'Chevron'
    });

    // 2. search_nodes with componentKey directly finds the peer component
    const searchRes = await client.callTool({ name: 'search_nodes', arguments: { query: 'chevron-key-40hex' } });
    const searchJson = JSON.parse((searchRes.content[0] as { text: string }).text);
    expect(searchJson).toEqual([
      expect.objectContaining({
        id: '2539:2562',
        name: 'Chevron',
        componentKey: 'chevron-key-40hex',
        library: 'peer-library-key',
        hasVectors: true
      })
    ]);

    // 3. inspect_node with comp:<componentKey> directly inspects the peer component
    const directRes = await client.callTool({ name: 'inspect_node', arguments: { reference: 'comp:chevron-key-40hex' } });
    const directJson = JSON.parse((directRes.content[0] as { text: string }).text);
    expect(directJson.selection).toMatchObject({
      id: '2539:2562',
      name: 'Chevron'
    });

    // 4. get_vector_svg on shell instance 1:2 automatically resolves vector from peer bundle
    const svgRes = await client.callTool({ name: 'get_vector_svg', arguments: { reference: '1:2' } });
    const svgJson = JSON.parse((svgRes.content[0] as { text: string }).text);
    expect(svgJson.svg).toContain('viewBox="0 0 24 24"');
    expect(svgJson.svg).toContain('stroke="#ff0000"');
    expect(svgJson.nodeId).toBe('2539:2562');

    // 5. get_asset automatically falls back to peer bundle when not in primary bundle
    const assetRes = await client.callTool({ name: 'get_asset', arguments: { hash: '0123456789abcdef0123456789abcdef01234567' } });
    const assetJson = JSON.parse((assetRes.content[0] as { text: string }).text);
    expect(assetJson).toMatchObject({
      hash: '0123456789abcdef0123456789abcdef01234567',
      peerLibrary: 'peer-library-key'
    });
    expect(assetJson.path).toBe('assets/images/0123456789abcdef0123456789abcdef01234567.png');
  } finally {
    await client.close();
    await rm(root, { recursive: true, force: true });
  }
});
