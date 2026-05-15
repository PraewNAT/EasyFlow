// Pure geometry helpers for routing flow lines between two rectangles.
import type { Anchor, LineType } from './types';

export interface Box { x: number; y: number; width: number; height: number }
export interface Point { x: number; y: number }
export type Side = 'top' | 'right' | 'bottom' | 'left';

// ---------------------------------------------------------------------------
// Anchor resolution
// ---------------------------------------------------------------------------

export function resolveAnchor(anchor: Anchor, from: Box, to: Box, isStart: boolean): Side {
  if (anchor !== 'auto') return anchor;
  const a = isStart ? from : to;
  const b = isStart ? to : from;
  const ac = { x: a.x + a.width / 2, y: a.y + a.height / 2 };
  const bc = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  const dx = bc.x - ac.x;
  const dy = bc.y - ac.y;
  // Slightly favor left/right for diagonal layouts so side-by-side objects
  // connect to facing edges instead of dropping to top/bottom too eagerly.
  if (Math.abs(dx) >= Math.abs(dy) * 0.65) return dx >= 0 ? 'right' : 'left';
  return dy >= 0 ? 'bottom' : 'top';
}

export function pointOnSide(box: Box, side: Side): Point {
  switch (side) {
    case 'top':    return { x: box.x + box.width / 2, y: box.y };
    case 'bottom': return { x: box.x + box.width / 2, y: box.y + box.height };
    case 'left':   return { x: box.x,                 y: box.y + box.height / 2 };
    case 'right':  return { x: box.x + box.width,     y: box.y + box.height / 2 };
  }
}

export function sideDirection(side: Side): Point {
  switch (side) {
    case 'top':    return { x: 0,  y: -1 };
    case 'bottom': return { x: 0,  y:  1 };
    case 'left':   return { x: -1, y:  0 };
    case 'right':  return { x:  1, y:  0 };
  }
}

// ---------------------------------------------------------------------------
// Step (orthogonal) routing — returns axis-aligned waypoints
//
// For parallel same-side anchors (both left, both right, both top, both bottom): one shared runway
// on the outside (min/max) so the connector never dips through a frame. Opposite-side pairs interpolate.
// For H→V and V→H (mixed): route AROUND the destination frame so the line
// never passes through it.  toBox must be provided for correct avoidance.
// ---------------------------------------------------------------------------

/** Remove consecutive duplicate points (avoid zero-length segments in rounded orth paths). */
function dedupeConsecutivePoints(pts: Point[]): Point[] {
  const out: Point[] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (!last || last.x !== p.x || last.y !== p.y) out.push(p);
  }
  return out;
}

/**
 * X-coordinate for vertical travel lane when routing top↔bottom between two rects without cutting
 * through either body: midpoint of horizontal gap if separated; else outside the union left/right,
 * biased toward nearer average anchor-x.
 */
function laneXForOppositeVerticalSides(fromBox: Box, toBox: Box, p1: Point, p2: Point, OUT: number): number {
  const fromR = fromBox.x + fromBox.width;
  const toR = toBox.x + toBox.width;
  const gapEps = 0.5;
  if (fromR < toBox.x - gapEps) {
    return (fromR + toBox.x) / 2;
  }
  if (toR < fromBox.x - gapEps) {
    return (toR + fromBox.x) / 2;
  }
  const leftLane = Math.min(fromBox.x, toBox.x) - OUT;
  const rightLane = Math.max(fromR, toR) + OUT;
  const mid = (p1.x + p2.x) / 2;
  return Math.abs(mid - leftLane) <= Math.abs(mid - rightLane) ? leftLane : rightLane;
}

/** Path-offset axis from the user's POV in the UI.
 *  - 'horizontal' (H↔H or mixed H→V): the perpendicular spine slides horizontally.
 *  - 'vertical' (V↔V facing or mixed V→H): the perpendicular spine slides vertically.
 *  - null: the shape doesn't have a single offsettable spine (wrap-around). */
export type PathOffsetAxis = 'horizontal' | 'vertical' | null;

