/**
 * End-to-end scenarios for the auto-layout model: several simulated clients run the real layout
 * modules the way useAutoLayout and Map.tsx glue them together (layout pass, reconcile pass,
 * optimistic saves, server echoes, cluster drags), and the tests check what each client draws.
 */
import { XYPosition } from 'reactflow';
import { computePlacements, Placement, PlacementEdge, ReconcileState, reconcileNodes } from './anchoring';
import { clusterDropUpdates, startClusterDrag } from './clusterDrag';
import { dagreEngine } from './engines/dagreEngine';
import { displayedUpdates, preSaveUpdates, structureChangeIds, unlockPreSave } from './orchestration';

type SystemSpec = { id: string; stored: XYPosition; locked?: boolean };
type ClientNode = {
  id: string;
  position: XYPosition;
  draggable: boolean;
  data: { position: XYPosition; locked: boolean };
};
type PositionUpdate = { solar_system_id: string; position: XYPosition };

const SIZE = { width: 142, height: 37 };

// React Flow's snapToGrid: each dragged node's position is rounded to the 15px grid on its own.
const snap = (p: XYPosition): XYPosition => ({ x: 15 * Math.round(p.x / 15), y: 15 * Math.round(p.y / 15) });

/** The server: stored positions. */
let server: Map<string, XYPosition>;
const sys = (id: string, x: number, y: number, locked = false): SystemSpec => {
  server.set(id, { x, y });
  return { id, stored: { x, y }, locked };
};

/** One browser tab: its React Flow nodes plus the hook's per-client state. */
class Client {
  nodes: ClientNode[] = [];
  edges: PlacementEdge[] = [];
  placements = new Map<string, Placement>();
  state: ReconcileState = { placed: new Set(), pinned: new Set() };
  cluster = new Map<string, string[]>();
  rootId: string | null = null;
  options: Record<string, string> = {};

  constructor(systems: SystemSpec[]) {
    systems.forEach(s => this.add(s));
  }

  /** As convertSystem2Node: draggable = !locked. */
  add(s: SystemSpec) {
    this.nodes.push({
      id: s.id,
      position: { ...s.stored },
      draggable: !s.locked,
      data: { position: { ...s.stored }, locked: !!s.locked },
    });
  }

  remove(id: string) {
    this.nodes = this.nodes.filter(n => n.id !== id);
  }

  /** A server echo (update_system / update_systems): position, data and draggable are replaced. */
  echo(id: string, stored: XYPosition, locked?: boolean) {
    const n = this.node(id);
    const isLocked = locked ?? n.data.locked;
    n.position = { ...stored };
    n.draggable = !isLocked;
    n.data = { position: { ...stored }, locked: isLocked };
  }

  /** The layout pass followed by the reconcile pass; returns how many nodes reconcile changed. */
  async layout(edges: PlacementEdge[], rootId: string | null, options: Record<string, string> = {}, enabled = true) {
    this.edges = edges;
    this.rootId = rootId;
    this.options = options;
    if (enabled) {
      const result = await computePlacements({
        engine: dagreEngine,
        nodes: this.nodes.map(n => ({ id: n.id, locked: n.data.locked })),
        edges,
        rootId,
        options,
        nodeSize: SIZE,
      });
      this.placements = result.placements;
      this.cluster = result.clusterByNode;
    } else {
      this.placements = new Map();
      this.cluster = new Map();
    }
    return this.reconcile();
  }

  reconcile() {
    const { updates, state } = reconcileNodes(this.nodes, this.placements, this.state);
    this.state = state;
    this.nodes = this.nodes.map(n => (updates.has(n.id) ? { ...n, ...updates.get(n.id) } : n));
    // Applying a reconcile must leave nothing for the next one, or the hook would render-loop.
    expect(reconcileNodes(this.nodes, this.placements, this.state).updates.size).toBe(0);
    return updates.size;
  }

