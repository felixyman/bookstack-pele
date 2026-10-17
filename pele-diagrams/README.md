# Pele Diagrams — BookStack theme module

Renders `mermaid` code blocks as diagrams (server-side SVG/PNG via
[Pele](https://pele.run/)), including in PDF and HTML exports.

This folder is packaged as a BookStack theme module. It requires the
`pele-render` sidecar service.

**Full installation instructions, configuration and limitations:**
see the repository README.

## Module contents

- `bookstack-module.json` — module metadata
- `functions.php` — registers the stylesheet view include
- `PeleTheme.php` — render pipeline, caching and sidecar client
- `views/` — page display overrides (web + exports) and the asset include
- `public/pele-bookstack.css` — light/dark theme mapping
