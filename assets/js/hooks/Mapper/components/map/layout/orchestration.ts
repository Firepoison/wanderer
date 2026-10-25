import { XYPosition } from 'reactflow';
import { compareEdgeAge, computePlacementsNow, Placement, PlacementEdge, PlacementInput } from './anchoring';
import { LayoutOptions } from './types';

/**
 * The pure pieces of `useAutoLayout`: how it reads options, decides whether the structure
 * changed, and picks the positions to save. Kept apart from the hook so they can be tested
 * without React.
 */

/**
 * `auto_layout_options` holds one option bag per engine, so switching engines preserves the
 * other's settings. Nothing here interprets the contents — that is the selected engine's job.
 */
export const readEngineOptions = (raw: unknown, engineId: string): LayoutOptions => {
  if (typeof raw !== 'string' || raw === '') {
    return {};
  }

  try {
    const parsed = JSON.parse(raw);
    const bag = parsed?.[engineId];
    return bag && typeof bag === 'object' ? (bag as LayoutOptions) : {};
  } catch {
    return {};
  }
};

// Stable across re-parses so the layout signature only changes when a value actually changed.
export const serializeOptions = (options: LayoutOptions): string =>
  Object.keys(options)
    .sort()
    .map(key => `${key}=${options[key]}`)
    .join(',');

// Connections without a creation time sort after every connection that has one.
export const connectionCreatedAt = (insertedAt: string | null | undefined): number => {
  const at = Date.parse(insertedAt ?? '');
  return Number.isNaN(at) ? Infinity : at;
};

const hashString = (value: string, seed: number): number => {
  let h = seed;
  for (let i = 0; i < value.length; i++) {
    h = (Math.imul(h, 33) ^ value.charCodeAt(i)) | 0;
  }
  return h;
};

const hashChar = (code: number, seed: number): number => (Math.imul(seed, 33) ^ code) | 0;

// Separator matters: without it hashing source-then-target is just hashing the concatenation,
// so `a -> bc` and `ab -> c` would collide.
const hashEdge = (source: string, target: string): number =>
  hashString(target, hashChar(62 /* '>' */, hashString(source, 5381)));

/**
 * Order-independent fingerprint of a set of hashes: two commutative accumulators (xor + sum)
 * plus a count. Lets the structural signature be built in a single allocation-free pass instead
 * of mapping to strings, sorting and serializing — which matters because the layout effect is
 * re-run on every `nodes`/`edges` identity change (i.e. every drag frame), not only on the
 * structural changes it actually cares about.
 */
class Fingerprint {
  private xor = 0;
  private sum = 0;
  private count = 0;

  add(hash: number) {
    this.xor ^= hash;
    this.sum = (this.sum + hash) | 0;
    this.count++;
  }

  toString() {
    return `${this.count}:${this.xor}:${this.sum}`;
  }
}

export interface SignatureInput {
  nodes: { id: string; data?: { locked?: boolean } }[];
  edges: { source: string; target: string; data?: { inserted_at?: string | null } }[];
  engineId: string;
  optionsKey: string;
  rootId: string | null;
}

/**
 * Everything the layout depends on except positions: nodes and whether each is locked,
 * connections and their ages (which pick anchors), engine, options and root. Positions are left
 * out on purpose, so drags and position syncs don't recompute the layout.
 */
export const layoutSignature = ({ nodes, edges, engineId, optionsKey, rootId }: SignatureInput): string => {
  const nodeFp = new Fingerprint();
  nodes.forEach(n => nodeFp.add(hashString(n.id, n.data?.locked ? 5387 : 5381)));

  const edgeFp = new Fingerprint();
  edges.forEach(e => edgeFp.add(hashString(e.data?.inserted_at ?? '', hashEdge(e.source, e.target))));

  return [engineId, optionsKey, rootId, nodeFp.toString(), edgeFp.toString()].join('|');
};

/**
 * The systems whose displayed positions to save before a change to `systemIds`: their own
 * clusters plus their neighbours' (a system being unlocked belongs to no cluster yet, but the
 * clusters it is about to join are its neighbours'), minus the systems themselves when they are
 * being removed.
 */
export const structureChangeIds = ({
  systemIds,
  removing = false,
  edges,
  clusterByNode,
}: {
  systemIds: string[];
  removing?: boolean;
  edges: { source: string; target: string }[];
  clusterByNode: Map<string, string[]>;
}): Set<string> => {
  const changing = new Set(systemIds);
  const touched = new Set(systemIds);
  edges.forEach(e => {
    if (changing.has(e.source)) {
      touched.add(e.target);
    }
    if (changing.has(e.target)) {
      touched.add(e.source);
    }
  });

  const ids = new Set<string>();
  touched.forEach(id => clusterByNode.get(id)?.forEach(member => ids.add(member)));
  if (removing) {
    systemIds.forEach(id => ids.delete(id));
  }
  return ids;
};

