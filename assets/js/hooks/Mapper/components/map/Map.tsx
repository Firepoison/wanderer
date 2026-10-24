import { NodeSelectionMouseHandler } from '@/hooks/Mapper/components/contexts/types.ts';
import { PingData, SolarSystemConnection, SolarSystemRawType } from '@/hooks/Mapper/types';
import { MapHandlers, OutCommand, OutCommandHandler } from '@/hooks/Mapper/types/mapHandlers.ts';
import { UserPermission } from '@/hooks/Mapper/types/permissions.ts';
import { useMapCheckPermissions } from '@/hooks/Mapper/mapRootProvider/hooks/api';
import { ctxManager } from '@/hooks/Mapper/utils/contextManager.ts';
import type { PanelPosition } from '@reactflow/core';
import clsx from 'clsx';
import { ForwardedRef, forwardRef, MouseEvent, useCallback, useEffect, useMemo, useRef } from 'react';
import ReactFlow, {
  Background,
  Edge,
  MiniMap,
  Node,
  NodeChange,
  NodeDragHandler,
  OnConnect,
  OnMoveEnd,
  OnSelectionChangeFunc,
  SelectionDragHandler,
  SelectionMode,
  useReactFlow,
} from 'reactflow';
import 'reactflow/dist/style.css';
import classes from './Map.module.scss';
import { MapProvider, useMapState } from './MapProvider';
import {
  ContextMenuConnection,
  ContextMenuRoot,
  SolarSystemEdge,
  useContextMenuConnectionHandlers,
  useContextMenuRootHandlers,
} from './components';
import { getBehaviorForTheme } from './helpers/getThemeBehavior';
import { useAutoLayout, useEdgesState, useMapHandlers, useNodesState, useUpdateNodes } from './hooks';
import { ClusterDrag, clusterDragTargets, startClusterDrag } from './layout';
import { useBackgroundVars } from './hooks/useBackgroundVars';
import { MapViewport, OnMapAddSystemCallback, OnMapSelectionChange } from './map.types';
import type { Viewport } from '@reactflow/core/dist/esm/types';
import { usePrevious } from 'primereact/hooks';

const initialNodes: Node<SolarSystemRawType>[] = [
  // {
  //   id: '31122321',
  //   width: 100,
  //   height: 28,
  //   position: { x: 0, y: 0 },
  //   data: {
  //     id: '31122321',
  //     solarSystemName: 'J111447',
  //     classTitle: 'C6',
  //   },
  //   type: 'custom',
  // },
];

const initialEdges = [
  {
    id: '1-2',
    source: '_____kek',
    target: '_____cheburek',
    sourceHandle: 'c',
    targetHandle: 'a',
    type: 'floating',
    // markerEnd: { type: MarkerType.Arrow },
    label: 'updatable edge',
  },
];

const edgeTypes = {
  floating: SolarSystemEdge,
};

export const MAP_ROOT_ID = 'MAP_ROOT_ID';

// Saving the layout rewrites the stored position of every laid-out system, so it is an admin
// action, like the auto-layout settings themselves. The server enforces that
// (`save_layout_positions` checks admin_map); this only hides the menu item from everyone else.
const SAVE_LAYOUT_PERMISSIONS = [UserPermission.ADMIN_MAP];

interface MapCompProps {
  refn: ForwardedRef<MapHandlers>;
  onCommand: OutCommandHandler;
  onSelectionChange: OnMapSelectionChange;
  onConnectionInfoClick?(e: SolarSystemConnection): void;
  onAddSystem?: OnMapAddSystemCallback;
  onSelectionContextMenu?: NodeSelectionMouseHandler;
  onChangeViewport?: (viewport: MapViewport) => void;
  minimapClasses?: string;
  isShowMinimap?: boolean;
  onSystemContextMenu: (event: MouseEvent<Element>, systemId: string) => void;
  showKSpaceBG?: boolean;
  isThickConnections?: boolean;
  isShowBackgroundPattern?: boolean;
  isSoftBackground?: boolean;
  theme?: string;
  pings: PingData[];
  minimapPlacement?: PanelPosition;
  localShowShipName?: boolean;
  defaultViewport?: Viewport;
}

