// Unit tests for the pure routing/curve helpers in geometry.ts.
//
// geometry.ts has no Figma dependency, so it runs straight under Node's
// built-in test runner with native TypeScript — no install, no mocks:
//   npm test      (→ node --test src/*.test.ts)
//
// Coverage is aimed at the bugs that actually regressed in this module:
//   - bezierHandlesFor: control points must not cross (the S-overshoot)
//   - computeStepWaypoints: H→V / V→H must collapse to a clean L when the
//     destination sits on the matching side (the inverted-condition bug)
//   - betweenOffsetSupported: a clean L has no slidable middle segment
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveAnchor,
  pointOnSide,
  sideDirection,
  betweenOffsetSupported,
  computeStepWaypoints,
  bezierHandlesFor,
  midpoint,
  type Box,
  type Point,
} from './geometry.ts';

const box = (x: number, y: number, width: number, height: number): Box => ({ x, y, width, height });
const approx = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps;
const samePoint = (p: Point, x: number, y: number) => approx(p.x, x) && approx(p.y, y);

// ---------------------------------------------------------------------------
// resolveAnchor
// ---------------------------------------------------------------------------

test('resolveAnchor: a pinned (non-auto) side passes through unchanged', () => {
  const b = box(0, 0, 100, 100);
  for (const side of ['top', 'right', 'bottom', 'left'] as const) {
    assert.equal(resolveAnchor(side, b, b, true), side);
    assert.equal(resolveAnchor(side, b, b, false), side);
  }
});

test('resolveAnchor: auto picks the facing side from the start frame', () => {
  const from = box(0, 0, 100, 100); // center (50,50)
  assert.equal(resolveAnchor('auto', from, box(300, 0, 100, 100), true), 'right');
  assert.equal(resolveAnchor('auto', from, box(-300, 0, 100, 100), true), 'left');
  assert.equal(resolveAnchor('auto', from, box(0, 300, 100, 100), true), 'bottom');
  assert.equal(resolveAnchor('auto', from, box(0, -300, 100, 100), true), 'top');
});

test('resolveAnchor: auto resolves the end side from the end frame back toward start', () => {
  const from = box(0, 0, 100, 100);
  const to = box(300, 0, 100, 100); // end sits to the right of start
  // For the END anchor, the facing side points back toward start → 'left'.
  assert.equal(resolveAnchor('auto', from, to, false), 'left');
});

// ---------------------------------------------------------------------------
// pointOnSide  (offset semantics documented in geometry.ts)
// ---------------------------------------------------------------------------

test('pointOnSide: centers on each edge at the default 0.5 offset', () => {
  const b = box(0, 0, 100, 100);
  assert.ok(samePoint(pointOnSide(b, 'top'), 50, 0));
  assert.ok(samePoint(pointOnSide(b, 'bottom'), 50, 100));
  assert.ok(samePoint(pointOnSide(b, 'left'), 0, 50));
  assert.ok(samePoint(pointOnSide(b, 'right'), 100, 50));
});

test('pointOnSide: offset endpoints follow the documented direction', () => {
  const b = box(0, 0, 100, 100);
  // top/bottom: 0 = left of edge, 1 = right of edge
  assert.ok(samePoint(pointOnSide(b, 'top', 0), 0, 0));
  assert.ok(samePoint(pointOnSide(b, 'top', 1), 100, 0));
  // left/right: 0 = bottom of edge, 1 = top of edge
  assert.ok(samePoint(pointOnSide(b, 'left', 0), 0, 100));
  assert.ok(samePoint(pointOnSide(b, 'left', 1), 0, 0));
});

test('pointOnSide: clamps out-of-range and non-finite offsets', () => {
  const b = box(0, 0, 100, 100);
  assert.ok(samePoint(pointOnSide(b, 'top', 2), 100, 0));   // clamps to 1
  assert.ok(samePoint(pointOnSide(b, 'top', -1), 0, 0));    // clamps to 0
  assert.ok(samePoint(pointOnSide(b, 'top', NaN), 50, 0));  // falls back to 0.5
});

test('sideDirection: unit outward normals', () => {
  assert.ok(samePoint(sideDirection('top'), 0, -1));
  assert.ok(samePoint(sideDirection('bottom'), 0, 1));
  assert.ok(samePoint(sideDirection('left'), -1, 0));
  assert.ok(samePoint(sideDirection('right'), 1, 0));
});

// ---------------------------------------------------------------------------
// bezierHandlesFor — regression guard for the S-overshoot
// ---------------------------------------------------------------------------

test('bezierHandlesFor: handles point along their side normals', () => {
  const { h1, h2 } = bezierHandlesFor({ x: 0, y: 0 }, 'right', { x: 300, y: 0 }, 'left');
  assert.ok(h1.x > 0 && approx(h1.y, 0), 'h1 points right (+x)');
  assert.ok(h2.x < 0 && approx(h2.y, 0), 'h2 points left (-x)');
});

test('bezierHandlesFor: control points never cross (no S overshoot)', () => {
  // Collinear right→left: the two control points must not pass each other,
  // i.e. combined handle length <= span. The earlier bug added ~0.25·span
  // extra and made them cross, producing the S loop.
  const p1 = { x: 0, y: 0 };
  const p2 = { x: 300, y: 0 };
  const span = Math.hypot(p2.x - p1.x, p2.y - p1.y);
  const { h1, h2 } = bezierHandlesFor(p1, 'right', p2, 'left');
  const mag1 = Math.hypot(h1.x, h1.y);
  const mag2 = Math.hypot(h2.x, h2.y);
  assert.ok(mag1 + mag2 <= span + 1e-6, `handles must not cross: ${mag1}+${mag2} <= ${span}`);
  const c1x = p1.x + h1.x;          // first control point
  const c2x = p2.x + h2.x;          // second control point
  assert.ok(c1x <= c2x + 1e-6, `control points must not cross: c1.x ${c1x} <= c2.x ${c2x}`);
});

