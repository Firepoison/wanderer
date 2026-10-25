import { createEvent } from 'react-event-hook';

import { Command, CommandData } from '@/hooks/Mapper/types/mapHandlers.ts';
import { SystemPositionUpdate } from '@/hooks/Mapper/types/system.ts';

export interface MapEvent<T extends Command> {
  name: T;
  data: CommandData[T];
}

const { useMapEventListener, emitMapEvent } = createEvent('map-event')<MapEvent<Command>>();

export { useMapEventListener, emitMapEvent };

export interface StructureChange {
  /**
   * Systems whose place in the graph is about to change: locked or unlocked, deleted,
   * disconnected, made or unmade root.
   */
  systemIds: string[];
  /** The systems themselves are being deleted. */
  removing?: boolean;
  /** The systems are being unlocked, so they rejoin the layout. */
  unlocking?: boolean;
  /**
   * Receives the positions to save instead of auto-layout sending them, so the caller can put
   * them in its own command and have the save and the change succeed or fail together.
   */
  collect?: (positions: SystemPositionUpdate[]) => void;
}

/**
 * Emit right before this client sends a change that reshapes the map's graph around
 * `systemIds`. Auto-layout listens and first saves the displayed positions of the clusters
 * involved, and of their neighbours' clusters, so the systems that leave the layout and each
 * cluster's anchor stay where they are drawn when the change lands; the rest of a reshaped
 * cluster is laid out afresh around its anchor. Listeners run synchronously, so that save is
 * sent (or collected) before the change itself.
 */
const { useStructureChangeListener, emitStructureChange } = createEvent('structure-change')<StructureChange>();

export { useStructureChangeListener, emitStructureChange };
