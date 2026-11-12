import test from 'node:test';
import assert from 'node:assert/strict';

import { startPinch, pinchCamera, startZoomFor } from '../src/ui/gestures.js';
import { screenToWorld } from '../src/render/render.js';

const view = { width: 400, height: 800, dpr: 1 };
const limits = { min: 0.07, max: 2.6 };
const cam = () => ({ x: 3000, y: 2000, zoom: 1 });

test('spreading two fingers zooms in by the same ratio', () => {
  const start = startPinch({ x: 150, y: 400 }, { x: 250, y: 400 }, cam());
  const next = pinchCamera(start, { x: 100, y: 400 }, { x: 300, y: 400 }, view, limits);
  assert.ok(Math.abs(next.zoom - 2) < 1e-9, `zoom ${next.zoom}`);
});

test('pinching in zooms out, and zoom stays inside the limits', () => {
  const start = startPinch({ x: 100, y: 400 }, { x: 300, y: 400 }, cam());
  assert.ok(pinchCamera(start, { x: 150, y: 400 }, { x: 250, y: 400 }, view, limits).zoom < 1);
  assert.equal(pinchCamera(start, { x: 199, y: 400 }, { x: 201, y: 400 }, view, limits).zoom, limits.min);
  assert.equal(pinchCamera(start, { x: 0, y: 400 }, { x: 4000, y: 400 }, view, limits).zoom, limits.max);
});

test('the map point under the fingers stays under them while pinching', () => {
  const c = cam();
  const a = { x: 120, y: 300 };
  const b = { x: 220, y: 380 };
  const start = startPinch(a, b, c);
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const before = screenToWorld(c, mid.x, mid.y, view);

  // Spread the fingers and slide them to the right and down at the same time.
  const a2 = { x: 160, y: 340 };
  const b2 = { x: 330, y: 470 };
  const next = pinchCamera(start, a2, b2, view, limits);
  const mid2 = { x: (a2.x + b2.x) / 2, y: (a2.y + b2.y) / 2 };
  const after = screenToWorld(next, mid2.x, mid2.y, view);

  assert.ok(Math.abs(after.x - before.x) < 1e-6, `x drifted by ${after.x - before.x}`);
  assert.ok(Math.abs(after.y - before.y) < 1e-6, `y drifted by ${after.y - before.y}`);
});

test('two fingers moving together pan the map without changing the zoom', () => {
  const c = cam();
  const start = startPinch({ x: 100, y: 400 }, { x: 200, y: 400 }, c);
  const next = pinchCamera(start, { x: 160, y: 460 }, { x: 260, y: 460 }, view, limits);
  assert.ok(Math.abs(next.zoom - 1) < 1e-9);
  assert.ok(Math.abs(next.x - (c.x - 60)) < 1e-6);
  assert.ok(Math.abs(next.y - (c.y - 60)) < 1e-6);
});

test('two fingers on the same spot do not blow up', () => {
  const start = startPinch({ x: 100, y: 100 }, { x: 100, y: 100 }, cam());
  const next = pinchCamera(start, { x: 100, y: 100 }, { x: 100, y: 100 }, view, limits);
  assert.ok(Number.isFinite(next.zoom) && Number.isFinite(next.x) && Number.isFinite(next.y));
});

test('a phone starts a little further out than a desktop', () => {
  assert.equal(startZoomFor(1920, 1080, 1), 1);
  assert.equal(startZoomFor(800, 600, 1), 1);
  const phone = startZoomFor(390, 844, 1);
  assert.ok(phone < 1 && phone >= 0.5, `phone zoom ${phone}`);
  assert.ok(startZoomFor(360, 640, 1) <= startZoomFor(480, 900, 1));
});