  node(id: string) {
    const n = this.nodes.find(x => x.id === id);
    if (!n) throw new Error(`no node ${id}`);
    return n;
  }

  pos(id: string) {
    return this.node(id).position;
  }

  snapshot() {
    return Object.fromEntries(this.nodes.map(n => [n.id, { ...n.position }]));
  }

  /** As savePositions' optimistic half: displayed and stored positions both become the update. */
  recordStored(updates: PositionUpdate[]) {
    const byId = new Map(updates.map(u => [u.solar_system_id, u.position]));
    this.nodes = this.nodes.map(n => {
      const p = byId.get(n.id);
      return p ? { ...n, position: p, data: { ...n.data, position: p } } : n;
    });
  }

  /** The server stores the updates and echoes them back. */
  serverApplies(updates: PositionUpdate[], to: Client[] = [this]) {
    updates.forEach(u => {
      server.set(u.solar_system_id, u.position);
      to.forEach(c => c.echo(u.solar_system_id, u.position));
    });
    to.forEach(c => c.reconcile());
  }

  /**
   * A drag in Map.tsx: startClusterDrag, React Flow moving each dragged node (snapped to the grid
   * when `snapToGrid`), clusterDropUpdates on drop, then savePositions and the deferred reconcile.
   */
  drag(grabbed: string[], delta: XYPosition, { snapToGrid = false } = {}) {
    grabbed.forEach(id => expect(this.node(id).draggable).toBe(true));
    const drag = startClusterDrag(this.nodes, grabbed, grabbed[0], id => this.cluster.get(id));
    const dragged = grabbed.map(id => {
      const p = this.pos(id);
      const moved = { x: p.x + delta.x, y: p.y + delta.y };
      return { id, position: snapToGrid ? snap(moved) : moved };
    });
    const updates = clusterDropUpdates(drag, dragged);
    this.recordStored(updates);
    return { updates, snapBack: this.reconcile() };
  }

  /** useAutoLayout's structure-change listener: the systems' clusters and their neighbours'. */
  saveAround(systemIds: string[], { removing = false, unlocking = false } = {}) {
    const ids = structureChangeIds({ systemIds, removing, edges: this.edges, clusterByNode: this.cluster });
    const anchors = unlocking
      ? unlockPreSave({
          unlocking: systemIds,
          nodes: this.nodes.map(n => ({ id: n.id, position: n.position, locked: n.data.locked })),
          edges: this.edges,
          before: this.placements,
          layout: { engine: dagreEngine, rootId: this.rootId, options: this.options, nodeSize: SIZE },
        })
      : [];
    const updates = preSaveUpdates(displayedUpdates(this.nodes, ids), anchors);
    this.serverApplies(updates);
    return updates;
  }

  /** As saveLayout: every placed node whose displayed position differs from its stored one. */
  saveLayout() {
    const updates = displayedUpdates(this.nodes, this.state.placed);
    this.serverApplies(updates);
    return updates;
  }

  storedVsDrawn() {
    return this.nodes
      .filter(n => n.position.x !== n.data.position.x || n.position.y !== n.data.position.y)
      .map(n => n.id);
  }
}

/** A client that loads the map now, from the server's stored state. */
const freshClient = (like: Client) =>
  new Client(
    [...server].map(([id, stored]) => ({ id, stored, locked: like.nodes.find(n => n.id === id)?.data.locked })),
  );

// A home tree, a separate chain and an isolated system, with deliberately messy stored positions.
// The R-A link is the home tree's oldest connection; X-Y is the chain's only one.
const base = () => [
  sys('R', 100, 100),
  sys('A', 400, 260),
  sys('B', 380, 20),
  sys('C', 900, 700),
  sys('X', 2000, 1500),
  sys('Y', 2100, 1650),
  sys('Z', -500, -500),
];
const baseEdges: PlacementEdge[] = [
  { source: 'R', target: 'A', createdAt: 1 },
  { source: 'A', target: 'B', createdAt: 2 },
  { source: 'A', target: 'C', createdAt: 3 },
  { source: 'X', target: 'Y', createdAt: 4 },
];
const without = (edges: PlacementEdge[], pred: (e: PlacementEdge) => boolean) => edges.filter(e => !pred(e));

