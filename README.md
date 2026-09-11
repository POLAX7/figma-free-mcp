# figma-free-mcp

<img width="1584" height="396" alt="Copy of White and Blue Simple Gradient Business Profile LinkedIn Banner" src="https://github.com/user-attachments/assets/58e23751-4015-4ced-bc65-630dea16900a" />


`fig-local-context` turns a locally exported Figma `.fig` file into a stable,
agent-ready context bundle. It runs entirely on the machine that owns the
export: there are no Figma API calls, MCP calls, browser automation, or remote
services during extraction.

The project is designed for implementation agents that need trustworthy design
facts such as layer hierarchy, text, dimensions, auto-layout, color, typography,
effects, z-order, and embedded asset paths. It prioritizes useful context over
pixel-perfect rendering.

## Status

The CLI and local MCP server are implemented. The current compatibility target
is normal Figma **Save local copy** exports: ZIP archives containing
`meta.json`, `canvas.fig`, a thumbnail, and optional `images/` entries. The
`canvas.fig` payload is decoded locally from Figma's Kiwi binary format.

The initial compatibility target is the `fig-kiwi` canvas signature. The format
is an undocumented Figma implementation detail, so compatibility is deliberately
versioned and unsupported variants fail explicitly instead of being guessed.

## Maintained fork changes and Figma Inspector

