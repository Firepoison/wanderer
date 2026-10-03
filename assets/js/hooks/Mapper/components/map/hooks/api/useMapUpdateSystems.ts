import { Node, useReactFlow } from 'reactflow';
import { useCallback, useRef } from 'react';
import { CommandUpdateSystems } from '@/hooks/Mapper/types/mapHandlers.ts';
import { convertSystem2Node } from '../../helpers/index.ts';
import { useMapState } from '@/hooks/Mapper/components/map/MapProvider.tsx';

export const useMapUpdateSystems = () => {
  const rf = useReactFlow();

  const {
    update,
    data: { systems },
  } = useMapState();

  const ref = useRef({ systems, update });
  ref.current = { systems, update };

  return useCallback(
    (systems: CommandUpdateSystems) => {
      // Lookup map rather than a `find` per node: a batched update (e.g. an auto-layout save)
      // carries most of the map's systems, which would make this O(nodes * systems).
      const byId = new Map(systems.map(s => [s.id, s]));
      const nodes = rf.getNodes();
      const prepared: Node[] = nodes.map(node => {
        const system = byId.get(node.id);

        if (system) {
          return {
            ...node,
            ...convertSystem2Node(system),
          };
        } else {
          return node;
        }
      });

      rf.setNodes(prepared);

      const out = ref.current.systems.map(current => {
        const newSystem = byId.get(current.id);
        if (!newSystem) {
          return current;
        }

        return newSystem;
      });

      update({ systems: out }, true);
    },
    [rf, update],
  );
};