beforeEach(() => {
  server = new Map();
});

describe('what each client draws', () => {
  it('keeps anchors at their stored positions and leaves isolated systems alone', async () => {
    const c = new Client(base());
    await c.layout(baseEdges, 'R');

    expect(c.pos('R')).toEqual(server.get('R'));
    expect(c.pos('X')).toEqual(server.get('X'));
    expect(c.pos('Z')).toEqual(server.get('Z'));
    expect(c.pos('A')).not.toEqual(server.get('A'));
  });

  it('converges on the same picture whatever each client displayed before', async () => {
    const one = new Client(base());
    const two = new Client(base());
    two.nodes.forEach((n, i) => (n.position = { x: n.position.x + 37 * i, y: n.position.y - 11 * i }));
    two.state = { placed: new Set(['A', 'B']), pinned: new Set() };

    await one.layout(baseEdges, 'R');
    await two.layout(baseEdges, 'R');

    // Every laid-out system; the isolated Z isn't the layout's to move.
    ['R', 'A', 'B', 'C', 'X', 'Y'].forEach(id => expect(two.pos(id)).toEqual(one.pos(id)));
  });

  it('puts a node back in its tree after a server echo resets it', async () => {
    const c = new Client(base());
    await c.layout(baseEdges, 'R');
    const before = c.snapshot();

    c.echo('B', server.get('B')!);

    expect(c.reconcile()).toBe(1);
    expect(c.snapshot()).toEqual(before);
  });

  it('only shifts layout offsets, not the anchor, when options change', async () => {
    const c = new Client(base());
    await c.layout(baseEdges, 'R', { rank_sep: 'compact' });
    const compact = c.snapshot();

    await c.layout(baseEdges, 'R', { rank_sep: 'spacious', direction: 'TB' });

    expect(c.pos('R')).toEqual(compact.R);
    expect(c.pos('B')).not.toEqual(compact.B);
  });
});

describe('anchoring under structural change', () => {
  it('does not move a chain when a long-mapped system rejoins it on a new connection', async () => {
    const c = new Client([sys('B', 0, 0), sys('C', 180, 0), sys('D', 360, 0)]);
    const chain: PlacementEdge[] = [
      { source: 'B', target: 'C', createdAt: 10 },
      { source: 'C', target: 'D', createdAt: 11 },
    ];
    await c.layout(chain, null);
    const before = c.snapshot();

    c.add(sys('Y', 540, 0));
    await c.layout([...chain, { source: 'D', target: 'Y', createdAt: 99 }], null);

    expect(c.placements.get('D')?.anchorId).toBe('B');
    ['B', 'C', 'D'].forEach(id => expect(c.pos(id)).toEqual(before[id]));
  });

  it('does not drift towards a far-away system that joins the tree', async () => {
    const c = new Client(base());
    await c.layout(baseEdges, 'R');
    const root = { ...c.pos('R') };

    c.add(sys('W', 50000, 50000));
    await c.layout([...baseEdges, { source: 'C', target: 'W', createdAt: 9 }], 'R');

    expect(c.pos('R')).toEqual(root);
    expect(Math.abs(c.pos('W').x - root.x)).toBeLessThan(2000);
  });

  it('keeps the cluster with the older connection in place when two clusters merge', async () => {
    const c = new Client(base());
    await c.layout(baseEdges, null);

    await c.layout([...baseEdges, { source: 'B', target: 'X', createdAt: 9 }], null);

    expect(c.pos('R')).toEqual(server.get('R'));
    expect(c.pos('X')).not.toEqual(server.get('X'));
  });

  it('keeps members in place while their anchor is gone, until the next layout pass', async () => {
    const c = new Client(base());
    await c.layout(baseEdges, null);
    const before = c.snapshot();

    c.remove('R');
    expect(c.reconcile()).toBe(0);
    expect(c.pos('A')).toEqual(before.A);

    await c.layout(
      without(baseEdges, e => e.source === 'R'),
      null,
    );
    expect(c.pos('A')).toEqual(server.get('A'));
  });

  it('returns a locked or disconnected system to its stored position', async () => {
    const c = new Client(base());
    await c.layout(baseEdges, 'R');

    c.echo('C', server.get('C')!, true);
    await c.layout(baseEdges, 'R');
    expect(c.pos('C')).toEqual(server.get('C'));
    expect(c.state.placed.has('C')).toBe(false);

    await c.layout(
      without(baseEdges, e => e.source === 'X'),
      'R',
    );
    expect(c.pos('X')).toEqual(server.get('X'));
    expect(c.pos('Y')).toEqual(server.get('Y'));
  });
});

