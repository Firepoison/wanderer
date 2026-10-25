import { OutCommand } from '@/hooks/Mapper/types/mapHandlers.ts';
import { useMapRootState } from '@/hooks/Mapper/mapRootProvider';
import { emitStructureChange } from '@/hooks/Mapper/events';

export const useDeleteSystems = () => {
  const { outCommand } = useMapRootState();

  const deleteSystems = (systemIds: string[]) => {
    if (!systemIds || !systemIds.length) {
      return;
    }

    emitStructureChange({ systemIds, removing: true });
    outCommand({ type: OutCommand.deleteSystems, data: systemIds });
  };

  return {
    deleteSystems,
  };
};
