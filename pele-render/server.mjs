/**
 * Pele render service for BookStack.
 *
 * Accepts batches of Mermaid syntax (Pele flavour) and returns:
 *  - mode "web":    raw SVG (CSS-variable driven, themed by the BookStack page stylesheet)
 *  - mode "export": SVG with CSS variables resolved to literal values (standalone exports)
 *  - mode "pdf":    var-resolved SVG rasterized to a high-DPI PNG data URI (dompdf-safe)
 *
 * The service is stateless and intended to be reachable only from the BookStack
 * container over the internal compose network.
 */

import http from 'node:http';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { render } from 'pele';
import { Resvg } from '@resvg/resvg-js';

const require = createRequire(import.meta.url);
const peleVersion = require('pele/package.json').version;

const PORT = intEnv('PORT', 3000);
const TOKEN = process.env.PELE_RENDER_TOKEN ?? '';
const MAX_BODY_BYTES = intEnv('PELE_MAX_BODY_BYTES', 4 * 1024 * 1024);
const MAX_BATCH = intEnv('PELE_MAX_BATCH', 50);
const MAX_SOURCE_CHARS = intEnv('PELE_MAX_SOURCE', 50000);
const PNG_SCALE = floatEnv('PELE_PNG_SCALE', 2);
const MAX_PNG_WIDTH = intEnv('PELE_MAX_PNG_WIDTH', 3200);
const DEFAULT_MAX_WIDTH = intEnv('PELE_MAX_WIDTH', 900);
const FONT_FAMILY = process.env.PELE_FONT_FAMILY ?? 'DejaVu Sans';
const FONT_FAMILY_MONO = process.env.PELE_FONT_FAMILY_MONO ?? 'DejaVu Sans Mono';

const MODES = new Set(['web', 'export', 'pdf']);

/** Pele default palette, used as a last resort when resolving bare var() references. */
const PELE_DEFAULT_VARS = {
  '--pele-bg': '#ffffff',
  '--pele-fg': '#1f1f1f',
  '--pele-muted': '#6e6e6e',
  '--pele-line': '#1f1f1f',
  '--pele-surface': '#f3f3f3',
  '--pele-surface-alt': '#e6e6e6',
  '--pele-border': '#8a8a8a',
  '--pele-accent': '#5b7bd5',
  '--pele-critical': '#e45756',
  '--pele-error': '#e45756',
  '--pele-radius': '4px',
  '--pele-font': 'sans-serif',
  '--pele-font-mono': 'monospace',
};

/**
 * Resolve Pele's CSS custom-property chain into literal values.
 *
 * Pele emits a root style like `--_fg:var(--pele-fg,#1f1f1f)` and references
 * `var(--_fg)`/`var(--pele-fg,...)` throughout the SVG. Renderers such as resvg
 * (and dompdf) do not understand CSS variables, so for export/PDF output we
 * flatten the chain to literals using the declared fallbacks.
 */
function resolveCssVars(svg) {
  const internal = new Map();
  for (const match of svg.matchAll(/--(_[a-z]+)\s*:\s*var\(\s*--pele-[a-z0-9-]+\s*,\s*([^)]+)\)/g)) {
    internal.set(match[1], match[2].trim());
  }

  let out = svg.replace(/var\(\s*--(_[a-z]+)\s*(?:,\s*([^)]+))?\)/g, (full, name, fallback) => {
    if (internal.has(name)) return internal.get(name);
    return fallback ? fallback.trim() : full;
  });

  out = out.replace(/var\(\s*(--pele-[a-z0-9-]+)\s*(?:,\s*([^)]+))?\)/g, (full, name, fallback) => {
    if (fallback) return fallback.trim();
    return PELE_DEFAULT_VARS[name] ?? full;
  });

  // Drop the now-unused custom property declarations from the root style attribute.
  out = out.replace(/--_[a-z]+\s*:\s*var\(\s*--pele-[a-z0-9-]+\s*,\s*[^)]+\)\s*;?/g, '');

  return out;
}

/** Rasterize a var-resolved SVG to a high-DPI PNG buffer. */
function rasterize(svg, width) {
  const scale = Number.isFinite(PNG_SCALE) && PNG_SCALE > 0 ? PNG_SCALE : 2;
  const targetWidth = Math.min(Math.max(1, Math.round(width * scale)), MAX_PNG_WIDTH);
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: targetWidth },
    font: { loadSystemFonts: true, defaultFontFamily: FONT_FAMILY },
  });
  return resvg.render().asPng();
}

