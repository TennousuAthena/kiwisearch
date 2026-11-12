import { RECOMMENDED_BLOCKLISTS, isSubscriptionUrl, parseBlocklist, type BlocklistSettings, type BlocklistSubscription, type FusionConfig } from '@kiwi-search/core';
import { useDeferredValue, useMemo, useState } from 'react';
import { browser } from 'wxt/browser';
import { blocklistStatus, describeCustomRules, type BlocklistMetaMap } from '@/lib/blocklistState';
import { CloseIcon } from '@/lib/icons';
import { Field, Switch } from './controls';

interface Props {
  config: FusionConfig;
  meta: BlocklistMetaMap;
  onChange: (update: (config: FusionConfig) => FusionConfig) => void;
}

const SYNTAX = `example.com                  这个网站和它的所有子域名（*.example.com 也一样）
example.com/blog             只屏蔽网站里的这个栏目
0.0.0.0 example.com          hosts 文件的写法
||example.com^               uBlock Origin / Adblock Plus 网络规则（可带 $doc）
*://*.example.com/*          uBlacklist 匹配模式，带 *. 的包含子域名
*://example.com/blog/*       只屏蔽某个栏目；不带 *. 的只指这一个域名
/blog\\.example\\.com\\/alice/  正则：必须写出网站名
@@||example.com^             例外：不屏蔽它，对所有列表都有效
@*://docs.example.com/*      例外的 uBlacklist 写法
# 注释  或  ! 注释`;

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
    if (!isSubscriptionUrl(address)) return setProblem('地址要以 https:// 开头（本机上的服务可以用 http://localhost）');
    if (taken.includes(address)) return setProblem('这个列表已经订阅了');
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
      <span className="card-title">用地址订阅别的列表</span>
      <div className="field-grid">
        <Field label="名称（可选）">
          <input value={name} placeholder="显示在被折叠的结果上" onChange={(event) => setName(event.target.value)} onKeyDown={enter} />
        </Field>
        <Field label="列表地址" hint={problem && <span className="problem" role="alert">{problem}</span>}>
          <input type="url" value={url} placeholder="https://example.com/blocklist.txt" onChange={(event) => setUrl(event.target.value)} onKeyDown={enter} />
        </Field>
      </div>
      <div>
        <button type="button" className="btn" disabled={!url.trim()} onClick={submit}>
          订阅
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
        <h3>屏蔽列表</h3>
        <span className="count">已订阅 {subscribed}</span>
        <div className="presets">
          <button type="button" className="btn small" disabled={!subscribed || refreshing} onClick={() => void refreshNow()}>
            {refreshing ? '更新中…' : '立即更新'}
          </button>
        </div>
      </div>
      <p className="note">
        订阅别人维护的内容农场、垃圾站名单，命中的结果会折叠到页面底部，并写明是哪个列表。名单由你的浏览器直接从来源下载（不带 Cookie，也不会告诉对方你搜了什么），每天最多更新一次。第三方名单难免误伤，展开折叠的结果就能看到；想放行某个网站，把它放进下面的「优先显示」，或在自定义规则里写一条例外。
      </p>
      <ul className="sources">
        {RECOMMENDED_BLOCKLISTS.map((entry) => {
          const on = lists.recommended.includes(entry.id);
          return (
            <li key={entry.id} className={on ? 'source on' : 'source'}>
              <div className="source-main">
                <Switch checked={on} label={entry.name} onChange={(next) => setRecommended(entry.id, next)} />
                <div className="source-name">
                  <strong>{entry.name}</strong>
                  <span>{entry.description}</span>
                  {on && <ListStatus meta={meta[entry.id]} now={now} />}
                </div>
                <div className="source-side">
                  <span className="license">{entry.license}</span>
                  <a className="link-btn" href={entry.homepage} target="_blank" rel="noreferrer">
                    来源
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
                {sub.enabled && (isSubscriptionUrl(sub.url) ? <ListStatus meta={meta[sub.id]} now={now} /> : <span className="list-status bad">地址不可用：需要 https://</span>)}
              </div>
              <div className="source-side">
                <button type="button" className="icon-btn small" aria-label={`删除订阅：${sub.name.trim() || addressOf(sub)}`} onClick={() => update((current) => ({ ...current, subscriptions: current.subscriptions.filter((entry) => entry.id !== sub.id) }))}>
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
            label="自定义规则"
            wide
            hint={summary || '一行一条。可以直接粘贴 uBlock Origin、uBlacklist 或 hosts 格式的名单；规则只保存在这个浏览器里。'}
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
            <summary>支持哪些写法？</summary>
            <pre className="protocol">{SYNTAX}</pre>
            <p className="note">uBlock 里隐藏页面元素的规则（带 ##）和 $script、$third-party 这类只针对资源请求的选项，对搜索结果没有意义，会被跳过。名单很大时建议用上面的订阅，而不是粘贴到这里。</p>
          </details>
        </div>
      </div>
    </div>
  );
}