export interface PathOffsetSupport {
  supported: boolean;
  axis: PathOffsetAxis;
}

/** Decide whether the path-offset slider applies to this connector shape.
 *  Returns the axis along which the spine moves, or null when the shape
 *  is wrap-around (no single spine to slide). */
export function pathOffsetSupport(
  s1: Side, s2: Side,
  fromBox: Box, toBox: Box,
  p1: Point, p2: Point,
): PathOffsetSupport {
  const h1 = s1 === 'left' || s1 === 'right';
  const h2 = s2 === 'left' || s2 === 'right';

  if (!h1 && !h2 && ((s1 === 'top' && s2 === 'bottom') || (s1 === 'bottom' && s2 === 'top'))) {
    // V↔V can degenerate into a 6-point wrap-around when the sides face the
    // wrong way; no single offset parameter applies to that path.
    const facingVertically =
      (s1 === 'bottom' && s2 === 'top' && p1.y <= p2.y) ||
      (s1 === 'top' && s2 === 'bottom' && p1.y >= p2.y);
    if (!facingVertically) return { supported: false, axis: null };
  }
  // fromBox/toBox aren't needed beyond the wrap-around check above.
  void fromBox; void toBox;

  if (h1 && h2) return { supported: true, axis: 'horizontal' };
  if (!h1 && !h2) return { supported: true, axis: 'vertical' };
  return { supported: true, axis: h1 ? 'horizontal' : 'vertical' };
}

/** Translate slider t (0–1, 0.5 = no change) into a delta around the natural
 *  midpoint used by same-side runways. ±2·OUT keeps the spine in a reasonable
 *  visual range without snapping. */
function sameSideDelta(t: number, OUT: number): number {
  return (t - 0.5) * 4 * OUT;
}

