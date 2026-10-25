import { renderHook } from '@testing-library/react';
import { MapEvent, useMapEventListener } from '@/hooks/Mapper/events';
import { Command, Commands } from '@/hooks/Mapper/types/mapHandlers.ts';
import { SolarSystemRawType } from '@/hooks/Mapper/types';
import { useCommandsSystems } from './useCommandsSystems';

const mockUpdate = jest.fn();
const mockSystems = [
  { id: '1', name: 'one' },
  { id: '2', name: 'two' },
  { id: '3', name: 'three' },
] as SolarSystemRawType[];
jest.mock('@/hooks/Mapper/mapRootProvider', () => ({
  useMapRootState: () => ({
    update: mockUpdate,
    data: { systems: mockSystems, systemSignatures: {}, detailedKills: {} },
    outCommand: jest.fn(),
  }),
}));
jest.mock('@/hooks/Mapper/mapRootProvider/hooks/useLoadSystemStatic.ts', () => ({
  useLoadSystemStatic: () => ({ addSystemStatic: jest.fn() }),
}));

describe('useCommandsSystems.updateSystems', () => {
  it('replaces updated systems by id, keeps the rest and their order, and passes the result on', () => {
    const events: MapEvent<Command>[] = [];
    renderHook(() => useMapEventListener(event => events.push(event)));
    const { result } = renderHook(() => useCommandsSystems());
    const updated = [
      { id: '3', name: 'three, renamed' },
      { id: '1', name: 'one, renamed' },
      { id: '99', name: 'not on the map' },
    ] as SolarSystemRawType[];

    result.current.updateSystems(updated);

    const expected = [updated[1], mockSystems[1], updated[0]];
    expect(mockUpdate).toHaveBeenCalledWith({ systems: expected }, true);
    expect(events).toEqual([{ name: Commands.updateSystems, data: expected }]);
    expect(mockUpdate.mock.calls[0][0].systems[1]).toBe(mockSystems[1]);
  });
});
