import { act, renderHook, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { Edge, Node, XYPosition } from 'reactflow';

import { emitStructureChange } from '@/hooks/Mapper/events';
import { computePlacements, LayoutInput, LayoutResult } from '@/hooks/Mapper/components/map/layout';
import { SolarSystemConnection, SolarSystemRawType } from '@/hooks/Mapper/types';
import { OutCommand } from '@/hooks/Mapper/types/mapHandlers.ts';
import { useAutoLayout } from './useAutoLayout';

// Map options, as useMapGetOption would read them from the map root state.
const mockOptions: Record<string, string> = {};
jest.mock('@/hooks/Mapper/mapRootProvider/hooks/api', () => ({
  useMapGetOption: (key: string) => mockOptions[key],
}));

// A controllable engine, selected with auto_layout_engine = "test"; everything else is real.
const mockTestEngine: { compute: jest.Mock<LayoutResult | Promise<LayoutResult>, [LayoutInput]> } = {
  compute: jest.fn(),
};
jest.mock('@/hooks/Mapper/components/map/layout', () => {
  const actual = jest.requireActual('@/hooks/Mapper/components/map/layout');
  return {
    ...actual,
    getLayoutEngine: (id: string | null) =>
      id === 'test'
        ? { id: 'test', supportsRoot: true, compute: (input: LayoutInput) => mockTestEngine.compute(input) }
        : actual.getLayoutEngine(id),
  };
});

type MapNode = Node<SolarSystemRawType>;
type MapEdge = Edge<SolarSystemConnection>;

const node = (id: string, x: number, y: number, locked = false): MapNode =>
  ({
    id,
    position: { x, y },
    draggable: !locked,
    data: { id, position: { x, y }, locked } as SolarSystemRawType,
  }) as MapNode;

const edge = (source: string, target: string, insertedAt: string): MapEdge =>
  ({
    id: `${source}_${target}`,
    source,
    target,
    data: { source, target, inserted_at: insertedAt } as SolarSystemConnection,
  }) as MapEdge;

// A home tree r-a-b-c, a chain x-y, an isolated z. r-a is the tree's oldest connection.
const homeNodes = () => [
  node('r', 100, 100),
  node('a', 400, 260),
  node('b', 380, 20),
  node('c', 900, 700),
  node('x', 2000, 1500),
  node('y', 2100, 1650),
  node('z', -500, -500),
];
const homeEdges = [
  edge('r', 'a', '2026-01-01T00:00:01Z'),
  edge('a', 'b', '2026-01-01T00:00:02Z'),
  edge('a', 'c', '2026-01-01T00:00:03Z'),
  edge('x', 'y', '2026-01-01T00:00:04Z'),
];

// Holds the nodes the way Map.tsx does (controlled state) and runs the hook on them.
const useHarness = ({
  initialNodes,
  edges,
  onCommand,
}: {
  initialNodes: MapNode[];
  edges: MapEdge[];
  onCommand: jest.Mock;
}) => {
  const [nodes, setNodes] = useState(initialNodes);
  const layout = useAutoLayout({ nodes, edges, setNodes, onCommand });
  return { nodes, setNodes, ...layout };
};

const renderLayout = (initialNodes = homeNodes(), edges = homeEdges) => {
  const onCommand = jest.fn().mockResolvedValue(undefined);
  const hook = renderHook(props => useHarness(props), { initialProps: { initialNodes, edges, onCommand } });
  const pos = (id: string) => hook.result.current.nodes.find(n => n.id === id)!.position;
  const stored = (id: string) => hook.result.current.nodes.find(n => n.id === id)!.data.position;
  return { ...hook, onCommand, pos, stored };
};

// What the layout should draw: each placed node at its anchor's stored position plus its offset.
const expectedPositions = async (nodes: MapNode[], edges: MapEdge[], rootId: string | null, options = {}) => {
  const { placements } = await computePlacements({
    engine: jest.requireActual('@/hooks/Mapper/components/map/layout').getLayoutEngine('dagre'),
    nodes: nodes.map(n => ({ id: n.id, locked: n.data.locked })),
    edges: edges.map(e => ({ source: e.source, target: e.target, createdAt: Date.parse(e.data!.inserted_at!) })),
    rootId,
    options,
    nodeSize: { width: 142, height: 37 },
  });
  const storedById = new Map(nodes.map(n => [n.id, n.data.position]));
  const out: Record<string, XYPosition> = {};
  placements.forEach((p, id) => {
    const anchor = storedById.get(p.anchorId)!;
    out[id] = { x: anchor.x + p.offset.x, y: anchor.y + p.offset.y };
  });
  return out;
};

type SentUpdate = { solar_system_id: string; position: XYPosition };
const lastCommand = (onCommand: jest.Mock) => onCommand.mock.calls[onCommand.mock.calls.length - 1][0];
const sentIds = (updates: SentUpdate[]) => updates.map(u => u.solar_system_id).sort();

const setOptions = (options: Record<string, string>) => {
  Object.keys(mockOptions).forEach(key => delete mockOptions[key]);
  Object.assign(mockOptions, options);
};

beforeEach(() => {
  setOptions({ auto_layout_enabled: 'true', auto_layout_engine: 'dagre', root_system_id: 'r' });
  mockTestEngine.compute.mockReset();
});

describe('useAutoLayout', () => {
  it('leaves the map alone while auto-layout is off', async () => {
    setOptions({ auto_layout_enabled: 'false' });
    const { result } = renderLayout();

    expect(result.current.enabled).toBe(false);
    expect(result.current.nodes).toEqual(homeNodes());
    expect(result.current.getCluster('a')).toBeUndefined();
  });

  it("draws each cluster around its anchor's stored position", async () => {
    const expected = await expectedPositions(homeNodes(), homeEdges, 'r');
    const { result, pos } = renderLayout();

    await waitFor(() => expect(pos('b')).toEqual(expected.b));
    Object.entries(expected).forEach(([id, p]) => expect(pos(id)).toEqual(p));
    expect(pos('r')).toEqual({ x: 100, y: 100 });
    expect(pos('z')).toEqual({ x: -500, y: -500 });
    expect(result.current.getCluster('b')).toEqual(['a', 'b', 'c', 'r']);
    expect(result.current.getCluster('z')).toBeUndefined();
  });

  it('puts a node back in its tree, before paint, after a server echo resets it', async () => {
    const { result, pos } = renderLayout();
    await waitFor(() => expect(result.current.getCluster('b')).toBeDefined());
    const laidOut = { ...pos('b') };

    act(() => result.current.setNodes(nds => nds.map(n => (n.id === 'b' ? { ...n, position: n.data.position } : n))));

    expect(pos('b')).toEqual(laidOut);
  });

  it('returns every system to its stored position when auto-layout is turned off', async () => {
    const { result, rerender, pos } = renderLayout();
    await waitFor(() => expect(result.current.getCluster('b')).toBeDefined());
    expect(pos('b')).not.toEqual({ x: 380, y: 20 });

    setOptions({ auto_layout_enabled: 'false' });
    rerender({ initialNodes: homeNodes(), edges: homeEdges, onCommand: jest.fn() });

    await waitFor(() => expect(pos('b')).toEqual({ x: 380, y: 20 }));
    homeNodes().forEach(n => expect(pos(n.id)).toEqual(n.position));
  });

  it('re-lays out when an option or the root changes', async () => {
    const { result, rerender, pos } = renderLayout();
    await waitFor(() => expect(result.current.getCluster('b')).toBeDefined());
    const normal = { ...pos('b') };
    const props = { initialNodes: homeNodes(), edges: homeEdges, onCommand: jest.fn() };

    setOptions({ ...mockOptions, auto_layout_options: '{"dagre":{"rank_sep":"spacious"}}' });
    rerender(props);
    await waitFor(() => expect(pos('b')).not.toEqual(normal));
    expect(pos('b')).toEqual((await expectedPositions(homeNodes(), homeEdges, 'r', { rank_sep: 'spacious' })).b);

    setOptions({ ...mockOptions, root_system_id: 'c' });
    rerender(props);
    await waitFor(() => expect(pos('c')).toEqual({ x: 900, y: 700 }));
  });

  describe('saving', () => {
    it('sends one position as update_system_position and several as update_system_positions', async () => {
      const { result, onCommand, pos, stored } = renderLayout();
      await waitFor(() => expect(result.current.getCluster('b')).toBeDefined());

      act(() => result.current.savePositions([{ solar_system_id: 'z', position: { x: 1, y: 2 } }]));
      expect(onCommand).toHaveBeenLastCalledWith({
        type: OutCommand.updateSystemPosition,
        data: { solar_system_id: 'z', position: { x: 1, y: 2 } },
      });
      expect(pos('z')).toEqual({ x: 1, y: 2 });
      expect(stored('z')).toEqual({ x: 1, y: 2 });

      const two = [
        { solar_system_id: 'x', position: { x: 10, y: 10 } },
        { solar_system_id: 'y', position: { x: 20, y: 20 } },
      ];
      act(() => result.current.savePositions(two));
      expect(onCommand).toHaveBeenLastCalledWith({ type: OutCommand.updateSystemPositions, data: two });

      onCommand.mockClear();
      act(() => result.current.savePositions([]));
      expect(onCommand).not.toHaveBeenCalled();
    });

    it("records a dropped tree's positions as stored right away, so nothing snaps back", async () => {
      const { result, pos } = renderLayout();
      await waitFor(() => expect(result.current.getCluster('b')).toBeDefined());
      const moved = ['r', 'a', 'b', 'c'].map(id => ({
        solar_system_id: id,
        position: { x: pos(id).x + 50, y: pos(id).y + 30 },
      }));

      act(() => {
        result.current.beginDrag();
        result.current.savePositions(moved);
        result.current.endDrag();
      });

      moved.forEach(u => expect(pos(u.solar_system_id)).toEqual(u.position));
    });

    it('saves the whole displayed layout, admin-only, and only what differs', async () => {
      const { result, onCommand, pos } = renderLayout();
      await waitFor(() => expect(result.current.getCluster('b')).toBeDefined());

      act(() => result.current.saveLayout());

      const sent = lastCommand(onCommand);
      expect(sent.type).toBe(OutCommand.saveLayoutPositions);
      // Anchors (r, x) already sit at their stored positions; the isolated z isn't laid out.
      expect(sentIds(sent.data.positions)).toEqual(['a', 'b', 'c', 'y']);
      sent.data.positions.forEach((u: SentUpdate) => expect(u.position).toEqual(pos(u.solar_system_id)));

      onCommand.mockClear();
      act(() => result.current.saveLayout());
      expect(onCommand).not.toHaveBeenCalled();
    });
  });

  describe('structure changes announced by other parts of the map', () => {
    it("saves the displayed positions of the systems' clusters before the change", async () => {
      const { result, onCommand, stored, pos } = renderLayout();
      await waitFor(() => expect(result.current.getCluster('b')).toBeDefined());

      act(() => emitStructureChange({ systemIds: ['b'] }));

      const sent = lastCommand(onCommand);
      expect(sent.type).toBe(OutCommand.updateSystemPositions);
      expect(sentIds(sent.data)).toEqual(['a', 'b', 'c']);
      ['a', 'b', 'c'].forEach(id => expect(stored(id)).toEqual(pos(id)));
    });

    it('hands the positions to `collect` instead of sending them', async () => {
      const { result, onCommand } = renderLayout();
      await waitFor(() => expect(result.current.getCluster('b')).toBeDefined());
      const collect = jest.fn();

      act(() => emitStructureChange({ systemIds: ['r'], collect }));

      expect(onCommand).not.toHaveBeenCalled();
      expect(sentIds(collect.mock.calls[0][0])).toEqual(['a', 'b', 'c']);
    });

    it('leaves out systems that are being removed, and covers the neighbours of an unlocked one', async () => {
      const nodes = [...homeNodes(), node('l', 1200, 400, true), node('q', 1500, 900), node('p', 1700, 900)];
      const edges = [
        ...homeEdges,
        edge('q', 'p', '2026-01-01T00:00:05Z'),
        edge('b', 'l', '2026-01-01T00:00:06Z'),
        edge('l', 'q', '2026-01-01T00:00:07Z'),
      ];
      const { result, onCommand } = renderLayout(nodes, edges);
      await waitFor(() => expect(result.current.getCluster('p')).toBeDefined());
      const ids = () => sentIds(lastCommand(onCommand).data);

      act(() => emitStructureChange({ systemIds: ['a'], removing: true }));
      expect(ids()).toEqual(['b', 'c']);

      // The locked l is in no cluster; its neighbours b and q are. a still differs (it wasn't
      // saved above, being removed), b and c no longer do.
      act(() => emitStructureChange({ systemIds: ['l'] }));
      expect(ids()).toEqual(['a', 'p']);
    });

    it('sends nothing when nothing differs', async () => {
      const { result, onCommand } = renderLayout();
      await waitFor(() => expect(result.current.getCluster('b')).toBeDefined());
      act(() => result.current.saveLayout());
      onCommand.mockClear();

      act(() => emitStructureChange({ systemIds: ['b'] }));

      expect(onCommand).not.toHaveBeenCalled();
    });
  });

  describe('dragging', () => {
    it('does not fight a drag, and reconciles once the drag ends', async () => {
      const { result, pos } = renderLayout();
      await waitFor(() => expect(result.current.getCluster('b')).toBeDefined());
      const laidOut = { ...pos('b') };

      act(() => {
        result.current.beginDrag();
        result.current.setNodes(nds => nds.map(n => (n.id === 'b' ? { ...n, position: { x: 0, y: 0 } } : n)));
      });
      expect(pos('b')).toEqual({ x: 0, y: 0 });

      // A drop that saved nothing (e.g. the server will refuse it) goes back to the layout.
      act(() => result.current.endDrag());
      expect(pos('b')).toEqual(laidOut);
    });

    it('ignores endDrag without a drag', async () => {
      const { result, pos } = renderLayout();
      await waitFor(() => expect(result.current.getCluster('b')).toBeDefined());
      const before = result.current.nodes.map(n => ({ ...n.position }));

      act(() => result.current.endDrag());

      expect(result.current.nodes.map(n => n.position)).toEqual(before);
      expect(pos('r')).toEqual({ x: 100, y: 100 });
    });
  });

  describe('the layout pass', () => {
    const line = (input: LayoutInput): LayoutResult => ({
      positions: Object.fromEntries(
        [...input.nodes].sort((p, q) => (p.id < q.id ? -1 : 1)).map((n, i) => [n.id, { x: i * 100, y: 0 }]),
      ),
    });

    beforeEach(() => setOptions({ auto_layout_enabled: 'true', auto_layout_engine: 'test', root_system_id: '' }));

    it('does not recompute for position-only changes', async () => {
      mockTestEngine.compute.mockImplementation(line);
      const { result } = renderLayout();
      await waitFor(() => expect(result.current.getCluster('b')).toBeDefined());
      const calls = mockTestEngine.compute.mock.calls.length;

      act(() =>
        result.current.setNodes(nds => nds.map(n => ({ ...n, position: { x: n.position.x + 1, y: n.position.y } }))),
      );
      act(() => result.current.savePositions([{ solar_system_id: 'z', position: { x: 3, y: 3 } }]));

      expect(mockTestEngine.compute.mock.calls.length).toBe(calls);
    });

    it('discards a slow result once a newer structure has started laying out', async () => {
      const pending: (() => void)[] = [];
      mockTestEngine.compute.mockImplementation(
        input => new Promise(resolve => pending.push(() => resolve(line(input)))),
      );
      // The b-c connection is already known; c itself arrives while a-b is still being laid out.
      const edges = [edge('a', 'b', '2026-01-01T00:00:01Z'), edge('b', 'c', '2026-01-01T00:00:02Z')];
      const { result, pos } = renderLayout([node('a', 0, 0), node('b', 500, 500)], edges);
      await waitFor(() => expect(pending).toHaveLength(1));

      act(() => result.current.setNodes(nds => [...nds, node('c', 900, 900)]));
      await waitFor(() => expect(pending).toHaveLength(2));

      await act(async () => pending[0]());
      expect(result.current.getCluster('a')).toBeUndefined();

      await act(async () => pending[1]());
      await waitFor(() => expect(result.current.getCluster('a')).toEqual(['a', 'b', 'c']));
      expect(pos('c')).toEqual({ x: 200, y: 0 });
    });

    it('logs an engine error and retries on the next structural change', async () => {
      const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      mockTestEngine.compute.mockImplementationOnce(() => {
        throw new Error('boom');
      });
      mockTestEngine.compute.mockImplementation(line);
      const { result, rerender } = renderLayout();
      await waitFor(() => expect(error).toHaveBeenCalledWith('Auto-layout failed', expect.any(Error)));
      expect(result.current.getCluster('b')).toBeUndefined();

      rerender({ initialNodes: homeNodes(), edges: homeEdges.slice(0, 3), onCommand: jest.fn() });

      await waitFor(() => expect(result.current.getCluster('b')).toBeDefined());
      error.mockRestore();
    });
  });
});
