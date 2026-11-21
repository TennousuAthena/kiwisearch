// @vitest-environment happy-dom
import { mountSearchApp, type KiwiHost } from '@kiwi-search/app';
import { t } from '@kiwi-search/app/i18n';
import { flushSync } from 'react-dom';
import { expect, it, vi } from 'vitest';

it('keeps Quick Settings open for label activation, but dismisses it when focus moves outside', async () => {
  const save = vi.fn<KiwiHost['preferences']['save']>().mockResolvedValue(undefined);
  const host: KiwiHost = {
    connect: () => { throw new Error('Unexpected search'); },
    favicon: async () => null,
    focusWorker: () => {},
    domainPreference: async () => { throw new Error('Unexpected domain preference'); },
    undoDomainPreference: async () => false,
    preferences: { load: async () => ({ 'ui:theme': 'dark' }), save, subscribe: () => {} },
    academicLanguage: { load: async () => 'any', save: async () => {} },
    homeUrl: '/',
    optionsUrl: '/options',
    urlStyle: 'hash',
  };
  const container = document.body.appendChild(document.createElement('div'));
  const root = mountSearchApp(container, host);
  try {
    await vi.waitFor(() => expect(document.documentElement.dataset.theme).toBe('dark'));
    flushSync(() => container.querySelector<HTMLButtonElement>('.quick-settings > button')!.click());
    const panel = container.querySelector<HTMLElement>('[role="dialog"]')!;
    const light = [...panel.querySelectorAll<HTMLLabelElement>('label')].find((label) => label.textContent === t('ux.preferences.light'))!;
    const close = panel.querySelector('header button')!;
    expect(document.activeElement).toBe(close);

    flushSync(() => close.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: null })));
    expect(panel.isConnected).toBe(true);
    flushSync(() => light.click());
    await vi.waitFor(() => expect(document.documentElement.dataset.theme).toBe('light'));
    expect(save).toHaveBeenCalledWith({ 'ui:theme': 'light' });
    expect(panel.isConnected).toBe(true);

    flushSync(() => {
      light.querySelector('input')!.focus();
      container.querySelector<HTMLInputElement>('.searchbox input')!.focus();
    });
    expect(panel.isConnected).toBe(false);
  } finally {
    root.unmount();
    container.remove();
  }
});
