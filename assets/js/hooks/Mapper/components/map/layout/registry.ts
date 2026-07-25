import { LayoutEngine } from './types';
import { dagreEngine } from './engines/dagreEngine';

/**
 * Registry of available layout engines. To add another engine (e.g. an ELK-based radial
 * layout): implement `LayoutEngine`, import it here, add it to this map, and declare the
 * options it accepts in `WandererApp.Map.LayoutEngines` so the settings form can render them.
 * The orchestrator (`useAutoLayout`) needs no changes — it treats options as opaque.
 */
export const LAYOUT_ENGINES: Record<string, LayoutEngine> = {
  [dagreEngine.id]: dagreEngine,
};

export const DEFAULT_LAYOUT_ENGINE_ID = dagreEngine.id;

export const getLayoutEngine = (id: string | undefined | null): LayoutEngine =>
  (id ? LAYOUT_ENGINES[id] : undefined) ?? LAYOUT_ENGINES[DEFAULT_LAYOUT_ENGINE_ID];

export const listLayoutEngines = (): LayoutEngine[] => Object.values(LAYOUT_ENGINES);