describe('a locked root', () => {
  it('still anchors its tree, pins it, and releases it when unlocked', async () => {
    const c = new Client(base());
    c.echo('R', server.get('R')!, true);
    await c.layout(baseEdges, 'R');

    expect(c.placements.get('A')?.anchorId).toBe('R');
    expect(c.pos('R')).toEqual(server.get('R'));
    ['R', 'A', 'B', 'C'].forEach(id => expect(c.node(id).draggable).toBe(false));
    expect(c.node('X').draggable).toBe(true);

    // An echo makes A draggable again (convertSystem2Node); the next reconcile pins it back.
    c.echo('A', server.get('A')!);
    expect(c.node('A').draggable).toBe(true);
    c.reconcile();
    expect(c.node('A').draggable).toBe(false);

    const pinned = c.snapshot();
    c.echo('R', server.get('R')!, false);
    await c.layout(baseEdges, 'R');
    ['R', 'A', 'B', 'C'].forEach(id => expect(c.node(id).draggable).toBe(true));
    expect(c.snapshot()).toEqual(pinned);
  });

  it('is the only locked system that stays in the layout', async () => {
    const c = new Client(base());
    await c.layout(baseEdges, 'R');

    c.echo('A', c.pos('A'), true);
    await c.layout(baseEdges, 'R');

    expect(c.state.placed.has('R')).toBe(false);
  });
});

