import { renderHook } from '@testing-library/react';
import { Node } from 'reactflow';
import { SolarSystemRawType } from '@/hooks/Mapper/types';
import { convertSystem2Node } from '../../helpers';
import { useMapUpdateSystems } from './useMapUpdateSystems';

const system = (id: string, x: number, locked = false) =>
  ({ id, position: { x, y: 0 }, locked, name: id }) as SolarSystemRawType;

const mockNodes: Node[] = [system('1', 0), system('2', 100), system('3', 200)].map(convertSystem2Node);
const mockSetNodes = jest.fn();
jest.mock('reactflow', () => ({
  ...jest.requireActual('reactflow'),
  useReactFlow: () => ({ getNodes: () => mockNodes, setNodes: mockSetNodes }),
}));

const mockUpdate = jest.fn();
const mockMapSystems = [system('1', 0), system('2', 100), system('3', 200)];
jest.mock('@/hooks/Mapper/components/map/MapProvider.tsx', () => ({
  useMapState: () => ({ update: mockUpdate, data: { systems: mockMapSystems } }),
}));

describe('useMapUpdateSystems', () => {
  it('applies a batch of server systems to the matching nodes only', () => {
    const { result } = renderHook(() => useMapUpdateSystems());
    const updates = [system('3', 900, true), system('1', 500), system('99', 0)];

    result.current(updates);

    const nodes: Node[] = mockSetNodes.mock.calls[0][0];
    expect(nodes.map(n => n.id)).toEqual(['1', '2', '3']);
    expect(nodes[0]).toMatchObject({ position: { x: 500, y: 0 }, data: updates[1] });
    expect(nodes[1]).toBe(mockNodes[1]);
    expect(nodes[2]).toMatchObject({ position: { x: 900, y: 0 }, draggable: false, data: updates[0] });

    expect(mockUpdate).toHaveBeenCalledWith({ systems: [updates[1], mockMapSystems[1], updates[0]] }, true);
  });
});