export interface DisplayedUpdate {
  solar_system_id: string;
  position: XYPosition;
}

/**
 * Unlocking a system can make it its cluster's anchor (see `pickAnchor`), and the cluster would
 * then be re-placed from the system's own stored position. For each cluster the unlock gives a
 * new anchor that wasn't laid out before, this returns a stored position for that anchor which
 * keeps the absorbed cluster with the oldest connection where it is displayed. The unlocked
 * system moves to where the layout puts it next to that cluster instead.
 *
 * `before` is the layout on screen, `after` the layout once `unlocking` are unlocked.
 */
export const unlockAnchorUpdates = ({
  unlocking,
  before,
  after,
  displayed,
  edges,
}: {
  unlocking: string[];
  before: Map<string, Placement>;
  after: Map<string, Placement>;
  displayed: Map<string, XYPosition>;
  edges: PlacementEdge[];
}): DisplayedUpdate[] => {
  const oldestFirst = [...edges].sort(compareEdgeAge);
  const updates: DisplayedUpdate[] = [];

  new Set(unlocking.map(id => after.get(id)?.anchorId)).forEach(anchorId => {
    // An anchor that was already laid out is saved where it is displayed, so its cluster stays.
    if (!anchorId || before.has(anchorId)) {
      return;
    }

    const absorbed = new Set<string>();
    after.forEach((p, id) => {
      const was = before.get(id);
      if (p.anchorId === anchorId && was) {
        absorbed.add(was.anchorId);
      }
    });

    // The absorbed cluster with the oldest connection stays, as in any merge. A cluster is
    // named by its anchor.
    const clusterOf = (id: string) => before.get(id)?.anchorId;
    const oldest = oldestFirst.find(e => {
      const cluster = clusterOf(e.source);
      return cluster !== undefined && cluster === clusterOf(e.target) && absorbed.has(cluster);
    });
    const kept = (oldest && clusterOf(oldest.source)) ?? [...absorbed][0];
    if (kept === undefined) {
      return;
    }

    const keptAt = displayed.get(kept);
    const offset = after.get(kept)?.offset;
    if (keptAt && offset) {
      updates.push({ solar_system_id: anchorId, position: { x: keptAt.x - offset.x, y: keptAt.y - offset.y } });
    }
  });

  return updates;
};

/**
 * `unlockAnchorUpdates` for the map as it is now, laid out as the unlock will leave it. That
 * layout is needed before the unlock is sent, so an engine that computes asynchronously gets no
 * updates, and the cluster moves after all.
 */
export const unlockPreSave = ({
  unlocking,
  nodes,
  edges,
  before,
  layout,
}: {
  unlocking: string[];
  nodes: { id: string; position: XYPosition; locked: boolean }[];
  edges: PlacementEdge[];
  before: Map<string, Placement>;
  layout: Omit<PlacementInput, 'nodes' | 'edges'>;
}): DisplayedUpdate[] => {
  const unlockingIds = new Set(unlocking);
  const after = computePlacementsNow({
    ...layout,
    nodes: nodes.map(n => ({ id: n.id, locked: n.locked && !unlockingIds.has(n.id) })),
    edges,
  });
  if (!after) {
    return [];
  }

  return unlockAnchorUpdates({
    unlocking,
    before,
    after: after.placements,
    displayed: new Map(nodes.map(n => [n.id, n.position])),
    edges,
  });
};

/** What to save before a structure change: `displayed`, with any anchor an unlock moves in its place. */
export const preSaveUpdates = (displayed: DisplayedUpdate[], anchors: DisplayedUpdate[]): DisplayedUpdate[] => {
  const moved = new Set(anchors.map(u => u.solar_system_id));
  return [...displayed.filter(u => !moved.has(u.solar_system_id)), ...anchors];
};

/** The displayed position of each of `ids` whose stored position differs from it. */
export const displayedUpdates = (
  nodes: { id: string; position: XYPosition; data?: { position?: XYPosition } }[],
  ids: Set<string>,
): DisplayedUpdate[] => {
  const updates: DisplayedUpdate[] = [];
  nodes.forEach(n => {
    const stored = n.data?.position;
    if (ids.has(n.id) && (stored?.x !== n.position.x || stored?.y !== n.position.y)) {
      updates.push({ solar_system_id: n.id, position: n.position });
    }
  });
  return updates;
};
