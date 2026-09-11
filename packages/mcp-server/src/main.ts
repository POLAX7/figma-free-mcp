#!/usr/bin/env node
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildNodeContext, comparePng, composeBundleVectorGroupSvg, inspectNode, resolveNodeReference, searchNodes, type AgentDocument, type AgentNode } from '@figctx/core';
import { z } from 'zod';
import { pageFrameSummaries } from './frame-summaries.js';
import { buildVisualReview, type ReviewPhase } from './review.js';
import { publicToolNames, publicToolSchemas } from './tool-schemas.js';

const root = argument('--root');
if (!root) throw new Error('Usage: figctx-mcp --root <bundle-directory>');
const bundleRoot = await resolveRootBundle(root);
const document = JSON.parse(await readFile(`${bundleRoot}/document.agent.json`, 'utf8')) as AgentDocument;
const manifest = JSON.parse(await readFile(`${bundleRoot}/manifest.json`, 'utf8')) as Record<string, unknown>;
const tokenFiles = await Promise.all(['colors', 'typography', 'effects'].map(async (name) => [name, JSON.parse(await readFile(`${bundleRoot}/tokens/${name}.json`, 'utf8')) as { tokens: Array<{ nodeIds: string[] }> }] as const));
const fontFile = JSON.parse(await readFile(`${bundleRoot}/tokens/fonts.json`, 'utf8')) as { fonts: Array<{ nodeIds: string[] }> };
const variableFile = await loadVariables();
const referenceIndex = await loadReferences();
const peerBundles = await discoverPeerBundles(bundleRoot);
const componentIndex = await buildComponentIndex(bundleRoot, document, peerBundles);
const server = new McpServer({ name: 'figctx-mcp', version: '0.1.0' });
const text = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] });
server.registerTool(publicToolNames.listFrames, { description: 'List locally extracted frames and canvases (compact, capped at 100).' }, async () => text(Object.values(document.nodesById).filter((n) => n.type === 'FRAME' || n.type === 'CANVAS').slice(0, 100).map((n) => ({ id: n.id, name: n.name, type: n.type, ...(n.bounds === undefined ? {} : { bounds: n.bounds }), childCount: n.childIds.length }))));
server.registerTool(publicToolNames.listFrameSummaries, { description: 'List compact frame and canvas summaries in sequential batches.', inputSchema: publicToolSchemas.list_frame_summaries }, async ({ cursor, limit }) => text(pageFrameSummaries(document, new Set(referenceIndex.references.map((reference) => reference.nodeId)), { cursor, limit })));
server.registerTool(publicToolNames.searchNodes, { description: 'Search local nodes by case-insensitive name, text substring, or componentKey.', inputSchema: publicToolSchemas.search_nodes }, async ({ query, type, limit }) => {
  const cap = limit ?? 20;

  // Direct componentKey lookup
  const cleanKey = query.startsWith('comp:') ? query.slice(5) : query;
  if (componentIndex.has(cleanKey)) {
    const item = componentIndex.get(cleanKey)!;
    return text([{
      id: item.nodeId,
      name: item.name,
      type: item.type,
      componentKey: item.componentKey,
      library: item.sourceBundle,
      hasVectors: item.hasVectors,
      hasImages: item.hasImages,
      matched: ['componentKey'],
      ancestors: []
    }]);
  }

  const primary = searchNodes(document, query, { type, limit: cap });
  if (primary.length >= cap) return text(primary);
  const peerHits = [];
  for (const peer of peerBundles) {
    if (primary.length + peerHits.length >= cap) break;
    try {
      const peerDoc = await loadPeerDoc(peer);
      const hits = searchNodes(peerDoc, query, { type, limit: cap - primary.length - peerHits.length });
      peerHits.push(...hits.map((h) => ({ ...h, library: peer.originFileKey })));
    } catch {}
  }
  return text([...primary, ...peerHits]);
});
server.registerTool(publicToolNames.getNodeContext, { description: 'Resolve a local node ID or Figma URL, including an attached reference PNG if available.', inputSchema: publicToolSchemas.get_node_context }, async ({ reference }) => {
  const { node, references } = await resolveAnyNode(reference);
  return text({ node, reference: references.find((item) => item.nodeId === node.id) });
});
server.registerTool(publicToolNames.getFrameBundle, { description: 'Return complete local subtree context, including descendant text, assets, vectors, style tokens, and attached reference PNGs.', inputSchema: publicToolSchemas.get_frame_bundle }, async ({ reference }) => { const context = buildNodeContext(document, resolveNodeReference(document, reference)); return text({ ...context, tokens: tokensFor(context.nodeIds), references: referenceIndex.references.filter((item) => context.nodeIds.includes(item.nodeId)), visualBaseline: manifest.visualBaseline }); });
server.registerTool('review_visual_match', { description: 'Call after the first implementation screenshot and again before completion. Compares an attached Figma reference PNG with candidatePath, returns reference/candidate/diff images and a corrective prompt. When passed is false, revise and call this tool again before declaring completion.', inputSchema: { reference: z.string(), candidatePath: z.string(), phase: z.enum(['midpoint', 'final']) } }, async ({ reference, candidatePath, phase }) => {
  const node = resolveNodeReference(document, reference);
  const attachedReference = referenceIndex.references.find((item) => item.nodeId === node.id);
  if (!attachedReference) throw new Error(`No reference PNG is attached to node ${node.id}`);
  const [referencePng, candidatePng] = await Promise.all([readFile(join(bundleRoot, attachedReference.path)), readFile(candidatePath)]);
  return { content: buildVisualReview({ nodeId: node.id, phase: phase as ReviewPhase, reference: referencePng, candidate: candidatePng, comparison: comparePng(referencePng, candidatePng) }).content };
});
server.registerTool(publicToolNames.getVectorSvg, { description: 'Compose one listed vector-only group into a self-contained SVG without modifying the bundle.', inputSchema: publicToolSchemas.get_vector_svg }, async ({ reference }) => {
  const { node, targetDoc, targetRoot } = await resolveAnyNode(reference);
  const warnings: string[] = [];
  let svg = await composeBundleVectorGroupSvg(targetRoot, targetDoc, node.id, warnings);

  // If local node has no vector group, check if its componentKey resolves to a peer component with vectors
  if (!svg) {
    const master = node.main_component_id ? targetDoc.nodesById[node.main_component_id] : (node.resolvedComponentId ? targetDoc.nodesById[node.resolvedComponentId] : undefined);
    const componentKey = node.componentKey ?? master?.componentKey;
    if (componentKey && componentIndex.has(componentKey)) {
      const indexed = componentIndex.get(componentKey)!;
      if (indexed.bundleRoot !== targetRoot && indexed.hasVectors) {
        const peer = peerBundles.find((p) => p.bundleRoot === indexed.bundleRoot);
        if (peer) {
          const peerDoc = await loadPeerDoc(peer);
          svg = await composeBundleVectorGroupSvg(peer.bundleRoot, peerDoc, indexed.nodeId, warnings);
          if (svg) return text({ nodeId: indexed.nodeId, peerLibrary: indexed.sourceBundle, svg, ...(warnings.length ? { warnings } : {}) });
        }
      }
    }
  }

  if (!svg) throw new Error(`No renderable vector group matches ${reference}`);
  return text({ nodeId: node.id, svg, ...(warnings.length ? { warnings } : {}) });
});
server.registerTool(publicToolNames.getStyleTokens, { description: 'Read extracted token files, font requirements, and Figma variables when present in the local export.' }, async () => text({ ...Object.fromEntries(tokenFiles), fonts: fontFile, variables: variableFile }));
server.registerTool(publicToolNames.getAsset, { description: 'Return the local extracted image path by hash.', inputSchema: publicToolSchemas.get_asset }, async ({ hash }) => {
  try {
    const entry = (await readdir(join(bundleRoot, 'assets/images'))).find((name) => name.startsWith(`${hash}.`));
    if (entry) return text({ hash, path: `assets/images/${entry}`, absolutePath: join(bundleRoot, 'assets/images', entry) });
  } catch {}

  for (const peer of peerBundles) {
    try {
      const peerEntry = (await readdir(join(peer.bundleRoot, 'assets/images'))).find((name) => name.startsWith(`${hash}.`));
      if (peerEntry) {
        return text({
          hash,
          path: `assets/images/${peerEntry}`,
          absolutePath: join(peer.bundleRoot, 'assets/images', peerEntry),
          peerLibrary: peer.originFileKey
        });
      }
    } catch {}
  }
  throw new Error(`Asset not found: ${hash}`);
});
server.registerTool(publicToolNames.inspectNode, { description: 'Return a bounded local node summary without asset paths or hashes.', inputSchema: publicToolSchemas.inspect_node }, async ({ reference, depth, maxChildren }) => {
  const { node, targetDoc, targetRoot } = await resolveAnyNode(reference);
  const inspection = inspectNode(targetDoc, node, { depth, maxChildren });

  const master = node.main_component_id ? targetDoc.nodesById[node.main_component_id] : (node.resolvedComponentId ? targetDoc.nodesById[node.resolvedComponentId] : undefined);
  const componentKey = node.componentKey ?? master?.componentKey;
  const sourceLibraryKey = node.sourceLibraryKey ?? master?.sourceLibraryKey;

  if (componentKey && componentIndex.has(componentKey)) {
    const indexed = componentIndex.get(componentKey)!;
    const isExternal = indexed.bundleRoot !== targetRoot;
    const hasLocalAssets = inspection.selection.assets.hasVector || inspection.selection.assets.imageFillCount > 0;

    const externalComponent: Record<string, unknown> = {
      componentKey,
      ...(sourceLibraryKey ? { sourceLibraryKey } : {}),
      originFileKey: indexed.sourceBundle,
      bundleRoot: indexed.bundleRoot,
      nodeId: indexed.nodeId,
      name: indexed.name,
      type: indexed.type,
      hasVectors: indexed.hasVectors,
      hasImages: indexed.hasImages,
      isExternal
    };

    if (isExternal && !hasLocalAssets && (indexed.hasVectors || indexed.hasImages)) {
      try {
        const peer = peerBundles.find((p) => p.bundleRoot === indexed.bundleRoot);
        if (peer) {
          const peerDoc = await loadPeerDoc(peer);
          const peerNode = peerDoc.nodesById[indexed.nodeId];
          if (peerNode) {
            const peerInspection = inspectNode(peerDoc, peerNode, { depth: depth ?? 1, maxChildren });
            externalComponent.resolvedPeerComponent = peerInspection.selection;
          }
        }
      } catch {}
    }

    return text({
      ...inspection,
      externalComponent
    });
  }

  return text(inspection);
});
await server.connect(new StdioServerTransport());
async function resolveRootBundle(inputPath: string): Promise<string> {
  try {
    await readFile(join(inputPath, 'document.agent.json'), 'utf8');
    return inputPath;
  } catch {}

  const candidateDirs = [inputPath, join(inputPath, '..')];
  for (const dir of candidateDirs) {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      const validBundles: Array<{ path: string; mtime: number }> = [];
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const candidate = join(dir, entry.name);
        try {
          const s = await stat(candidate);
          await readFile(join(candidate, 'document.agent.json'), 'utf8');
          validBundles.push({ path: candidate, mtime: s.mtimeMs });
        } catch {}
      }
      if (validBundles.length > 0) {
        validBundles.sort((a, b) => b.mtime - a.mtime);
        return validBundles[0].path;
      }
    } catch {}
  }
  throw new Error(`Cannot find valid bundle in ${inputPath} or its parent directory.`);
}
function argument(name: string) { const index=process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index+1]; }
function tokensFor(nodeIds: readonly string[]) { const selected = new Set(nodeIds); return { ...Object.fromEntries(tokenFiles.map(([name, file]) => [name, file.tokens.filter((token) => token.nodeIds.some((id) => selected.has(id)))])), fonts: fontFile.fonts.filter((font) => font.nodeIds.some((id) => selected.has(id))), variables: variableFile }; }
async function loadReferences(): Promise<{ references: Array<{ nodeId: string; path: string; width: number; height: number; sha256: string }> }> { try { return JSON.parse(await readFile(join(bundleRoot, 'references/index.json'), 'utf8')) as { references: Array<{ nodeId: string; path: string; width: number; height: number; sha256: string }> }; } catch (error: unknown) { if ((error as { code?: string }).code === 'ENOENT') return { references: [] }; throw error; } }
async function loadVariables(): Promise<{ collections: unknown[]; ungrouped: unknown[] }> { try { return JSON.parse(await readFile(join(bundleRoot, 'tokens/variables.json'), 'utf8')) as { collections: unknown[]; ungrouped: unknown[] }; } catch (error: unknown) { if ((error as { code?: string }).code === 'ENOENT') return { collections: [], ungrouped: [] }; throw error; } }
interface PeerBundle { bundleRoot: string; manifest: Record<string, unknown>; originFileKey?: string; document?: AgentDocument; references?: Array<{ nodeId: string; path: string; width: number; height: number; sha256: string }>; }
async function discoverPeerBundles(currentRoot: string): Promise<PeerBundle[]> {
  const peers: PeerBundle[] = [];
  try {
    const parentDir = join(currentRoot, '..');
    const entries = await readdir(parentDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const peerRoot = join(parentDir, entry.name);
      if (peerRoot === currentRoot) continue;
      try {
        const manifestText = await readFile(join(peerRoot, 'manifest.json'), 'utf8');
        const peerManifest = JSON.parse(manifestText) as Record<string, unknown>;
        const originFileKey = typeof peerManifest.originFileKey === 'string' ? peerManifest.originFileKey : undefined;
        peers.push({ bundleRoot: peerRoot, manifest: peerManifest, originFileKey });
      } catch {}
    }
  } catch {}
  return peers;
}
async function loadPeerDoc(peer: PeerBundle): Promise<AgentDocument> {
  if (!peer.document) {
    peer.document = JSON.parse(await readFile(join(peer.bundleRoot, 'document.agent.json'), 'utf8')) as AgentDocument;
  }
  return peer.document;
}

