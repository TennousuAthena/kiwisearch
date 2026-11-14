import { describe, expect, it } from 'vitest';
import { isExtensionPageSender } from '../lib/summaryRequest';
describe('summary port boundaries', () => {
  it('accepts only this extension page identity, including URL query/hash', () => {
    expect(isExtensionPageSender({ id: 'own', url: 'chrome-extension://own/app.html?q=x#cite' }, 'own', 'chrome-extension://own/')).toBe(true);
    for (const url of ['https://example.com/app.html', 'chrome-extension://other/app.html', 'chrome-extension://own/content.js']) expect(isExtensionPageSender({ id: 'own', url }, 'own', 'chrome-extension://own/')).toBe(false);
    expect(isExtensionPageSender({ id: 'other', url: 'chrome-extension://own/app.html' }, 'own', 'chrome-extension://own/')).toBe(false);
  });
});
