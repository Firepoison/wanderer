import { renderHook } from '@testing-library/react';
import { StructureChange, useStructureChangeListener } from '@/hooks/Mapper/events';
import { OutCommand } from '@/hooks/Mapper/types/mapHandlers.ts';
import { useDeleteSystems } from './useDeleteSystems';

const mockCalls: string[] = [];
const mockOutCommand = jest.fn((command: { type: string }) => {
  mockCalls.push(`command:${command.type}`);
  return Promise.resolve();
});
jest.mock('@/hooks/Mapper/mapRootProvider', () => ({
  useMapRootState: () => ({ outCommand: mockOutCommand }),
}));

const listen = () => {
  const changes: StructureChange[] = [];
  renderHook(() =>
    useStructureChangeListener(change => {
      changes.push(change);
      mockCalls.push('structure-change');
    }),
  );
  return changes;
};

beforeEach(() => {
  mockCalls.length = 0;
  mockOutCommand.mockClear();
});

describe('useDeleteSystems', () => {
  it('announces the removal so auto-layout can save first, then deletes', () => {
    const changes = listen();
    const { result } = renderHook(() => useDeleteSystems());

    result.current.deleteSystems(['1', '2']);

    expect(changes).toEqual([{ systemIds: ['1', '2'], removing: true }]);
    expect(mockOutCommand).toHaveBeenCalledWith({ type: OutCommand.deleteSystems, data: ['1', '2'] });
    expect(mockCalls).toEqual(['structure-change', `command:${OutCommand.deleteSystems}`]);
  });

  it('does nothing for an empty selection', () => {
    const changes = listen();
    const { result } = renderHook(() => useDeleteSystems());

    result.current.deleteSystems([]);

    expect(changes).toEqual([]);
    expect(mockOutCommand).not.toHaveBeenCalled();
  });
});
