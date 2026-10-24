import { getConnectedComponents } from './helpers';

describe('getConnectedComponents', () => {
  it('groups nodes by connectivity, with sorted members in a deterministic order', () => {
    const components = getConnectedComponents(
      ['d', 'b', 'a', 'c', 'e'],
      [
        { source: 'c', target: 'a' },
        { source: 'd', target: 'e' },
      ],
    );

    expect(components.map(c => c.nodeIds)).toEqual([['a', 'c'], ['b'], ['d', 'e']]);
  });

  it('gives each component only its own edges, and ignores edges that leave the node set', () => {
    const components = getConnectedComponents(
      ['a', 'b', 'c'],
      [
        { source: 'a', target: 'b' },
        { source: 'b', target: 'outside' },
        { source: 'outside', target: 'c' },
      ],
    );

    expect(components).toEqual([
      { nodeIds: ['a', 'b'], edges: [{ source: 'a', target: 'b' }] },
      { nodeIds: ['c'], edges: [] },
    ]);
  });

  it('passes the input edge objects through, extra fields included', () => {
    const edge = { source: 'a', target: 'b', createdAt: 42 };
    const [component] = getConnectedComponents(['a', 'b'], [edge]);

    expect(component.edges[0]).toBe(edge);
  });

  it('follows cycles and long chains without visiting a node twice', () => {
    const ids = ['n1', 'n2', 'n3', 'n4'];
    const components = getConnectedComponents(ids, [
      { source: 'n1', target: 'n2' },
      { source: 'n2', target: 'n3' },
      { source: 'n3', target: 'n1' },
      { source: 'n3', target: 'n4' },
    ]);

    expect(components).toHaveLength(1);
    expect(components[0].nodeIds).toEqual(ids);
    expect(components[0].edges).toHaveLength(4);
  });
});