export function computeStepWaypoints(
  p1: Point, s1: Side,
  p2: Point, s2: Side,
  padding: number,
  toBox?: Box,
  fromBox?: Box,
  offset?: number,
): Point[] {
  const h1 = s1 === 'left' || s1 === 'right';
  const h2 = s2 === 'left' || s2 === 'right';
  /** Clearance beyond stroke radius — larger ⇒ line sits further outside frames (orthogonal + mixed bends). Previous base was ~28px. */
  const OUT = Math.max(padding, 56);
  /** 0–1 slider value; 0.5 reproduces the original default geometry exactly. */
  const t = typeof offset === 'number' && Number.isFinite(offset)
    ? Math.max(0, Math.min(1, offset))
    : 0.5;
  // --- H→H (e.g. right → left) ---
  if (h1 && h2) {
    const exitX = s1 === 'right' ? p1.x + OUT : p1.x - OUT;
    const approachX = s2 === 'right' ? p2.x + OUT : p2.x - OUT;
    const bothLeft = s1 === 'left' && s2 === 'left';
    const bothRight = s1 === 'right' && s2 === 'right';
    let midX: number;
    if (bothLeft) {
      // Outward = -X. Slider t shifts the runway perpendicular to the spine,
      // clamped so we never re-enter either frame's interior.
      const naturalMidX = Math.min(exitX, approachX);
      const maxInside = fromBox && toBox
        ? Math.min(fromBox.x, toBox.x) - 1
        : naturalMidX + 2 * OUT;
      midX = Math.min(maxInside, naturalMidX - sameSideDelta(t, OUT));
    } else if (bothRight) {
      const naturalMidX = Math.max(exitX, approachX);
      const minOutside = fromBox && toBox
        ? Math.max(fromBox.x + fromBox.width, toBox.x + toBox.width) + 1
        : naturalMidX - 2 * OUT;
      midX = Math.max(minOutside, naturalMidX + sameSideDelta(t, OUT));
    } else {
      midX = exitX + t * (approachX - exitX);
    }
    return dedupeConsecutivePoints([p1, { x: midX, y: p1.y }, { x: midX, y: p2.y }, p2]);
  }

  // --- V→V (left/right/up/down sides as exit normals; not horizontal edge pairs) ---
  if (!h1 && !h2) {
    const exitY = s1 === 'bottom' ? p1.y + OUT : p1.y - OUT;
    const approachY = s2 === 'bottom' ? p2.y + OUT : p2.y - OUT;
    const bothTop = s1 === 'top' && s2 === 'top';
    const bothBot = s1 === 'bottom' && s2 === 'bottom';
    let midY: number;
    if (bothTop) {
      const naturalMidY = Math.min(exitY, approachY);
      const maxInside = fromBox && toBox
        ? Math.min(fromBox.y, toBox.y) - 1
        : naturalMidY + 2 * OUT;
      midY = Math.min(maxInside, naturalMidY - sameSideDelta(t, OUT));
    } else if (bothBot) {
      const naturalMidY = Math.max(exitY, approachY);
      const minOutside = fromBox && toBox
        ? Math.max(fromBox.y + fromBox.height, toBox.y + toBox.height) + 1
        : naturalMidY - 2 * OUT;
      midY = Math.max(minOutside, naturalMidY + sameSideDelta(t, OUT));
    } else if (
      fromBox && toBox &&
      ((s1 === 'top' && s2 === 'bottom') || (s1 === 'bottom' && s2 === 'top'))
    ) {
      const facingVertically =
        (s1 === 'bottom' && s2 === 'top' && p1.y <= p2.y) ||
        (s1 === 'top' && s2 === 'bottom' && p1.y >= p2.y);
      if (facingVertically) {
        midY = p1.y + t * (p2.y - p1.y);
        return dedupeConsecutivePoints([p1, { x: p1.x, y: midY }, { x: p2.x, y: midY }, p2]);
      }
      // Wrap-around branch: pathOffsetSupport() reports unsupported so the UI
      // disables the slider; we just fall through with the deterministic geometry.
      const laneX = laneXForOppositeVerticalSides(fromBox, toBox, p1, p2, OUT);
      const yAboveBoth = Math.min(fromBox.y, toBox.y) - OUT;
      const yBelowBoth = Math.max(fromBox.y + fromBox.height, toBox.y + toBox.height) + OUT;
      if (s1 === 'top' && s2 === 'bottom') {
        return dedupeConsecutivePoints([
          p1,
          { x: p1.x, y: yAboveBoth },
          { x: laneX, y: yAboveBoth },
          { x: laneX, y: yBelowBoth },
          { x: p2.x, y: yBelowBoth },
          p2,
        ]);
      }
      return dedupeConsecutivePoints([
        p1,
        { x: p1.x, y: yBelowBoth },
        { x: laneX, y: yBelowBoth },
        { x: laneX, y: yAboveBoth },
        { x: p2.x, y: yAboveBoth },
        p2,
      ]);
    } else {
      midY = exitY + t * (approachY - exitY);
    }
    return dedupeConsecutivePoints([p1, { x: p1.x, y: midY }, { x: p2.x, y: midY }, p2]);
  }

  // --- Mixed: H→V or V→H ---
  if (!toBox) {
    if (h1) return dedupeConsecutivePoints([p1, { x: p2.x, y: p1.y }, p2]);
    return dedupeConsecutivePoints([p1, { x: p1.x, y: p2.y }, p2]);
  }

  if (h1) {
    // s1 horizontal (right/left), s2 vertical (top/bottom)
    let outerX: number;
    if (s1 === 'right') {
      if (toBox.x > p1.x) {
        const exitX = p1.x + OUT;
        const approachX = toBox.x - OUT;
        outerX = exitX + t * (approachX - exitX);
      } else {
        outerX = Math.max(p1.x + OUT, toBox.x + toBox.width + OUT);
      }
    } else {
      if (toBox.x + toBox.width < p1.x) {
        const exitX = p1.x - OUT;
        const approachX = toBox.x + toBox.width + OUT;
        outerX = exitX + t * (approachX - exitX);
      } else {
        outerX = Math.min(p1.x - OUT, toBox.x - OUT);
      }
    }
    const outerY = s2 === 'top'
      ? Math.min(p2.y - OUT, toBox.y - OUT)
      : Math.max(p2.y + OUT, toBox.y + toBox.height + OUT);
    return dedupeConsecutivePoints([p1, { x: outerX, y: p1.y }, { x: outerX, y: outerY }, { x: p2.x, y: outerY }, p2]);
  } else {
    // s1 vertical (top/bottom), s2 horizontal (right/left)
    let outerY: number;
    if (s1 === 'bottom') {
      if (toBox.y > p1.y) {
        const exitY = p1.y + OUT;
        const approachY = toBox.y - OUT;
        outerY = exitY + t * (approachY - exitY);
      } else {
        outerY = Math.max(p1.y + OUT, toBox.y + toBox.height + OUT);
      }
    } else {
      if (toBox.y + toBox.height < p1.y) {
        const exitY = p1.y - OUT;
        const approachY = toBox.y + toBox.height + OUT;
        outerY = exitY + t * (approachY - exitY);
      } else {
        outerY = Math.min(p1.y - OUT, toBox.y - OUT);
      }
    }
    const outerX = s2 === 'right'
      ? Math.max(p2.x + OUT, toBox.x + toBox.width + OUT)
      : Math.min(p2.x - OUT, toBox.x - OUT);
    return dedupeConsecutivePoints([p1, { x: p1.x, y: outerY }, { x: outerX, y: outerY }, { x: outerX, y: p2.y }, p2]);
  }
}

