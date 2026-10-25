import { XYPosition } from 'reactflow';
import { getConnectedComponents } from './helpers';
import { LayoutEdgeInput, LayoutEngine, LayoutInput, LayoutOptions, LayoutResult } from './types';

/** Where a laid-out node sits: an offset from its cluster's anchor node. */
export interface Placement {
  anchorId: string;
  offset: XYPosition;
  /** The cluster is anchored on a locked root, so it can't move: its members aren't draggable. */
  pinned: boolean;
}

export interface PlacementNode {
  id: string;
  locked: boolean;
}

export interface PlacementEdge extends LayoutEdgeInput {
  /** When the connection was created, in epoch ms; Infinity when unknown. */
  createdAt: number;
}

export interface PlacementInput {
  engine: LayoutEngine;
  nodes: PlacementNode[];
  edges: PlacementEdge[];
  rootId: string | null;
  options: LayoutOptions;
  /** Every node is laid out at this size, so the result doesn't depend on how a client renders. */
  nodeSize: { width: number; height: number };
}

export interface PlacementResult {
  placements: Map<string, Placement>;
  /** Every placed node id -> all node ids of its cluster (including itself). */
  clusterByNode: Map<string, string[]>;
}

/** One cluster to lay out. */
interface ClusterJob {
  nodeIds: string[];
  edges: PlacementEdge[];
  /** The root, when the cluster contains it. */
  rootId: string | null;
  pinned: boolean;
}

const planClusters = ({ nodes, edges, rootId }: PlacementInput): ClusterJob[] => {
  const nodeIds = new Set<string>();
  const excluded = new Set<string>();
  let lockedRoot = false;
  nodes.forEach(n => {
    nodeIds.add(n.id);
    if (n.locked && n.id === rootId) {
      lockedRoot = true;
    } else if (n.locked) {
      excluded.add(n.id);
    }
  });

  const layoutIds = nodes.filter(n => !excluded.has(n.id)).map(n => n.id);
  const layoutEdges = edges.filter(
    e => !excluded.has(e.source) && !excluded.has(e.target) && nodeIds.has(e.source) && nodeIds.has(e.target),
  );

  return getConnectedComponents(layoutIds, layoutEdges)
    .filter(c => c.nodeIds.length >= 2)
    .map(c => {
      const clusterRoot = rootId && c.nodeIds.includes(rootId) ? rootId : null;
      return { nodeIds: c.nodeIds, edges: c.edges, rootId: clusterRoot, pinned: clusterRoot !== null && lockedRoot };
    });
};

const layoutInput = (job: ClusterJob, { options, nodeSize }: PlacementInput): LayoutInput => ({
  nodes: job.nodeIds.map(id => ({ id, ...nodeSize })),
  edges: job.edges,
  rootId: job.rootId,
  options,
});

const addPlacements = (job: ClusterJob, result: LayoutResult, into: PlacementResult) => {
  const anchorId = pickAnchor(job.nodeIds, job.edges, job.rootId);
  const origin = result.positions[anchorId];
  if (!origin) {
    return;
  }

  job.nodeIds.forEach(id => {
    const p = result.positions[id];
    if (!p) {
      return;
    }
    into.clusterByNode.set(id, job.nodeIds);
    into.placements.set(id, {
      anchorId,
      offset: { x: Math.round(p.x - origin.x), y: Math.round(p.y - origin.y) },
      pinned: job.pinned,
    });
  });
};

/**
 * Lays out every *managed* cluster — a connected group of at least two unlocked nodes — and
 * expresses each member's position as an offset from the cluster's anchor. Positions are not an
 * input, so the result is a pure function of structure, options and root.
 *
 * Locked nodes keep their stored positions, so they and their connections are left out — except
 * a locked root. An anchor is displayed exactly at its stored position anyway, so a locked root
 * still anchors its cluster; the cluster is then `pinned`, since moving it would move the root.
 */
export const computePlacements = async (input: PlacementInput): Promise<PlacementResult> => {
  const result: PlacementResult = { placements: new Map(), clusterByNode: new Map() };
  for (const job of planClusters(input)) {
    addPlacements(job, await input.engine.compute(layoutInput(job, input)), result);
  }
  return result;
};

/**
 * `computePlacements` without waiting, for callers that must act before anything else runs: the
 * placements when the engine computes synchronously (as dagre does), or null for an engine that
 * returns a promise.
 */
export const computePlacementsNow = (input: PlacementInput): PlacementResult | null => {
  const result: PlacementResult = { placements: new Map(), clusterByNode: new Map() };
  for (const job of planClusters(input)) {
    const computed = input.engine.compute(layoutInput(job, input));
    if (computed instanceof Promise) {
      return null;
    }
    addPlacements(job, computed, result);
  }
  return result;
};

