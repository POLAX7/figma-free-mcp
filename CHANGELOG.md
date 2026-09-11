# Changelog

All notable changes to `figctx` are documented here. Versions follow
[Semantic Versioning](https://semver.org/).

## Unreleased

### Added
- Cross-bundle peer discovery and indexing by `componentKey` for external design systems.
- Variable color resolver tracking recursive `ALIAS` chains to real RGBA values.
- Support for primitive shapes (`RECTANGLE`, `ROUNDED_RECTANGLE`, `ELLIPSE`) and stroke outlines in vector composition.
- Structured rendering warning diagnostics for skipped layers in `figctx render`.

### Fixed
- Fixed raw Kiwi fallback colors (`#d9d9d9`) overriding bound Figma color variables.
- Fixed affine matrix multiplication formula in vector group composition.
- Fixed border/outline shape fills unintentionally masking background elements.
- Fixed external component instance inspection and transparent vector/asset fallback from peer bundles.

## 0.1.0 - 2026-07-30

- First public npm distribution with `figctx` and `figctx-mcp` commands.
