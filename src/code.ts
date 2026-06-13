// EasyFlow – Figma sandbox entry point.
// Build marker — bump on every behaviour change so the user can verify
// Figma actually loaded the latest dist (Figma aggressively caches
// development plugins; older bundles persist across reloads).
console.log('[EasyFlow] build 2026-06-14-clean-L-hv loaded');

// Safety net: any rejection that escapes a handler (e.g. a getPluginData
// throw on a node Figma silently deleted) shouldn't crash the plugin or
// skip downstream syncUi() calls. Log and swallow.
(globalThis as { addEventListener?: (e: string, h: (ev: { reason?: unknown; preventDefault?: () => void }) => void) => void })
  .addEventListener?.('unhandledrejection', (ev) => {
    console.warn('[EasyFlow] swallowed unhandled rejection:', ev.reason);
    ev.preventDefault?.();
  });
// documentAccess: "dynamic-page" requires loadAllPagesAsync() before
// documentchange events fire. That call is expensive on large multi-page
// documents, so we defer it until a flow actually exists (or is created)
// — the plugin opens instantly even in huge files and only pays the load
// cost when documentchange would actually do useful work.

import {
  betweenOffsetSupported,
  bezierHandlesFor,
  buildPath,
  computeStepWaypoints,
  pathMidpoint,
  pointOnSide,
  resolveAnchor,
  sideDirection,
  type Box,
  type Point,
  type Side,
} from './geometry';
import {
  DEFAULT_ANCHOR_OFFSET,
  DEFAULT_BETWEEN_OFFSET,
  DEFAULT_STYLE,
  FLOW_NAME_PREFIX,
  PLUGIN_DATA_KEY,
  type ArrowType,
  type FlowMeta,
  type FlowStyle,
  type PresetStyles,
  type PluginToUi,
  type UiToPlugin,
  // PresetName removed — presets now use arbitrary string keys
} from './types';

/** Plugin data on label/frame nodes so clicks promote to the flow vector. */
const LABEL_OWNER_KEY = 'easyflow.owner';

// ---------------------------------------------------------------------------
// Plugin bootstrap — everything synchronous so it's ready on the first event
// ---------------------------------------------------------------------------

figma.showUI(__html__, { width: 368, height: 560, themeColors: true });

let active = true;
let lastStyle: FlowStyle = clone(DEFAULT_STYLE);

// Track the previous selection so we can determine direction (start → end).
let lastSelectionIds: string[] = figma.currentPage.selection.map((n) => n.id);

// Reverse indices — declared up here (before the bootstrap call below
// uses them) because esbuild's IIFE bundle would otherwise hit them
// while still in their temporal dead zone and throw
// "cannot read property 'clear' of undefined".
//   endpointToFlows: endpoint node id → set of flow ids that use it
//   flowToEndpoints: flow id → its two endpoint ids (O(1) delete unindex)
//   flowToLabel / labelToFlow: bidirectional flow ↔ label-node link
const endpointToFlows = new Map<string, Set<string>>();
const flowToEndpoints = new Map<string, [string, string]>();
const flowToLabel = new Map<string, string>();
const labelToFlow = new Map<string, string>();

// Register selection / page handlers synchronously — both work in
// dynamic-page mode without loadAllPagesAsync.
figma.on('selectionchange', () => { void onSelectionChangedAsync(); });
figma.on('currentpagechange', () => { void onCurrentPageChangedAsync(); });

// Build the endpoint index from the current page synchronously. This is a
// shallow scan over top-level children (flows are always page-level — see
// createFlow), not a recursive findAll, so it's cheap even on busy pages.
bootstrapEndpointIndexForCurrentPage();
// If the current page already has flows, kick off the (expensive) full
// document load so frame moves rerender flows. Runs in the background so
// the plugin UI is interactive immediately.
maybeEnableDocChangeForCurrentPage();

// Load persisted preset styles and notify UI when ready.
const SAVED_PRESET_STYLES_KEY = 'easyflow.presetStyles';
void figma.clientStorage.getAsync(SAVED_PRESET_STYLES_KEY).then((styles) => {
  if (styles && typeof styles === 'object') {
    const raw = styles as Record<string, unknown>;
    // Migrate legacy 'custom' key → 'default'
    if (raw['custom'] && !raw['default']) {
      raw['default'] = raw['custom'];
      delete raw['custom'];
    }
    const presetStyles = normalizePresetStyles(raw as PresetStyles);
    if (presetStyles['default']) lastStyle = presetStyles['default'];
    figma.ui.postMessage({ type: 'preset-styles', styles: presetStyles } as PluginToUi);
  }
});

// ---------------------------------------------------------------------------
// Lazy full-document access
// ---------------------------------------------------------------------------

let docAccessPromise: Promise<void> | null = null;

function ensureFullDocAccess(): Promise<void> {
  if (docAccessPromise) return docAccessPromise;
  docAccessPromise = (async () => {
    await figma.loadAllPagesAsync();
    figma.on('documentchange', onDocumentChanged);
    // The user may have moved endpoint frames while the load was running.
    // Queue every tracked flow's endpoints once so the deferred render
    // catches up to the current positions.
    if (flowToEndpoints.size > 0) {
      for (const [, [fromId, toId]] of flowToEndpoints) {
        pendingFlowGeoEndpointIds.add(fromId);
        pendingFlowGeoEndpointIds.add(toId);
      }
      scheduleFlowRerenderForMovedEndpoints();
    }
  })();
  return docAccessPromise;
}

function maybeEnableDocChangeForCurrentPage(): void {
  if (flowToEndpoints.size > 0) void ensureFullDocAccess();
}

async function onCurrentPageChangedAsync(): Promise<void> {
  bootstrapEndpointIndexForCurrentPage();
  maybeEnableDocChangeForCurrentPage();
  await syncUi();
}

// ---------------------------------------------------------------------------
// Selection handler
// ---------------------------------------------------------------------------

