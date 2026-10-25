import { PrimeIcons } from 'primereact/api';
import { MenuItem } from 'primereact/menuitem';

/**
 * Whether `systemId` is shown as the auto-layout root. The root only anchors auto-layout, so it
 * is not marked while auto-layout is off — its menu entry is hidden then too, so a marker shown
 * then could not be cleared.
 */
export const isRootNode = (autoLayoutEnabled: boolean, rootSystemId: unknown, systemId: string | number): boolean =>
  autoLayoutEnabled && !!rootSystemId && String(rootSystemId) === String(systemId);

/** The system context menu's root toggle, offered to map admins while auto-layout is on. */
export const rootNodeMenuItems = ({
  canAdminMap,
  autoLayoutEnabled,
  rootSystemId,
  systemId,
  onToggle,
}: {
  canAdminMap: boolean;
  autoLayoutEnabled: boolean;
  rootSystemId: string | undefined;
  systemId: string;
  onToggle: () => void;
}): MenuItem[] =>
  canAdminMap && autoLayoutEnabled
    ? [
        {
          label: rootSystemId === systemId ? 'Unset root node' : 'Set as root node',
          icon: PrimeIcons.SITEMAP,
          command: onToggle,
        },
      ]
    : [];
