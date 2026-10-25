import { act, renderHook } from '@testing-library/react';
import { Edge } from 'reactflow';
import { StructureChange, useStructureChangeListener } from '@/hooks/Mapper/events';
import { SolarSystemConnection } from '@/hooks/Mapper/types';
import { OutCommand } from '@/hooks/Mapper/types/mapHandlers.ts';
import { useContextMenuConnectionHandlers } from './useContextMenuConnectionHandlers';

const mockCalls: string[] = [];
const mockOutCommand = jest.fn((command: { type: string }) => {
  mockCalls.push(`command:${command.type}`);
  return Promise.resolve();
});
jest.mock('@/hooks/Mapper/components/map/MapProvider.tsx', () => ({
  useMapState: () => ({ outCommand: mockOutCommand }),
}));

const connection = { id: '1_2', source: '1', target: '2', data: {} } as Edge<SolarSystemConnection>;

describe('useContextMenuConnectionHandlers', () => {
  beforeEach(() => {
    mockCalls.length = 0;
    mockOutCommand.mockClear();
  });

  it('announces the disconnection of both systems before deleting the connection', () => {
    const changes: StructureChange[] = [];
    renderHook(() =>
      useStructureChangeListener(change => {
        changes.push(change);
        mockCalls.push('structure-change');
      }),
    );
    const { result } = renderHook(() => useContextMenuConnectionHandlers());

    act(() => result.current.handleConnectionContext({ preventDefault: () => undefined } as never, connection));
    act(() => result.current.onDeleteConnection());

    expect(changes).toEqual([{ systemIds: ['1', '2'] }]);
    expect(mockOutCommand).toHaveBeenCalledWith({
      type: OutCommand.manualDeleteConnection,
      data: { source: '1', target: '2' },
    });
    expect(mockCalls).toEqual(['structure-change', `command:${OutCommand.manualDeleteConnection}`]);
  });

  it('does nothing without a selected connection', () => {
    const { result } = renderHook(() => useContextMenuConnectionHandlers());

    act(() => result.current.onDeleteConnection());

    expect(mockOutCommand).not.toHaveBeenCalled();
  });
});