async function onSelectionChangedAsync(): Promise<void> {
  const sel = figma.currentPage.selection;

  // Promote clicks on inner children (vector/text) to the flow wrapper.
  if (await promoteSelection()) return; // will re-fire selectionchange

  const previousIds = lastSelectionIds;
  lastSelectionIds = sel.map((n) => n.id);

  if (active
    && sel.length === 2
    && sel[0].id !== sel[1].id
    && sel.every(isConnectableNode)
    && sel.every((n) => readMeta(n) === null)) {
    const existing = await findFlowBetween(sel[0].id, sel[1].id);
    if (existing) {
      figma.currentPage.selection = [existing];
      return;
    }
    let startNode: SceneNode = sel[0];
    let endNode: SceneNode = sel[1];
    if (previousIds.length === 1) {
      const s = sel.find((n) => n.id === previousIds[0]);
      const e = sel.find((n) => n.id !== previousIds[0]);
      if (s && e) { startNode = s; endNode = e; }
    }
    void createAndSelectFlow(startNode, endNode);
    return;
  }

  await syncUi();
}

async function createAndSelectFlow(from: SceneNode, to: SceneNode): Promise<void> {
  // Newly auto-drawn flows always start with 'auto' anchors so the router
  // picks the best sides from the actual frame positions instead of
  // inheriting whatever the user last pinned on a previous flow.
  // Explicitly seed offsets to center so a freshly created flow can never
  // inherit a non-default value (UI also resets sliders on selection sync).
  const meta: FlowMeta = {
    ...clone(lastStyle),
    startAnchor: 'auto',
    endAnchor: 'auto',
    fromNodeId: from.id,
    toNodeId: to.id,
    startOffset: DEFAULT_ANCHOR_OFFSET,
    endOffset: DEFAULT_ANCHOR_OFFSET,
    betweenOffset: DEFAULT_BETWEEN_OFFSET,
  };
  try {
    const flow = await createFlow(meta);
    figma.currentPage.selection = [flow];
    // selectionchange will fire → syncUi runs automatically.
    // Now that at least one flow exists, ensure documentchange is wired
    // up so future endpoint moves rerender it.
    void ensureFullDocAccess();
  } catch (err) {
    figma.notify('EasyFlow: ' + String(err));
    await syncUi();
  }
}

// ---------------------------------------------------------------------------
// UI message handler
// ---------------------------------------------------------------------------

figma.ui.onmessage = async (msg: UiToPlugin) => {
  switch (msg.type) {
    case 'ui-ready':
      await syncUi();
      break;
    case 'set-active':
      active = msg.active;
      break;
    case 'create-flow':
      lastStyle = msg.style;
      await handleCreateOrUpdate(msg.style);
      break;
    case 'update-style':
      lastStyle = msg.style;
      await handleCreateOrUpdate(msg.style);
      break;
    case 'swap-direction':
      await handleSwap();
      break;
    case 'update-anchor-offsets':
      await handleUpdateAnchorOffsets(msg.startOffset, msg.endOffset, msg.betweenOffset);
      break;
    case 'save-preset-styles': {
      const presetStyles = normalizePresetStyles(msg.styles);
      if (presetStyles['default']) lastStyle = presetStyles['default'];
      void figma.clientStorage.setAsync(SAVED_PRESET_STYLES_KEY, presetStyles);
      break;
    }
    case 'resize-ui': {
      const h = Math.round(msg.height);
      const clamped = Math.min(980, Math.max(260, Number.isFinite(h) ? h : 400));
      figma.ui.resize(368, clamped);
      break;
    }
  }
};

// ---------------------------------------------------------------------------
// Selection promotion: click on inner vector/text → select the flow wrapper
// ---------------------------------------------------------------------------

