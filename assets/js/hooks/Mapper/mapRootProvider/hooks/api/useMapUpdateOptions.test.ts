import { renderHook } from '@testing-library/react';
import { useMapUpdateOptions } from './useMapUpdateOptions';

const mockUpdate = jest.fn();
jest.mock('@/hooks/Mapper/mapRootProvider', () => ({
  useMapRootState: () => ({ update: mockUpdate }),
}));

describe('useMapUpdateOptions', () => {
  it('replaces the map options wholesale with what the server sent', () => {
    const { result } = renderHook(() => useMapUpdateOptions());
    const options = { auto_layout_enabled: 'true', root_system_id: '31000448' };

    result.current(options as never);

    expect(mockUpdate).toHaveBeenCalledWith({ options });
  });
});
