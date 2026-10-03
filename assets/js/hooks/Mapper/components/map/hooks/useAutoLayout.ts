import { Dispatch, SetStateAction, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import debounce from 'lodash.debounce';
import { Edge, Node, XYPosition } from 'reactflow';

import { SolarSystemRawType } from '@/hooks/Mapper/types';
import { OutCommand, OutCommandHandler } from '@/hooks/Mapper/types/mapHandlers.ts';
import { UserPermission } from '@/hooks/Mapper/types/permissions.ts';
import { useMapCheckPermissions, useMapGetOption } from '@/hooks/Mapper/mapRootProvider/hooks/api';
import { computeBoundsCenter } from '@/hooks/Mapper/helpers/recenterSystems.ts';
import {
  getConnectedComponents,
  getLayoutEngine,
  LayoutEdgeInput,
  LayoutNodeInput,
  LayoutOptions,
} from '@/hooks/Mapper/components/map/layout';

const PERSIST_PERMISSIONS = [UserPermission.UPDATE_SYSTEM];
const DEFAULT_NODE_W = 130;
const DEFAULT_NODE_H = 34;

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

type PersistFlush = { (): void; cancel(): void; flush(): void };

interface UseAutoLayoutProps {
  nodes: Node<SolarSystemRawType>[];
  edges: Edge[];
  /**
   * The *controlled* nodes setter (from `useNodesState`), not `useReactFlow().setNodes`. The
   * latter emits a `reset` change, which `applyNodeChanges` handles by discarding every other
   * change in the batch and rebuilding the array from React Flow's store snapshot.
   */
  setNodes: Dispatch<SetStateAction<Node<SolarSystemRawType>[]>>;
  onCommand: OutCommandHandler;
}

export interface UseAutoLayoutResult {
  /**
   * If auto-layout is enabled and `nodeId` belongs to a managed cluster (a connected group of
   * unlocked systems), returns every node id in that cluster (including itself); otherwise
   * undefined. The drag handlers use this to move a whole tree together.
   */
  getCluster: (nodeId: string) => string[] | undefined;
  /**
   * Call when the user starts dragging nodes. Sends any queued auto-layout positions right away
   * (so they reach the server *before* the drop's positions rather than overwriting them), and
   * suspends layout until `endDrag` so a mid-drag recompute can't fight the drag.
   */
  beginDrag: () => void;
  /** Call after the drop's positions have been sent. Re-runs any layout deferred by the drag. */
  endDrag: () => void;
}

/**
 * Map-wide automatic layout. When enabled (a `Map.options` policy set by an admin), it
 * deterministically arranges *managed* nodes — unlocked systems connected to at least one
 * other unlocked system — into a tree using the selected pluggable engine. Disconnected and
 * locked systems keep their positions.
 *
 * Movement model (see the drag handlers in Map.tsx): managed nodes stay normally draggable
 * (`!locked`), but dragging one translates its *entire cluster* together via `getCluster`, so
 * the tree shape is preserved and users reposition whole trees rather than single nodes. This
 * applies to everyone; server-side permission (update_system) still governs who can persist.
 *
 * Every client that may update systems persists the *auto-arranged* positions it computes, so
 * the server never keeps pre-layout coordinates just because no admin had the map open (a later
 * update_system echo would then carry those stale coordinates and pull the node out of the
 * tree). Concurrent clients compute from the same server state, so their writes agree up to the
 * determinism caveat below; last write wins. Manual cluster drags are persisted by whoever
 * performs them.
 *
 * TODO(layout-determinism): the result is not yet a pure function of structure — it depends on
 * per-client measured node dimensions and on each client's current positions (via the centroid
 * translation below), so two admins can compute different coordinates for the same graph and
 * the last write wins. Related: a layout computed before React Flow has measured a new node
 * uses the DEFAULT_NODE_* placeholder and is not recomputed when the real size arrives, because
 * dimensions are deliberately kept out of the signature.
 */
export const useAutoLayout = ({ nodes, edges, setNodes, onCommand }: UseAutoLayoutProps): UseAutoLayoutResult => {
  const canPersist = useMapCheckPermissions(PERSIST_PERMISSIONS);

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

  // While the user drags, layout is deferred; bumping `dragEpoch` on drop re-runs the effect so
  // a structural change that arrived mid-drag is laid out from the dropped positions.
  const draggingRef = useRef(false);
  const [dragEpoch, setDragEpoch] = useState(0);

  // Debounced persistence of the auto-arranged layout. Updates accumulate in `pendingRef`
  // (keyed by system id) rather than being passed as arguments, so a later run that moves
  // nothing cannot replace — and thereby discard — an earlier run's batch.
  const pendingRef = useRef<Map<string, XYPosition>>(new Map());
  const flushRef = useRef<PersistFlush | null>(null);
  if (!flushRef.current) {
    flushRef.current = debounce(() => {
      const pending = pendingRef.current;
      if (pending.size === 0) {
        return;
      }
      const data = Array.from(pending, ([solar_system_id, position]) => ({ solar_system_id, position }));
      pending.clear();
      onCommandRef.current({ type: OutCommand.updateSystemPositions, data });
    }, 600);
  }

  // Drop a pending persist rather than pushing it onto a torn-down LiveView hook.
  useEffect(() => () => flushRef.current?.cancel(), []);

  const getCluster = useCallback((nodeId: string) => clusterByNodeRef.current.get(nodeId), []);

  const beginDrag = useCallback(() => {
    draggingRef.current = true;
    flushRef.current?.flush();
    // Discard a layout still awaiting the engine: applying it mid-drag would reshape the tree
    // under the cursor. Clearing the in-flight marker lets the same structure run again later.
    runIdRef.current++;
    inFlightSigRef.current = null;
  }, []);

  const endDrag = useCallback(() => {
    if (!draggingRef.current) {
      return;
    }
    draggingRef.current = false;
    setDragEpoch(e => e + 1);
  }, []);

  useEffect(() => {
    if (!enabled) {
      clusterByNodeRef.current = new Map();
      lastSigRef.current = '';
      inFlightSigRef.current = null;
      runIdRef.current++;
      return;
    }

    if (draggingRef.current) {
      return;
    }

    const nodeFp = new Fingerprint();
    nodes.forEach(n => nodeFp.add(hashString(n.id, n.data?.locked ? 5387 : 5381)));

    const edgeFp = new Fingerprint();
    edges.forEach(e => edgeFp.add(hashEdge(e.source, e.target)));

    const signature = [engineId, optionsKey, rootId, nodeFp.toString(), edgeFp.toString()].join('|');

    // Positions aren't part of the signature, so this early-returns during drags/position
    // syncs and only recomputes the (expensive) layout on real structural changes.
    if (signature === lastSigRef.current || signature === inFlightSigRef.current) {
      return;
    }
    inFlightSigRef.current = signature;
    const runId = ++runIdRef.current;

    const run = async () => {
      const currentPos = new Map<string, XYPosition>();
      const dims = new Map<string, { w: number; h: number }>();
      const lockedSet = new Set<string>();
      nodes.forEach(n => {
        currentPos.set(n.id, n.position);
        dims.set(n.id, { w: n.width ?? DEFAULT_NODE_W, h: n.height ?? DEFAULT_NODE_H });
        if (n.data?.locked) {
          lockedSet.add(n.id);
        }
      });

      const unlockedIds = nodes.filter(n => !lockedSet.has(n.id)).map(n => n.id);
      const layoutEdges: LayoutEdgeInput[] = edges
        .filter(
          e =>
            !lockedSet.has(e.source) &&
            !lockedSet.has(e.target) &&
            currentPos.has(e.source) &&
            currentPos.has(e.target),
        )
        .map(e => ({ source: e.source, target: e.target }));

      const components = getConnectedComponents(unlockedIds, layoutEdges).filter(c => c.nodeIds.length >= 2);

      const clusterByNode = new Map<string, string[]>();
      const newPositions = new Map<string, XYPosition>();

      for (const comp of components) {
        const layoutNodes: LayoutNodeInput[] = comp.nodeIds.map(id => ({
          id,
          width: dims.get(id)?.w ?? DEFAULT_NODE_W,
          height: dims.get(id)?.h ?? DEFAULT_NODE_H,
        }));

        const compRoot = rootId && comp.nodeIds.includes(rootId) ? rootId : null;

        const result = await engine.compute({
          nodes: layoutNodes,
          edges: comp.edges,
          rootId: compRoot,
          options,
        });

        // Preserve the component's original centroid: clusters stay where users put them,
        // only their internal structure is tidied.
        const laidOutItems = comp.nodeIds
          .filter(id => result.positions[id])
          .map(id => ({ position: result.positions[id] }));
        const originalItems = comp.nodeIds
          .filter(id => currentPos.has(id))
          .map(id => ({ position: currentPos.get(id) as XYPosition }));

        const laidOutCenter = computeBoundsCenter(laidOutItems);
        const originalCenter = computeBoundsCenter(originalItems);
        const dx = originalCenter.x - laidOutCenter.x;
        const dy = originalCenter.y - laidOutCenter.y;

        comp.nodeIds.forEach(id => {
          const p = result.positions[id];
          if (!p) {
            return;
          }
          clusterByNode.set(id, comp.nodeIds);
          newPositions.set(id, { x: Math.round(p.x + dx), y: Math.round(p.y + dy) });
        });
      }

      // A newer structure started laying out while we were awaiting the engine — discard this
      // result instead of letting the slower run overwrite the newer one.
      if (runIdRef.current !== runId) {
        return;
      }

      clusterByNodeRef.current = clusterByNode;

      // Diff against the snapshot this layout was computed from, so nothing mutates inside the
      // state updater (which React may invoke more than once).
      const moved = new Map<string, XYPosition>();
      nodes.forEach(n => {
        const pos = newPositions.get(n.id);
        if (!pos) {
          return;
        }
        if (Math.abs(pos.x - n.position.x) > 0.5 || Math.abs(pos.y - n.position.y) > 0.5) {
          moved.set(n.id, pos);
        }
      });

      if (moved.size === 0) {
        return;
      }

      setNodes(nds =>
        nds.map(n => {
          const pos = moved.get(n.id);
          return pos ? { ...n, position: pos } : n;
        }),
      );

      if (canPersist) {
        moved.forEach((position, id) => pendingRef.current.set(id, position));
        flushRef.current?.();
      }
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
  }, [nodes, edges, enabled, engine, engineId, options, optionsKey, rootId, canPersist, setNodes, dragEpoch]);

  return { getCluster, beginDrag, endDrag };
};
