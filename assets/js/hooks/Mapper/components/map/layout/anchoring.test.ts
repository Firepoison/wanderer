import { XYPosition } from 'reactflow';
import {
  computePlacements,
  EMPTY_RECONCILE_STATE,
  pickAnchor,
  Placement,
  PlacementEdge,
  PlacementInput,
  reconcileNodes,
} from './anchoring';
import { LayoutEngine, LayoutInput } from './types';

const edge = (source: string, target: string, createdAt: number): PlacementEdge => ({ source, target, createdAt });

// Lays nodes out on a line in id order, 100px apart, so offsets are easy to predict.
const lineEngine = (overrides: Partial<LayoutEngine> = {}): LayoutEngine & { calls: LayoutInput[] } => {
  const calls: LayoutInput[] = [];
  return {
    id: 'line',
    supportsRoot: true,
    calls,
    compute(input) {
      calls.push(input);
      const positions: Record<string, XYPosition> = {};
      [...input.nodes]
        .sort((a, b) => (a.id < b.id ? -1 : 1))
        .forEach((n, i) => (positions[n.id] = { x: i * 100, y: 0 }));
      return { positions };
    },
    ...overrides,
  };
};

const placementsOf = (input: Partial<PlacementInput> & Pick<PlacementInput, 'nodes' | 'edges'>) =>
  computePlacements({
    engine: lineEngine(),
    rootId: null,
    options: {},
    nodeSize: { width: 142, height: 37 },
    ...input,
  });

const unlocked = (...ids: string[]) => ids.map(id => ({ id, locked: false }));

describe('pickAnchor', () => {
  it('prefers the root when the cluster contains it', () => {
    expect(pickAnchor(['a', 'b', 'c'], [edge('a', 'b', 1)], 'c')).toBe('c');
  });

  it('ignores a root outside the cluster', () => {
    expect(pickAnchor(['a', 'b'], [edge('b', 'a', 1)], 'zz')).toBe('b');
  });

  it('otherwise picks the source of the oldest connection', () => {
    expect(pickAnchor(['a', 'b', 'c'], [edge('a', 'b', 5), edge('c', 'b', 2)], null)).toBe('c');
  });

  it('breaks ties between equally old connections by source/target id', () => {
    expect(pickAnchor(['a', 'b', 'c'], [edge('c', 'b', 2), edge('a', 'b', 2)], null)).toBe('a');
    expect(pickAnchor(['a', 'b'], [edge('b', 'a', Infinity), edge('a', 'b', Infinity)], null)).toBe('a');
  });

  it('falls back to the first node when there are no connections', () => {
    expect(pickAnchor(['a', 'b'], [], null)).toBe('a');
  });
});

