import { act, renderHook } from '@testing-library/react';
import { StructureChange, useStructureChangeListener } from '@/hooks/Mapper/events';
import { SolarSystemRawType } from '@/hooks/Mapper/types';
import { OutCommand, OutCommandHandler } from '@/hooks/Mapper/types/mapHandlers.ts';
import { useContextMenuSystemHandlers } from './useContextMenuSystemHandlers';

jest.mock('@/hooks/Mapper/mapRootProvider', () => ({
  useMapRootState: () => ({ outCommand: jest.fn() }),
}));

const calls: string[] = [];
const outCommandMock = jest.fn((command: { type: string }) => {
  calls.push(`command:${command.type}`);
  return Promise.resolve();
});
const outCommand = outCommandMock as unknown as OutCommandHandler;

const systems = [
  { id: '1', locked: false },
  { id: '2', locked: true },
] as SolarSystemRawType[];

// Mounts a structure-change listener; `respond` lets it act like auto-layout (e.g. collect).
const listen = (respond: (change: StructureChange) => void = () => undefined) => {
  const changes: StructureChange[] = [];
  renderHook(() =>
    useStructureChangeListener(change => {
      changes.push(change);
      calls.push('structure-change');
      respond(change);
    }),
  );
  return changes;
};

const openOn = (systemId: string, rootSystemId = '') => {
  const hook = renderHook(() =>
    useContextMenuSystemHandlers({ systems, hubs: [], userHubs: [], outCommand, rootSystemId }),
  );
  act(() => hook.result.current.open({ preventDefault: () => undefined }, systemId));
  return hook;
};

beforeEach(() => {
  calls.length = 0;
  outCommandMock.mockClear();
});

describe('useContextMenuSystemHandlers', () => {
  describe('lock toggle', () => {
    it('announces the change before locking', () => {
      const changes = listen();
      const { result } = openOn('1');

      act(() => result.current.onLockToggle());

      expect(changes).toEqual([{ systemIds: ['1'], unlocking: false }]);
      expect(outCommandMock).toHaveBeenCalledWith({
        type: OutCommand.updateSystemLocked,
        data: { system_id: '1', value: true },
      });
      expect(calls).toEqual(['structure-change', `command:${OutCommand.updateSystemLocked}`]);
    });

    it('announces an unlock before sending it, flagged as one, so the clusters it joins stay put', () => {
      const changes = listen();
      const { result } = openOn('2');

      act(() => result.current.onLockToggle());

      expect(changes).toEqual([{ systemIds: ['2'], unlocking: true }]);
      expect(outCommandMock).toHaveBeenCalledWith({
        type: OutCommand.updateSystemLocked,
        data: { system_id: '2', value: false },
      });
      expect(calls).toEqual(['structure-change', `command:${OutCommand.updateSystemLocked}`]);
    });
  });

  describe('root toggle', () => {
    const collected = [{ solar_system_id: '1', position: { x: 10, y: 20 } }];

    it('collects the positions to save and sends them inside the admin-only root change', () => {
      const changes = listen(change => change.collect?.(collected));
      const { result } = openOn('1', '9');

      act(() => result.current.onSetRootToggle());

      expect(changes[0].systemIds).toEqual(['1', '9']);
      expect(outCommandMock).toHaveBeenCalledTimes(1);
      expect(outCommandMock).toHaveBeenCalledWith({
        type: OutCommand.updateLayoutSettings,
        data: { root_system_id: '1', positions: collected },
      });
    });

    it('clears the root when toggled on the root itself', () => {
      listen(change => change.collect?.([]));
      const { result } = openOn('9', '9');

      act(() => result.current.onSetRootToggle());

      expect(outCommandMock).toHaveBeenCalledWith({
        type: OutCommand.updateLayoutSettings,
        data: { root_system_id: '', positions: [] },
      });
    });

    it('announces only the new root when none was set', () => {
      const changes = listen();
      const { result } = openOn('1');

      act(() => result.current.onSetRootToggle());

      expect(changes[0].systemIds).toEqual(['1']);
      // Nobody collected anything, so the root change carries no positions.
      expect(outCommandMock).toHaveBeenCalledWith({
        type: OutCommand.updateLayoutSettings,
        data: { root_system_id: '1', positions: [] },
      });
    });
  });

  it('does nothing before a system was opened', () => {
    const changes = listen();
    const { result } = renderHook(() =>
      useContextMenuSystemHandlers({ systems, hubs: [], userHubs: [], outCommand, rootSystemId: '' }),
    );

    act(() => {
      result.current.onLockToggle();
      result.current.onSetRootToggle();
    });

    expect(changes).toEqual([]);
    expect(outCommandMock).not.toHaveBeenCalled();
  });
});
