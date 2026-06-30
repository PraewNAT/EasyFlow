// Shared types between the Figma sandbox (code.ts) and UI (ui.html).

export type Anchor = 'top' | 'right' | 'bottom' | 'left' | 'auto';
export type ArrowType = 'none' | 'arrow' | 'circle' | 'diamond';
export type StrokeStyle = 'solid' | 'dashed';
export type LineType = 'step' | 'curved';

export interface FlowLabel {
  text: string;
  fontFamily: string;
  fontWeight: string;
  fontSize: number;
  color: string; // hex without #
  background: string; // hex without #
  backgroundEnabled: boolean;
  borderEnabled: boolean; // border color uses the line stroke color
}

export interface FlowStyle {
  strokeColor: string; // hex without #
  opacity: number; // 0-100
  strokeWidth: number;
  strokeStyle: StrokeStyle;
  lineType: LineType;
  radius: number;
  startArrow: ArrowType;
  endArrow: ArrowType;
  startAnchor: Anchor;
  endAnchor: Anchor;
  label: FlowLabel;
}

export interface FlowMeta extends FlowStyle {
  fromNodeId: string;
  toNodeId: string;
  /** Stable EasyFlow-minted UUID of the source endpoint, also stamped onto
   *  that node's own plugin data (key `easyflow.frameId`). Figma reassigns
   *  node ids on a cross-file copy/paste but preserves plugin data, so when
   *  the saved fromNodeId stops resolving we can still re-link the flow by
   *  matching this UUID against the pasted endpoint. Optional: flows created
   *  before this feature gain it lazily on their first successful render. */
  fromFrameUuid?: string;
  /** Same as fromFrameUuid but for the target endpoint. */
  toFrameUuid?: string;
  /** Optional text/frame used as label; parented next to the flow vector (not serialized to UI style). */
  labelNodeId?: string;
  /** Position of the start anchor along its chosen edge. 0–1; default 0.5 = center.
   *  For left/right sides: 0 = bottom of edge, 1 = top of edge.
   *  For top/bottom sides: 0 = left of edge, 1 = right of edge.
   *  Stored on the flow (not the style) so preset changes don't reset it. */
  startOffset?: number;
  /** Same semantics as startOffset but for the end anchor. */
  endOffset?: number;
  /** Position of the middle (between) segment along the start→end axis.
   *  0 = closer to start, 0.5 = natural midpoint, 1 = closer to end.
   *  Has no effect on straight lines (no middle segment to slide). */
  betweenOffset?: number;
}

export const DEFAULT_ANCHOR_OFFSET = 0.5;
export const DEFAULT_BETWEEN_OFFSET = 0.5;

export type PresetStyles = Record<string, FlowStyle>;

export const DEFAULT_STYLE: FlowStyle = {
  strokeColor: '00eeff',
  opacity: 100,
  strokeWidth: 4,
  strokeStyle: 'solid',
  lineType: 'step',
  radius: 20,
  startArrow: 'none',
  endArrow: 'arrow',
  startAnchor: 'auto',
  endAnchor: 'auto',
  label: {
    text: '',
    fontFamily: 'Inter',
    fontWeight: 'Regular',
    fontSize: 16,
    color: '000000',
    background: 'ffffff',
    backgroundEnabled: true,
    borderEnabled: true,
  },
};

// Messages from UI -> sandbox
export type UiToPlugin =
  | { type: 'ui-ready' }
  | { type: 'set-active'; active: boolean }
  /** When false (the default), a newly created flow starts with an empty label
   *  instead of inheriting the last-used label text. */
  | { type: 'set-remember-label'; on: boolean }
  | { type: 'create-flow'; style: FlowStyle }
  | { type: 'update-style'; style: FlowStyle }
  | { type: 'swap-direction' }
  /** Pin/unpin the anchor sides of the selected flow(s). Anchors are
   *  structural, not visual style, so they travel on their own message rather
   *  than riding along with every label/colour update-style. */
  | { type: 'update-anchors'; startAnchor: Anchor; endAnchor: Anchor }
  | { type: 'resize-ui'; height: number; width?: number }
  | { type: 'save-preset-styles'; styles: PresetStyles }
  /** Per-preset "remember label" flags (which presets keep their typed label
   *  text across new flows / reopens). Persisted via clientStorage, same as
   *  preset styles, so it survives a plugin close/reopen — unlike the UI
   *  iframe's own localStorage, which Figma doesn't guarantee to persist. */
  | { type: 'save-preset-remember'; remember: Record<string, boolean> }
  | {
      type: 'update-anchor-offsets';
      startOffset?: number;
      endOffset?: number;
      betweenOffset?: number;
    };

// Messages from sandbox -> UI
export type PluginToUi =
  | {
      type: 'selection';
      mode: 'none' | 'two-frames' | 'one-flow' | 'multi-flow' | 'mixed';
      style?: FlowStyle;
      active: boolean;
      // Resolved (actually-rendered) anchor sides for the selected single flow.
      // Useful when the user pinned 'auto' but wants to see where it lives.
      resolvedStartSide?: 'top' | 'right' | 'bottom' | 'left';
      resolvedEndSide?: 'top' | 'right' | 'bottom' | 'left';
      fromName?: string;
      toName?: string;
      /** Per-endpoint anchor offsets along their chosen edges (0–1). */
      startOffset?: number;
      endOffset?: number;
      /** Position of the middle segment along start→end. 0.5 = natural. */
      betweenOffset?: number;
      /** True when multi-select has differing values for that endpoint. */
      startOffsetMixed?: boolean;
      endOffsetMixed?: boolean;
      betweenOffsetMixed?: boolean;
      /** False when the connector has no slidable middle segment (e.g.
       *  a perfectly straight line). UI disables the slider in that case. */
      betweenOffsetSupported?: boolean;
    }
  | { type: 'notify'; message: string }
  | { type: 'preset-styles'; styles: PresetStyles }
  /** Per-preset "remember label" flags, loaded from clientStorage on boot. */
  | { type: 'preset-remember'; remember: Record<string, boolean> }
  /** Tell the panel to clear its label input — sent after a flow is created
   *  while "remember label" is off, so the text doesn't linger for the next one. */
  | { type: 'reset-label' }
  /** Lightweight update for the Between slider's enabled state — sent
   *  while the user drags Start/End sliders, since changing those
   *  values can transition the path between straight and bent shapes.
   *  We avoid sending a full 'selection' sync so the in-flight slider
   *  drag isn't disturbed. */
  | { type: 'between-support'; supported: boolean };

export const PLUGIN_DATA_KEY = 'easyflow.meta';
export const FLOW_NAME_PREFIX = 'EasyFlow ›';
