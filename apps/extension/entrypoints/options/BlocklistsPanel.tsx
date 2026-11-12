import { RECOMMENDED_BLOCKLISTS, isSubscriptionUrl, parseBlocklist, type BlocklistSettings, type BlocklistSubscription, type FusionConfig } from '@kiwi-search/core';
import { useDeferredValue, useMemo, useState } from 'react';
import { browser } from 'wxt/browser';
import { blocklistStatus, describeCustomRules, type BlocklistMetaMap } from '@/lib/blocklistState';
import { raw, t } from '@/lib/i18n';
import { CloseIcon } from '@/lib/icons';
import { Field, Switch } from './controls';

interface Props {
  config: FusionConfig;
  meta: BlocklistMetaMap;
  onChange: (update: (config: FusionConfig) => FusionConfig) => void;
}

const addressOf = (sub: BlocklistSubscription) => {
  try {
    return new URL(sub.url).hostname;
  } catch {
    return sub.url;
  }
};

function ListStatus({ meta, now }: { meta: BlocklistMetaMap[string]; now: number }) {
  const status = blocklistStatus(meta, now);
  return (
    <span className={`list-status ${status.tone}`} role="status">
      {status.text}
    </span>
  );
}

/** Subscribe to someone else's list by address. Only https goes out (plain http for a list served from this machine). */
function AddSubscription({ taken, onAdd }: { taken: string[]; onAdd: (sub: BlocklistSubscription) => void }) {
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [problem, setProblem] = useState('');
  function submit() {
    const address = url.trim();
    if (!address) return;
    if (!isSubscriptionUrl(address)) return setProblem(t('options.blocklist.urlNeedsHttps'));
    if (taken.includes(address)) return setProblem(t('options.blocklist.alreadySubscribed'));
    onAdd({ id: `custom-${crypto.randomUUID().slice(0, 8)}`, name: name.trim(), url: address, enabled: true });
    setName('');
    setUrl('');
    setProblem('');
  }
  const enter = (event: React.KeyboardEvent) => {
    if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  };
  return (
    <div className="card-body flat">
      <span className="card-title">{t('options.blocklist.addTitle')}</span>
      <div className="field-grid">
        <Field label={t('options.blocklist.nameLabel')}>
          <input value={name} placeholder={t('options.blocklist.namePlaceholder')} onChange={(event) => setName(event.target.value)} onKeyDown={enter} />
        </Field>
        <Field label={t('options.blocklist.urlLabel')} hint={problem && <span className="problem" role="alert">{problem}</span>}>
          <input type="url" value={url} placeholder="https://example.com/blocklist.txt" onChange={(event) => setUrl(event.target.value)} onKeyDown={enter} />
        </Field>
      </div>
      <div>
        <button type="button" className="btn" disabled={!url.trim()} onClick={submit}>
          {t('options.blocklist.subscribe')}
        </button>
      </div>
    </div>
  );
}

