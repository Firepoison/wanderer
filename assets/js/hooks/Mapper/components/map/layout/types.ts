import { XYPosition } from 'reactflow';

export interface LayoutNodeInput {
  id: string;
  width: number;
  height: number;
}

export interface LayoutEdgeInput {
  source: string;
  target: string;
}

/**
 * Engine-specific settings, exactly as stored in `Map.options.auto_layout_options[engineId]`.
 *
 * Deliberately untyped at this level: direction, spacing and ranking are vocabulary of whichever
 * engine defines them, not of layout in general. The orchestrator passes this through opaquely
 * and each engine validates the keys it knows, so an option meant for another engine — or a
 * value that has drifted from the server-side catalog (`WandererApp.Map.LayoutEngines`) — is
 * ignored rather than misapplied.
 */
export type LayoutOptions = Record<string, string>;

export interface LayoutInput {
  nodes: LayoutNodeInput[];
  edges: LayoutEdgeInput[];
  /** Anchor node. Only supplied to engines that declare `supportsRoot`. */
  rootId?: string | null;
  options: LayoutOptions;
}

export interface LayoutResult {
  /** New positions keyed by node id, top-left corner (React Flow convention). */
  positions: Record<string, XYPosition>;
}

/**
 * A layout engine turns a graph (nodes + edges + optional root) into node positions.
 *
 * The only things layout assumes of every engine are the graph itself and whether a root node
 * means anything to it; everything else is negotiated through `options`. Adding an engine means
 * implementing this interface, registering it in `registry.ts`, and adding its option catalog to
 * `WandererApp.Map.LayoutEngines` (which is what the settings form renders from) — the
 * orchestrator in `useAutoLayout` stays untouched.
 *
 * `compute` may be synchronous (dagre) or async (e.g. elkjs runs in a worker); callers await.
 */
export interface LayoutEngine {
  id: string;
  label: string;
  /** When false, `LayoutInput.rootId` is never populated for this engine. */
  supportsRoot: boolean;
  compute(input: LayoutInput): LayoutResult | Promise<LayoutResult>;
}