This maintained fork adds the local component-instance resolution used by the
[Figma Inspector workflow](https://github.com/POLAX7/figma-inspector). The
Inspector repository contains the inspection decisions, AST pruning, cache and
rate-limit handling, while this repository provides the local `.fig` extraction
and MCP context consumed by that workflow.

### Key Capabilities & Recent Bug Fixes

#### 1. Component Resolution & Instance Expansion
- **Preserve Component Metadata**: Preserve an instance's original `node_id`, `main_component_id`, `sourceLibraryKey`, and `componentKey` from `symbolData`, while keeping the raw `childIds` unchanged for diagnostics.
- **Local Instance Expansion**: Resolve local `SYMBOL` definitions into per-instance `resolvedChildIds`, including nested components with cycle protection and isolated IDs when the same component is used repeatedly.
- **Symbol Component Overrides**: Apply `symbolOverrides.overriddenSymbolID` to the expanded instance tree, so an overridden trailing control resolves to its actual component (for example, Trash instead of the base Cancel/X component).
- **Target-Specific Text Overrides**: Apply text overrides by their `guidPath` target (`instanceTextOverridesByNodeId`) instead of relying on array ordering in Figma's export.
- **Bounded Context Traversal**: Make node context traversal and bounded inspection use resolved children, reporting component identity, source libraries, and expansion status.

#### 2. Cross-Bundle & Design System Resolution
- **Peer Bundle Discovery**: Automatically detect neighboring bundles (such as shared external Design Systems) located in parent directories.
- **Cross-Bundle Component Indexing**: Build an index across primary and peer bundles keyed by Figma `componentKey`, enabling direct lookups via `search_nodes` or `inspect_node --node 'comp:<key>'`.
- **Instance Swap Resolution**: Support instance swaps referencing external design system components (`componentPropAssignments` and `symbolOverrides`), resolving substituted components across peer bundles when exporting SVGs or inspecting nodes.
- **Transparent Asset & Vector Fallback**: When an instance in the primary file references an external component, `get_vector_svg` and `get_asset` seamlessly fall back to peer bundles to fetch vector geometry or image assets.

#### 3. Accurate Color & Variable Alias Resolution
- **Figma Variable Alias Tracking**: Recursively follow variable reference chains (`colorVar` with `ALIAS` dataType) to resolve their ultimate RGBA color values (`buildVariableColorResolver`), eliminating stale raw fallback colors (such as default `#d9d9d9` gray).
- **Symbol Override Paints**: Accurately resolve fill and stroke variable colors inside `symbolOverrides` for instantiated components.

#### 4. High-Fidelity Vector & SVG Rendering
- **Symbol & Component Frame Preservation**: Render vector groups against their declared symbol or instance frame bounds as the SVG canvas/viewBox (e.g., 24×24 or 30×30), preserving inner margins, padding, and transforms instead of truncating the viewBox to leaf vector tight bounding boxes.
- **1D & Dimension Vector Geometry Scaling**: Correctly scale 1D straight horizontal/vertical lines and scaled vectors in `fitGeometryToSize` so lines span their intended dimensions instead of remaining constrained to unscaled raw coordinates.
- **Per-Node Vector Geometry**: Key vector SVGs by node ID so multiple vector instances sharing the same Kiwi binary blob can each render at their respective sizes and stroke weights.
- **Shape & Outline Preservation**: Support geometric shapes (`RECTANGLE`, `ROUNDED_RECTANGLE`, `ELLIPSE`, `FRAME`) with proper SVG representations (`<rect>`, `<ellipse>`).
- **Stroke & Stroke Alignment**: Preserve stroke colors, stroke width, and `strokeAlign` (`INSIDE`, `CENTER`, `OUTSIDE`) calculations.
- **Outside Stroke Bounds**: Expand rectangle geometry and emit negative `x`/`y` offsets for `OUTSIDE` strokes, preventing the outer border from being rendered at the original bounds or silently clipped.
- **Rounded Outside Strokes**: Expand rounded-rectangle corner radii together with `OUTSIDE` strokes so the outer border preserves the intended corner geometry.
- **Standalone Vector Segments**: Preserve vector-network segments that are not included in a filled region, so independent lines are not silently omitted from the SVG output.
- **Binary Vector Fallback**: Prefer the complete `.bin.gz` vector network when a materialized SVG is missing or incomplete, and fall back to the materialized SVG only when binary decoding is unavailable.
- **Disconnected Vector Paths**: Preserve separate, disconnected vector-network segments when the network has no filled regions, preventing an X or multi-line icon from collapsing to a single slash.
- **Rounded Vector Strokes**: Preserve rounded cap/join output for vector nodes with Figma `cornerRadius`; inherited `MITER` defaults no longer erase the rounded appearance of Design System icons.
- **Degenerate Vector Bounds**: Keep stroked vectors with zero or near-zero dimensions renderable by deriving a usable output size from stroke width or visible children.
- **Border/Outline Layer Recognition**: Automatically treat layers named `border` or `outline` with strokes as `fill="none"` to avoid obscuring underlying layers.
- **Affine Transform Bugfix**: Corrected affine matrix multiplication calculation (`multiply`) to prevent skew/rotation errors during nested vector composition.
- **Render Diagnostics**: The `figctx render` CLI command outputs structured warnings to `stderr` when skipping unsupported layer attributes rather than failing silently.

These changes keep offline inspection local-first; the Inspector workflow only
uses a cloud fallback when the local bundle cannot resolve the component.

## Commands

```sh
figctx extract design.fig --out .figctx/design
figctx inspect .figctx/design --node <node-id>
figctx search .figctx/design "checkout" --type TEXT --limit 10
figctx pack .figctx/design --node <node-id> --format codex
figctx render .figctx/design --node <node-id> > artwork.svg
```

When the renderer changes, re-extract the source `.fig` into a new bundle so
materialized vector SVGs and `document.agent.json` use the same parser build:

```sh
node packages/cli/dist/main.js extract DesignSystem.fig --out .figctx/design-system-full-v4
node packages/cli/dist/main.js render .figctx/design-system-full-v4 --node 955:692 > icon.svg
```

Restart any long-running MCP client after changing its `--root` or rebuilding
the server. The configured root must contain the freshly extracted
`document.agent.json`, not only the raw `.fig` file.

## Install and use

Requires Node.js 20 or newer. No checkout or build is needed for normal use.

Run the CLI without installing it globally:

```sh
npx -y figctx@0.1.0 extract design.fig --out .figctx/design
npx -y figctx@0.1.0 inspect .figctx/design --node '1-2'
npx -y figctx@0.1.0 pack .figctx/design --node 'https://www.figma.com/design/file/name?node-id=1-2' --format codex
npx -y figctx@0.1.0 render .figctx/design --node '1-2' > artwork.svg
```

Or install both local tools once:

```sh
npm install --global figctx
figctx extract design.fig --out .figctx/design
figctx-mcp --root "$PWD/.figctx/design"
```

The npm distribution contains Node.js executables, not native platform
binaries. Use an exact package version in MCP configuration so a design agent
has a repeatable tool contract.

### Contributor setup

Contributors need pnpm as well as Node.js 20+:

```sh
pnpm install
pnpm build
node packages/cli/dist/main.js extract design.fig --out .figctx/design
```

### Releasing

Public versions follow Semantic Versioning. Update `packages/cli/package.json`
and `CHANGELOG.md` in the release pull request, merge it, then create the
matching protected tag (`vX.Y.Z`). The publish workflow runs the complete
check, creates the npm tarball, publishes it, and attaches the tarball plus
SHA-256 to the GitHub Release.

For the first `0.1.0` publication, an npm owner must publish the tarball
manually with 2FA. Afterwards configure npm Trusted Publishing for
`symonbaikov/figma-free-mcp`, workflow file `publish.yml`, and the
`npm-publish` GitHub environment; future tags publish with GitHub OIDC and no
long-lived npm token.

## Prompt examples

### Implement a Figma page

The following prompt can be given to an implementation agent:

```text
On the `page-stress` branch, implement the entire page from the Figma design.

Use fig-context-extracter to inspect the design. It will help you extract all
styles, images, and text from the local Figma file:
https://github.com/symonbaikov/fig-local-context

The local `.fig` file is located at:
Downloads/Страница гайда (Copy).fig

Implement both the desktop and mobile versions from the start.

Desktop design:
https://www.figma.com/design/EXfHitAQKwAIBHdY5fqa9A/%D0%A1%D1%82%D1%80%D0%B0%D0%BD%D0%B8%D1%86%D0%B0-%D0%B3%D0%B0%D0%B9%D0%B4%D0%B0--Copy-?node-id=54-1224&t=6N2Rf8lhG1IMJCRY-4

Mobile design:
https://www.figma.com/design/EXfHitAQKwAIBHdY5fqa9A/%D0%A1%D1%82%D1%80%D0%B0%D0%BD%D0%B8%D1%86%D0%B0-%D0%B3%D0%B0%D0%B9%D0%B4%D0%B0--Copy-?node-id=35-438&t=6N2Rf8lhG1IMJCRY-4
```

### Pixel-validation workflow

Save an exported PNG for each frame that needs visual parity, then attach it
to its local canonical node ID. All steps are local and make no Figma request:

```sh
# Refuse pixel-perfect work early if a required local font is missing.
figctx font-check .figctx/design --font-dir ./fonts

# Attach the PNG exported from that frame in Figma.
figctx reference .figctx/design --node '320-182023' --image ./references/mobile-page.png

# After implementation, compare a local browser screenshot to the reference.
figctx compare .figctx/design --node '320-182023' --candidate ./screenshots/mobile-page.png
# Make visual drift fail CI only when it exceeds the chosen allowance.
figctx compare .figctx/design --node '320-182023' --candidate ./screenshots/mobile-page.png --max-mismatch-ratio 0.02
# Validate a bundle without reopening its source .fig.
figctx doctor .figctx/design
```

`reference` stores a PNG in `references/` with its dimensions and SHA-256.
`compare` writes `comparisons/<node-id>/diff.png` and `report.json`, including
the mismatch pixel count and ratio. `pack` and MCP `get_frame_bundle` return
all references attached within the requested subtree.

The vector renderer also maintains regression coverage for nested affine
transforms, external-component fallbacks, variable color aliases, geometric
shapes, masks, unsupported-layer warnings, standalone vector segments, and
`INSIDE`/`CENTER`/`OUTSIDE` stroke behavior. In particular, rectangle `OUTSIDE`
strokes are tested for both expanded dimensions, negative offsets, and
rounded-corner radii; vector networks with filled regions are tested to retain
segments outside those regions. These automated tests do not
replace validation against a corpus of real `.fig` bundles and rendered PNG
pixel comparisons; those remain additional verification steps for new image
types and previously untested component combinations.

`--node` accepts canonical bundle IDs (`1:2`), Figma URL IDs (`1-2`), and a
Figma URL containing `node-id`. Resolution is local to the extracted bundle;
it never requests the linked Figma file. When the local export carries an
`originFileKey`, a URL with `/design/<file-key>/` or `/file/<file-key>/` must
match it; a URL for another Figma file fails with
`NODE_REFERENCE_FILE_MISMATCH` before a node is returned.

`pack --format codex` returns the selected node's complete depth-first subtree,
descendant text, deduplicated image/vector references, available maximal
vector-only groups, and every style token used by that subtree. Use `render`
with one listed group ID to receive a single self-contained SVG; it does not
write to the bundle. This is the intended command for an agent implementing a
whole section or page, while `inspect` remains a concise single-node lookup.

Start the MCP server after extraction:

```sh
npx -y --package figctx@0.1.0 figctx-mcp --root "$PWD/.figctx/design"
```

It exposes `list_frames`, `list_frame_summaries`, `search_nodes`, `get_node_context`, `get_frame_bundle`,
`review_visual_match`, `get_vector_svg`, `get_style_tokens`, `get_asset`, and `inspect_node` via stdio. Node and frame responses include
attached reference metadata when present. The server reads only bundle files
plus the candidate PNG supplied to `review_visual_match`; it never opens the source `.fig`, writes to the bundle, or uses the network.

Use `list_frame_summaries` or `search_nodes` to discover node IDs without loading full node records; `list_frame_summaries` returns 100 entries by default and includes `nextCursor` for the next batch (up to 200 with `limit`). `list_frames` remains available with its existing detailed response.

Use `inspect_node` for a compact, bounded preview before implementation. It accepts a node reference plus optional `depth` (default 2, maximum 5) and `maxChildren` (default 20, maximum 100); its response reports omitted descendants and summarizes images/vectors without exposing asset paths or hashes. Use `get_frame_bundle` only when implementing a section or page: it uses the same complete-subtree contract as `figctx pack`.

For Codex, configure the npm package with an exact version and absolute bundle
path:

```json
{
  "mcpServers": {
    "figctx": {
      "command": "npx",
      "args": [
        "-y",
        "--package",
        "figctx@0.1.0",
        "figctx-mcp",
        "--root",
        "/absolute/path/to/design.figctx"
      ]
    }
  }
}
```

For Claude Desktop, put the same server command in its configuration file:

```json
{
  "mcpServers": {
    "figctx": {
      "command": "npx",
      "args": [
        "-y",
        "--package",
        "figctx@0.1.0",
        "figctx-mcp",
        "--root",
        "/absolute/path/to/design.figctx"
      ]
    }
  }
}
```

### Agent visual self-review

An implementation agent should capture a same-viewport PNG after its first
working version and again before it finishes. It calls
`review_visual_match` with the target Figma node, the local screenshot path,
and `phase: "midpoint"` or `phase: "final"`.

The tool returns the attached Figma reference, the candidate, and a pixel diff
as MCP image blocks, followed by a corrective prompt. Its fixed acceptance
gate is `mismatchRatio <= 0.005` (0.5%). When `passed` is false, the agent must
make the smallest corrective changes, take a fresh screenshot, and call the
tool again; it must not declare the implementation complete first. Reference
and candidate dimensions must match.

`extract` creates a self-contained bundle. `inspect` and `pack` read that bundle
only; they do not need to reopen the original `.fig` file.

```text
.figctx/design/
├── manifest.json
├── document.raw.json
├── document.agent.json
├── tokens/
│   ├── colors.json
│   ├── typography.json
│   ├── effects.json
│   ├── fonts.json
│   └── variables.json
├── assets/images/
├── assets/images.json
├── assets/thumbnail.png
├── assets/vectors.json
├── assets/vectors/
│   ├── vector-network-<id>.svg
│   └── vector-network-<id>.bin.gz
├── references/index.json
├── references/<node-id>.png
├── comparisons/<node-id>/report.json
├── comparisons/<node-id>/diff.png
└── frames/<node-id>/context.md
```

### Bundle files

- `manifest.json` records the source file name and SHA-256, parser and contract
  versions, detected variants, extraction status, and warnings.
- `document.raw.json` is the decoded Kiwi document for diagnostics. Large binary
  blobs remain files or references, not base64 JSON payloads.
- `document.agent.json` is the stable normalized layer tree. Nodes retain IDs,
  names, type, parent/child ordering, absolute bounds, transforms, visibility,
  opacity, masks and frame clipping flags, constraints, layout details, paints, effects, text, Figma-computed
  text layout metrics (baselines and font metadata), and asset/vector
  references.
- `tokens/` contains deduplicated colors, typography, and effects, each with
  the source node IDs that produced it.
- `tokens/fonts.json` records required font family, style, PostScript name,
  observed weight, and source node IDs. It never copies licensed system fonts.
- `tokens/variables.json` records local Figma variable collections, modes, and
  values when the `.fig` export contains them. Existing bundles may not have
  this optional file; consumers return empty variables in that case.
- Text nodes with mixed local styles expose compact `textSegments` runs in
  `document.agent.json`; each run contains the character range, resolved
  typography overrides, and fill override when present. Nodes also retain
  local style references and variable bindings when the export provides them.
- `assets/images/` contains extracted raster assets with extensions inferred
  from their real byte signatures, not from Figma's extensionless filenames.
- `assets/images.json` maps every original image hash to its local, inferred
  path. When present in the export, `assets/thumbnail.png` is retained as the
  unmodified document-level visual baseline for implementation review.
- `assets/vectors/` retains the original Kiwi vector-network blobs and, when
  their geometry is valid, materializes a portable SVG beside each blob.
  `assets/vectors.json` maps a blob ID to its lossless gzip-compressed path and
  optional `svgPath`; `document.agent.json` carries the same fields in
  `vectorRef`. SVG paths use `currentColor`, so consumers can style inline SVG
  consistently; malformed vector blobs remain available only as `.bin.gz`.
- Core consumers can use `composeVectorGroupSvg()` to compose a maximal
  vector-only subtree into one SVG. It applies `frameMaskDisabled: false` as
  SVG clip paths and Figma `mask: true` layers as masks for their following
  siblings. Raster fills, strokes, blend modes, effects, gradients, and text
  make a group unavailable rather than producing a partial SVG.
- `frames/*/context.md` is a deterministic, compact summary for every canvas
  and top-level frame. Nested frames remain fully addressable with `pack` and
  are intentionally not duplicated as thousands of tiny files.

## Supported input and compatibility policy

An accepted archive must be a valid ZIP containing `canvas.fig`. The first
decoder supports a `canvas.fig` beginning with `fig-kiwi`; it reads the embedded
Kiwi schema, decompresses the document chunks, and normalizes the decoded tree.

Other canvas payloads are not treated as corrupt by default. They receive the
structured `UNSUPPORTED_FIG_VARIANT` result so a new adapter can be added with
real evidence. The output contract has its own version independent of the
decoder version, allowing parser internals to change without silently breaking
agent integrations.

## Safety and privacy

- Extraction is local-only. The tool does not authenticate with, contact, or
  upload anything to Figma or another service.
- ZIP paths are treated as untrusted. Traversal entries, duplicate critical
  entries, malformed metadata, and configurable resource-limit violations fail
  safely.
- Output is written into a temporary sibling directory and renamed only after a
  complete successful extraction, preventing half-written agent bundles.
- The original `.fig` is read-only. Existing output directories are refused
  unless the caller explicitly requests replacement.
- Real customer or proprietary `.fig` files and generated bundles are never
  committed as fixtures.

## Architecture

The repository is a TypeScript/Node.js workspace with these boundaries:

- `packages/core` owns archive reading, Kiwi decoding, normalizing, token
  extraction, and atomic bundle writing.
- `packages/cli` owns command parsing, human-readable diagnostics, and exit
  codes.
- `packages/mcp-server` serves existing bundles over stdio and never reparses
  Figma files or contacts Figma.
- `examples/` contains schemas and synthetic examples only.

The Kiwi dependency is isolated behind a `KiwiDecoder` adapter. This keeps the
undocumented binary format separate from the long-lived public JSON contract.

## Errors

Failures are structured in `manifest.json`, printed concisely by the CLI, and
use nonzero exit codes. Initial error codes are:

- `INVALID_FIG_ARCHIVE`
- `MISSING_CANVAS`
- `UNSUPPORTED_FIG_VARIANT`
- `CORRUPT_KIWI_CHUNK`
- `RESOURCE_LIMIT_EXCEEDED`
- `OUTPUT_EXISTS`
- `NODE_NOT_FOUND`
- `NODE_REFERENCE_FILE_MISMATCH`
- `INVALID_REFERENCE_IMAGE`
- `REFERENCE_IMAGE_DIMENSION_MISMATCH`
- `REFERENCE_NOT_FOUND`

## Tests and fixtures

The test suite has three layers:

1. Unit tests for archive/variant detection, safe paths, image signatures, and
   token normalization.
2. Committed synthetic fixture archives for successful, malformed, and
   unsupported cases, including snapshot tests for the stable agent document.
3. A local-only acceptance test enabled with `FIGCTX_ACCEPTANCE_FIG`. It checks
   successful decode of a real export without copying, snapshotting, printing,
   or committing the design or its output.

### Private real-export CI

`Real Figma acceptance` runs on same-repository pull requests to `main` and on
manual dispatch. Fork pull requests run the normal CI only, so they never
receive the private fixture credential. The acceptance job downloads an
immutable release asset from a separate private repository, verifies its
SHA-256, extracts it, compares hashes of safe bundle outputs, and exercises all
CLI and MCP tools without printing or uploading design data.

One-time GitHub setup:

1. Create a private test-data repository and publish the export as the release
   asset named by `tests/acceptance/fixture-contract.json`.
2. Set `FIGCTX_TEST_DATA_REPOSITORY` as a repository variable and
   `FIGCTX_TEST_DATA_TOKEN` as a fine-grained, read-only token with access only
   to that private repository.
3. Protect `main` and require both the existing CI check and
   `Real Figma acceptance / real-fig` for internal pull requests.

To rotate the fixture, publish a new immutable release asset, run
`FIGCTX_ACCEPTANCE_FIG=/path/to/figctx-acceptance.fig pnpm test:real-fig`
locally after updating the contract hashes, and review only the resulting
checksum/count diff. Never commit the `.fig`, generated bundle, logs, or
workflow artifacts.

## Non-goals for the first release

- Screenshot-perfect rendering
- A Figma API client, Figma MCP client, or browser automation
- Editing or writing `.fig` files
- A hosted service

## References and attribution

The implementation follows the local-export flow described by
[Figma Help](https://help.figma.com/hc/en-us/articles/360041003114-Import-files-to-the-file-browser).
It treats the format as unstable, consistent with
[Evan Wallace's parser note](https://madebyevan.com/figma/fig-file-parser/).
The Kiwi binary runtime is MIT-licensed and provides the embedded-schema
decoding model used by this project; see [evanw/kiwi](https://github.com/evanw/kiwi).
The project also acknowledges [kreako/fig2json](https://github.com/kreako/fig2json)
as an open-source precedent for local, LLM-oriented `.fig` conversion.

## License

MIT. See [LICENSE](LICENSE).
