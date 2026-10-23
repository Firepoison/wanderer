import { XYPosition } from 'reactflow';
import { getConnectedComponents } from './helpers';
import { LayoutEdgeInput, LayoutEngine, LayoutOptions } from './types';

/** Where a laid-out node sits: an offset from its cluster's anchor node. */
export interface Placement {
  anchorId: string;
  offset: XYPosition;
}

export interface PlacementNode {
  id: string;
  locked: boolean;
  /** Epoch ms; Infinity when unknown. */
  createdAt: number;
}

export interface PlacementInput {
  engine: LayoutEngine;
  nodes: PlacementNode[];
  edges: LayoutEdgeInput[];
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

/**
 * Lays out every *managed* cluster — a connected group of at least two unlocked nodes — and
 * expresses each member's position as an offset from the cluster's anchor. Positions are not an
 * input, so the result is a pure function of structure, options and root.
 */
export const computePlacements = async ({
  engine,
  nodes,
  edges,
  rootId,
  options,
  nodeSize,
}: PlacementInput): Promise<PlacementResult> => {
  const nodeIds = new Set<string>();
  const locked = new Set<string>();
  const createdAt = new Map<string, number>();
  nodes.forEach(n => {
    nodeIds.add(n.id);
    createdAt.set(n.id, n.createdAt);
    if (n.locked) {
      locked.add(n.id);
    }
  });

  const unlockedIds = nodes.filter(n => !n.locked).map(n => n.id);
  const layoutEdges = edges.filter(
    e => !locked.has(e.source) && !locked.has(e.target) && nodeIds.has(e.source) && nodeIds.has(e.target),
  );

  const components = getConnectedComponents(unlockedIds, layoutEdges).filter(c => c.nodeIds.length >= 2);

  const placements = new Map<string, Placement>();
  const clusterByNode = new Map<string, string[]>();

  for (const comp of components) {
    const compRoot = rootId && comp.nodeIds.includes(rootId) ? rootId : null;

    const result = await engine.compute({
      nodes: comp.nodeIds.map(id => ({ id, ...nodeSize })),
      edges: comp.edges,
      rootId: compRoot,
      options,
    });

    const anchorId = pickAnchor(comp.nodeIds, compRoot, id => createdAt.get(id) ?? Infinity);
    const origin = result.positions[anchorId];
    if (!origin) {
      continue;
    }

    comp.nodeIds.forEach(id => {
      const p = result.positions[id];
      if (!p) {
        return;
      }
      clusterByNode.set(id, comp.nodeIds);
      placements.set(id, {
        anchorId,
        offset: { x: Math.round(p.x - origin.x), y: Math.round(p.y - origin.y) },
      });
    });
  }

  return { placements, clusterByNode };
};

/**
 * The node a cluster is pinned to: the root when the cluster contains it, otherwise the oldest
 * member (ties and missing timestamps broken by id). Adding a node therefore never moves an
 * existing cluster, and when two clusters merge the newer one attaches to the older.
 */
export const pickAnchor = (nodeIds: string[], rootId: string | null, createdAt: (id: string) => number): string => {
  if (rootId && nodeIds.includes(rootId)) {
    return rootId;
  }

  let anchor = nodeIds[0];
  let anchorCreatedAt = createdAt(anchor);
  for (const id of nodeIds) {
    const at = createdAt(id);
    if (at < anchorCreatedAt || (at === anchorCreatedAt && id < anchor)) {
      anchor = id;
      anchorCreatedAt = at;
    }
  }

  return anchor;
};

interface PositionedNode {
  id: string;
  position: XYPosition;
  /** The server's stored position for the node. */
  data?: { position?: XYPosition };
}

export interface ReconcileResult {
  /** Nodes whose displayed position must change, and where to. */
  moves: Map<string, XYPosition>;
  /** Nodes the layout now places; pass to the next call as `previouslyPlaced`. */
  placed: Set<string>;
}

/**
 * Display positions for one reconcile pass. A placed node goes to its anchor's *stored* position
 * plus its offset, so every client derives the same picture from shared server state. A node the
 * layout placed last pass but no longer does (it was locked, disconnected, or auto-layout was
 * turned off) goes back to its own stored position, which is also what any client that loads the
 * map now would show.
 */
export const reconcilePositions = (
  nodes: PositionedNode[],
  placements: Map<string, Placement>,
  previouslyPlaced: Set<string>,
): ReconcileResult => {
  const stored = new Map<string, XYPosition>();
  nodes.forEach(n => {
    if (n.data?.position) {
      stored.set(n.id, n.data.position);
    }
  });

  const moves = new Map<string, XYPosition>();
  const placed = new Set<string>();

  nodes.forEach(n => {
    let target: XYPosition | undefined;

    const placement = placements.get(n.id);
    if (placement) {
      placed.add(n.id);
      const anchor = stored.get(placement.anchorId);
      // The anchor was just removed; the layout pass that follows re-anchors this cluster, so
      // leave the node where it is rather than flicker it to its own stored position meanwhile.
      if (!anchor) {
        return;
      }
      target = { x: anchor.x + placement.offset.x, y: anchor.y + placement.offset.y };
    } else if (previouslyPlaced.has(n.id)) {
      target = stored.get(n.id);
    }

    if (target && (target.x !== n.position.x || target.y !== n.position.y)) {
      moves.set(n.id, target);
    }
  });

  return { moves, placed };
};