describe('dragging', () => {
  it('moves the whole tree without snapping back, and other clients match after the echo', async () => {
    const one = new Client(base());
    const two = new Client(base());
    await one.layout(baseEdges, 'R');
    await two.layout(baseEdges, 'R');

    const { updates, snapBack } = one.drag(['B'], { x: 315, y: -90 });
    expect(snapBack).toBe(0);
    expect(new Set(updates.map(u => u.solar_system_id))).toEqual(new Set(['R', 'A', 'B', 'C']));

    one.serverApplies(updates, [one, two]);
    expect(two.snapshot()).toEqual(one.snapshot());

    const fresh = freshClient(one);
    await fresh.layout(baseEdges, 'R');
    expect(fresh.snapshot()).toEqual(one.snapshot());
  });

  it('moves the whole tree when only part of it is selected', async () => {
    const c = new Client(base());
    await c.layout(baseEdges, 'R');
    const before = c.snapshot();

    const { updates, snapBack } = c.drag(['B', 'Z'], { x: -60, y: 45 });

    expect(snapBack).toBe(0);
    expect(updates).toHaveLength(5);
    ['R', 'A', 'B', 'C', 'Z'].forEach(id => expect(c.pos(id)).toEqual({ x: before[id].x - 60, y: before[id].y + 45 }));
    expect(c.pos('X')).toEqual(before.X);
  });

  it('stores every system where it is drawn after a snapped drag across clusters', async () => {
    const c = new Client(base());
    await c.layout(baseEdges, 'R');
    c.saveLayout();
    expect(c.storedVsDrawn()).toEqual([]);
    const offsets = (ids: string[]) =>
      ids.map(id => ({ x: c.pos(id).x - c.pos(ids[0]).x, y: c.pos(id).y - c.pos(ids[0]).y }));
    const before = { home: offsets(['R', 'A', 'B', 'C']), chain: offsets(['X', 'Y']) };

    const { snapBack } = c.drag(['B', 'Y', 'Z'], { x: -133, y: 7 }, { snapToGrid: true });

    expect(c.storedVsDrawn()).toEqual([]);
    expect(snapBack).toBe(0);
    expect(offsets(['R', 'A', 'B', 'C'])).toEqual(before.home);
    expect(offsets(['X', 'Y'])).toEqual(before.chain);
    expect(c.pos('Z')).toEqual(snap({ x: -500 - 133, y: -500 + 7 }));
  });

  it('moves a tree rigidly when two of its dragged systems snap differently', async () => {
    const c = new Client(base());
    await c.layout(baseEdges, 'R');
    c.saveLayout();
    const a = { ...c.pos('A') };
    const cc = { ...c.pos('C') };
    const delta = [7, 8, 9, 10, 11, 12, 13, 14]
      .map(d => ({ x: -100 + d, y: d }))
      .find(d => {
        const sa = snap({ x: a.x + d.x, y: a.y + d.y });
        const sc = snap({ x: cc.x + d.x, y: cc.y + d.y });
        return sa.x - a.x !== sc.x - cc.x || sa.y - a.y !== sc.y - cc.y;
      });
    expect(delta).toBeDefined();
    const root = { ...c.pos('R') };

    c.drag(['A', 'C'], delta!, { snapToGrid: true });

    expect(c.storedVsDrawn()).toEqual([]);
    const moved = (id: string, from: XYPosition) => ({ x: c.pos(id).x - from.x, y: c.pos(id).y - from.y });
    expect(moved('C', cc)).toEqual(moved('A', a));
    expect(moved('R', root)).toEqual(moved('A', a));
  });
});

describe('saving the layout', () => {
  it('lets the arrangement survive turning auto-layout off; without it, systems revert', async () => {
    const c = new Client(base());
    await c.layout(baseEdges, 'R');
    const laidOut = c.snapshot();

    await c.layout(baseEdges, 'R', {}, false);
    ['A', 'B', 'C', 'Y'].forEach(id => expect(c.pos(id)).toEqual(server.get(id)));

    await c.layout(baseEdges, 'R');
    expect(c.snapshot()).toEqual(laidOut);
    const saved = c.saveLayout();
    // Anchors already sit at their stored positions, so only the other placed systems are sent.
    expect(new Set(saved.map(u => u.solar_system_id))).toEqual(new Set(['A', 'B', 'C', 'Y']));

    await c.layout(baseEdges, 'R', {}, false);
    expect(c.snapshot()).toEqual(laidOut);
  });
});

/**
 * A change the client makes (lock, connection delete, system delete, unlock): with the pre-save
 * the watched systems stay where they were drawn, and a client that loads the map afterwards
 * agrees; without it, something jumps (otherwise the scenario would prove nothing).
 */
const structuralChange = async ({
  ids,
  removing = false,
  unlocking = false,
  change,
  watch,
  setup = async c => {
    await c.layout(baseEdges, null);
  },
}: {
  ids: string[];
  removing?: boolean;
  unlocking?: boolean;
  change: (c: Client) => PlacementEdge[];
  watch: string[];
  setup?: (c: Client) => Promise<void>;
}) => {
  for (const preSave of [false, true]) {
    server = new Map();
    const c = new Client(base());
    await setup(c);
    const before = c.snapshot();

    if (preSave) c.saveAround(ids, { removing, unlocking });
    await c.layout(change(c), null);

    const jumped = watch.filter(id => c.pos(id).x !== before[id].x || c.pos(id).y !== before[id].y);
    if (!preSave) {
      expect(jumped.length).toBeGreaterThan(0);
      continue;
    }
    expect(jumped).toEqual([]);
    const fresh = freshClient(c);
    await fresh.layout(change(fresh), null);
    watch.forEach(id => expect(fresh.pos(id)).toEqual(c.pos(id)));
  }
};