async function promoteSelection(): Promise<boolean> {
  const sel = figma.currentPage.selection;
  const result: SceneNode[] = [];
  let changed = false;
  const seen = new Set<string>();

  for (const n of sel) {
    let target: SceneNode = n;
    try {
      if (!readMeta(n)) {
        const parent = n.parent;
        if (parent && readMeta(parent)) {
          target = parent as SceneNode;
          changed = true;
        } else {
          const ownerId = n.getPluginData(LABEL_OWNER_KEY);
          if (ownerId) {
            const owner = await figma.getNodeByIdAsync(ownerId);
            if (owner && readMeta(owner)) {
              target = owner as SceneNode;
              changed = true;
            }
          }
        }
      }
    } catch {
      // Stale node handle — skip it. Better than letting the rejection
      // abort selection promotion and downstream syncUi.
      continue;
    }
    if (!seen.has(target.id)) {
      seen.add(target.id);
      result.push(target);
    }
  }

  if (changed) {
    figma.currentPage.selection = result;
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Selection → UI sync
// ---------------------------------------------------------------------------

type SelectionMode = 'none' | 'two-frames' | 'one-flow' | 'multi-flow' | 'mixed';

interface Classification {
  mode: SelectionMode;
  style?: FlowStyle;
  singleFlow?: SceneNode;
}

function classifySelection(): Classification {
  const sel = figma.currentPage.selection;
  if (sel.length === 0) return { mode: 'none' };

  const flows = sel.filter((n) => readMeta(n) !== null);

  if (flows.length === sel.length) {
    if (flows.length === 1 && (flows[0].type === 'VECTOR' || flows[0].type === 'FRAME')) {
      return {
        mode: 'one-flow',
        style: extractStyle(readMeta(flows[0])!),
        singleFlow: flows[0],
      };
    }
    return { mode: 'multi-flow' };
  }

  if (flows.length === 0 && sel.length === 2 && sel.every(isConnectableNode)) {
    return { mode: 'two-frames' };
  }
  return { mode: 'mixed' };
}

async function syncUi(): Promise<void> {
  const { mode, style, singleFlow } = classifySelection();

  const payload: PluginToUi = {
    type: 'selection',
    mode,
    style: style ?? lastStyle,
    active,
  };

  // For a single selected flow, compute which sides are actually connected
  // and what the source/destination frame names are.
  if (mode === 'one-flow' && singleFlow) {
    const meta = readMeta(singleFlow);
    if (meta) {
      const fromNode = await figma.getNodeByIdAsync(meta.fromNodeId) as SceneNode | null;
      const toNode = await figma.getNodeByIdAsync(meta.toNodeId) as SceneNode | null;
      if (fromNode && toNode) {
        const fromBox = absoluteBox(fromNode);
        const toBox = absoluteBox(toNode);
        const startSide = resolveAnchor(meta.startAnchor, fromBox, toBox, true);
        const endSide = resolveAnchor(meta.endAnchor, fromBox, toBox, false);
        payload.resolvedStartSide = startSide;
        payload.resolvedEndSide = endSide;
        payload.fromName = fromNode.name;
        payload.toName = toNode.name;
        payload.startOffset = typeof meta.startOffset === 'number' ? meta.startOffset : DEFAULT_ANCHOR_OFFSET;
        payload.endOffset = typeof meta.endOffset === 'number' ? meta.endOffset : DEFAULT_ANCHOR_OFFSET;
        payload.betweenOffset = typeof meta.betweenOffset === 'number' ? meta.betweenOffset : DEFAULT_BETWEEN_OFFSET;
        const startPt = pointOnSide(fromBox, startSide, payload.startOffset);
        const endPt = pointOnSide(toBox, endSide, payload.endOffset);
        payload.betweenOffsetSupported = meta.lineType === 'step'
          && betweenOffsetSupported(startSide, endSide, startPt, endPt, fromBox, toBox);
      }
    }
  } else if (mode === 'multi-flow') {
    // Aggregate start/end offsets across selected flows. Each tracks its own
    // "mixed" state — UI shows the per-slider label independently.
    const flows = figma.currentPage.selection.filter((n) => readMeta(n) !== null);
    let firstStart: number | null = null;
    let firstEnd: number | null = null;
    let firstBetween: number | null = null;
    let startMixed = false;
    let endMixed = false;
    let betweenMixed = false;
    let anyBetweenSupported = false;
    for (const f of flows) {
      const m = readMeta(f);
      if (!m) continue;
      const sOff = typeof m.startOffset === 'number' ? m.startOffset : DEFAULT_ANCHOR_OFFSET;
      const eOff = typeof m.endOffset === 'number' ? m.endOffset : DEFAULT_ANCHOR_OFFSET;
      const bOff = typeof m.betweenOffset === 'number' ? m.betweenOffset : DEFAULT_BETWEEN_OFFSET;
      if (firstStart === null) firstStart = sOff;
      else if (Math.abs(sOff - firstStart) > 1e-6) startMixed = true;
      if (firstEnd === null) firstEnd = eOff;
      else if (Math.abs(eOff - firstEnd) > 1e-6) endMixed = true;
      if (firstBetween === null) firstBetween = bOff;
      else if (Math.abs(bOff - firstBetween) > 1e-6) betweenMixed = true;
      if (m.lineType === 'step') anyBetweenSupported = true;
    }
    payload.startOffset = firstStart !== null ? firstStart : DEFAULT_ANCHOR_OFFSET;
    payload.endOffset = firstEnd !== null ? firstEnd : DEFAULT_ANCHOR_OFFSET;
    payload.betweenOffset = firstBetween !== null ? firstBetween : DEFAULT_BETWEEN_OFFSET;
    payload.startOffsetMixed = startMixed;
    payload.endOffsetMixed = endMixed;
    payload.betweenOffsetMixed = betweenMixed;
    payload.betweenOffsetSupported = anyBetweenSupported;
  }

  figma.ui.postMessage(payload);
}

// ---------------------------------------------------------------------------
// Create / update
// ---------------------------------------------------------------------------

async function handleCreateOrUpdate(style: FlowStyle): Promise<void> {
  if (!active) { figma.notify('EasyFlow is turned off'); return; }

  const sel = figma.currentPage.selection;
  const flows = sel.filter((n) => readMeta(n) !== null);

  if (flows.length > 0) {
    for (const flow of flows) {
      const meta = readMeta(flow);
      if (!meta || (flow.type !== 'FRAME' && flow.type !== 'VECTOR')) continue;
      const next: FlowMeta = { ...meta, ...style };
      // Style updates (color, anchor side, preset, etc.) always
      // re-center the path offsets. The user's stated invariant is
      // "offset must always be at the center of each frame" — this
      // enforces it at the meta level so neither stale UI state nor
      // dropped offset messages can desync the rendered geometry
      // from the slider. Per-flow drag adjustments still work
      // (update-anchor-offsets path leaves style untouched).
      next.startOffset = DEFAULT_ANCHOR_OFFSET;
      next.endOffset = DEFAULT_ANCHOR_OFFSET;
      next.betweenOffset = DEFAULT_BETWEEN_OFFSET;
      writeMeta(flow, next);
      // Coalesce: in-flight render absorbs new style; we don't await so the
      // UI message handler returns immediately and Figma stays responsive.
      void enqueueRender(flow, next);
    }
    // Push the canonical state back to the UI. Without this, the UI keeps
    // whatever it locally set (e.g. an offset slider value that the
    // sandbox just overwrote because the anchor side changed) and the two
    // drift out of sync. Sandbox is the source of truth; UI mirrors it.
    void syncUi();
    return;
  }

  if (sel.length === 2 && sel.every(isConnectableNode)) {
    await createAndSelectFlow(sel[0], sel[1]);
    return;
  }

  figma.notify('Select one object, then Shift+click another object.');
}

async function handleSwap(): Promise<void> {
  const flows = figma.currentPage.selection.filter((n) => readMeta(n) !== null);
  if (flows.length === 0) {
    figma.notify('Select a flow line first.');
    return;
  }
  for (const flow of flows) {
    const meta = readMeta(flow);
    if (!meta || (flow.type !== 'FRAME' && flow.type !== 'VECTOR')) continue;
    const swapped: FlowMeta = {
      ...meta,
      fromNodeId: meta.toNodeId,
      toNodeId: meta.fromNodeId,
      startAnchor: meta.endAnchor,
      endAnchor: meta.startAnchor,
      startArrow: meta.endArrow,
      endArrow: meta.startArrow,
    };
    // Endpoints are the same set after swap, so the reverse index doesn't change.
    writeMeta(flow, swapped);
    void enqueueRender(flow, swapped);
  }
  await syncUi();
}

async function handleUpdateAnchorOffsets(
  startOffset?: number,
  endOffset?: number,
  betweenOffset?: number,
): Promise<void> {
  if (!active) return;
  const sClamp = typeof startOffset === 'number' && Number.isFinite(startOffset)
    ? Math.max(0, Math.min(1, startOffset))
    : undefined;
  const eClamp = typeof endOffset === 'number' && Number.isFinite(endOffset)
    ? Math.max(0, Math.min(1, endOffset))
    : undefined;
  const bClamp = typeof betweenOffset === 'number' && Number.isFinite(betweenOffset)
    ? Math.max(0, Math.min(1, betweenOffset))
    : undefined;
  if (sClamp === undefined && eClamp === undefined && bClamp === undefined) return;
  const flows = figma.currentPage.selection.filter((n) => readMeta(n) !== null);
  for (const flow of flows) {
    const meta = readMeta(flow);
    if (!meta || (flow.type !== 'FRAME' && flow.type !== 'VECTOR')) continue;
    const next: FlowMeta = { ...meta };
    if (sClamp !== undefined) next.startOffset = sClamp;
    if (eClamp !== undefined) next.endOffset = eClamp;
    if (bClamp !== undefined) next.betweenOffset = bClamp;
    writeMeta(flow, next);
    void enqueueRender(flow, next);
  }
  // If start/end moved, the path may have transitioned between
  // straight ↔ bent shapes — push just the Between slider's enabled
  // state. Debounce the (expensive: 2x getNodeByIdAsync per flow)
  // recompute so a 60Hz drag doesn't thrash the node-id RPC, and so
  // the message back doesn't disturb the slider mid-drag.
  if (sClamp !== undefined || eClamp !== undefined) {
    scheduleBetweenSupportPost();
  }
}

let __betweenSupportTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleBetweenSupportPost(): void {
  if (__betweenSupportTimer !== null) return;
  __betweenSupportTimer = setTimeout(() => {
    __betweenSupportTimer = null;
    void postBetweenSupportFromSelection();
  }, 120);
}

async function postBetweenSupportFromSelection(): Promise<void> {
  const flows = figma.currentPage.selection.filter((n) => readMeta(n) !== null);
  if (flows.length === 0) return;
  let supported = false;
  for (const flow of flows) {
    const meta = readMeta(flow);
    if (!meta || meta.lineType !== 'step') continue;
    const fromNode = await figma.getNodeByIdAsync(meta.fromNodeId) as SceneNode | null;
    const toNode = await figma.getNodeByIdAsync(meta.toNodeId) as SceneNode | null;
    if (!fromNode || !toNode) continue;
    const fromBox = absoluteBox(fromNode);
    const toBox = absoluteBox(toNode);
    const startSide = resolveAnchor(meta.startAnchor, fromBox, toBox, true);
    const endSide = resolveAnchor(meta.endAnchor, fromBox, toBox, false);
    const startPt = pointOnSide(fromBox, startSide, meta.startOffset ?? DEFAULT_ANCHOR_OFFSET);
    const endPt = pointOnSide(toBox, endSide, meta.endOffset ?? DEFAULT_ANCHOR_OFFSET);
    if (betweenOffsetSupported(startSide, endSide, startPt, endPt, fromBox, toBox)) {
      supported = true;
      break;
    }
  }
  figma.ui.postMessage({ type: 'between-support', supported });
}

// ---------------------------------------------------------------------------
// Render queue — coalesces rapid update-style messages so we never queue more
// than one pending render per flow node. Drops intermediate styles while a
// render is in flight; only the latest is processed when the current finishes.
// ---------------------------------------------------------------------------

const renderInFlight = new Set<string>();
const renderPending = new Map<string, FlowMeta>();
// Hash of the inputs that produced the last successful render, per flow id.
// Lets renderFlow short-circuit when nothing visible would change — saves the
// setVectorNetworkAsync / font-load cycle on redundant style updates, slider
// drags that release on the same value, and documentchange events that touch
// unrelated properties on tracked endpoints.
const lastRenderHash = new Map<string, string>();
function renderInputHash(meta: FlowMeta, fromBox: Box, toBox: Box): string {
  return JSON.stringify([
    meta.strokeColor, meta.opacity, meta.strokeWidth, meta.strokeStyle,
    meta.lineType, meta.radius,
    meta.startArrow, meta.endArrow,
    meta.startAnchor, meta.endAnchor,
    meta.startOffset ?? 0.5, meta.endOffset ?? 0.5, meta.betweenOffset ?? 0.5,
    meta.label,
    fromBox.x, fromBox.y, fromBox.width, fromBox.height,
    toBox.x, toBox.y, toBox.width, toBox.height,
  ]);
}

async function enqueueRender(node: SceneNode, meta: FlowMeta): Promise<void> {
  const id = node.id;
  if (renderInFlight.has(id)) {
    renderPending.set(id, meta);
    return;
  }
  renderInFlight.add(id);
  try {
    await renderFlow(node, meta);
    while (renderPending.has(id)) {
      const next = renderPending.get(id)!;
      renderPending.delete(id);
      if (node.removed) break;
      await renderFlow(node, next);
    }
  } finally {
    renderInFlight.delete(id);
  }
}

// Cache successfully-loaded fonts so buildLabel doesn't pay the loadFontAsync
// cost on every render (Figma resolves cached fonts much faster than a fresh
// network/disk lookup).
const loadedFontKeys = new Set<string>();
async function ensureFontLoaded(font: FontName): Promise<FontName> {
  const key = `${font.family}::${font.style}`;
  if (loadedFontKeys.has(key)) return font;
  try {
    await figma.loadFontAsync(font);
    loadedFontKeys.add(key);
    return font;
  } catch {
    const fallback: FontName = { family: 'Inter', style: 'Regular' };
    const fkey = `${fallback.family}::${fallback.style}`;
    if (!loadedFontKeys.has(fkey)) {
      await figma.loadFontAsync(fallback);
      loadedFontKeys.add(fkey);
    }
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

async function createFlow(meta: FlowMeta): Promise<VectorNode> {
  const vec = figma.createVector();
  vec.name = flowName(meta.label.text);
  vec.fills = [];
  figma.currentPage.appendChild(vec);
  writeMeta(vec, meta);
  indexFlowEndpoints(vec.id, meta.fromNodeId, meta.toNodeId);
  await renderFlow(vec, meta);
  return vec;
}

function arrowTypeToStrokeCap(t: ArrowType): StrokeCap {
  switch (t) {
    case 'none':
      return 'NONE';
    case 'arrow':
      return 'ARROW_EQUILATERAL';
    case 'circle':
      return 'CIRCLE_FILLED';
    case 'diamond':
      return 'DIAMOND_FILLED';
    case 'square':
      return 'ARROW_LINES';
    default:
      return 'NONE';
  }
}

function bboxOfPoints(pts: Point[]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return { minX, minY, maxX, maxY };
}

async function removeFlowLabel(meta: FlowMeta, flowId?: string): Promise<void> {
  if (!meta.labelNodeId) return;
  const lab = await figma.getNodeByIdAsync(meta.labelNodeId);
  if (lab && !lab.removed) lab.remove();
  labelToFlow.delete(meta.labelNodeId);
  if (flowId) flowToLabel.delete(flowId);
}

async function removeLabelsOwnedBy(flowId: string): Promise<void> {
  const labelId = flowToLabel.get(flowId);
  if (!labelId) return;
  flowToLabel.delete(flowId);
  labelToFlow.delete(labelId);
  const label = await figma.getNodeByIdAsync(labelId);
  if (label && !label.removed) label.remove();
}

/** Cheap key over every label-affecting field — if it matches, only the
 *  position has to move (no fonts to load, no node to recreate). */
function labelSignature(meta: FlowMeta): string {
  const l = meta.label;
  return [
    l.text, l.fontFamily, l.fontWeight, l.fontSize,
    l.color, l.background, l.backgroundEnabled, l.borderEnabled,
    meta.strokeColor, meta.strokeWidth,
  ].join('|');
}
const LABEL_SIG_KEY = 'easyflow.labelSig';

async function syncFlowLabel(vec: VectorNode, meta: FlowMeta, midAbs: Point): Promise<FlowMeta> {
  const wantsLabel = meta.label.text.trim().length > 0;
  const sig = wantsLabel ? labelSignature(meta) : '';

  // Existing label whose signature matches → just reposition, skip font load
  // and node recreation entirely (the most common path during slider drags).
  if (wantsLabel && meta.labelNodeId) {
    const existing = await figma.getNodeByIdAsync(meta.labelNodeId) as SceneNode | null;
    if (existing && !existing.removed) {
      const prevSig = existing.getPluginData(LABEL_SIG_KEY);
      if (prevSig === sig) {
        existing.x = midAbs.x - existing.width / 2;
        existing.y = midAbs.y - existing.height / 2;
        flowToLabel.set(vec.id, existing.id);
        labelToFlow.set(existing.id, vec.id);
        return meta;
      }
    }
  }

  await removeFlowLabel(meta, vec.id);
  if (!wantsLabel) {
    const { labelNodeId: _l, ...rest } = meta;
    return rest as FlowMeta;
  }
  const parent = vec.parent;
  if (!parent) return meta;
  const created = await buildLabel(meta);
  created.setPluginData(LABEL_OWNER_KEY, vec.id);
  created.setPluginData(LABEL_SIG_KEY, sig);
  parent.appendChild(created);
  created.x = midAbs.x - created.width / 2;
  created.y = midAbs.y - created.height / 2;
  flowToLabel.set(vec.id, created.id);
  labelToFlow.set(created.id, vec.id);
  return { ...meta, labelNodeId: created.id };
}

async function renderFlow(node: SceneNode, meta: FlowMeta): Promise<void> {
  if (node.type === 'VECTOR') {
    await renderVectorFlow(node, meta);
    return;
  }
  if (node.type === 'FRAME' && readMeta(node)) {
    await renderLegacyFrameFlow(node as FrameNode, meta);
  }
}

async function renderVectorFlow(vec: VectorNode, meta: FlowMeta): Promise<void> {
  const fromNode = await figma.getNodeByIdAsync(meta.fromNodeId) as SceneNode | null;
  const toNode = await figma.getNodeByIdAsync(meta.toNodeId) as SceneNode | null;
  if (!fromNode || !toNode || fromNode.removed || toNode.removed) {
    await removeFlowLabel(meta, vec.id);
    unindexFlow(vec.id);
    lastRenderHash.delete(vec.id);
    vec.remove();
    return;
  }

  const fromBox = absoluteBox(fromNode);
  const toBox = absoluteBox(toNode);
  const hash = renderInputHash(meta, fromBox, toBox);
  if (lastRenderHash.get(vec.id) === hash) return;
  lastRenderHash.set(vec.id, hash);
  const startSide = resolveAnchor(meta.startAnchor, fromBox, toBox, true);
  const endSide = resolveAnchor(meta.endAnchor, fromBox, toBox, false);
  const startPoint = pointOnSide(fromBox, startSide, meta.startOffset ?? DEFAULT_ANCHOR_OFFSET);
  const endPoint = pointOnSide(toBox, endSide, meta.endOffset ?? DEFAULT_ANCHOR_OFFSET);

  const capS = arrowTypeToStrokeCap(meta.startArrow);
  const capE = arrowTypeToStrokeCap(meta.endArrow);

  let vertices: VectorVertex[] = [];
  let segments: VectorSegment[] = [];

  if (meta.lineType === 'curved') {
    // True cubic-Bézier curve: 2 vertices + 1 segment with tangent handles
    // pointing along each side normal. Produces the smooth S-shape the user
    // expects from a connector tool, instead of an orthogonal step path with
    // big rounded corners.
    const { h1, h2 } = bezierHandlesFor(startPoint, startSide, endPoint, endSide);
    vertices = [
      { x: startPoint.x, y: startPoint.y, strokeCap: capS },
      { x: endPoint.x, y: endPoint.y, strokeCap: capE },
    ];
    segments = [{ start: 0, end: 1, tangentStart: h1, tangentEnd: h2 }];
  } else {
    const pts = computeStepWaypoints(startPoint, startSide, endPoint, endSide, meta.radius, toBox, fromBox, meta.betweenOffset);
    if (pts.length < 2) {
      console.warn('[EasyFlow] renderVectorFlow: fewer than 2 waypoints, skipping render');
      return;
    }
    const n = pts.length;
    for (let i = 0; i < n; i++) {
      if (i === 0) {
        vertices.push({ x: pts[i].x, y: pts[i].y, strokeCap: capS });
      } else if (i === n - 1) {
        vertices.push({ x: pts[i].x, y: pts[i].y, strokeCap: capE });
      } else {
        vertices.push({ x: pts[i].x, y: pts[i].y, cornerRadius: meta.radius });
      }
    }
    for (let i = 0; i < n - 1; i++) segments.push({ start: i, end: i + 1 });
  }

  const { minX, minY } = bboxOfPoints(vertices.map((v) => ({ x: v.x, y: v.y })));
  const relVerts: VectorVertex[] = vertices.map((v) => {
    const rx = v.x - minX;
    const ry = v.y - minY;
    if (v.strokeCap !== undefined) return { x: rx, y: ry, strokeCap: v.strokeCap };
    if (v.cornerRadius !== undefined) return { x: rx, y: ry, cornerRadius: v.cornerRadius };
    return { x: rx, y: ry };
  });
  // Segments need re-indexing? No — vertex indices stay the same, only x/y
  // change to relative space. tangentStart / tangentEnd are vectors (not
  // points) so they're already in the correct local frame.

  vec.x = minX;
  vec.y = minY;
  vec.name = flowName(meta.label.text);

  const strokePaint: Paint = {
    type: 'SOLID',
    color: hexToRgb(meta.strokeColor),
    opacity: meta.opacity / 100,
  };
  vec.strokes = [strokePaint];
  vec.strokeWeight = meta.strokeWidth;
  vec.strokeAlign = 'CENTER';
  vec.strokeJoin = 'ROUND';
  vec.dashPattern =
    meta.strokeStyle === 'dashed' ? [meta.strokeWidth * 2, meta.strokeWidth * 2] : [];
  vec.fills = [];

  // setVectorNetworkAsync replaces the underlying network; the previous
  // `vec.vectorPaths = []` write was redundant and forced an extra commit.
  await vec.setVectorNetworkAsync({ vertices: relVerts, segments });

  const mid = pathMidpoint(meta.lineType, startPoint, startSide, endPoint, endSide, meta.radius, toBox, fromBox, meta.betweenOffset);
  const nextMeta = await syncFlowLabel(vec, meta, mid);
  writeMeta(vec, nextMeta);
}

async function renderLegacyFrameFlow(wrapper: FrameNode, meta: FlowMeta): Promise<void> {
  const fromNode = await figma.getNodeByIdAsync(meta.fromNodeId) as SceneNode | null;
  const toNode = await figma.getNodeByIdAsync(meta.toNodeId) as SceneNode | null;
  if (!fromNode || !toNode || fromNode.removed || toNode.removed) {
    lastRenderHash.delete(wrapper.id);
    wrapper.remove();
    return;
  }

  const fromBox = absoluteBox(fromNode);
  const toBox = absoluteBox(toNode);
  const hash = renderInputHash(meta, fromBox, toBox);
  if (lastRenderHash.get(wrapper.id) === hash) return;
  lastRenderHash.set(wrapper.id, hash);
  const startSide = resolveAnchor(meta.startAnchor, fromBox, toBox, true);
  const endSide = resolveAnchor(meta.endAnchor, fromBox, toBox, false);
  const startPoint = pointOnSide(fromBox, startSide, meta.startOffset ?? DEFAULT_ANCHOR_OFFSET);
  const endPoint = pointOnSide(toBox, endSide, meta.endOffset ?? DEFAULT_ANCHOR_OFFSET);

  for (const child of [...wrapper.children]) child.remove();

  wrapper.x = 0;
  wrapper.y = 0;

  const strokePaint: Paint = {
    type: 'SOLID',
    color: hexToRgb(meta.strokeColor),
    opacity: meta.opacity / 100,
  };

  const vector = figma.createVector();
  vector.name = 'line';
  vector.strokes = [strokePaint];
  vector.strokeWeight = meta.strokeWidth;
  vector.strokeAlign = 'CENTER';
  vector.dashPattern =
    meta.strokeStyle === 'dashed' ? [meta.strokeWidth * 2, meta.strokeWidth * 2] : [];
  vector.fills = [];
  vector.vectorPaths = [
    {
      windingRule: 'NONE',
      data: buildPath(meta.lineType, startPoint, startSide, endPoint, endSide, meta.radius, toBox, fromBox, meta.betweenOffset),
    },
  ];
  wrapper.appendChild(vector);

  const startCap = buildArrowHead(meta.startArrow, startPoint, startSide, meta.strokeWidth, strokePaint);
  if (startCap) wrapper.appendChild(startCap);
  const endCap = buildArrowHead(meta.endArrow, endPoint, endSide, meta.strokeWidth, strokePaint);
  if (endCap) wrapper.appendChild(endCap);

  if (meta.label.text.trim().length > 0) {
    const labelNode = await buildLabel(meta);
    const mid = pathMidpoint(meta.lineType, startPoint, startSide, endPoint, endSide, meta.radius, toBox, fromBox, meta.betweenOffset);
    labelNode.x = mid.x - labelNode.width / 2;
    labelNode.y = mid.y - labelNode.height / 2;
    wrapper.appendChild(labelNode);
  }

  fitWrapperToContent(wrapper);
  wrapper.name = flowName(meta.label.text);
}

// ---------------------------------------------------------------------------
// Moving frames → update attached flow geometry
// ---------------------------------------------------------------------------

const FLOW_ENDPOINT_GEO_PROPS: ReadonlySet<NodeChangeProperty> = new Set([
  'x',
  'y',
  'width',
  'height',
  'relativeTransform',
  'rotation',
  'parent',
]);

let pendingFlowGeoEndpointIds = new Set<string>();
let docChangeFlowTimer: ReturnType<typeof setTimeout> | null = null;

function queueFlowRerenderEndpointsFromChanges(event: DocumentChangeEvent): void {
  // Cheap exit: nothing to track, so don't iterate `documentChanges` at all.
  // Big documents fire many irrelevant changes (other plugins, user edits
  // far from any flow); we'd otherwise spend O(changes × properties) just
  // to discover there's nothing to do.
  if (endpointToFlows.size === 0 && flowToEndpoints.size === 0 && labelToFlow.size === 0) return;

  for (const change of event.documentChanges) {
    if (change.type === 'DELETE') {
      // Was this an endpoint? → queue a rerender so the orphaned flow
      // can detect its endpoint is gone and clean itself up.
      if (endpointToFlows.has(change.id)) {
        pendingFlowGeoEndpointIds.add(change.id);
      }
      // Was this a flow itself? → drop it from the index. O(1) via the
      // flowToEndpoints reverse map.
      if (flowToEndpoints.has(change.id)) {
        unindexFlow(change.id);
      }
      // Was this a label node?
      const ownerFlowId = labelToFlow.get(change.id);
      if (ownerFlowId) {
        labelToFlow.delete(change.id);
        flowToLabel.delete(ownerFlowId);
      }
      continue;
    }
    if (change.type !== 'PROPERTY_CHANGE') continue;
    // Filter at the source: only endpoints of tracked flows trigger work.
    if (!endpointToFlows.has(change.id)) continue;
    let touchesGeo = false;
    for (const p of change.properties) {
      if (FLOW_ENDPOINT_GEO_PROPS.has(p)) { touchesGeo = true; break; }
    }
    if (touchesGeo) pendingFlowGeoEndpointIds.add(change.id);
  }
}

function scheduleFlowRerenderForMovedEndpoints(): void {
  if (pendingFlowGeoEndpointIds.size === 0) return;
  // Schedule-once batching: subsequent changes within the window accumulate
  // into `pendingFlowGeoEndpointIds` instead of pushing the deadline back.
  // Without this, a continuous drag (which fires documentchange every few
  // ms) would never flush until the user paused — flows visibly lagged.
  // Cap the rerender rate at ~one batch per 12 ms (~83 Hz) which is well
  // above what the user can perceive but well below Figma's per-event cost.
  if (docChangeFlowTimer !== null) return;
  docChangeFlowTimer = setTimeout(() => {
    docChangeFlowTimer = null;
    const ids = pendingFlowGeoEndpointIds;
    pendingFlowGeoEndpointIds = new Set();
    void rerenderFlowsForEndpointIds(ids);
  }, 12);
}

function indexFlowEndpoints(flowId: string, fromId: string, toId: string): void {
  flowToEndpoints.set(flowId, [fromId, toId]);
  for (const epId of [fromId, toId]) {
    let s = endpointToFlows.get(epId);
    if (!s) { s = new Set(); endpointToFlows.set(epId, s); }
    s.add(flowId);
  }
}

function unindexFlow(flowId: string): void {
  lastRenderHash.delete(flowId);
  const eps = flowToEndpoints.get(flowId);
  if (!eps) return;
  flowToEndpoints.delete(flowId);
  for (const epId of eps) {
    const s = endpointToFlows.get(epId);
    if (s) { s.delete(flowId); if (s.size === 0) endpointToFlows.delete(epId); }
  }
}

/** Build the reverse index from existing flows on the current page.
 *  Iterates top-level children only — flows are always appended directly
 *  to the page (see createFlow), so a recursive findAll would just be
 *  pulling thousands of unrelated nodes through getPluginData on big pages. */
function bootstrapEndpointIndexForCurrentPage(): void {
  endpointToFlows.clear();
  flowToEndpoints.clear();
  flowToLabel.clear();
  labelToFlow.clear();
  for (const child of figma.currentPage.children) {
    if (child.type !== 'VECTOR' && child.type !== 'FRAME') continue;
    const m = readMeta(child);
    if (!m) continue;
    indexFlowEndpoints(child.id, m.fromNodeId, m.toNodeId);
    if (m.labelNodeId) {
      flowToLabel.set(child.id, m.labelNodeId);
      labelToFlow.set(m.labelNodeId, child.id);
    }
  }
}

async function rerenderFlowsForEndpointIds(endpointIds: Set<string>): Promise<void> {
  if (endpointIds.size === 0) return;

  // Fast path: look up affected flows via the reverse index.
  const flowIds = new Set<string>();
  for (const epId of endpointIds) {
    const s = endpointToFlows.get(epId);
    if (s) for (const fid of s) flowIds.add(fid);
  }
  if (flowIds.size === 0) return;

  for (const fid of flowIds) {
    const node = await figma.getNodeByIdAsync(fid) as SceneNode | null;
    if (!node || node.removed) continue;
    if (node.type !== 'VECTOR' && node.type !== 'FRAME') continue;
    const meta = readMeta(node);
    if (!meta) continue;
    void enqueueRender(node, meta);
  }
}

function onDocumentChanged(event: DocumentChangeEvent): void {
  queueFlowRerenderEndpointsFromChanges(event);
  scheduleFlowRerenderForMovedEndpoints();
}

function fitWrapperToContent(wrapper: FrameNode): void {
  if (wrapper.children.length === 0) return;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const c of wrapper.children) {
    minX = Math.min(minX, c.x);
    minY = Math.min(minY, c.y);
    maxX = Math.max(maxX, c.x + c.width);
    maxY = Math.max(maxY, c.y + c.height);
  }
  for (const c of wrapper.children) { c.x -= minX; c.y -= minY; }
  wrapper.x += minX;
  wrapper.y += minY;
  wrapper.resizeWithoutConstraints(Math.max(1, maxX - minX), Math.max(1, maxY - minY));
}

// ---------------------------------------------------------------------------
// Arrow heads
// ---------------------------------------------------------------------------

function buildArrowHead(
  type: ArrowType, point: Point, side: Side,
  strokeWidth: number, paint: Paint,
): SceneNode | null {
  if (type === 'none') return null;
  const size = Math.max(8, strokeWidth * 3);
  const dir = sideDirection(side);
  switch (type) {
    case 'arrow':   return triangleArrow(point, dir, size, paint);
    case 'circle':  return shapeAt('ELLIPSE', point, size, paint);
    case 'diamond': return diamondAt(point, size, paint);
    case 'square':  return shapeAt('RECT', point, size, paint);
  }
}

function shapeAt(kind: 'ELLIPSE' | 'RECT', center: Point, size: number, paint: Paint): SceneNode {
  const node = kind === 'ELLIPSE' ? figma.createEllipse() : figma.createRectangle();
  node.resize(size, size);
  node.x = center.x - size / 2;
  node.y = center.y - size / 2;
  node.fills = [paint];
  node.strokes = [];
  node.name = kind === 'ELLIPSE' ? 'cap-circle' : 'cap-square';
  return node;
}

function diamondAt(center: Point, size: number, paint: Paint): SceneNode {
  const r = size / 2;
  const v = figma.createVector();
  v.vectorPaths = [{
    windingRule: 'NONZERO',
    data: `M ${center.x} ${center.y - r} L ${center.x + r} ${center.y} L ${center.x} ${center.y + r} L ${center.x - r} ${center.y} Z`,
  }];
  v.fills = [paint]; v.strokes = []; v.name = 'cap-diamond';
  return v;
}

function triangleArrow(tip: Point, outwardDir: Point, size: number, paint: Paint): SceneNode {
  const base = { x: tip.x + outwardDir.x * size, y: tip.y + outwardDir.y * size };
  const perp = { x: -outwardDir.y, y: outwardDir.x };
  const h = size * 0.6;
  const p2 = { x: base.x + perp.x * h, y: base.y + perp.y * h };
  const p3 = { x: base.x - perp.x * h, y: base.y - perp.y * h };
  const v = figma.createVector();
  v.vectorPaths = [{
    windingRule: 'NONZERO',
    data: `M ${tip.x} ${tip.y} L ${p2.x} ${p2.y} L ${p3.x} ${p3.y} Z`,
  }];
  v.fills = [paint]; v.strokes = []; v.name = 'cap-arrow';
  return v;
}

// ---------------------------------------------------------------------------
// Label with optional background box
// ---------------------------------------------------------------------------

async function buildLabel(meta: FlowMeta): Promise<SceneNode> {
  const fontName: FontName = { family: meta.label.fontFamily, style: meta.label.fontWeight };
  const usedFont = await ensureFontLoaded(fontName);

  const text = figma.createText();
  text.fontName = usedFont;
  text.fontSize = meta.label.fontSize;
  text.characters = meta.label.text;
  text.fills = [{ type: 'SOLID', color: hexToRgb(meta.label.color) }];
  text.name = 'label-text';

  const wantsBg = meta.label.backgroundEnabled;
  const wantsBorder = meta.label.borderEnabled;
  if (!wantsBg && !wantsBorder) { text.name = 'label'; return text; }

  const wrap = figma.createFrame();
  wrap.name = 'label';
  wrap.layoutMode = 'HORIZONTAL';
  wrap.primaryAxisSizingMode = 'AUTO';
  wrap.counterAxisSizingMode = 'AUTO';
  wrap.paddingLeft = 10; wrap.paddingRight = 10;
  wrap.paddingTop = 4;   wrap.paddingBottom = 4;
  wrap.cornerRadius = 4;
  wrap.fills = wantsBg ? [{ type: 'SOLID', color: hexToRgb(meta.label.background) }] : [];
  if (wantsBorder) {
    wrap.strokes = [{ type: 'SOLID', color: hexToRgb(meta.strokeColor) }];
    wrap.strokeWeight = Math.max(1, meta.strokeWidth * 0.5);
    wrap.strokeAlign = 'INSIDE';
  } else {
    wrap.strokes = [];
  }
  wrap.clipsContent = false;
  wrap.appendChild(text);
  return wrap;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isConnectableNode(node: SceneNode): boolean {
  // Figma can hand us nodes that were deleted between the selectionchange
  // event firing and this handler running (e.g. mid-create animations).
  // Even `.removed` access can throw on truly invalidated handles, so
  // wrap the whole body. If anything throws, treat the node as
  // unusable rather than letting the rejection skip syncUi().
  try {
    if (node.removed) return false;
    if (readMeta(node) !== null) return false;
    if (node.getPluginData(LABEL_OWNER_KEY)) return false;
    const b = node.absoluteBoundingBox;
    return !!b && b.width > 0 && b.height > 0;
  } catch {
    return false;
  }
}

async function findFlowBetween(idA: string, idB: string): Promise<SceneNode | null> {
  // Use the reverse index — intersect flow sets for both endpoints, then
  // confirm direction-agnostic match via meta. O(min(|A|,|B|)) instead of
  // a full-page findAll.
  const setA = endpointToFlows.get(idA);
  if (!setA || setA.size === 0) return null;
  const setB = endpointToFlows.get(idB);
  if (!setB || setB.size === 0) return null;
  const [small, large] = setA.size <= setB.size ? [setA, setB] : [setB, setA];
  for (const fid of small) {
    if (!large.has(fid)) continue;
    const node = await figma.getNodeByIdAsync(fid) as SceneNode | null;
    if (!node || node.removed) { unindexFlow(fid); continue; }
    return node;
  }
  return null;
}

function absoluteBox(node: SceneNode): Box {
  const b = node.absoluteBoundingBox;
  if (b) return { x: b.x, y: b.y, width: b.width, height: b.height };
  return { x: node.x, y: node.y, width: node.width, height: node.height };
}

function readMeta(node: BaseNode): FlowMeta | null {
  try {
    const raw = node.getPluginData(PLUGIN_DATA_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as FlowMeta;
  } catch { return null; }
}

function writeMeta(node: BaseNode, meta: FlowMeta): void {
  node.setPluginData(PLUGIN_DATA_KEY, JSON.stringify(meta));
}

function extractStyle(meta: FlowMeta): FlowStyle {
  // Per-flow offsets (startOffset, endOffset, betweenOffset) live on the
  // flow, not the style — strip them so preset/style swaps don't carry
  // them across flows.
  const {
    fromNodeId: _f, toNodeId: _t, labelNodeId: _l,
    startOffset: _s, endOffset: _e, betweenOffset: _b,
    ...style
  } = meta;
  return style;
}

function normalizeStyle(style: Partial<FlowStyle>): FlowStyle {
  const next = { ...clone(DEFAULT_STYLE), ...style };
  next.label = { ...clone(DEFAULT_STYLE.label), ...(style.label || {}) };
  return next;
}

function normalizePresetStyles(styles: PresetStyles): PresetStyles {
  const out: PresetStyles = {};
  for (const [name, style] of Object.entries(styles)) {
    if (style) out[name] = normalizeStyle(style as Partial<FlowStyle>);
  }
  return out;
}

function flowName(label: string): string {
  return label.trim() ? `${FLOW_NAME_PREFIX} ${label.trim()}` : `${FLOW_NAME_PREFIX} flow`;
}

function clone<T>(v: T): T { return JSON.parse(JSON.stringify(v)); }

function hexToRgb(hex: string): RGB {
  const clean = hex.replace('#', '').trim();
  const norm = clean.length === 3
    ? clean.split('').map((c) => c + c).join('')
    : clean.padEnd(6, '0').slice(0, 6);
  const n = parseInt(norm, 16);
  return { r: ((n >> 16) & 0xff) / 255, g: ((n >> 8) & 0xff) / 255, b: (n & 0xff) / 255 };
}
