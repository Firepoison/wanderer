import { PrimeIcons } from 'primereact/api';
import { isRootNode, rootNodeMenuItems } from './rootNode';

describe('isRootNode', () => {
  it('marks the root, comparing ids as strings', () => {
    expect(isRootNode(true, '31000448', 31000448)).toBe(true);
    expect(isRootNode(true, 31000448, '31000448')).toBe(true);
  });

  it.each<[string, boolean, unknown, string]>([
    ['auto-layout is off', false, '1', '1'],
    ['no root is set', true, '', '1'],
    ['no root option at all', true, undefined, '1'],
    ['it is another system', true, '2', '1'],
  ])('does not mark a system when %s', (_, enabled, rootId, systemId) => {
    expect(isRootNode(enabled, rootId, systemId)).toBe(false);
  });
});

describe('rootNodeMenuItems', () => {
  const onToggle = jest.fn();
  const items = (overrides: Partial<Parameters<typeof rootNodeMenuItems>[0]> = {}) =>
    rootNodeMenuItems({
      canAdminMap: true,
      autoLayoutEnabled: true,
      rootSystemId: '1',
      systemId: '2',
      onToggle,
      ...overrides,
    });

  it('offers "Set as root node" on another system', () => {
    expect(items()).toEqual([{ label: 'Set as root node', icon: PrimeIcons.SITEMAP, command: onToggle }]);
  });

  it('offers "Unset root node" on the root', () => {
    expect(items({ systemId: '1' })[0].label).toBe('Unset root node');
  });

  it('offers it when no root is set yet', () => {
    expect(items({ rootSystemId: undefined })[0].label).toBe('Set as root node');
  });

  it.each([
    ['non-admins', { canAdminMap: false }],
    ['anyone while auto-layout is off', { autoLayoutEnabled: false }],
  ])('offers nothing to %s', (_, overrides) => {
    expect(items(overrides)).toEqual([]);
  });
});