// Build SVG path data from axis-aligned waypoints with quadratic rounded corners.
export function roundedPath(points: Point[], radius: number): string {
  if (points.length < 2) return '';
  let out = `M ${fmt(points[0].x)} ${fmt(points[0].y)}`;
  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1];
    const curr = points[i];
    const next = points[i + 1];
    const r = Math.min(radius, dist(prev, curr) / 2, dist(curr, next) / 2);
    if (r <= 0.5) { out += ` L ${fmt(curr.x)} ${fmt(curr.y)}`; continue; }
    const inP  = toward(curr, prev, r);
    const outP = toward(curr, next, r);
    out += ` L ${fmt(inP.x)} ${fmt(inP.y)} Q ${fmt(curr.x)} ${fmt(curr.y)} ${fmt(outP.x)} ${fmt(outP.y)}`;
  }
  const last = points[points.length - 1];
  out += ` L ${fmt(last.x)} ${fmt(last.y)}`;
  return out;
}

// ---------------------------------------------------------------------------
// "Curved" line type — same orthogonal spine as step, with larger corner radii (soft elbows), not one cubic Bézier.
// ---------------------------------------------------------------------------

/**
 * Boost corner rounding for curved flows.
 * roundedPath clamps each weld with min(R, adjacent/2) — pick R near the geometric ceiling (~½ of the
 * shortest segment) plus a generous floor so long spans read very soft (“green line”).
 */
export function curvedOrthoRadius(waypoints: Point[], baseRadius: number): number {
  const floor = Math.max(baseRadius * 16, 200);
  if (waypoints.length < 3) return floor;

  let minLeg = Infinity;
  for (let i = 1; i < waypoints.length; i++) {
    const a = waypoints[i - 1];
    const b = waypoints[i];
    minLeg = Math.min(minLeg, Math.hypot(b.x - a.x, b.y - a.y));
  }
  if (!Number.isFinite(minLeg) || minLeg <= 0) return floor;

  // As high as orthogonal fillets allow before roundedPath clamps (≈ half the shortest waypoint leg).
  const nearGeomMax = Math.max(0, minLeg * 0.497 - 0.75);
  return Math.min(1_500_000, Math.max(floor, nearGeomMax));
}

// ---------------------------------------------------------------------------
// Main entry point used by code.ts
// ---------------------------------------------------------------------------

export function buildPath(
  lineType: LineType,
  p1: Point, s1: Side,
  p2: Point, s2: Side,
  radius: number,
  toBox?: Box,
  fromBox?: Box,
  offset?: number,
): string {
  const waypoints = computeStepWaypoints(p1, s1, p2, s2, radius, toBox, fromBox, offset);
  const rEff = lineType === 'curved' ? curvedOrthoRadius(waypoints, radius) : radius;
  return roundedPath(waypoints, rEff);
}

