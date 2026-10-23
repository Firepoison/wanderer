import { createEvent } from 'react-event-hook';

import { Command, CommandData } from '@/hooks/Mapper/types/mapHandlers.ts';

export interface MapEvent<T extends Command> {
  name: T;
  data: CommandData[T];
}

const { useMapEventListener, emitMapEvent } = createEvent('map-event')<MapEvent<Command>>();

export { useMapEventListener, emitMapEvent };

export interface StructureChange {
  /** Systems whose connections are about to change: locked, deleted, disconnected, made root. */
  systemIds: string[];
  /** The systems themselves are being deleted. */
  removing?: boolean;
}

/**
 * Emit right before this client sends a change that reshapes the map's graph around
 * `systemIds`. Auto-layout listens and first saves the displayed positions of the clusters
 * involved, so nothing jumps when the change lands. Listeners run synchronously, so that save is
 * sent before the change itself.
 */
const { useStructureChangeListener, emitStructureChange } = createEvent('structure-change')<StructureChange>();

export { useStructureChangeListener, emitStructureChange };