/** Subscribed block lists, the user's own, and the rules text. Everything here works without any key. */
export function BlocklistsPanel({ config, meta, onChange }: Props) {
  const lists = config.judge.blocklists;
  const update = (change: (current: BlocklistSettings) => BlocklistSettings) =>
    onChange((current) => ({ ...current, judge: { ...current.judge, blocklists: change(current.judge.blocklists) } }));
  const [refreshing, setRefreshing] = useState(false);
  const now = Date.now();

  const subscribed = lists.recommended.length + lists.subscriptions.filter((sub) => sub.enabled).length;
  const setRecommended = (id: string, on: boolean) =>
    update((current) => ({ ...current, recommended: on ? [...new Set([...current.recommended, id])] : current.recommended.filter((entry) => entry !== id) }));
  const setSubscription = (id: string, patch: Partial<BlocklistSubscription>) =>
    update((current) => ({ ...current, subscriptions: current.subscriptions.map((sub) => (sub.id === id ? { ...sub, ...patch } : sub)) }));

  async function refreshNow() {
    setRefreshing(true);
    try {
      await browser.runtime.sendMessage({ type: 'kiwi:blocklist-refresh' });
    } finally {
      setRefreshing(false);
    }
  }

  // Counting a pasted list on every key would stall typing in a large one.
  const deferredText = useDeferredValue(lists.custom);
  const summary = useMemo(() => describeCustomRules(parseBlocklist(deferredText).stats), [deferredText]);
  const takenUrls = [...RECOMMENDED_BLOCKLISTS.map((entry) => entry.url), ...lists.subscriptions.map((sub) => sub.url.trim())];

  return (
    <div className="group">
      <div className="group-head">
        <h3>{t('options.blocklist.title')}</h3>
        <span className="count">{t('options.blocklist.subscribedCount', { count: subscribed })}</span>
        <div className="presets">
          <button type="button" className="btn small" disabled={!subscribed || refreshing} onClick={() => void refreshNow()}>
            {refreshing ? t('options.blocklist.refreshing') : t('options.blocklist.refreshNow')}
          </button>
        </div>
      </div>
      <p className="note">{t('options.blocklist.note')}</p>
      <p className="note">{t('options.blocklist.noteMistakes')}</p>
      <ul className="sources">
        {RECOMMENDED_BLOCKLISTS.map((entry) => {
          const on = lists.recommended.includes(entry.id);
          return (
            <li key={entry.id} className={on ? 'source on' : 'source'}>
              <div className="source-main">
                <Switch checked={on} label={entry.name} onChange={(next) => setRecommended(entry.id, next)} />
                <div className="source-name">
                  <strong>{entry.name}</strong>
                  <span>{t(`options.blocklist.recommended.${entry.id}`)}</span>
                  {on && <ListStatus meta={meta[entry.id]} now={now} />}
                </div>
                <div className="source-side">
                  <span className="license">{entry.license}</span>
                  <a className="link-btn" href={entry.homepage} target="_blank" rel="noreferrer">
                    {t('options.blocklist.homepage')}
                  </a>
                </div>
              </div>
            </li>
          );
        })}
        {lists.subscriptions.map((sub) => (
          <li key={sub.id} className={sub.enabled ? 'source on' : 'source'}>
            <div className="source-main">
              <Switch checked={sub.enabled} label={sub.name || addressOf(sub)} onChange={(next) => setSubscription(sub.id, { enabled: next })} />
              <div className="source-name">
                <strong>{sub.name.trim() || addressOf(sub)}</strong>
                <span className="list-url">{sub.url}</span>
                {sub.enabled && (isSubscriptionUrl(sub.url) ? <ListStatus meta={meta[sub.id]} now={now} /> : <span className="list-status bad">{t('options.blocklist.badUrl')}</span>)}
              </div>
              <div className="source-side">
                <button type="button" className="icon-btn small" aria-label={t('options.blocklist.removeSubscription', { name: sub.name.trim() || addressOf(sub) })} onClick={() => update((current) => ({ ...current, subscriptions: current.subscriptions.filter((entry) => entry.id !== sub.id) }))}>
                  <CloseIcon />
                </button>
              </div>
            </div>
          </li>
        ))}
      </ul>
      <div className="card">
        <AddSubscription taken={takenUrls} onAdd={(sub) => update((current) => ({ ...current, subscriptions: [...current.subscriptions, sub] }))} />
      </div>
      <div className="card">
        <div className="card-body flat">
          <Field
            label={t('options.blocklist.customLabel')}
            wide
            hint={summary || t('options.blocklist.customHint')}
          >
            <textarea
              className="rules-text"
              rows={7}
              spellCheck={false}
              maxLength={500_000}
              value={lists.custom}
              placeholder={'spam-site.com\n*://*.content-farm.net/*\n||example.org^\n@@||docs.example.org^'}
              onChange={(event) => update((current) => ({ ...current, custom: event.target.value }))}
            />
          </Field>
          <details className="inline-details">
            <summary>{t('options.blocklist.syntaxSummary')}</summary>
            <pre className="protocol">{raw('options.blocklist.syntax.raw')}</pre>
            <p className="note">{t('options.blocklist.syntaxNote')}</p>
          </details>
        </div>
      </div>
    </div>
  );
}