/** Render a single source, returning an individually error-isolated result. */
function renderSource(source, mode, maxWidth) {
  try {
    const result = render(source, {
      maxWidth,
      fontFamily: FONT_FAMILY,
      fontFamilyMono: FONT_FAMILY_MONO,
      limit: MAX_SOURCE_CHARS,
    });

    const base = { type: result.type, width: result.width, height: result.height };

    if (mode === 'web') {
      return { ok: true, ...base, svg: result.svg };
    }

    const svg = resolveCssVars(result.svg);
    if (mode === 'export') {
      return { ok: true, ...base, svg };
    }

    const png = rasterize(svg, result.width);
    return {
      ok: true,
      ...base,
      pngDataUri: `data:image/png;base64,${Buffer.from(png).toString('base64')}`,
    };
  } catch (error) {
    return { ok: false, error: errorInfo(error) };
  }
}

function errorInfo(error) {
  const candidate = error ?? {};
  return {
    code: typeof candidate.code === 'string' ? candidate.code : 'render-error',
    message: String(candidate.message ?? 'Unable to render diagram').slice(0, 500),
    line: Number.isInteger(candidate.line) ? candidate.line : 0,
    column: Number.isInteger(candidate.column) ? candidate.column : 0,
    type: typeof candidate.type === 'string' ? candidate.type : null,
  };
}

function handleRender(payload) {
  const mode = payload?.mode;
  const sources = payload?.sources;

  if (!MODES.has(mode)) {
    return { status: 400, body: { error: 'invalid-mode' } };
  }
  if (!Array.isArray(sources) || sources.length === 0) {
    return { status: 400, body: { error: 'no-sources' } };
  }
  if (sources.length > MAX_BATCH) {
    return { status: 413, body: { error: 'batch-too-large', max: MAX_BATCH } };
  }
  if (sources.some((source) => typeof source !== 'string')) {
    return { status: 400, body: { error: 'invalid-source' } };
  }
  if (sources.some((source) => Buffer.byteLength(source, 'utf8') > MAX_SOURCE_CHARS * 4)) {
    return { status: 413, body: { error: 'source-too-large' } };
  }

  const maxWidth = Number.isFinite(payload?.maxWidth) && payload.maxWidth > 0
    ? Math.min(4000, Math.round(payload.maxWidth))
    : DEFAULT_MAX_WIDTH;

  const results = sources.map((source) => renderSource(source, mode, maxWidth));

  return { status: 200, body: { results } };
}

const server = http.createServer((req, res) => {
  const started = Date.now();

  if (req.method === 'GET' && req.url === '/health') {
    sendJson(res, 200, { ok: true, pele: peleVersion, modes: [...MODES] });
    return;
  }

  if (req.method !== 'POST' || req.url !== '/render') {
    sendJson(res, 404, { error: 'not-found' });
    return;
  }

  const suppliedToken = req.headers['x-pele-token'] ?? null;
  if (!TOKEN || suppliedToken !== TOKEN) {
    sendJson(res, 401, { error: 'unauthorized' });
    return;
  }

  readJsonBody(req)
    .then((payload) => {
      const { status, body } = handleRender(payload);
      const failures = (body.results ?? []).filter((result) => !result.ok).length;
      console.log(JSON.stringify({
        event: 'render',
        mode: payload?.mode ?? null,
        sources: payload?.sources?.length ?? 0,
        failures,
        ms: Date.now() - started,
      }));
      sendJson(res, status, body);
    })
    .catch((error) => {
      const status = error?.statusCode ?? 400;
      sendJson(res, status, { error: error?.message ?? 'bad-request' });
    });
});

server.keepAliveTimeout = 65000;
server.headersTimeout = 70000;

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        const error = new Error('body-too-large');
        error.statusCode = 413;
        reject(error);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(new Error('invalid-json'));
      }
    });

    req.on('error', reject);
  });
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

function intEnv(name, fallback) {
  const value = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(value) ? value : fallback;
}

function floatEnv(name, fallback) {
  const value = Number.parseFloat(process.env[name] ?? '');
  return Number.isFinite(value) ? value : fallback;
}

function start() {
  server.listen(PORT, () => {
    console.log(JSON.stringify({ event: 'listening', port: PORT, pele: peleVersion, token: TOKEN ? 'set' : 'missing' }));
  });

  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
      server.close(() => process.exit(0));
    });
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  start();
}

export { renderSource, resolveCssVars, handleRender, server };