const edgeKey = (e: LayoutEdgeInput) => `${e.source}|${e.target}`;

/** Orders connections oldest first; ties and unknown times are broken by source/target id. */
export const compareEdgeAge = (a: PlacementEdge, b: PlacementEdge): number => {
  if (a.createdAt !== b.createdAt) {
    return a.createdAt < b.createdAt ? -1 : 1;
  }
  const ka = edgeKey(a);
  const kb = edgeKey(b);
  return ka < kb ? -1 : ka > kb ? 1 : 0;
};

/**
 * The node a cluster is pinned to: the root when the cluster contains it, otherwise the source of
 * the cluster's oldest connection.
 *
 * Connections are deleted, never hidden from the server, so a system that is added to the map —
 * a new one, or one re-added after being mapped long ago — always joins through a connection
 * newer than the cluster's own, and its arrival never moves the cluster. When two clusters
 * merge, the one with the older connection stays put while the other attaches to it.
 *
 * Unlocking is the exception: a lock hides the system's connections from the layout, so the
 * system can return holding the cluster's oldest connection and become its anchor. The client
 * that unlocks it moves the system first so the cluster stays put (`unlockAnchorUpdates`).
 */
export const pickAnchor = (nodeIds: string[], edges: PlacementEdge[], rootId: string | null): string => {
  if (rootId && nodeIds.includes(rootId)) {
    return rootId;
  }

  let oldest: PlacementEdge | undefined;
  for (const e of edges) {
    if (!oldest || compareEdgeAge(e, oldest) < 0) {
      oldest = e;
    }
  }

  return oldest ? oldest.source : nodeIds[0];
};

interface ReconciledNode {
  id: string;
  position: XYPosition;
  draggable?: boolean;
  /** The server's stored state for the node. */
  data?: { position?: XYPosition; locked?: boolean };
}

export interface NodeUpdate {
  position?: XYPosition;
  draggable?: boolean;
}

export interface ReconcileState {
  /** Nodes the layout placed. */
  placed: Set<string>;
  /** Nodes made non-draggable because their cluster is pinned. */
  pinned: Set<string>;
}

export const EMPTY_RECONCILE_STATE: ReconcileState = { placed: new Set(), pinned: new Set() };

export interface ReconcileResult {
  /** Nodes whose displayed state must change, and how. */
  updates: Map<string, NodeUpdate>;
  /** Pass to the next call as `previous`. */
  state: ReconcileState;
}

/**
 * Display state for one reconcile pass.
 *
 * - A placed node goes to its anchor's *stored* position plus its offset, so every client
 *   derives the same picture from shared server state. A node the layout placed last pass but
 *   no longer does (it was locked, disconnected, or auto-layout was turned off) goes back to its
 *   own stored position, which is also what any client that loads the map now would show.
 * - A node in a pinned cluster is made non-draggable; once it isn't, it gets back the
 *   draggability nodes normally have (`!locked`, as `convertSystem2Node` sets it).
 */
export const reconcileNodes = (
  nodes: ReconciledNode[],
  placements: Map<string, Placement>,
  previous: ReconcileState,
): ReconcileResult => {
  const stored = new Map<string, XYPosition>();
  nodes.forEach(n => {
    if (n.data?.position) {
      stored.set(n.id, n.data.position);
    }
  });

  const updates = new Map<string, NodeUpdate>();
  const state: ReconcileState = { placed: new Set(), pinned: new Set() };

  nodes.forEach(n => {
    const update: NodeUpdate = {};
    const placement = placements.get(n.id);

    let target: XYPosition | undefined;
    if (placement) {
      state.placed.add(n.id);
      const anchor = stored.get(placement.anchorId);
      // When the anchor was just removed, the layout pass that follows re-anchors this cluster,
      // so leave the node where it is rather than flicker it to its own stored position meanwhile.
      if (anchor) {
        target = { x: anchor.x + placement.offset.x, y: anchor.y + placement.offset.y };
      }
    } else if (previous.placed.has(n.id)) {
      target = stored.get(n.id);
    }
    if (target && (target.x !== n.position.x || target.y !== n.position.y)) {
      update.position = target;
    }

    if (placement?.pinned) {
      state.pinned.add(n.id);
      if (n.draggable !== false) {
        update.draggable = false;
      }
    } else if (previous.pinned.has(n.id)) {
      const natural = !n.data?.locked;
      if (n.draggable !== natural) {
        update.draggable = natural;
      }
    }

    if (update.position || update.draggable !== undefined) {
      updates.set(n.id, update);
    }
  });

  return { updates, state };
};
