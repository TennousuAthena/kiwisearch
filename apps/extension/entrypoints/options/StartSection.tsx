import type { FusionConfig, SourceId } from '@kiwi-search/core';
import { useState } from 'react';
import { browser } from 'wxt/browser';
import { CheckIcon, CopyIcon } from '@/lib/icons';
import { SOURCE_INFO } from '@/lib/sourceCatalog';
import type { SourceHealthMap } from '@/lib/sourceHealth';
import { SOURCE_LABELS } from '@/lib/sourceMeta';
import { describeSource } from '@/lib/sourceView';

const DEFAULT_SEARCH_FIELDS = [
  { id: 'name', label: '名称', value: 'Kiwi Search' },
  { id: 'keyword', label: '快捷字词', value: 'kiwi' },
  { id: 'url', label: '网址', value: 'https://s.kiwi.moe/s?q=%s' },
] as const;

interface Props {
  config: FusionConfig;
  health: SourceHealthMap;
  /** Set when shown as the first-run guide; absent when it is the copy kept under "高级". */
  onDone?: () => void;
}

/**
 * Three things worth doing once: make Kiwi the browser's search, sign in to the platforms you want searched, and
 * (optionally) add keys. Nothing here is required: the search works without any of it.
 */
export function StartSection({ config, health, onDone }: Props) {
  const [copied, setCopied] = useState<string | null>(null);
  const [copyError, setCopyError] = useState(false);
  const [settingsFallback, setSettingsFallback] = useState(false);
  const platforms = (Object.keys(SOURCE_INFO) as SourceId[]).filter((id) => SOURCE_INFO[id].login && config.sources[id]?.enabled);

  async function copy(id: string, value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(id);
      setCopyError(false);
      window.setTimeout(() => setCopied(null), 1600);
    } catch {
      setCopyError(true);
    }
  }

  async function openSearchEngineSettings() {
    setSettingsFallback(false);
    try {
      await browser.tabs.create({ url: 'chrome://settings/searchEngines' });
    } catch {
      setSettingsFallback(true);
    }
  }

  return (
    <div className="start">
      <ol className="start-steps">
        <li>
          <h3>把 Kiwi 设为默认搜索</h3>
          <p className="note">Chrome 不允许扩展替你改默认搜索引擎，需要手动加一次。不改也行：在地址栏输入 <code>k</code> 加空格就能用 Kiwi。</p>
          <div className="copy-grid">
            {DEFAULT_SEARCH_FIELDS.map(({ id, label, value }) => (
              <div className="copy-item" key={id}>
                <span>{label}</span>
                <code>{value}</code>
                <button type="button" className="btn small" aria-label={`复制${label}`} onClick={() => void copy(id, value)}>
                  {copied === id ? (
                    <>
                      <CheckIcon />
                      已复制
                    </>
                  ) : (
                    <>
                      <CopyIcon />
                      复制
                    </>
                  )}
                </button>
              </div>
            ))}
          </div>
          {copyError && (
            <p className="note" role="alert">
              复制失败，请手动选中上面的内容复制。
            </p>
          )}
          <p className="note">
            打开搜索引擎设置，在“网站搜索”旁点“添加”，填入上面三项，再在该条目的 ⋮ 菜单里选“设为默认”。
          </p>
          <button type="button" className="btn" onClick={() => void openSearchEngineSettings()}>
            打开 Chrome 搜索引擎设置
          </button>
          {settingsFallback && (
            <p className="note">
              无法自动打开，请把 <code>chrome://settings/searchEngines</code> 复制到地址栏。
            </p>
          )}
        </li>
        <li>
          <h3>登录你想搜的平台</h3>
          <p className="note">知乎、小红书、X 只有登录后才有结果。Kiwi 用的是你自己浏览器里的登录状态，不保存也不上传你的账号。</p>
          {platforms.length ? (
            <ul className="start-platforms">
              {platforms.map((id) => {
                const badge = describeSource(id, config, health[id]);
                return (
                  <li key={id}>
                    <span>{SOURCE_LABELS[id]}</span>
                    {badge && <span className={`state state-${badge.tone}`}>{badge.label}</span>}
                    <a className="btn small" href={SOURCE_INFO[id].loginUrl} target="_blank" rel="noreferrer">
                      去登录
                    </a>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="note">你没有开启需要登录的平台，这一步可以跳过。</p>
          )}
        </li>
        <li>
          <h3>需要的话，再填 Key</h3>
          <p className="note">
            <a href="#ai">AI 概览和智能过滤</a>要用你自己的模型 Key；<a href="#sources">搜索范围</a>里 Brave、Exa 等来源也需要各自的 Key。都是可选的。
          </p>
        </li>
      </ol>
      {onDone && (
        <div className="start-done">
          <button type="button" className="btn btn-primary" onClick={onDone}>
            完成，不再显示
          </button>
          <span className="note">之后可以在“高级”里重新打开。</span>
        </div>
      )}
    </div>
  );
}