describe('computePlacements', () => {
  it('places only clusters of at least two connected nodes', async () => {
    const { placements, clusterByNode } = await placementsOf({
      nodes: unlocked('a', 'b', 'lonely'),
      edges: [edge('a', 'b', 1)],
    });

    expect([...placements.keys()].sort()).toEqual(['a', 'b']);
    expect(clusterByNode.get('a')).toEqual(['a', 'b']);
    expect(clusterByNode.has('lonely')).toBe(false);
  });

  it('expresses positions as rounded offsets from the anchor', async () => {
    const engine = lineEngine({
      compute: () => ({ positions: { a: { x: 10.4, y: 5 }, b: { x: 110.6, y: 5.6 } } }),
    });
    const { placements } = await placementsOf({ engine, nodes: unlocked('a', 'b'), edges: [edge('b', 'a', 1)] });

    expect(placements.get('b')).toEqual({ anchorId: 'b', offset: { x: 0, y: 0 }, pinned: false });
    expect(placements.get('a')).toEqual({ anchorId: 'b', offset: { x: -100, y: -1 }, pinned: false });
  });

  it('leaves locked nodes out, splitting the clusters they connected', async () => {
    const { placements, clusterByNode } = await placementsOf({
      nodes: [...unlocked('a', 'b', 'c', 'd'), { id: 'hub', locked: true }],
      edges: [edge('a', 'b', 1), edge('b', 'hub', 2), edge('hub', 'c', 3), edge('c', 'd', 4)],
    });

    expect(placements.has('hub')).toBe(false);
    expect(clusterByNode.get('a')).toEqual(['a', 'b']);
    expect(clusterByNode.get('c')).toEqual(['c', 'd']);
  });

  it('keeps a locked root in its cluster as the anchor, and pins that cluster', async () => {
    const { placements } = await placementsOf({
      rootId: 'r',
      nodes: [{ id: 'r', locked: true }, ...unlocked('a', 'x', 'y')],
      edges: [edge('r', 'a', 5), edge('x', 'y', 1)],
    });

    expect(placements.get('r')).toMatchObject({ anchorId: 'r', pinned: true });
    expect(placements.get('a')).toMatchObject({ anchorId: 'r', pinned: true });
    expect(placements.get('x')).toMatchObject({ anchorId: 'x', pinned: false });
  });

  it('does not pin a cluster whose root is unlocked', async () => {
    const { placements } = await placementsOf({ rootId: 'r', nodes: unlocked('r', 'a'), edges: [edge('a', 'r', 1)] });

    expect(placements.get('a')).toMatchObject({ anchorId: 'r', pinned: false });
  });

  it('gives the engine the root only for the cluster that contains it, at the nominal size', async () => {
    const engine = lineEngine();
    await placementsOf({
      engine,
      rootId: 'r',
      nodeSize: { width: 50, height: 20 },
      nodes: unlocked('r', 'a', 'x', 'y'),
      edges: [edge('r', 'a', 1), edge('x', 'y', 2)],
    });

    const byCluster = Object.fromEntries(engine.calls.map(call => [call.nodes.map(n => n.id).join(','), call]));
    expect(byCluster['a,r'].rootId).toBe('r');
    expect(byCluster['x,y'].rootId).toBeNull();
    expect(engine.calls.flatMap(call => call.nodes)).toEqual(
      expect.arrayContaining([{ id: 'r', width: 50, height: 20 }]),
    );
  });

  it('ignores connections to systems that are not on the map', async () => {
    const { placements } = await placementsOf({
      nodes: unlocked('a', 'b'),
      edges: [edge('a', 'b', 1), edge('b', 'gone', 0)],
    });

    // The connection to "gone" is older, but it is not part of the map, so it cannot pick the anchor.
    expect(placements.get('b')!.anchorId).toBe('a');
  });

  it('awaits engines that compute asynchronously', async () => {
    const engine = lineEngine();
    const asyncEngine = { ...engine, compute: async (input: LayoutInput) => engine.compute(input) };
    const { placements } = await placementsOf({
      engine: asyncEngine,
      nodes: unlocked('a', 'b'),
      edges: [edge('a', 'b', 1)],
    });

    expect(placements.get('b')!.offset).toEqual({ x: 100, y: 0 });
  });

  it('skips a cluster when the engine returns no position for its anchor', async () => {
    const engine = lineEngine({ compute: () => ({ positions: { b: { x: 0, y: 0 } } }) });
    const { placements, clusterByNode } = await placementsOf({
      engine,
      nodes: unlocked('a', 'b'),
      edges: [edge('a', 'b', 1)],
    });

    expect(placements.size).toBe(0);
    expect(clusterByNode.size).toBe(0);
  });

  it('leaves out a member the engine returns no position for, keeping the rest of its cluster', async () => {
    const engine = lineEngine({ compute: () => ({ positions: { a: { x: 0, y: 0 }, b: { x: 100, y: 0 } } }) });
    const { placements, clusterByNode } = await placementsOf({
      engine,
      nodes: unlocked('a', 'b', 'c'),
      edges: [edge('a', 'b', 1), edge('b', 'c', 2)],
    });

    expect([...placements.keys()].sort()).toEqual(['a', 'b']);
    expect(clusterByNode.has('c')).toBe(false);
  });
});