interface IndexedComponent {
  componentKey: string;
  sourceBundle: string;
  bundleRoot: string;
  nodeId: string;
  name: string;
  type: string;
  hasVectors: boolean;
  hasImages: boolean;
}

function hasVectorsInTree(doc: AgentDocument, node: AgentNode): boolean {
  if (node.vectorRef) return true;
  for (const childId of node.childIds) {
    const child = doc.nodesById[childId];
    if (child && hasVectorsInTree(doc, child)) return true;
  }
  return false;
}

function hasImagesInTree(doc: AgentDocument, node: AgentNode): boolean {
  if (node.assetRefs && node.assetRefs.length > 0) return true;
  for (const childId of node.childIds) {
    const child = doc.nodesById[childId];
    if (child && hasImagesInTree(doc, child)) return true;
  }
  return false;
}

async function buildComponentIndex(
  currentRoot: string,
  primaryDocument: AgentDocument,
  peers: PeerBundle[]
): Promise<Map<string, IndexedComponent>> {
  const index = new Map<string, IndexedComponent>();

  const indexDoc = async (root: string, doc: AgentDocument, originKey?: string) => {
    const bundleKey = originKey || doc.originFileKey || root.split('/').pop() || 'unknown';

    for (const node of Object.values(doc.nodesById)) {
      if (node.componentKey) {
        const hasVectors = hasVectorsInTree(doc, node);
        const hasImages = hasImagesInTree(doc, node);
        const existing = index.get(node.componentKey);
        if (!existing || (!existing.hasVectors && hasVectors)) {
          index.set(node.componentKey, {
            componentKey: node.componentKey,
            sourceBundle: bundleKey,
            bundleRoot: root,
            nodeId: node.id,
            name: node.name,
            type: node.type,
            hasVectors,
            hasImages
          });
        }
      }
    }

    try {
      const rawText = await readFile(join(root, 'document.raw.json'), 'utf8');
      const raw = JSON.parse(rawText) as { document?: { nodeChanges?: Array<Record<string, unknown>> } };
      const changes = raw.document?.nodeChanges ?? [];
      for (const change of changes) {
        const compKey = typeof change.componentKey === 'string' ? change.componentKey : undefined;
        const guid = change.guid as { sessionID: number; localID: number } | undefined;
        if (compKey && guid) {
          const id = `${guid.sessionID}:${guid.localID}`;
          const node = doc.nodesById[id];
          if (node) {
            if (!node.componentKey) node.componentKey = compKey;
            const hasVectors = hasVectorsInTree(doc, node);
            const hasImages = hasImagesInTree(doc, node);
            const existing = index.get(compKey);
            if (!existing || (!existing.hasVectors && hasVectors)) {
              index.set(compKey, {
                componentKey: compKey,
                sourceBundle: bundleKey,
                bundleRoot: root,
                nodeId: id,
                name: node.name,
                type: node.type,
                hasVectors,
                hasImages
              });
            }
          }
        }
      }
    } catch {}
  };

  await indexDoc(currentRoot, primaryDocument, primaryDocument.originFileKey);

  for (const peer of peers) {
    try {
      const peerDoc = await loadPeerDoc(peer);
      await indexDoc(peer.bundleRoot, peerDoc, peer.originFileKey);
    } catch {}
  }

  return index;
}

