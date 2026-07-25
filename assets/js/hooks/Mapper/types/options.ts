import { UserPermission } from '@/hooks/Mapper/types/permissions.ts';

export type StringBoolean = 'true' | 'false';

export type MapOptions = {
  allowed_copy_for: UserPermission;
  allowed_paste_for: UserPermission;
  layout: string;
  restrict_offline_showing: StringBoolean;
  show_linked_signature_id: StringBoolean;
  show_linked_signature_id_temp_name: StringBoolean;
  show_temp_system_name: StringBoolean;
  store_custom_labels: StringBoolean;
  // Auto-layout (map-wide, admin-controlled). See map/layout/.
  auto_layout_enabled: StringBoolean;
  auto_layout_engine: string;
  /**
   * JSON: one option bag per engine, e.g. `{"dagre":{"direction":"LR",...}}`. The keys are
   * engine-specific vocabulary defined by WandererApp.Map.LayoutEngines, so this stays a string
   * here and is parsed by the engine that owns it.
   */
  auto_layout_options: string;
  root_system_id: string;
};
