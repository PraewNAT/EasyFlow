// Shared types between the Figma sandbox (code.ts) and UI (ui.html).

export type Anchor = 'top' | 'right' | 'bottom' | 'left' | 'auto';
export type ArrowType = 'none' | 'arrow' | 'circle' | 'diamond' | 'square';
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
  /** Optional text/frame used as label; parented next to the flow vector (not serialized to UI style). */
  labelNodeId?: string;
  /** Normalized middle-segment offset for elbow paths. 0–1; default 0.5 = natural midpoint.
   *  Stored on the flow (not on the style) so preset changes don't reset it and endpoint
   *  moves preserve the same proportional position. */
  pathOffset?: number;
}

export const DEFAULT_PATH_OFFSET = 0.5;

export type PresetName = 'custom' | 'success' | 'error';
export type PresetStyles = Partial<Record<PresetName, FlowStyle>>;

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
  | { type: 'create-flow'; style: FlowStyle }
  | { type: 'update-style'; style: FlowStyle }
  | { type: 'swap-direction' }
  | { type: 'resize-ui'; height: number }
  | { type: 'save-preset-styles'; styles: PresetStyles }
  | { type: 'update-path-offset'; offset: number };

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
      /** Current offset of the selected flow (or shared value across multi-select). */
      pathOffset?: number;
      /** True when multi-select contains different offsets — UI shows "Mixed". */
      pathOffsetMixed?: boolean;
      /** False when the connector shape doesn't support offset (curved, wrap-around). */
      pathOffsetSupported?: boolean;
    }
  | { type: 'notify'; message: string }
  | { type: 'preset-styles'; styles: PresetStyles };

export const PLUGIN_DATA_KEY = 'easyflow.meta';
export const FLOW_NAME_PREFIX = 'EasyFlow ›';
