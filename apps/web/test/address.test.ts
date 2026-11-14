import { describe, expect, it, vi } from 'vitest';
import { dropQueryString } from '../src/address';

const win = (search: string, hash = '') => ({ location: { search, pathname: '/', hash }, history: { replaceState: vi.fn() } });

describe('a query string on the search page', () => {
  it('is dropped, and the fragment is kept', () => {
    const w = win('?q=hello&m=news', '#q=other');
    expect(dropQueryString(w)).toBe(true);
    expect(w.history.replaceState).toHaveBeenCalledWith(null, '', '/#q=other');
  });

  it('leaves an address without one alone', () => {
    const w = win('', '#q=x');
    expect(dropQueryString(w)).toBe(false);
    expect(w.history.replaceState).not.toHaveBeenCalled();
  });
});
