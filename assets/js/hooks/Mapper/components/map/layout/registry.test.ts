import { dagreEngine } from './engines/dagreEngine';
import { getLayoutEngine } from './registry';

describe('getLayoutEngine', () => {
  it('returns the engine registered under the id', () => {
    expect(getLayoutEngine('dagre')).toBe(dagreEngine);
  });

  it.each([null, undefined, '', 'unknown'])('falls back to dagre for %p', id => {
    expect(getLayoutEngine(id)).toBe(dagreEngine);
  });

  it.each(['constructor', 'toString', '__proto__', 'hasOwnProperty'])(
    'does not resolve Object.prototype keys such as %p',
    id => {
      expect(getLayoutEngine(id)).toBe(dagreEngine);
    },
  );
});