// The midpoint ALONG the actual path (not the geometric center of p1–p2).
// For a step path, this is the point at 50% of total path length.
// For a curved (cubic-bezier) path, this is B(0.5).
export function pathMidpoint(
  lineType: LineType,
  p1: Point, s1: Side,
  p2: Point, s2: Side,
  padding: number,
  toBox?: Box,
  fromBox?: Box,
  offset?: number,
): Point {
  if (lineType === 'curved') {
    const { h1, h2 } = bezierHandlesFor(p1, s1, p2, s2);
    const c1 = { x: p1.x + h1.x, y: p1.y + h1.y };
    const c2 = { x: p2.x + h2.x, y: p2.y + h2.y };
    // Cubic Bézier at t = 0.5 → 0.125·P0 + 0.375·P1 + 0.375·P2 + 0.125·P3
    return {
      x: 0.125 * p1.x + 0.375 * c1.x + 0.375 * c2.x + 0.125 * p2.x,
      y: 0.125 * p1.y + 0.375 * c1.y + 0.375 * c2.y + 0.125 * p2.y,
    };
  }
  const pts = computeStepWaypoints(p1, s1, p2, s2, padding, toBox, fromBox, offset);
  return waypointMidpoint(pts);
}

// ---------------------------------------------------------------------------
// True curved (cubic Bézier) routing — handles point along each side normal
// so the curve exits perpendicular to its frame and approaches perpendicular
// to the destination, producing a smooth S-curve like Figma's connector.
// ---------------------------------------------------------------------------

/**
 * Compute control-point offset vectors for a cubic Bézier connecting (p1, s1)
 * to (p2, s2). Handles are returned RELATIVE to their endpoints (Figma's
 * VectorSegment.tangentStart / tangentEnd convention).
 */
export function bezierHandlesFor(
  p1: Point, s1: Side,
  p2: Point, s2: Side,
): { h1: Point; h2: Point } {
  const n1 = sideDirection(s1);
  const n2 = sideDirection(s2);
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  // Distance projected along each normal — keeps the handle long enough to
  // bend smoothly even when frames are vertically aligned but horizontally far
  // (or vice versa).
  const projected1 = Math.abs(n1.x * dx + n1.y * dy);
  const projected2 = Math.abs(n2.x * dx + n2.y * dy);
  const span = Math.hypot(dx, dy);
  // Magnitude: at least 60px so short connectors still curve, capped to half
  // the gap so handles don't overshoot. Using max(projected, 0.5·span) lets
  // perpendicular layouts still get a soft bow.
  const mag1 = Math.max(60, Math.min(projected1 * 0.5 + span * 0.25, span * 0.6));
  const mag2 = Math.max(60, Math.min(projected2 * 0.5 + span * 0.25, span * 0.6));
  return {
    h1: { x: n1.x * mag1, y: n1.y * mag1 },
    h2: { x: n2.x * mag2, y: n2.y * mag2 },
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function waypointMidpoint(pts: Point[]): Point {
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += dist(pts[i - 1], pts[i]);
  let half = total / 2;
  for (let i = 1; i < pts.length; i++) {
    const seg = dist(pts[i - 1], pts[i]);
    if (half <= seg) {
      const t = half / seg;
      return { x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t, y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * t };
    }
    half -= seg;
  }
  return pts[pts.length - 1];
}

function dist(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function toward(from: Point, target: Point, d: number): Point {
  const l = dist(from, target);
  if (l === 0) return { ...from };
  const t = d / l;
  return { x: from.x + (target.x - from.x) * t, y: from.y + (target.y - from.y) * t };
}

function fmt(n: number): string { return n.toFixed(2); }

// Keep old export name so code.ts doesn't need to change the import.
export function midpoint(p1: Point, p2: Point): Point {
  return { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
}
