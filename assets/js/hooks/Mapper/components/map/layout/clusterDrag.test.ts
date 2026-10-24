import { clusterDragTargets, startClusterDrag } from './clusterDrag';

// Two clusters, {a, b, c} and {x, y}, plus a loose node z.
const clusters: Record<string, string[]> = {
  a: ['a', 'b', 'c'],
  b: ['a', 'b', 'c'],
  c: ['a', 'b', 'c'],
  x: ['x', 'y'],
  y: ['x', 'y'],
};
const getCluster = (id: string) => clusters[id];

const nodes = [
  { id: 'a', position: { x: 0, y: 0 } },
  { id: 'b', position: { x: 100, y: 7 } },
  { id: 'c', position: { x: 200, y: 14 } },
  { id: 'x', position: { x: 500, y: 500 } },
  { id: 'y', position: { x: 600, y: 503 } },
  { id: 'z', position: { x: -50, y: -50 } },
  { id: 'untouched', position: { x: 9, y: 9 } },
];

describe('startClusterDrag', () => {
  it('lets the grabbed node lead its own cluster, and the first dragged member lead each other one', () => {
    const drag = startClusterDrag(nodes, ['a', 'y', 'b', 'x'], 'b', getCluster);

    expect(drag.leaderOf).toEqual({ a: 'b', b: 'b', c: 'b', x: 'y', y: 'y' });
  });

  it('records the start of every dragged node and every member of a dragged cluster', () => {
    const drag = startClusterDrag(nodes, ['b', 'z'], 'b', getCluster);

    expect(drag.start).toEqual({
      a: { x: 0, y: 0 },
      b: { x: 100, y: 7 },
      c: { x: 200, y: 14 },
      z: { x: -50, y: -50 },
    });
    expect(drag.leaderOf.z).toBeUndefined();
  });

  it('copies start positions instead of keeping references to the nodes', () => {
    const positions = nodes.map(n => ({ ...n, position: { ...n.position } }));
    const drag = startClusterDrag(positions, ['a'], 'a', getCluster);
    positions[0].position.x = 999;

    expect(drag.start.a).toEqual({ x: 0, y: 0 });
  });
});

describe('clusterDragTargets', () => {
  it("moves every cluster member, dragged or not, by its leader's delta", () => {
    const drag = startClusterDrag(nodes, ['b', 'c'], 'b', getCluster);
    // Grid snapping moved b by (-135, 8) but c, also dragged, by (-130, 1).
    const targets = clusterDragTargets(drag, [
      { id: 'b', position: { x: -35, y: 15 } },
      { id: 'c', position: { x: 70, y: 15 } },
    ]);

    expect(targets).toEqual({
      a: { x: -135, y: 8 },
      b: { x: -35, y: 15 },
      c: { x: 65, y: 22 },
    });
  });

  it('moves each cluster by its own leader when several clusters are dragged', () => {
    const drag = startClusterDrag(nodes, ['a', 'y'], 'a', getCluster);
    const targets = clusterDragTargets(drag, [
      { id: 'a', position: { x: 10, y: 0 } },
      { id: 'y', position: { x: 600, y: 510 } },
    ]);

    expect(targets).toEqual({
      a: { x: 10, y: 0 },
      b: { x: 110, y: 7 },
      c: { x: 210, y: 14 },
      x: { x: 500, y: 507 },
      y: { x: 600, y: 510 },
    });
  });

  it('leaves dragged nodes outside any cluster to React Flow', () => {
    const drag = startClusterDrag(nodes, ['z'], 'z', getCluster);

    expect(clusterDragTargets(drag, [{ id: 'z', position: { x: 0, y: 0 } }])).toEqual({});
  });

  it("skips a cluster whose leader isn't among the reported dragged nodes", () => {
    const drag = startClusterDrag(nodes, ['a'], 'a', getCluster);

    expect(clusterDragTargets(drag, [])).toEqual({});
  });
});
