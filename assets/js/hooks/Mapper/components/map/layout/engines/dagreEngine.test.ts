import { XYPosition } from 'reactflow';
import { LayoutEdgeInput, LayoutOptions } from '../types';
import { dagreEngine } from './dagreEngine';

const W = 142;
const H = 37;
const nodes = (...ids: string[]) => ids.map(id => ({ id, width: W, height: H }));
const e = (source: string, target: string): LayoutEdgeInput => ({ source, target });

const layout = (ids: string[], edges: LayoutEdgeInput[], options: LayoutOptions = {}, rootId: string | null = null) =>
  (dagreEngine.compute({ nodes: nodes(...ids), edges, rootId, options }) as { positions: Record<string, XYPosition> })
    .positions;

describe('dagreEngine', () => {
  it('declares that it anchors on a root', () => {
    expect(dagreEngine.id).toBe('dagre');
    expect(dagreEngine.supportsRoot).toBe(true);
  });

  it('returns no positions for no nodes', () => {
    expect(layout([], [])).toEqual({});
  });

  it("reports top-left corners, not dagre's node centres", () => {
    expect(layout(['only'], [])).toEqual({ only: { x: 0, y: 0 } });
  });

  describe('direction', () => {
    it.each([
      ['LR', { x: 232, y: 0 }],
      ['RL', { x: -232, y: 0 }],
      ['TB', { x: 0, y: 127 }],
      ['BT', { x: 0, y: -127 }],
    ])('%s puts the child one rank away from the parent', (direction, expected) => {
      const p = layout(['a', 'b'], [e('a', 'b')], { direction });

      expect({ x: p.b.x - p.a.x, y: p.b.y - p.a.y }).toEqual(expected);
    });

    it('defaults to left-to-right, also for unknown values', () => {
      expect(layout(['a', 'b'], [e('a', 'b')], { direction: 'sideways' })).toEqual(layout(['a', 'b'], [e('a', 'b')]));
    });
  });

  describe('spacing', () => {
    it.each([
      ['compact', 187],
      ['normal', 232],
      ['spacious', 292],
    ])('rank_sep %s sets the gap between tree levels', (rankSep, distance) => {
      const p = layout(['a', 'b'], [e('a', 'b')], { rank_sep: rankSep });

      expect(p.b.x - p.a.x).toBe(distance);
    });

    it.each([
      ['compact', 57],
      ['normal', 82],
      ['spacious', 127],
    ])('node_sep %s sets the gap between siblings', (nodeSep, distance) => {
      const p = layout(['r', 'a', 'b'], [e('r', 'a'), e('r', 'b')], { node_sep: nodeSep });

      expect(Math.abs(p.b.y - p.a.y)).toBe(distance);
    });

    it.each(['huge', 'constructor', 'toString', '__proto__'])('falls back to normal spacing for %p', value => {
      expect(layout(['r', 'a', 'b'], [e('r', 'a'), e('r', 'b')], { rank_sep: value, node_sep: value })).toEqual(
        layout(['r', 'a', 'b'], [e('r', 'a'), e('r', 'b')]),
      );
    });
  });

  describe('root', () => {
    it('puts the root at rank 0 even when the stored connection points towards it', () => {
      const p = layout(['r', 'b'], [e('b', 'r')], {}, 'r');

      expect(p.r.x).toBeLessThan(p.b.x);
    });

    it('follows the stored connection direction when there is no root', () => {
      const p = layout(['r', 'b'], [e('b', 'r')]);

      expect(p.b.x).toBeLessThan(p.r.x);
    });

    it('lays out every node of a cycle, with the root first', () => {
      const p = layout(['r', 'a', 'b'], [e('r', 'a'), e('a', 'b'), e('b', 'r')], {}, 'r');

      expect(Object.keys(p).sort()).toEqual(['a', 'b', 'r']);
      expect(p.r.x).toBeLessThan(Math.min(p.a.x, p.b.x));
    });

    it('ignores a root that is not among the nodes', () => {
      expect(layout(['a', 'b'], [e('a', 'b')], {}, 'elsewhere')).toEqual(layout(['a', 'b'], [e('a', 'b')]));
    });
  });

  it.each(['network-simplex', 'tight-tree', 'longest-path', 'bogus'])('lays out every node with ranker %p', ranker => {
    const p = layout(['r', 'a', 'b', 'c'], [e('r', 'a'), e('a', 'b'), e('r', 'c'), e('c', 'b')], { ranker }, 'r');

    expect(Object.keys(p).sort()).toEqual(['a', 'b', 'c', 'r']);
  });

  it('gives the same layout whatever order the nodes and edges arrive in', () => {
    const ids = ['31000448', '30002659', '31001040', '31002253', '30004759'];
    const edges = [
      e('31000448', '30002659'),
      e('31000448', '31001040'),
      e('31001040', '31002253'),
      e('31001040', '30004759'),
    ];

    const forward = layout(ids, edges, {}, '31000448');
    const reversed = layout([...ids].reverse(), [...edges].reverse(), {}, '31000448');

    expect(reversed).toEqual(forward);
  });
});