test('bezierHandlesFor: each handle is capped at half the span on a long connector', () => {
  const p1 = { x: 0, y: 0 };
  const p2 = { x: 400, y: 0 };
  const halfSpan = Math.hypot(p2.x - p1.x, p2.y - p1.y) / 2;
  const { h1, h2 } = bezierHandlesFor(p1, 'right', p2, 'left');
  assert.ok(Math.hypot(h1.x, h1.y) <= halfSpan + 1e-6);
  assert.ok(Math.hypot(h2.x, h2.y) <= halfSpan + 1e-6);
});

test('bezierHandlesFor: short connectors keep a 40px floor so they stay visibly curved', () => {
  // span 20 → halfSpan 10, but the floor keeps the handle at 40.
  const { h1 } = bezierHandlesFor({ x: 0, y: 0 }, 'right', { x: 20, y: 0 }, 'left');
  assert.ok(approx(Math.hypot(h1.x, h1.y), 40), 'short-span handle pinned to the 40px floor');
});

// ---------------------------------------------------------------------------
// computeStepWaypoints — clean-L detection (the inverted-condition regression)
// ---------------------------------------------------------------------------

test('computeStepWaypoints H→V: clean L when destination is below-right (right→top)', () => {
  // start exits 'right', end enters from 'top', end frame is below-right.
  const p1 = { x: 0, y: 0 };
  const p2 = { x: 200, y: 200 };
  const toBox = box(150, 200, 100, 100);
  const pts = computeStepWaypoints(p1, 'right', p2, 'top', 20, toBox);
  assert.equal(pts.length, 3, 'clean L has exactly one corner (3 points)');
  assert.ok(samePoint(pts[1], p2.x, p1.y), 'corner sits at (p2.x, p1.y)');
});

test('computeStepWaypoints H→V: clean L for left→bottom (destination above-left)', () => {
  const p1 = { x: 200, y: 200 };
  const p2 = { x: 0, y: 0 };
  const toBox = box(-50, -100, 100, 100);
  const pts = computeStepWaypoints(p1, 'left', p2, 'bottom', 20, toBox);
  assert.equal(pts.length, 3);
  assert.ok(samePoint(pts[1], p2.x, p1.y));
});

test('computeStepWaypoints V→H: clean L for bottom→left (destination below-right)', () => {
  const p1 = { x: 0, y: 0 };
  const p2 = { x: 200, y: 200 };
  const toBox = box(200, 150, 100, 100);
  const pts = computeStepWaypoints(p1, 'bottom', p2, 'left', 20, toBox);
  assert.equal(pts.length, 3);
  assert.ok(samePoint(pts[1], p1.x, p2.y), 'corner sits at (p1.x, p2.y)');
});

test('computeStepWaypoints H→V: detours (NOT a clean L) when destination is on the wrong side', () => {
  // start exits 'right' but the destination is to the LEFT → no clean L,
  // must route around with a dogleg (more than 3 points).
  const p1 = { x: 200, y: 0 };
  const p2 = { x: 0, y: 200 };
  const toBox = box(-50, 200, 100, 100);
  const pts = computeStepWaypoints(p1, 'right', p2, 'top', 20, toBox);
  assert.ok(pts.length > 3, `wrong-side case must detour, got ${pts.length} points`);
});

test('computeStepWaypoints H→H: right→left makes a single-spine Z elbow', () => {
  const p1 = { x: 100, y: 0 };
  const p2 = { x: 300, y: 100 };
  const pts = computeStepWaypoints(p1, 'right', p2, 'left', 20);
  assert.equal(pts.length, 4, 'two corners on the shared vertical spine');
  // both middle points share the same x (the vertical runway)
  assert.ok(approx(pts[1].x, pts[2].x), 'middle segment is vertical');
  assert.ok(samePoint(pts[0], p1.x, p1.y));
  assert.ok(samePoint(pts[3], p2.x, p2.y));
});

// ---------------------------------------------------------------------------
// betweenOffsetSupported
// ---------------------------------------------------------------------------

test('betweenOffsetSupported: false for an H→V clean L (no middle segment to slide)', () => {
  assert.equal(
    betweenOffsetSupported('right', 'top', { x: 0, y: 0 }, { x: 200, y: 200 }),
    false,
  );
});

test('betweenOffsetSupported: false for a straight H↔H line (equal y)', () => {
  assert.equal(
    betweenOffsetSupported('right', 'left', { x: 0, y: 50 }, { x: 200, y: 50 }),
    false,
  );
});

test('betweenOffsetSupported: true for an offset H↔H connection (has a spine)', () => {
  assert.equal(
    betweenOffsetSupported('right', 'left', { x: 0, y: 0 }, { x: 200, y: 120 }),
    true,
  );
});

// ---------------------------------------------------------------------------
// midpoint
// ---------------------------------------------------------------------------

test('midpoint: geometric center of two points', () => {
  assert.ok(samePoint(midpoint({ x: 0, y: 0 }, { x: 10, y: 20 }), 5, 10));
});
