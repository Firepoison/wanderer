import { LayoutEngine } from './types';
import { dagreEngine } from './engines/dagreEngine';

/**
 * Registry of available layout engines. To add another engine (e.g. an ELK-based radial
 * layout): implement `LayoutEngine`, import it here, add it to this map, and declare the
 * options it accepts in `WandererApp.Map.LayoutEngines` so the settings form can render them.
 * The orchestrator (`useAutoLayout`) needs no changes — it treats options as opaque.
 *
 * A Map rather than an object literal, so a stored engine id like "constructor" can't resolve
 * to something on Object.prototype.
 */
const LAYOUT_ENGINES = new Map<string, LayoutEngine>([[dagreEngine.id, dagreEngine]]);

export const getLayoutEngine = (id: string | undefined | null): LayoutEngine =>
  (id ? LAYOUT_ENGINES.get(id) : undefined) ?? dagreEngine;
