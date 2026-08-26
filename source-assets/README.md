# Source artwork

This directory preserves distinct original and concept artwork that is not used
directly by the application. It is excluded from the Docker build context.

For the repository-wide file map, see the root [README](../README.md). These
instructions live here because they apply specifically to the adjacent source
artwork.

- `role-art/` contains original role-image variants retained before web-ready
  versions were selected for `static/assets/roles/`.
- `backgrounds/` contains superseded background compositions.
- `concepts/` contains layout and visual-development references.

Runtime code must reference files under `static/`. When promoting an image,
give it a lowercase kebab-case filename, place it in the matching
`static/assets/` or `static/img/` directory, and update its cache-busting query
string where it is referenced.
