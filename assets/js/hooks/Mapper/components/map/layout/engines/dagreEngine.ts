import dagre from '@dagrejs/dagre';
import { XYPosition } from 'reactflow';
import { LayoutEdgeInput, LayoutEngine, LayoutInput, LayoutNodeInput, LayoutOptions, LayoutResult } from '../types';

/**
 * Dagre's own option vocabulary. These are layered-graph concepts — a rank is a tree level —
 * and mean nothing to a radial or force-directed engine, so they stay local to this module
 * rather than sitting in the shared layout contract.
 *
 * The keys and values mirror the `dagre` entry of the server-side catalog in
 * `WandererApp.Map.LayoutEngines`; anything unrecognised falls back to the defaults below, so a
 * stale or hand-edited stored value degrades to a sane layout instead of breaking one.
 */
export type DagreDirection = 'LR' | 'TB' | 'RL' | 'BT';
export type DagreRanker = 'network-simplex' | 'tight-tree' | 'longest-path';

const DIRECTIONS: readonly DagreDirection[] = ['LR', 'TB', 'RL', 'BT'];
const RANKERS: readonly DagreRanker[] = ['network-simplex', 'tight-tree', 'longest-path'];

const DEFAULT_DIRECTION: DagreDirection = 'LR';
const DEFAULT_RANKER: DagreRanker = 'network-simplex';

// Spacing presets in px: gaps between tree levels (ranks) and between siblings within a level.
// Loosely mirrors the server-side new-node spacing (map_position_calculator.ex: node 130x34,
// @m_x 50, @m_y 41).
const RANK_SEP_PRESETS: Record<string, number> = { compact: 45, normal: 90, spacious: 150 };
const NODE_SEP_PRESETS: Record<string, number> = { compact: 20, normal: 45, spacious: 90 };

const oneOf = <T extends string>(valid: readonly T[], value: string | undefined, fallback: T): T =>
  valid.includes(value as T) ? (value as T) : fallback;

const preset = (presets: Record<string, number>, value: string | undefined): number =>
  presets[value ?? ''] ?? presets.normal;

const rankdirFor = (direction: DagreDirection): 'TB' | 'BT' | 'LR' | 'RL' => direction;

const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

/**
 * Re-orient edges as a spanning tree rooted at `rootId` (parent -> child via BFS) so the
 * root lands at rank 0. Non-tree edges (cycles) are appended as-is; dagre handles the
 * resulting back-edges. Deterministic: neighbors are visited in id order.
 */
const orientFromRoot = (nodes: LayoutNodeInput[], edges: LayoutEdgeInput[], rootId: string): LayoutEdgeInput[] => {
  const adj = new Map<string, string[]>();
  nodes.forEach(n => adj.set(n.id, []));
  edges.forEach(e => {
    adj.get(e.source)?.push(e.target);
    adj.get(e.target)?.push(e.source);
  });
  adj.forEach((v, k) => adj.set(k, v.slice().sort()));

  const visited = new Set<string>([rootId]);
  const queue: string[] = [rootId];
  const oriented: LayoutEdgeInput[] = [];
  const seen = new Set<string>();

  while (queue.length) {
    const cur = queue.shift() as string;
    for (const nb of adj.get(cur) ?? []) {
      if (!visited.has(nb)) {
        visited.add(nb);
        oriented.push({ source: cur, target: nb });
        seen.add(pairKey(cur, nb));
        queue.push(nb);
      }
    }
  }

  // Keep any remaining (cycle-closing) edges so dagre still constrains them.
  edges.forEach(e => {
    const key = pairKey(e.source, e.target);
    if (!seen.has(key)) {
      seen.add(key);
      oriented.push(e);
    }
  });

  return oriented;
};

const readOptions = (options: LayoutOptions) => ({
  direction: oneOf(DIRECTIONS, options.direction, DEFAULT_DIRECTION),
  ranker: oneOf(RANKERS, options.ranker, DEFAULT_RANKER),
  rankSep: preset(RANK_SEP_PRESETS, options.rank_sep),
  nodeSep: preset(NODE_SEP_PRESETS, options.node_sep),
});

export const dagreEngine: LayoutEngine = {
  id: 'dagre',
  label: 'Tree',
  supportsRoot: true,

  compute({ nodes, edges, rootId, options }: LayoutInput): LayoutResult {
    const positions: Record<string, XYPosition> = {};
    if (nodes.length === 0) {
      return { positions };
    }

    const { direction, ranker, rankSep, nodeSep } = readOptions(options);

    const g = new dagre.graphlib.Graph();
    g.setGraph({
      rankdir: rankdirFor(direction),
      ranksep: rankSep,
      nodesep: nodeSep,
      ranker,
    });
    g.setDefaultEdgeLabel(() => ({}));

    // Deterministic insertion order -> identical layout on every client.
    const sortedNodes = [...nodes].sort((a, b) => a.id.localeCompare(b.id));
    sortedNodes.forEach(n => g.setNode(n.id, { width: n.width, height: n.height }));

    const useEdges =
      rootId && nodes.some(n => n.id === rootId) ? orientFromRoot(sortedNodes, edges, rootId) : [...edges];

    useEdges
      .sort((a, b) => a.source.localeCompare(b.source) || a.target.localeCompare(b.target))
      .forEach(e => g.setEdge(e.source, e.target));

    dagre.layout(g);

    sortedNodes.forEach(n => {
      const pos = g.node(n.id);
      if (pos) {
        // dagre reports node centers; React Flow positions are top-left corners.
        positions[n.id] = { x: pos.x - n.width / 2, y: pos.y - n.height / 2 };
      }
    });

    return { positions };
  },
};