describe('saving before a structural change', () => {
  it('keeps a locked middle system and its now-isolated neighbours in place', () =>
    structuralChange({
      ids: ['A'],
      change: c => {
        c.echo('A', server.get('A')!, true);
        return baseEdges;
      },
      watch: ['R', 'A', 'B', 'C'],
    }));

  it('keeps both halves in place when a connection delete splits a tree', () =>
    structuralChange({
      ids: ['R', 'A'],
      change: () => without(baseEdges, e => e.source === 'R' && e.target === 'A'),
      watch: ['R', 'A', 'B', 'C'],
    }));

  it('keeps the rest of the tree in place when a system is deleted, without saving the deleted one', async () => {
    const c = new Client(base());
    await c.layout(baseEdges, null);
    expect(c.saveAround(['A'], { removing: true }).map(u => u.solar_system_id)).not.toContain('A');

    await structuralChange({
      ids: ['A'],
      removing: true,
      change: cl => {
        cl.remove('A');
        return without(baseEdges, e => e.source === 'A' || e.target === 'A');
      },
      watch: ['R', 'B', 'C'],
    });
  });

  it('keeps a chain in place when its locked home, holding its oldest connection, is unlocked', async () => {
    // The chain was mapped out of H, and dragged away from it while H was locked.
    const chain: PlacementEdge[] = [
      { source: 'H', target: 'A', createdAt: 1 },
      { source: 'A', target: 'B', createdAt: 2 },
      { source: 'B', target: 'C', createdAt: 3 },
    ];
    for (const preSave of [false, true]) {
      server = new Map();
      const c = new Client([sys('H', 0, 0, true), sys('A', 180, 0), sys('B', 360, 0), sys('C', 540, 0)]);
      await c.layout(chain, null);
      c.serverApplies(c.drag(['B'], { x: 300, y: 400 }).updates);
      const before = c.snapshot();

      if (preSave) c.saveAround(['H'], { unlocking: true });
      c.echo('H', server.get('H')!, false);
      await c.layout(chain, null);
      expect(c.placements.get('A')?.anchorId).toBe('H');

      const jumped = ['A', 'B', 'C'].filter(id => c.pos(id).x !== before[id].x || c.pos(id).y !== before[id].y);
      if (!preSave) {
        expect(jumped).toEqual(['A', 'B', 'C']);
        continue;
      }
      expect(jumped).toEqual([]);
      const fresh = freshClient(c);
      await fresh.layout(chain, null);
      ['H', 'A', 'B', 'C'].forEach(id => expect(fresh.pos(id)).toEqual(c.pos(id)));
    }
  });

  it("saves an unlocked system's neighbouring clusters, and the older tree keeps its anchor", async () => {
    const bridged: PlacementEdge[] = [
      ...baseEdges,
      { source: 'Q', target: 'P', createdAt: 5 },
      { source: 'B', target: 'L', createdAt: 6 },
      { source: 'L', target: 'Q', createdAt: 7 },
    ];
    const c = new Client([...base(), sys('Q', 1500, 900), sys('P', 1700, 900), sys('L', 1200, 400, true)]);
    await c.layout(bridged, null);

    const saved = c.saveAround(['L'], { unlocking: true }).map(u => u.solar_system_id);
    expect(saved).toEqual(expect.arrayContaining(['A', 'P']));

    c.echo('L', c.pos('L'), false);
    await c.layout(bridged, null);
    expect(c.placements.get('L')?.anchorId).toBe('R');

    const fresh = freshClient(c);
    await fresh.layout(bridged, null);
    ['R', 'A', 'B', 'C', 'L', 'Q', 'P'].forEach(id => expect(fresh.pos(id)).toEqual(c.pos(id)));
  });
});
