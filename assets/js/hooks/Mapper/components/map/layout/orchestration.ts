import { XYPosition } from 'reactflow';
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
