import { Dispatch, SetStateAction, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Edge, Node } from 'reactflow';

import { SolarSystemConnection, SolarSystemRawType, SystemPositionUpdate } from '@/hooks/Mapper/types';
import { OutCommand, OutCommandHandler } from '@/hooks/Mapper/types/mapHandlers.ts';
import { useMapGetOption } from '@/hooks/Mapper/mapRootProvider/hooks/api';
import { useStructureChangeListener } from '@/hooks/Mapper/events';
import {
  computePlacements,
  EMPTY_RECONCILE_STATE,
  getLayoutEngine,
  LayoutOptions,
  Placement,
  ReconcileState,
  reconcileNodes,
} from '@/hooks/Mapper/components/map/layout';

// Every client lays out with the same nominal node size, so they all compute identical offsets
// whatever theme each one uses. It is the largest theme's node (accessible-large-theme.scss), so
// no theme's nodes overlap.
const LAYOUT_NODE_SIZE = { width: 142, height: 37 };

const NO_PLACEMENTS: Map<string, Placement> = new Map();

/**
 * `auto_layout_options` holds one option bag per engine, so switching engines preserves the
 * other's settings. Nothing here interprets the contents — that is the selected engine's job.
 */
const readEngineOptions = (raw: unknown, engineId: string): LayoutOptions => {
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
const serializeOptions = (options: LayoutOptions): string =>
  Object.keys(options)
    .sort()
    .map(key => `${key}=${options[key]}`)
    .join(',');

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

// Connections without a creation time sort after every connection that has one.
const createdAtOf = (insertedAt: string | null | undefined): number => {
  const at = Date.parse(insertedAt ?? '');
  return Number.isNaN(at) ? Infinity : at;
};

interface UseAutoLayoutProps {
  nodes: Node<SolarSystemRawType>[];
  edges: Edge<SolarSystemConnection>[];
  /**
   * The *controlled* nodes setter (from `useNodesState`), not `useReactFlow().setNodes`. The
   * latter emits a `reset` change, which `applyNodeChanges` handles by discarding every other
   * change in the batch and rebuilding the array from React Flow's store snapshot.
   */
  setNodes: Dispatch<SetStateAction<Node<SolarSystemRawType>[]>>;
  onCommand: OutCommandHandler;
}

export interface UseAutoLayoutResult {
  enabled: boolean;
  /**
   * If auto-layout is enabled and `nodeId` belongs to a managed cluster (a connected group of
   * unlocked systems), returns every node id in that cluster (including itself); otherwise
   * undefined. The drag handlers use this to move a whole tree together.
   */
  getCluster: (nodeId: string) => string[] | undefined;
  /** Call when the user starts dragging nodes. Suspends reconciling until `endDrag`. */
  beginDrag: () => void;
  /** Call after the drop's positions have been saved. Reconciles anything deferred by the drag. */
  endDrag: () => void;
  /**
   * Persists positions the user chose, recording them as the nodes' stored positions right away
   * rather than waiting for the server's echo: the next reconcile places each cluster from its
   * anchor's stored position, and would otherwise snap a just-dropped tree back to where it was.
   */
  savePositions: (updates: SystemPositionUpdate[]) => void;
  /**
   * Persists the displayed layout as every managed node's stored position, so the arrangement
   * survives turning auto-layout off and is what the API and exports report. Sent as
   * `save_layout_positions`, which the server accepts from map admins only.
   */
  saveLayout: () => void;
}

/**
 * Map-wide automatic layout. When enabled (a `Map.options` policy set by an admin), it arranges
 * *managed* nodes — unlocked systems connected to at least one other unlocked system — into a
 * tree using the selected pluggable engine. Disconnected and locked systems keep their positions.
 *
 * The layout is a view: nothing here writes it to the server on its own. Each cluster is pinned
 * to an anchor system (`pickAnchor`: the root, else the source of its oldest connection), and
 * every member is displayed at the anchor's *stored* position plus the offset the engine
 * computed for it. Structure, connection ages, options, root, stored positions and the nominal
 * LAYOUT_NODE_SIZE are all shared state, so every client derives the same picture, and a server
 * echo can't pull a node out of its tree — the next reconcile puts it back. A locked root still
 * anchors its tree, which is then pinned: its members can't be dragged.
 *
 * Two passes: the engine runs only when the structure changes (see the signature below), while
 * a cheap reconcile runs on every `nodes` change, before paint, to apply the placements and to
 * return nodes that just left the layout to their stored positions.
 *
 * Positions are written only for something a user did. Dragging moves whole clusters (see the
 * drag handlers in Map.tsx) and saves what the user sees; locking, unlocking, deleting,
 * disconnecting or re-rooting first saves the clusters involved (`emitStructureChange`); an
 * admin can save the whole layout (`saveLayout`). Clusters nobody has touched since they were
 * laid out keep their older stored arrangement, which is what the API, exports and a disabled
 * auto-layout show, and what a node falls back to when a change no client made (connection or
 * system auto-expiry) takes it out of the layout.
 */
export const useAutoLayout = ({ nodes, edges, setNodes, onCommand }: UseAutoLayoutProps): UseAutoLayoutResult => {
  const enabled = useMapGetOption('auto_layout_enabled') === 'true';
  const engineRaw = useMapGetOption('auto_layout_engine');
  const optionsRaw = useMapGetOption('auto_layout_options');
  const rootRaw = useMapGetOption('root_system_id');

  const engine = getLayoutEngine(engineRaw ? String(engineRaw) : null);
  const engineId = engine.id;
  const options = useMemo(() => readEngineOptions(optionsRaw, engineId), [optionsRaw, engineId]);
  const optionsKey = useMemo(() => serializeOptions(options), [options]);

  // Engines that don't anchor on a root never see one, rather than silently ignoring it.
  const rootId = engine.supportsRoot && rootRaw ? String(rootRaw) : null;

  // Signature of the structure the last *successful* layout was computed from, and of the one
  // currently being computed. Both are needed: the in-flight value stops the effect from
  // starting the same run twice, while only success promotes it to `lastSigRef` so a thrown
  // engine error doesn't permanently suppress layout for that structure.
  const lastSigRef = useRef<string>('');
  const inFlightSigRef = useRef<string | null>(null);
  const runIdRef = useRef(0);
  const clusterByNodeRef = useRef<Map<string, string[]>>(new Map());
  const onCommandRef = useRef(onCommand);
  onCommandRef.current = onCommand;
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const edgesRef = useRef(edges);
  edgesRef.current = edges;

  const [placements, setPlacements] = useState<Map<string, Placement>>(NO_PLACEMENTS);
  // What the last reconcile placed and pinned, so the next one knows which nodes just left.
  const reconcileRef = useRef<ReconcileState>(EMPTY_RECONCILE_STATE);

  // While the user drags, reconciling is deferred so it can't fight the drag; bumping
  // `dragEpoch` on drop reconciles from the positions the drop saved.
  const draggingRef = useRef(false);
  const [dragEpoch, setDragEpoch] = useState(0);

  const getCluster = useCallback((nodeId: string) => clusterByNodeRef.current.get(nodeId), []);

  const beginDrag = useCallback(() => {
    draggingRef.current = true;
  }, []);

  const endDrag = useCallback(() => {
    if (!draggingRef.current) {
      return;
    }
    draggingRef.current = false;
    setDragEpoch(e => e + 1);
  }, []);

  // Marks positions as stored ahead of the server's echo (see `savePositions`).
  const recordStored = useCallback(
    (updates: SystemPositionUpdate[]) => {
      if (updates.length === 0) {
        return;
      }

      const byId = new Map(updates.map(u => [u.solar_system_id, u.position]));
      setNodes(nds =>
        nds.map(n => {
          const position = byId.get(n.id);
          return position ? { ...n, position, data: { ...n.data, position } } : n;
        }),
      );
    },
    [setNodes],
  );

  const sendPositions = useCallback((updates: SystemPositionUpdate[]) => {
    if (updates.length === 1) {
      onCommandRef.current({ type: OutCommand.updateSystemPosition, data: updates[0] });
    } else if (updates.length > 1) {
      onCommandRef.current({ type: OutCommand.updateSystemPositions, data: updates });
    }
  }, []);

  const savePositions = useCallback(
    (updates: SystemPositionUpdate[]) => {
      recordStored(updates);
      sendPositions(updates);
    },
    [recordStored, sendPositions],
  );

  // The displayed position of each of `ids` that differs from its stored one.
  const displayedUpdates = useCallback((ids: Set<string>) => {
    const updates: SystemPositionUpdate[] = [];
    nodesRef.current.forEach(n => {
      const stored = n.data?.position;
      if (ids.has(n.id) && (stored?.x !== n.position.x || stored?.y !== n.position.y)) {
        updates.push({ solar_system_id: n.id, position: n.position });
      }
    });
    return updates;
  }, []);

  const saveLayout = useCallback(() => {
    const updates = displayedUpdates(reconcileRef.current.placed);
    if (updates.length === 0) {
      return;
    }
    recordStored(updates);
    onCommandRef.current({ type: OutCommand.saveLayoutPositions, data: { positions: updates } });
  }, [displayedUpdates, recordStored]);

  // A change this client is about to send will reshape these clusters: a locked or disconnected
  // node leaves the layout for its stored position, and a cluster that gains, loses or changes
  // its anchor is re-placed from the new anchor's stored position. Saving what is displayed
  // first makes those the positions everyone already sees, so nothing jumps.
  useStructureChangeListener(({ systemIds, removing, collect }) => {
    // The systems' own clusters, plus their neighbours': a system being unlocked belongs to no
    // cluster yet, but the clusters it is about to join are its neighbours'.
    const changing = new Set(systemIds);
    const touched = new Set(systemIds);
    edgesRef.current.forEach(e => {
      if (changing.has(e.source)) {
        touched.add(e.target);
      }
      if (changing.has(e.target)) {
        touched.add(e.source);
      }
    });

    const ids = new Set<string>();
    touched.forEach(id => clusterByNodeRef.current.get(id)?.forEach(member => ids.add(member)));
    if (removing) {
      systemIds.forEach(id => ids.delete(id));
    }

    const updates = displayedUpdates(ids);
    recordStored(updates);
    if (collect) {
      collect(updates);
    } else {
      sendPositions(updates);
    }
  });

  // Layout pass: recompute placements when the structure changes.
  useEffect(() => {
    if (!enabled) {
      clusterByNodeRef.current = new Map();
      lastSigRef.current = '';
      inFlightSigRef.current = null;
      runIdRef.current++;
      setPlacements(NO_PLACEMENTS);
      return;
    }

    const nodeFp = new Fingerprint();
    nodes.forEach(n => nodeFp.add(hashString(n.id, n.data?.locked ? 5387 : 5381)));

    // Connection ages pick anchors, so they are part of the structure too.
    const edgeFp = new Fingerprint();
    edges.forEach(e => edgeFp.add(hashString(e.data?.inserted_at ?? '', hashEdge(e.source, e.target))));

    const signature = [engineId, optionsKey, rootId, nodeFp.toString(), edgeFp.toString()].join('|');

    // Positions aren't part of the signature, so this early-returns during drags/position
    // syncs and only recomputes the (expensive) layout on real structural changes.
    if (signature === lastSigRef.current || signature === inFlightSigRef.current) {
      return;
    }
    inFlightSigRef.current = signature;
    const runId = ++runIdRef.current;

    const run = async () => {
      const result = await computePlacements({
        engine,
        nodes: nodes.map(n => ({ id: n.id, locked: !!n.data?.locked })),
        edges: edges.map(e => ({ source: e.source, target: e.target, createdAt: createdAtOf(e.data?.inserted_at) })),
        rootId,
        options,
        nodeSize: LAYOUT_NODE_SIZE,
      });

      // A newer structure started laying out while we were awaiting the engine — discard this
      // result instead of letting the slower run overwrite the newer one.
      if (runIdRef.current !== runId) {
        return;
      }

      clusterByNodeRef.current = result.clusterByNode;
      setPlacements(result.placements);
    };

    run()
      .then(() => {
        if (runIdRef.current === runId) {
          lastSigRef.current = signature;
        }
      })
      .catch(err => {
        // Leave `lastSigRef` untouched so this structure is retried on the next change instead
        // of being permanently skipped.
        console.error('Auto-layout failed', err);
      })
      .finally(() => {
        if (inFlightSigRef.current === signature) {
          inFlightSigRef.current = null;
        }
      });
  }, [nodes, edges, enabled, engine, engineId, options, optionsKey, rootId]);

  // Reconcile pass: runs before paint, so a node reset by a server echo is put back in its tree
  // without ever being drawn at its stored position.
  useLayoutEffect(() => {
    if (draggingRef.current) {
      return;
    }

    const { updates, state } = reconcileNodes(nodes, placements, reconcileRef.current);
    reconcileRef.current = state;
    if (updates.size === 0) {
      return;
    }

    setNodes(nds =>
      nds.map(n => {
        const update = updates.get(n.id);
        return update ? { ...n, ...update } : n;
      }),
    );
  }, [nodes, placements, dragEpoch, setNodes]);

  return { enabled, getCluster, beginDrag, endDrag, savePositions, saveLayout };
};
