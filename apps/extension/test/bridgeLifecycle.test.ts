import { describe, expect, it, vi } from 'vitest';
import { createBridgeLifecycle } from '../lib/bridgeLifecycle';

describe('a page that goes away and comes back', () => {
  const setup = () => { const closeAll = vi.fn(); const restorePush = vi.fn(); return { closeAll, restorePush, lifecycle: createBridgeLifecycle({ closeAll, restorePush }) }; };

  it('closes the link when the page is really going away', () => {
    const { lifecycle, closeAll } = setup();
    lifecycle.pagehide(false);
    expect(closeAll).toHaveBeenCalledTimes(1);
  });

  it('keeps the link when the page is only cached for Back, and starts the push port again when it returns', () => {
    const { lifecycle, closeAll, restorePush } = setup();
    lifecycle.pagehide(true);
    expect(closeAll).not.toHaveBeenCalled();
    lifecycle.pageshow(true);
    expect(restorePush).toHaveBeenCalledTimes(1);
  });

  it('does nothing when a page is shown for the first time', () => {
    const { lifecycle, closeAll, restorePush } = setup();
    lifecycle.pageshow(false);
    expect(closeAll).not.toHaveBeenCalled();
    expect(restorePush).not.toHaveBeenCalled();
  });
});