const MapComp = ({
  refn,
  onCommand,
  minimapClasses,
  onSelectionChange,
  onSystemContextMenu,
  onConnectionInfoClick,
  onSelectionContextMenu,
  isShowMinimap,
  showKSpaceBG,
  isThickConnections,
  isShowBackgroundPattern,
  isSoftBackground,
  theme,
  onAddSystem,
  pings,
  minimapPlacement = 'bottom-right',
  localShowShipName = false,
  onChangeViewport,
  defaultViewport,
}: MapCompProps) => {
  const { getNodes, setViewport } = useReactFlow();
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<SolarSystemRawType>>(initialNodes);
  const [edges, , onEdgesChange] = useEdgesState<Edge<SolarSystemConnection>>(initialEdges);

  useMapHandlers(refn, onSelectionChange);
  useUpdateNodes(nodes);
  const {
    enabled: isAutoLayoutEnabled,
    getCluster,
    beginDrag,
    endDrag,
    savePositions,
    saveLayout,
  } = useAutoLayout({ nodes, edges, setNodes, onCommand });
  const canSaveLayout = useMapCheckPermissions(SAVE_LAYOUT_PERMISSIONS);

  // Authoritative node state for the drag handlers. React Flow's own store (`getNodes()`) lags
  // the controlled `nodes` prop by a committed render, so reading positions from it mid-drag
  // yields the previous frame's values.
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;

  // While auto-layout is on, dragging any node of a connected cluster moves the whole tree
  // together, its shape preserved; see `ClusterDrag` for how each cluster follows its leader.
  const dragRef = useRef<ClusterDrag | null>(null);

  const { handleRootContext, ...rootCtxProps } = useContextMenuRootHandlers({ onAddSystem, onCommand });
  const { handleConnectionContext, ...connectionCtxProps } = useContextMenuConnectionHandlers();
  const { update } = useMapState();
  const { variant, gap, size, color } = useBackgroundVars(theme);
  const { isPanAndDrag, nodeComponent, connectionMode } = getBehaviorForTheme(theme || 'default');

  const refVars = useRef({ onChangeViewport });
  refVars.current = { onChangeViewport };

  const nodeTypes = useMemo(() => {
    return {
      custom: nodeComponent,
    };
  }, [nodeComponent]);

  const onConnect: OnConnect = useCallback(
    params => {
      const { source, target } = params;

      onCommand({
        type: OutCommand.manualAddConnection,
        data: { source, target },
      });
    },
    [onCommand],
  );

  const startDrag = useCallback(
    (dragged: Node[], grabbedId: string) => {
      beginDrag();
      dragRef.current = startClusterDrag(
        nodesRef.current,
        dragged.map(n => n.id),
        grabbedId,
        getCluster,
      );
    },
    [getCluster, beginDrag],
  );

  const followDrag = useCallback(
    (dragged: Node[]) => {
      const drag = dragRef.current;
      if (!drag) {
        return;
      }
      const targets = clusterDragTargets(drag, dragged);
      // Move every cluster member to where its leader puts it. This goes through the controlled
      // state setter, so it is queued *after* React Flow's own position changes for the dragged
      // nodes, and overrides them for any dragged node that snapped differently from its leader.
      setNodes(nds =>
        nds.map(n => {
          const target = targets[n.id];
          if (!target || (n.position.x === target.x && n.position.y === target.y)) {
            return n;
          }
          return { ...n, position: target };
        }),
      );
    },
    [setNodes],
  );

  const finishDrag = useCallback(
    (dragged: Node[]) => {
      const drag = dragRef.current;
      dragRef.current = null;

      // Cluster members get their start positions plus their leader's total delta — exactly the
      // transform followDrag applied. Reading them back from React Flow's store instead would
      // pick up the previous frame's coordinates and snap the cluster backwards. Dragged nodes
      // outside any cluster keep where React Flow put them.
      const targets = drag ? clusterDragTargets(drag, dragged) : {};
      const updates = dragged.filter(n => !targets[n.id]).map(n => ({ solar_system_id: n.id, position: n.position }));
      Object.entries(targets).forEach(([id, position]) => updates.push({ solar_system_id: id, position }));

      savePositions(updates);
      endDrag();
    },
    [savePositions, endDrag],
  );

  // Undoes a drag React Flow abandoned, so nothing is left moved but unsaved.
  const abortDrag = useCallback(() => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (drag) {
      setNodes(nds =>
        nds.map(n => {
          const s = drag.start[n.id];
          return s ? { ...n, position: s, dragging: false } : n;
        }),
      );
    }
    endDrag();
  }, [setNodes, endDrag]);

  // React Flow ends an aborted drag (a second finger on a touch screen) without calling
  // onNodeDragStop/onSelectionDragStop, which would leave reconciling suspended. So once every
  // pointer is released, give React Flow's own stop handler — which runs on that same release —
  // a moment, and undo the drag if it never came. Tracking all pressed pointers keeps lifting a
  // second finger mid-drag from ending a drag that is still going.
  useEffect(() => {
    const pressed = new Set<number>();
    const onDown = (e: PointerEvent) => pressed.add(e.pointerId);
    const onUp = (e: PointerEvent) => {
      pressed.delete(e.pointerId);
      const drag = dragRef.current;
      if (!drag || pressed.size > 0) {
        return;
      }
      setTimeout(() => {
        if (dragRef.current === drag) {
          abortDrag();
        }
      }, 100);
    };

    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('pointercancel', onUp, true);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('pointerup', onUp, true);
      window.removeEventListener('pointercancel', onUp, true);
    };
  }, [abortDrag]);

  // `dragged` holds every node React Flow is moving: the grabbed one plus any other selected.
  const handleNodeDragStart: NodeDragHandler = useCallback(
    (_, node, dragged) => startDrag(dragged.length > 0 ? dragged : [node], node.id),
    [startDrag],
  );

  const handleNodeDrag: NodeDragHandler = useCallback(
    (_, node, dragged) => followDrag(dragged.length > 0 ? dragged : [node]),
    [followDrag],
  );

  const handleNodeDragStop: NodeDragHandler = useCallback(
    (_, node, dragged) => finishDrag(dragged.length > 0 ? dragged : [node]),
    [finishDrag],
  );

  // Nothing is grabbed in a selection drag, so any dragged node can lead its own cluster.
  const handleSelectionDragStart: SelectionDragHandler = useCallback(
    (_, dragged) => {
      if (dragged.length > 0) {
        startDrag(dragged, dragged[0].id);
      }
    },
    [startDrag],
  );

  const handleSelectionDrag: SelectionDragHandler = useCallback((_, dragged) => followDrag(dragged), [followDrag]);

  const handleSelectionDragStop: SelectionDragHandler = useCallback((_, dragged) => finishDrag(dragged), [finishDrag]);

  const resetContexts = useCallback(() => ctxManager.reset(), []);

  const handleSelectionChange: OnSelectionChangeFunc = useCallback(
    ({ edges, nodes }) => {
      onSelectionChange({
        connections: edges.map(({ source, target }) => ({ source, target })),
        systems: nodes.map(x => x.id),
      });
    },
    [onSelectionChange],
  );

  const handleMoveEnd: OnMoveEnd = useCallback((_, viewport) => {
    // @ts-ignore
    refVars.current.onChangeViewport?.(viewport);
  }, []);

  const handleNodesChange = useCallback(
    (changes: NodeChange[]) => {
      // prevents single node deselection on background / same node click
      // allows deseletion of all nodes if multiple are currently selected
      if (changes.length === 1 && changes[0].type == 'select' && changes[0].selected === false) {
        changes[0].selected = getNodes().filter(node => node.selected).length === 1;
      }

      const nextChanges = changes.reduce((acc, change) => {
        return [...acc, change];
      }, [] as NodeChange[]);

      onNodesChange(nextChanges);
    },
    [getNodes, onNodesChange],
  );

  useEffect(() => {
    update(x => ({
      ...x,
      showKSpaceBG: showKSpaceBG,
      isThickConnections: isThickConnections,
      pings,
      localShowShipName,
    }));
  }, [showKSpaceBG, isThickConnections, pings, update, localShowShipName]);

  const prevViewport = usePrevious(defaultViewport);
  useEffect(() => {
    if (defaultViewport == null) {
      return;
    }

    if (prevViewport == null) {
      return;
    }

    setViewport(defaultViewport);
  }, [defaultViewport, prevViewport, setViewport]);

  return (
    <>
      <div
        data-window-id={MAP_ROOT_ID}
        className={clsx(classes.MapRoot, { [classes.BackgroundAlternateColor]: isSoftBackground })}
      >
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={handleNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          // TODO we need save into session all of this
          //      and on any action do either
          defaultViewport={defaultViewport}
          edgeTypes={edgeTypes}
          nodeTypes={nodeTypes}
          connectionMode={connectionMode}
          snapToGrid
          nodeDragThreshold={10}
          onNodeDragStart={handleNodeDragStart}
          onNodeDrag={handleNodeDrag}
          onNodeDragStop={handleNodeDragStop}
          onSelectionDragStart={handleSelectionDragStart}
          onSelectionDrag={handleSelectionDrag}
          onSelectionDragStop={handleSelectionDragStop}
          onConnectStart={() => update({ isConnecting: true })}
          onConnectEnd={() => update({ isConnecting: false })}
          onNodeMouseEnter={(_, node) => update({ hoverNodeId: node.id })}
          onPaneClick={event => {
            event.preventDefault();
            event.stopPropagation();
          }}
          // onKeyUp=
          onNodeMouseLeave={() => update({ hoverNodeId: null })}
          onEdgeClick={(_, t) => {
            onConnectionInfoClick?.(t.data);
          }}
          onEdgeContextMenu={handleConnectionContext}
          onNodeContextMenu={(ev, node) => onSystemContextMenu(ev, node.id)}
          // TODO don't know why this error appear - but it annoying
          // eslint-disable-next-line @typescript-eslint/ban-ts-comment
          // @ts-expect-error
          onPaneContextMenu={handleRootContext}
          onSelectionContextMenu={(ev, nodes) => onSelectionContextMenu?.(ev, nodes)}
          onSelectionChange={handleSelectionChange} // TODO - somewhy calling 2 times. don't know why
          // onSelectionEnd={handleSelectionChange}
          onMoveStart={resetContexts}
          onMouseDown={resetContexts}
          onMoveEnd={handleMoveEnd}
          minZoom={0.2}
          maxZoom={1.5}
          elevateNodesOnSelect
          deleteKeyCode={['']}
          {...(isPanAndDrag
            ? {
                selectionOnDrag: true,
                panOnDrag: [2],
              }
            : {})}
          // TODO need create clear example with problem with that flag
          //  if system is not visible edge not drawing (and any render in Custom node is not happening)
          // onlyRenderVisibleElements
          selectionMode={SelectionMode.Partial}
        >
          {isShowMinimap && (
            <MiniMap pannable zoomable ariaLabel="Mini map" className={minimapClasses} position={minimapPlacement} />
          )}
          {isShowBackgroundPattern && <Background variant={variant} gap={gap} size={size} color={color} />}
        </ReactFlow>
        {/* <button className="z-auto btn btn-primary absolute top-20 right-20" onClick={handleGetPassages}>
          Test // DON NOT REMOVE
        </button> */}
      </div>

      <ContextMenuRoot {...rootCtxProps} onSaveLayout={isAutoLayoutEnabled && canSaveLayout ? saveLayout : undefined} />
      <ContextMenuConnection {...connectionCtxProps} />
    </>
  );
};

export type MapPropsType = Omit<MapCompProps, 'refn'>;

// TODO: INFO - this component needs for correct work map provider
// eslint-disable-next-line react/display-name
export const Map = forwardRef((props: MapPropsType, ref: ForwardedRef<MapHandlers>) => {
  return (
    <MapProvider onCommand={props.onCommand}>
      <MapComp refn={ref} {...props} />
    </MapProvider>
  );
});
