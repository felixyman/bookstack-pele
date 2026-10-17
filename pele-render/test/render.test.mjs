import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

// Configure the service before importing it (constants are read at import time).
process.env.PELE_RENDER_TOKEN = 'test-token';
process.env.PELE_MAX_BATCH = '3';
process.env.PELE_MAX_SOURCE = '20000';

const { renderSource, resolveCssVars, handleRender, server } = await import('../server.mjs');

const VALID_SOURCE = 'flowchart LR\n  A[One] --> B[Two]';
const BROKEN_SOURCE = 'flowchart LR\n  A -->';

test('resolveCssVars flattens Pele CSS variables to literals', () => {
  const { svg } = renderSource(VALID_SOURCE, 'web');
  assert.ok(svg.includes('var(--pele-'), 'expected raw SVG to reference pele variables');

  const resolved = resolveCssVars(svg);
  assert.ok(!resolved.includes('var('), 'expected no var() references after resolution');
  assert.ok(resolved.includes('#1f1f1f'), 'expected default foreground colour to be inlined');
});

test('web mode returns var-driven SVG', () => {
  const result = renderSource(VALID_SOURCE, 'web');
  assert.equal(result.ok, true);
  assert.equal(result.type, 'flowchart');
  assert.ok(result.width > 0 && result.height > 0);
  assert.ok(result.svg.includes('var(--pele-'));
});

test('export mode returns literal SVG', () => {
  const result = renderSource(VALID_SOURCE, 'export');
  assert.equal(result.ok, true);
  assert.ok(result.svg.includes('<svg'));
  assert.ok(!result.svg.includes('var('));
});

test('pdf mode returns a PNG data URI', () => {
  const result = renderSource(VALID_SOURCE, 'pdf');
  assert.equal(result.ok, true);
  assert.ok(result.pngDataUri.startsWith('data:image/png;base64,'));

  const png = Buffer.from(result.pngDataUri.split(',')[1], 'base64');
  assert.deepEqual([...png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], 'expected PNG magic bytes');
});

test('render errors are isolated with position details', () => {
  const result = renderSource(BROKEN_SOURCE, 'web');
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'syntax');
  assert.ok(result.error.line > 0);
});

test('handleRender validates mode and sources', () => {
  assert.equal(handleRender({ mode: 'nope', sources: ['x'] }).status, 400);
  assert.equal(handleRender({ mode: 'web', sources: [] }).status, 400);
  assert.equal(handleRender({ mode: 'web', sources: ['a', 'b', 'c', 'd'] }).status, 413);
  assert.equal(handleRender({ mode: 'web', sources: [42] }).status, 400);
});

test('handleRender renders a valid batch', () => {
  const { status, body } = handleRender({ mode: 'export', sources: [VALID_SOURCE, BROKEN_SOURCE] });
  assert.equal(status, 200);
  assert.equal(body.results.length, 2);
  assert.equal(body.results[0].ok, true);
  assert.equal(body.results[1].ok, false);
});

test('http: health, auth and render endpoints', async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).ok, true);

    const unauthorized = await fetch(`${base}/render`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'web', sources: [VALID_SOURCE] }),
    });
    assert.equal(unauthorized.status, 401);

    const authorized = await fetch(`${base}/render`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-pele-token': 'test-token' },
      body: JSON.stringify({ mode: 'web', sources: [VALID_SOURCE] }),
    });
    assert.equal(authorized.status, 200);
    const payload = await authorized.json();
    assert.equal(payload.results[0].ok, true);

    const missing = await fetch(`${base}/nope`);
    assert.equal(missing.status, 404);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

after(() => {
  server.close();
});
