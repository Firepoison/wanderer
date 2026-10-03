import { useCallback, useRef } from 'react';
import { CommandUpdateOptions } from '@/hooks/Mapper/types/mapHandlers.ts';
import { useMapRootState } from '@/hooks/Mapper/mapRootProvider';

/**
 * Handles the incoming `update_options` command. The backend sends the full,
 * merged map options map, so we replace `data.options` wholesale.
 */
export const useMapUpdateOptions = () => {
  const { update } = useMapRootState();

  const ref = useRef({ update });
  ref.current = { update };

  return useCallback((options: CommandUpdateOptions) => {
    ref.current.update({ options });
  }, []);
};
