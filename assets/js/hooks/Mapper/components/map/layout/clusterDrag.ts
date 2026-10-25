import { XYPosition } from 'reactflow';

interface PositionedNode {
  id: string;
  position: XYPosition;
}

/**
 * A drag that moves whole clusters. React Flow snaps each dragged node to the grid on its own,
 * so two dragged nodes can move by slightly different amounts; each cluster therefore follows
 * one of its own dragged nodes, its leader, and every member of the cluster — dragged or not —
 * moves by the leader's delta. That keeps each cluster's shape exact, so the positions saved on
 * drop are exactly the ones the layout then draws.
 */
export interface ClusterDrag {
  /** Start position of every node the drag moves: the dragged nodes and the rest of their clusters. */
  start: Record<string, XYPosition>;
  /** Member of a dragged cluster -> the dragged node whose movement the cluster follows. */
  leaderOf: Record<string, string>;
}

/**
 * Plans a drag of `draggedIds`. The grabbed node leads its own cluster; any other dragged
 * cluster is led by its first dragged member. In a selection drag nothing is grabbed, so pass
 * any of the dragged nodes.
 */
export const startClusterDrag = (
  nodes: PositionedNode[],
  draggedIds: string[],
  grabbedId: string,
  getCluster: (nodeId: string) => string[] | undefined,
): ClusterDrag => {
  const leaderOf: Record<string, string> = {};
  [grabbedId, ...draggedIds.filter(id => id !== grabbedId)].forEach(id => {
    // A member of a cluster that already has a leader.
    if (leaderOf[id]) {
      return;
    }
    getCluster(id)?.forEach(member => (leaderOf[member] = id));
  });

  const moving = new Set([...draggedIds, ...Object.keys(leaderOf)]);
  // Single pass over the nodes with a membership set — a `find` per member would be
  // O(members * nodes), and for auto-layout maps most nodes are in one cluster.
  const start: Record<string, XYPosition> = {};
  nodes.forEach(n => {
    if (moving.has(n.id)) {
      start[n.id] = { x: n.position.x, y: n.position.y };
    }
  });

  return { start, leaderOf };
};

/**
 * Where every member of a dragged cluster should be: its start position plus its leader's delta
 * so far, taken from the dragged nodes' current positions. Dragged nodes outside any cluster
 * aren't included; they stay wherever React Flow puts them.
 */
export const clusterDragTargets = (drag: ClusterDrag, dragged: PositionedNode[]): Record<string, XYPosition> => {
  const deltas: Record<string, XYPosition> = {};
  dragged.forEach(n => {
    const s = drag.start[n.id];
    if (s) {
      deltas[n.id] = { x: n.position.x - s.x, y: n.position.y - s.y };
    }
  });

  const targets: Record<string, XYPosition> = {};
  Object.entries(drag.leaderOf).forEach(([id, leader]) => {
    const s = drag.start[id];
    const d = deltas[leader];
    if (s && d) {
      targets[id] = { x: s.x + d.x, y: s.y + d.y };
    }
  });

  return targets;
};

/**
 * The positions to save when a drag ends. Cluster members get their start positions plus their
 * leader's total delta — exactly the transform `clusterDragTargets` applied while dragging;
 * reading them back from React Flow's store instead would pick up the previous frame's
 * coordinates and snap the cluster backwards. Dragged nodes outside any cluster keep where React
 * Flow put them.
 */
export const clusterDropUpdates = (
  drag: ClusterDrag,
  dragged: PositionedNode[],
): { solar_system_id: string; position: XYPosition }[] => {
  const targets = clusterDragTargets(drag, dragged);
  const updates = dragged.filter(n => !targets[n.id]).map(n => ({ solar_system_id: n.id, position: n.position }));
  Object.entries(targets).forEach(([id, position]) => updates.push({ solar_system_id: id, position }));
  return updates;
};
