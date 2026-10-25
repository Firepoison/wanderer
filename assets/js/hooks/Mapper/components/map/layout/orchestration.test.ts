import {
  connectionCreatedAt,
  displayedUpdates,
  layoutSignature,
  readEngineOptions,
  serializeOptions,
  SignatureInput,
  structureChangeIds,
  unlockAnchorUpdates,
} from './orchestration';
import { Placement, PlacementEdge } from './anchoring';

describe('readEngineOptions', () => {
  it("returns the selected engine's bag", () => {
    expect(readEngineOptions('{"dagre":{"direction":"TB"},"other":{"x":"1"}}', 'dagre')).toEqual({ direction: 'TB' });
  });

  it.each([
    ['a non-string', 42],
    ['an empty string', ''],
    ['invalid JSON', '{{'],
    ['a blob without the engine', '{"other":{}}'],
    ['a bag that is not an object', '{"dagre":"TB"}'],
    ['a null bag', '{"dagre":null}'],
    ['JSON null', 'null'],
  ])('returns no options for %s', (_, raw) => {
    expect(readEngineOptions(raw, 'dagre')).toEqual({});
  });
});

describe('serializeOptions', () => {
  it('ignores key order, so re-parsed options give the same key', () => {
    expect(serializeOptions({ b: '2', a: '1' })).toBe(serializeOptions({ a: '1', b: '2' }));
    expect(serializeOptions({ a: '1', b: '2' })).toBe('a=1,b=2');
  });

  it('changes when a value changes', () => {
    expect(serializeOptions({ a: '1' })).not.toBe(serializeOptions({ a: '2' }));
  });
});

describe('connectionCreatedAt', () => {
  it('parses the ISO timestamp the server sends', () => {
    expect(connectionCreatedAt('2026-10-24T12:00:00.000000Z')).toBe(Date.UTC(2026, 9, 24, 12));
  });

  it.each([null, undefined, '', 'not a date'])('sorts %p after every known time', value => {
    expect(connectionCreatedAt(value)).toBe(Infinity);
  });
});

describe('layoutSignature', () => {
  const base: SignatureInput = {
    nodes: [{ id: 'a' }, { id: 'b', data: { locked: false } }, { id: 'c' }],
    edges: [
      { source: 'a', target: 'b', data: { inserted_at: '2026-01-01T00:00:00Z' } },
      { source: 'b', target: 'c' },
    ],
    engineId: 'dagre',
    optionsKey: 'direction=LR',
    rootId: 'a',
  };
  const sig = (overrides: Partial<SignatureInput> = {}) => layoutSignature({ ...base, ...overrides });

  it('ignores node and edge order', () => {
    expect(sig({ nodes: [...base.nodes].reverse(), edges: [...base.edges].reverse() })).toBe(sig());
  });

  it('ignores everything but structure, such as positions', () => {
    const withPositions = base.nodes.map(n => ({ ...n, position: { x: 1, y: 2 } }));
    expect(sig({ nodes: withPositions })).toBe(sig());
  });

  it.each<[string, Partial<SignatureInput>]>([
    ['a node is added', { nodes: [...base.nodes, { id: 'd' }] }],
    ['a node is removed', { nodes: base.nodes.slice(0, 2) }],
    ['a node is locked', { nodes: base.nodes.map(n => (n.id === 'b' ? { ...n, data: { locked: true } } : n)) }],
    ['a connection is added', { edges: [...base.edges, { source: 'a', target: 'c' }] }],
    ['a connection is removed', { edges: base.edges.slice(0, 1) }],
    [
      "a connection's age changes",
      { edges: [{ ...base.edges[0], data: { inserted_at: '2026-02-01T00:00:00Z' } }, base.edges[1]] },
    ],
    ['the engine changes', { engineId: 'other' }],
    ['an option changes', { optionsKey: 'direction=TB' }],
    ['the root changes', { rootId: 'b' }],
    ['the root is cleared', { rootId: null }],
  ])('changes when %s', (_, overrides) => {
    expect(sig(overrides)).not.toBe(sig());
  });

  it('tells a -> bc apart from ab -> c', () => {
    expect(sig({ edges: [{ source: 'a', target: 'bc' }] })).not.toBe(sig({ edges: [{ source: 'ab', target: 'c' }] }));
  });
});

describe('structureChangeIds', () => {
  const clusterByNode = new Map([
    ['a', ['a', 'b']],
    ['b', ['a', 'b']],
    ['x', ['x', 'y']],
    ['y', ['x', 'y']],
  ]);
  const edges = [
    { source: 'a', target: 'b' },
    { source: 'b', target: 'locked' },
    { source: 'locked', target: 'x' },
    { source: 'x', target: 'y' },
  ];
  const ids = (systemIds: string[], removing?: boolean) =>
    [...structureChangeIds({ systemIds, removing, edges, clusterByNode })].sort();

  it("covers the systems' own clusters", () => {
    expect(ids(['a'])).toEqual(['a', 'b']);
  });

  it("covers the neighbours' clusters, e.g. for a system that is about to be unlocked", () => {
    expect(ids(['locked'])).toEqual(['a', 'b', 'x', 'y']);
  });

  it('leaves out systems that are being removed', () => {
    expect(ids(['a'], true)).toEqual(['b']);
  });

  it('is empty for systems outside any cluster with no clustered neighbours', () => {
    expect(ids(['nowhere'])).toEqual([]);
  });
});

