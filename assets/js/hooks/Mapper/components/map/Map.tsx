import { NodeSelectionMouseHandler } from '@/hooks/Mapper/components/contexts/types.ts';
import { PingData, SolarSystemConnection, SolarSystemRawType } from '@/hooks/Mapper/types';
import { MapHandlers, OutCommand, OutCommandHandler } from '@/hooks/Mapper/types/mapHandlers.ts';
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
  XYPosition,
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
  const { getCluster, beginDrag, endDrag } = useAutoLayout({ nodes, edges, setNodes, onCommand });

  // Authoritative node state for the drag handlers. React Flow's own store (`getNodes()`) lags
  // the controlled `nodes` prop by a committed render, so reading positions from it mid-drag
  // yields the previous frame's values.
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;

  // While auto-layout is on, dragging any node in a connected cluster moves the whole tree
  // together (its relative shape is preserved). Holds the grabbed node + each cluster member's
  // start position for the duration of a drag.
  // Record (not Map) — the exported `Map` component below shadows the global Map constructor.
  const clusterDragRef = useRef<{ nodeId: string; members: string[]; start: Record<string, XYPosition> } | null>(null);

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

  const handleNodeDragStart: NodeDragHandler = useCallback(
    (_, node) => {
      beginDrag();
      const members = getCluster(node.id);
      if (members && members.length > 1) {
        // Single pass over the nodes with a membership set — a `find` per member would be
        // O(members * nodes), and for auto-layout maps most nodes are in one cluster.
        const memberSet = new Set(members);
        const start: Record<string, XYPosition> = {};
        nodesRef.current.forEach(n => {
          if (memberSet.has(n.id)) {
            start[n.id] = { x: n.position.x, y: n.position.y };
          }
        });
        clusterDragRef.current = { nodeId: node.id, members, start };
      } else {
        clusterDragRef.current = null;
      }
    },
    [getCluster, beginDrag],
  );

  const handleNodeDrag: NodeDragHandler = useCallback(
    (_, node) => {
      const drag = clusterDragRef.current;
      if (!drag || drag.nodeId !== node.id) {
        return;
      }
      const origin = drag.start[node.id];
      if (!origin) {
        return;
      }
      // Move the whole tree rigidly. This goes through the controlled state setter, so it is
      // queued *after* React Flow's own position change for the grabbed node and composes with
      // it; re-asserting the grabbed node's position below is then a no-op in the common case,
      // and a safety net if the ordering ever changes.
      const dx = node.position.x - origin.x;
      const dy = node.position.y - origin.y;
      setNodes(nds =>
        nds.map(n => {
          if (n.id === node.id) {
            if (n.position.x === node.position.x && n.position.y === node.position.y) {
              return n;
            }
            return { ...n, position: { x: node.position.x, y: node.position.y } };
          }
          const s = drag.start[n.id];
          if (!s) {
            return n;
          }
          const x = s.x + dx;
          const y = s.y + dy;
          if (n.position.x === x && n.position.y === y) {
            return n;
          }
          return { ...n, position: { x, y } };
        }),
      );
    },
    [setNodes],
  );

  const handleDragStop: NodeDragHandler = useCallback(
    (_, node) => {
      const drag = clusterDragRef.current;
      if (drag && drag.nodeId === node.id) {
        clusterDragRef.current = null;
        const origin = drag.start[node.id];
        const dx = origin ? node.position.x - origin.x : 0;
        const dy = origin ? node.position.y - origin.y : 0;
        // Derive the final positions from the recorded start positions and the grabbed node's
        // total delta — exactly the transform handleNodeDrag applied. Reading them back from
        // React Flow's store instead would pick up the previous frame's coordinates and snap
        // the cluster backwards.
        const data = drag.members
          .filter(id => drag.start[id])
          .map(id => ({
            solar_system_id: id,
            position: { x: drag.start[id].x + dx, y: drag.start[id].y + dy },
          }));
        onCommand({ type: OutCommand.updateSystemPositions, data });
      } else {
        onCommand({
          type: OutCommand.updateSystemPosition,
          data: { solar_system_id: node.id, position: node.position },
        });
      }
      endDrag();
    },
    [onCommand, endDrag],
  );

  const handleSelectionDragStop: SelectionDragHandler = useCallback(
    (_, nodes) => {
      setTimeout(() => {
        onCommand({
          type: OutCommand.updateSystemPositions,
          data: nodes.map(x => ({ solar_system_id: x.id, position: x.position })),
        });
        endDrag();
      }, 500);
    },
    [onCommand, endDrag],
  );

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
          onNodeDragStop={handleDragStop}
          onSelectionDragStart={beginDrag}
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

      <ContextMenuRoot {...rootCtxProps} />
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
