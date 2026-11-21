// @vitest-environment happy-dom
import { mountSearchApp, type KiwiHost } from '@kiwi-search/app';
import { t } from '@kiwi-search/app/i18n';
import { flushSync } from 'react-dom';
import { afterEach, expect, it, vi } from 'vitest';

const connect = vi.fn<KiwiHost['connect']>();
const postMessage = vi.fn();
const host: KiwiHost = {
  connect,
  favicon: async () => null,
  focusWorker: () => {},
  domainPreference: async () => { throw new Error('Unexpected domain preference'); },
  undoDomainPreference: async () => false,
  preferences: { load: async () => ({}), save: async () => {}, subscribe: () => {} },
  academicLanguage: { load: async () => 'any', save: async () => {} },
  homeUrl: '/',
  optionsUrl: '/options',
  urlStyle: 'hash',
};
let root: ReturnType<typeof mountSearchApp> | undefined;
const container = document.createElement('div');

afterEach(() => {
  root?.unmount();
  root = undefined;
  container.remove();
  window.history.replaceState(null, '', '/');
  vi.restoreAllMocks();
  connect.mockReset();
  postMessage.mockReset();
});

const mount = () => {
  document.body.append(container);
  flushSync(() => { root = mountSearchApp(container, host); });
};
const button = (label: string) => {
  const control = [...container.querySelectorAll('button')].find((item) => item.textContent?.trim() === label);
  expect(control, label).toBeDefined();
  flushSync(() => control!.click());
};
const input = () => container.querySelector<HTMLInputElement>('.searchbox input')!;
const expired = () => expect(container.querySelector('.empty h3')?.textContent).toBe(t('ux.history.expired'));

it('keeps the committed query through filter and mode changes after an academic snapshot expires', async () => {
  const year = new Date().getFullYear() - 4;
  window.history.replaceState({ kiwiEntry: 'expired' }, '', '/#m=academic&q=NASA');
  const navigation = vi.spyOn(performance, 'getEntriesByType').mockReturnValue([{ type: 'back_forward' } as PerformanceNavigationTiming]);
  mount();
  await vi.waitFor(expired);

  const draft = 'unsubmitted draft';
  flushSync(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input(), draft);
    input().dispatchEvent(new Event('input', { bubbles: true }));
  });
  button(t('newtab.app.sinceYear', { year }));
  expect(location.hash).toBe(`#m=academic&since=${year}&q=NASA`);
  expect(input().value).toBe(draft);
  button(t('newtab.app.sortByCitations'));
  expect(location.hash).toBe(`#m=academic&since=${year}&paperSort=citations&q=NASA`);
  button(t('mode.news'));
  expect(location.hash).toBe('#m=news&q=NASA');
  button(t('newtab.news.range.week'));
  expect(location.hash).toBe('#m=news&range=week&q=NASA');
  button(t('newtab.news.sort.date'));
  expect(location.hash).toBe('#m=news&range=week&sort=date&q=NASA');
  expired();
  expect(connect).not.toHaveBeenCalled();

  root?.unmount();
  navigation.mockReturnValue([{ type: 'reload' } as PerformanceNavigationTiming]);
  connect.mockReturnValue({ postMessage, disconnect: () => {}, onMessage: { addListener: () => {} }, onDisconnect: { addListener: () => {} } });
  mount();
  await vi.waitFor(() => expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ query: 'NASA', mode: 'news', news: { range: 'week', sort: 'date' } })));
  expect(input().value).toBe('NASA');
});