async function resolveAnyNode(reference: string) {
  // Check if reference is a componentKey or comp:<key>
  const cleanKey = reference.startsWith('comp:') ? reference.slice(5) : reference;
  if (componentIndex.has(cleanKey)) {
    const item = componentIndex.get(cleanKey)!;
    if (item.bundleRoot === bundleRoot) {
      return { node: document.nodesById[item.nodeId]!, targetDoc: document, targetRoot: bundleRoot, references: referenceIndex.references };
    }
    const peer = peerBundles.find((p) => p.bundleRoot === item.bundleRoot);
    if (peer) {
      const peerDoc = await loadPeerDoc(peer);
      if (!peer.references) {
        try {
          peer.references = (JSON.parse(await readFile(join(peer.bundleRoot, 'references/index.json'), 'utf8')) as { references: Array<{ nodeId: string; path: string; width: number; height: number; sha256: string }> }).references;
        } catch {
          peer.references = [];
        }
      }
      return { node: peerDoc.nodesById[item.nodeId]!, targetDoc: peerDoc, targetRoot: peer.bundleRoot, references: peer.references };
    }
  }

  try {
    const node = resolveNodeReference(document, reference);
    return { node, targetDoc: document, targetRoot: bundleRoot, references: referenceIndex.references };
  } catch (err) {
    for (const peer of peerBundles) {
      try {
        const peerDoc = await loadPeerDoc(peer);
        const node = resolveNodeReference(peerDoc, reference);
        if (!peer.references) {
          try {
            peer.references = (JSON.parse(await readFile(join(peer.bundleRoot, 'references/index.json'), 'utf8')) as { references: Array<{ nodeId: string; path: string; width: number; height: number; sha256: string }> }).references;
          } catch {
            peer.references = [];
          }
        }
        return { node, targetDoc: peerDoc, targetRoot: peer.bundleRoot, references: peer.references };
      } catch {}
    }
    throw err;
  }
}
