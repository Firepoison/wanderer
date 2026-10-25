import { fireEvent, render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { ContextMenu } from 'primereact/contextmenu';
import { ContextMenuRoot } from './ContextMenuRoot';

// Renders the menu model as buttons, so the test sees which items the menu would offer.
jest.mock('primereact/contextmenu', () => {
  const React = jest.requireActual('react');
  const ContextMenu = React.forwardRef(
    ({ model }: { model: { label?: string; command?: () => void }[] }, ref: unknown) =>
      React.createElement(
        'ul',
        { ref },
        model
          .filter(item => item.label)
          .map(item =>
            React.createElement(
              'li',
              { key: item.label },
              React.createElement('button', { onClick: () => item.command?.() }, item.label),
            ),
          ),
      ),
  );
  ContextMenu.displayName = 'ContextMenu';
  return { ContextMenu };
});

// The real ui-kit index pulls in most of the app through a circular import chain that Vite's ESM
// tolerates but Jest's CommonJS does not; the menu only uses these two in its Paste item.
jest.mock('@/hooks/Mapper/components/ui-kit', () => ({
  MenuItemWithInfo: () => null,
  WdMenuItem: () => null,
}));

jest.mock('@/hooks/Mapper/components/map/MapProvider.tsx', () => ({
  useMapState: () => ({ data: { options: { allowed_paste_for: 'add_system' }, userPermissions: {} } }),
}));

const renderMenu = (onSaveLayout?: () => void) =>
  render(
    <ContextMenuRoot
      contextMenuRef={createRef<ContextMenu>()}
      pasteSystemsAndConnections={undefined}
      onAddSystem={jest.fn()}
      onPasteSystemsAnsConnections={jest.fn()}
      onSaveLayout={onSaveLayout}
    />,
  );

describe('ContextMenuRoot', () => {
  it('offers "Save Layout Positions" when given a handler, and calls it', () => {
    const onSaveLayout = jest.fn();
    renderMenu(onSaveLayout);

    fireEvent.click(screen.getByText('Save Layout Positions'));

    expect(onSaveLayout).toHaveBeenCalledTimes(1);
  });

  it('leaves it out otherwise (auto-layout off, or not a map admin)', () => {
    renderMenu();

    expect(screen.queryByText('Save Layout Positions')).toBeNull();
    expect(screen.getByText('Add System')).toBeTruthy();
  });
});
