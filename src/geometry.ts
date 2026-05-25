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

/** Anchor offset semantics (0–1, default 0.5 = center of edge):
 *   - left/right sides: 0 = bottom of edge, 1 = top of edge
 *   - top/bottom sides: 0 = left of edge,   1 = right of edge */
export function pointOnSide(box: Box, side: Side, offset = 0.5): Point {
  const t = Math.max(0, Math.min(1, Number.isFinite(offset) ? offset : 0.5));
  switch (side) {
    case 'top':    return { x: box.x + box.width * t,       y: box.y };
    case 'bottom': return { x: box.x + box.width * t,       y: box.y + box.height };
    case 'left':   return { x: box.x,                       y: box.y + box.height * (1 - t) };
    case 'right':  return { x: box.x + box.width,           y: box.y + box.height * (1 - t) };
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

/** Returns true when the connector has a middle segment whose position
 *  can be meaningfully slid by the Between slider. False for cases where
 *  the path degenerates to a straight line or wraps around (no single
 *  middle spine). */
export function betweenOffsetSupported(
  s1: Side, s2: Side,
  p1: Point, p2: Point,
  fromBox?: Box, toBox?: Box,
): boolean {
  const h1 = s1 === 'left' || s1 === 'right';
  const h2 = s2 === 'left' || s2 === 'right';
  // H↔H opposite sides degenerate to straight horizontal when p1.y == p2.y.
  if (h1 && h2) {
    const bothLeft = s1 === 'left' && s2 === 'left';
    const bothRight = s1 === 'right' && s2 === 'right';
    if (!bothLeft && !bothRight && Math.abs(p1.y - p2.y) < 0.5) return false;
    return true;
  }
  // V↔V facing degenerates to straight vertical when p1.x == p2.x.
  if (!h1 && !h2) {
    if ((s1 === 'top' && s2 === 'bottom') || (s1 === 'bottom' && s2 === 'top')) {
      const facingVertically =
        (s1 === 'bottom' && s2 === 'top' && p1.y <= p2.y) ||
        (s1 === 'top' && s2 === 'bottom' && p1.y >= p2.y);
      if (!facingVertically) return false; // wrap-around: no single spine
      if (Math.abs(p1.x - p2.x) < 0.5) return false;
    }
    return true;
  }
  // Mixed h↔v: clean-L cases have only one corner (nothing to slide). The
  // slider is meaningful only when the routing has to detour (the Z path
  // with two corners) — i.e. when the direction from start side to end
  // side doesn't match the relative position of the frames.
  if (h1) {
    const horizontalFits = s1 === 'right' ? p2.x > p1.x : p2.x < p1.x;
    const verticalFits = s2 === 'top' ? p1.y > p2.y : p1.y < p2.y;
    if (horizontalFits && verticalFits) return false; // clean L
  } else {
    const verticalFits = s1 === 'bottom' ? p2.y > p1.y : p2.y < p1.y;
    const horizontalFits = s2 === 'left' ? p1.x < p2.x : p1.x > p2.x;
    if (verticalFits && horizontalFits) return false; // clean L
  }
  return !!toBox;
  void fromBox;
}

/** Map slider t (0..1) → delta around the natural same-side runway midpoint.
 *  ±2·OUT keeps the spine visually within the box neighborhood. */
function sameSideDelta(t: number, OUT: number): number {
  return (t - 0.5) * 4 * OUT;
}

export function computeStepWaypoints(
  p1: Point, s1: Side,
  p2: Point, s2: Side,
  padding: number,
  toBox?: Box,
  fromBox?: Box,
  between?: number,
): Point[] {
  const h1 = s1 === 'left' || s1 === 'right';
  const h2 = s2 === 'left' || s2 === 'right';
  /** Clearance beyond stroke radius — larger ⇒ line sits further outside frames (orthogonal + mixed bends). Previous base was ~28px. */
  const OUT = Math.max(padding, 56);
  /** Middle-segment offset; 0.5 reproduces the original default geometry. */
  const t = typeof between === 'number' && Number.isFinite(between)
    ? Math.max(0, Math.min(1, between))
    : 0.5;
  // --- H→H (e.g. right → left) ---
  if (h1 && h2) {
    const exitX = s1 === 'right' ? p1.x + OUT : p1.x - OUT;
    const approachX = s2 === 'right' ? p2.x + OUT : p2.x - OUT;
    const bothLeft = s1 === 'left' && s2 === 'left';
    const bothRight = s1 === 'right' && s2 === 'right';
    let midX: number;
    if (bothLeft) {
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

  // --- V→V ---
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
      // Wrap-around branch: between slider not applicable; deterministic geometry.
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

  // Clean L (2 segments, 1 corner) is the visually obvious route when the
  // anchor sides match the relative position of the two frames — e.g.
  // Start exits bottom and End enters left and the End frame sits
  // diagonally below-right. Producing a Z with dogleg in those cases
  // looks "engineered" rather than direct. We detect that case first.
  if (h1) {
    // H→V: s1 horizontal, s2 vertical. Clean L corner = (p2.x, p1.y).
    const horizontalFits = s1 === 'right' ? p2.x > p1.x : p2.x < p1.x;
    const verticalFits = s2 === 'top' ? p1.y > p2.y : p1.y < p2.y;
    if (horizontalFits && verticalFits) {
      return dedupeConsecutivePoints([p1, { x: p2.x, y: p1.y }, p2]);
    }
  } else {
    // V→H: s1 vertical, s2 horizontal. Clean L corner = (p1.x, p2.y).
    const verticalFits = s1 === 'bottom' ? p2.y > p1.y : p2.y < p1.y;
    const horizontalFits = s2 === 'left' ? p1.x < p2.x : p1.x > p2.x;
    if (verticalFits && horizontalFits) {
      return dedupeConsecutivePoints([p1, { x: p1.x, y: p2.y }, p2]);
    }
  }

  // For the Z-routing (overlap / detour) cases, let `t` reach the End
  // frame's own edge instead of stopping at OUT clearance away. Keeps a
  // visible kink (doesn't collapse to an L because outerX/outerY on the
  // other axis still detours), but Between=1.0 now visually nests the
  // middle bend right against the End frame.
  if (h1) {
    let outerX: number;
    if (s1 === 'right') {
      if (toBox.x > p1.x) {
        const exitX = p1.x + OUT;
        const approachX = toBox.x;
        outerX = exitX + t * (approachX - exitX);
      } else {
        outerX = Math.max(p1.x + OUT, toBox.x + toBox.width + OUT);
      }
    } else {
      if (toBox.x + toBox.width < p1.x) {
        const exitX = p1.x - OUT;
        const approachX = toBox.x + toBox.width;
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
    let outerY: number;
    if (s1 === 'bottom') {
      if (toBox.y > p1.y) {
        const exitY = p1.y + OUT;
        const approachY = toBox.y;
        outerY = exitY + t * (approachY - exitY);
      } else {
        outerY = Math.max(p1.y + OUT, toBox.y + toBox.height + OUT);
      }
    } else {
      if (toBox.y + toBox.height < p1.y) {
        const exitY = p1.y - OUT;
        const approachY = toBox.y + toBox.height;
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
  between?: number,
): string {
  const waypoints = computeStepWaypoints(p1, s1, p2, s2, radius, toBox, fromBox, between);
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
  between?: number,
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
  const pts = computeStepWaypoints(p1, s1, p2, s2, padding, toBox, fromBox, between);
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