describe('reconcileNodes', () => {
  type TestNode = {
    id: string;
    position: XYPosition;
    draggable?: boolean;
    data: { position: XYPosition; locked?: boolean };
  };
  const node = (id: string, stored: XYPosition, displayed: XYPosition = stored, extra: Partial<TestNode> = {}) => ({
    id,
    position: displayed,
    draggable: true,
    data: { position: stored, locked: false },
    ...extra,
  });
  const placement = (anchorId: string, x: number, y: number, pinned = false): Placement => ({
    anchorId,
    offset: { x, y },
    pinned,
  });

  it("places each node at its anchor's stored position plus its offset", () => {
    const nodes = [node('a', { x: 10, y: 10 }), node('b', { x: 999, y: 999 })];
    const placements = new Map([
      ['a', placement('a', 0, 0)],
      ['b', placement('a', 100, 5)],
    ]);

    const { updates, state } = reconcileNodes(nodes, placements, EMPTY_RECONCILE_STATE);

    expect(updates).toEqual(new Map([['b', { position: { x: 110, y: 15 } }]]));
    expect([...state.placed].sort()).toEqual(['a', 'b']);
  });

  it('reports nothing when every node is already where it belongs', () => {
    const nodes = [node('a', { x: 10, y: 10 }), node('b', { x: 0, y: 0 }, { x: 110, y: 15 })];
    const placements = new Map([
      ['a', placement('a', 0, 0)],
      ['b', placement('a', 100, 5)],
    ]);

    expect(reconcileNodes(nodes, placements, EMPTY_RECONCILE_STATE).updates.size).toBe(0);
  });

  it('returns a node that just left the layout to its stored position, and leaves others alone', () => {
    const nodes = [node('left', { x: 1, y: 2 }, { x: 50, y: 50 }), node('never', { x: 3, y: 4 }, { x: 70, y: 70 })];
    const previous = { placed: new Set(['left']), pinned: new Set<string>() };

    const { updates, state } = reconcileNodes(nodes, new Map(), previous);

    expect(updates).toEqual(new Map([['left', { position: { x: 1, y: 2 } }]]));
    expect(state.placed.size).toBe(0);
  });

  it('keeps a node in place, still placed, while its anchor is missing', () => {
    const nodes = [node('b', { x: 0, y: 0 }, { x: 40, y: 40 })];
    const placements = new Map([['b', placement('gone', 10, 10)]]);

    const { updates, state } = reconcileNodes(nodes, placements, EMPTY_RECONCILE_STATE);

    expect(updates.size).toBe(0);
    expect(state.placed.has('b')).toBe(true);
  });

  it('makes pinned nodes non-draggable and restores them once they are no longer pinned', () => {
    const nodes = [
      node('r', { x: 0, y: 0 }, { x: 0, y: 0 }, { draggable: false, data: { position: { x: 0, y: 0 }, locked: true } }),
      node('a', { x: 100, y: 0 }),
    ];
    const pinned = new Map([
      ['r', placement('r', 0, 0, true)],
      ['a', placement('r', 100, 0, true)],
    ]);

    const first = reconcileNodes(nodes, pinned, EMPTY_RECONCILE_STATE);
    expect(first.updates).toEqual(new Map([['a', { draggable: false }]]));
    expect([...first.state.pinned].sort()).toEqual(['a', 'r']);

    const pinnedNodes = nodes.map(n => (n.id === 'a' ? { ...n, draggable: false } : n));
    const unpinned = new Map([
      ['r', placement('r', 0, 0)],
      ['a', placement('r', 100, 0)],
    ]);
    const second = reconcileNodes(pinnedNodes, unpinned, first.state);
    // The locked root stays non-draggable; the rest regain the draggability nodes normally have.
    expect(second.updates).toEqual(new Map([['a', { draggable: true }]]));
    expect(second.state.pinned.size).toBe(0);
  });

  it('never changes draggability of nodes it did not pin', () => {
    const nodes = [node('x', { x: 0, y: 0 }, { x: 0, y: 0 }, { draggable: false })];

    expect(reconcileNodes(nodes, new Map(), EMPTY_RECONCILE_STATE).updates.size).toBe(0);
  });

  it('reaches a fixed point: applying its updates leaves nothing to do', () => {
    const nodes = [node('a', { x: 5, y: 5 }), node('b', { x: 0, y: 0 }), node('c', { x: 0, y: 0 }, { x: 9, y: 9 })];
    const placements = new Map([
      ['a', placement('a', 0, 0, true)],
      ['b', placement('a', 30, 40, true)],
    ]);
    const previous = { placed: new Set(['c']), pinned: new Set<string>() };

    const first = reconcileNodes(nodes, placements, previous);
    const applied = nodes.map(n => ({ ...n, ...first.updates.get(n.id) }));

    expect(reconcileNodes(applied, placements, first.state).updates.size).toBe(0);
  });
});