describe('displayedUpdates', () => {
  const nodes = [
    { id: 'moved', position: { x: 5, y: 5 }, data: { position: { x: 0, y: 0 } } },
    { id: 'same', position: { x: 1, y: 1 }, data: { position: { x: 1, y: 1 } } },
    { id: 'unstored', position: { x: 2, y: 2 } },
    { id: 'other', position: { x: 9, y: 9 }, data: { position: { x: 0, y: 0 } } },
  ];

  it('lists the selected systems whose displayed position differs from the stored one', () => {
    expect(displayedUpdates(nodes, new Set(['moved', 'same', 'unstored']))).toEqual([
      { solar_system_id: 'moved', position: { x: 5, y: 5 } },
      { solar_system_id: 'unstored', position: { x: 2, y: 2 } },
    ]);
  });

  it('is empty when nothing is selected', () => {
    expect(displayedUpdates(nodes, new Set())).toEqual([]);
  });
});

describe('unlockAnchorUpdates', () => {
  const at = (anchorId: string, x: number, y = 0): Placement => ({ anchorId, offset: { x, y }, pinned: false });
  const edge = (source: string, target: string, createdAt: number): PlacementEdge => ({ source, target, createdAt });

  // A chain mapped out of home H, which was locked afterwards: H -> A is the oldest connection.
  const chainEdges = [edge('H', 'A', 1), edge('A', 'B', 2), edge('B', 'C', 3)];
  const chainBefore = new Map([
    ['A', at('A', 0)],
    ['B', at('A', 232)],
    ['C', at('A', 464)],
  ]);
  const chainAfter = new Map([
    ['H', at('H', 0)],
    ['A', at('H', 232)],
    ['B', at('H', 464)],
    ['C', at('H', 696)],
  ]);
  const chainDisplayed = new Map([
    ['H', { x: 0, y: 0 }],
    ['A', { x: 1000, y: 600 }],
    ['B', { x: 1232, y: 600 }],
    ['C', { x: 1464, y: 600 }],
  ]);

  it('moves a system that becomes the anchor so the cluster it joins stays where it is drawn', () => {
    const updates = unlockAnchorUpdates({
      unlocking: ['H'],
      before: chainBefore,
      after: chainAfter,
      displayed: chainDisplayed,
      edges: chainEdges,
    });

    // From H at (768, 600), A at offset 232 is drawn at (1000, 600) again.
    expect(updates).toEqual([{ solar_system_id: 'H', position: { x: 768, y: 600 } }]);
  });

  it('changes nothing when the cluster keeps an anchor that was already laid out', () => {
    const after = new Map([...chainBefore, ['D', at('A', 696)]]);

    expect(
      unlockAnchorUpdates({
        unlocking: ['D'],
        before: chainBefore,
        after,
        displayed: chainDisplayed,
        edges: [...chainEdges.slice(1), edge('C', 'D', 9)],
      }),
    ).toEqual([]);
  });

  it('changes nothing for a system that joins no cluster', () => {
    expect(
      unlockAnchorUpdates({
        unlocking: ['Z'],
        before: chainBefore,
        after: chainBefore,
        displayed: chainDisplayed,
        edges: chainEdges,
      }),
    ).toEqual([]);
  });

  it('changes nothing when the new cluster absorbs no laid-out cluster', () => {
    expect(
      unlockAnchorUpdates({
        unlocking: ['H'],
        before: new Map(),
        after: new Map([
          ['H', at('H', 0)],
          ['Z', at('H', 232)],
        ]),
        displayed: new Map([['Z', { x: 5, y: 5 }]]),
        edges: [edge('H', 'Z', 1)],
      }),
    ).toEqual([]);
  });

  it('keeps the absorbed cluster with the oldest connection in place when the unlock merges several', () => {
    // H bridges {A, B} and {X, Y}; A -> B is older than X -> Y.
    const updates = unlockAnchorUpdates({
      unlocking: ['H'],
      before: new Map([
        ['X', at('X', 0)],
        ['Y', at('X', 232)],
        ['A', at('A', 0)],
        ['B', at('A', 232)],
      ]),
      after: new Map([
        ['H', at('H', 0)],
        ['X', at('H', 232, 50)],
        ['Y', at('H', 464, 50)],
        ['A', at('H', 232, -50)],
        ['B', at('H', 464, -50)],
      ]),
      displayed: new Map([
        ['X', { x: 900, y: 900 }],
        ['A', { x: 500, y: 500 }],
      ]),
      edges: [edge('H', 'X', 0), edge('X', 'Y', 3), edge('A', 'B', 2), edge('H', 'A', 1)],
    });

    expect(updates).toEqual([{ solar_system_id: 'H', position: { x: 268, y: 550 } }]);
  });
});
