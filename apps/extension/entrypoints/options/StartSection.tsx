import type { FusionConfig, SourceId } from '@kiwi-search/core';
import { t } from '@kiwi-search/app/i18n';
import { tr } from '@kiwi-search/app/i18n/rich';
import { SOURCE_INFO } from '@/lib/sourceCatalog';
import { DefaultSearchSteps } from './DefaultSearchSteps';
import { InterfaceSource } from './InterfaceSource';
import type { SourceHealthMap } from '@/lib/sourceHealth';
import { sourceLabel } from '@/lib/sourceMeta';
import { describeSource } from '@/lib/sourceView';

interface Props {
  config: FusionConfig;
  health: SourceHealthMap;
}

/**
 * Three things worth doing once: make Kiwi the browser's search, sign in to the platforms you want searched, and
 * (optionally) add keys. Nothing here is required: the search works without any of it.
 */
export function StartSection({ config, health }: Props) {
  const platforms = (Object.keys(SOURCE_INFO) as SourceId[]).filter((id) => SOURCE_INFO[id].login && config.sources[id]?.enabled);

  return (
    <div className="start">
      <ol className="start-steps">
        <li>
          <h3>{t('options.start.uiTitle')}</h3>
          <InterfaceSource />
        </li>
        <li>
          <h3>{t('options.start.defaultTitle')}</h3>
          <DefaultSearchSteps />
        </li>
        <li>
          <h3>{t('options.start.loginTitle')}</h3>
          <p className="note">{t('options.start.loginNote')}</p>
          {platforms.length ? (
            <ul className="start-platforms">
              {platforms.map((id) => {
                const badge = describeSource(id, config, health[id]);
                return (
                  <li key={id}>
                    <span>{sourceLabel(id)}</span>
                    {badge && <span className={`state state-${badge.tone}`}>{badge.label}</span>}
                    <a className="btn small" href={SOURCE_INFO[id].loginUrl} target="_blank" rel="noreferrer">
                      {t('options.start.loginAction')}
                    </a>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="note">{t('options.start.noPlatforms')}</p>
          )}
        </li>
        <li>
          <h3>{t('options.start.keysTitle')}</h3>
          <p className="note">
            {tr('options.start.keys', { tags: { aiLink: (text) => <a href="#ai">{text}</a>, sourcesLink: (text) => <a href="#sources">{text}</a> } })}
          </p>
        </li>
      </ol>
    </div>
  );
}
