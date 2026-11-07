# Source artwork

The [`unused-art/`](unused-art/) tree is the single archive for artwork that is
not loaded by the application. It contains superseded runtime images, original
variants, concepts, and visual references, grouped by purpose. The entire
`source-assets/` directory is excluded from the Docker build context.

- Screen and feature folders such as `entry/`, `quests/`, `results/`, and `ui/`
  contain distinct unused variants.
- `concepts/` and `references/` contain visual-development material that was
  never a runtime dependency.
- `duplicates/` preserves redundant root-level copies of artwork already filed
  elsewhere. These can be removed later without affecting the game.

Runtime artwork is served as WebP (quality 90, original resolution). The
lossless PNG masters it was encoded from were retired on 2026-11-07 into the
matching category folders here under the same names; re-encode from them
rather than from the WebP files when artwork needs regenerating.

For the repository-wide file map, see the root [README](../README.md).

Runtime code must reference files in a category folder under `static/assets/`.
When promoting an archived image, give it a lowercase kebab-case filename, move
it to the matching runtime category, and update every reference and cache-busting
query string. When retiring runtime art, move it into the matching category
under `unused-art/` instead of leaving unreferenced files in `static/`.
