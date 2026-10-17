# Third-party components

This project builds on the following third-party software.

## Pele

- Used by the `pele-render` sidecar to render Mermaid syntax to SVG.
- License: MIT
- Source: https://github.com/obsidianmd/pele
- Website: https://pele.run

## @resvg/resvg-js

- Used by the `pele-render` sidecar to rasterise SVG diagrams to PNG (PDF
  export mode).
- License: MPL-2.0
- Source: https://github.com/thx/resvg-js (based on resvg by RazrFalcon)

## DejaVu fonts

- Installed in the `pele-render` container image and used for diagram text
  measurement and rasterisation.
- License: Bitstream Vera Fonts Copyright (© 2003 Bitstream, Inc.); see
  https://dejavu-fonts.github.io/License.html

## Node.js

- Runtime base image (`node:22-alpine`) for the `pele-render` sidecar.
- License: MIT (Node.js), plus bundled third-party licenses as distributed by
  the Node.js project.

Diagrams are rendered from user-provided Mermaid syntax. See Pele's
[security notes](https://pele.run/security) for how the renderer treats
untrusted diagram source.
