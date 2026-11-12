import type { FusionConfig } from '@kiwi-search/core';
import type { BlocklistMetaMap } from '@/lib/blocklistState';
import { t } from '@/lib/i18n';
import { BlocklistsPanel } from './BlocklistsPanel';
import { DomainInput } from './controls';

interface Props {
  config: FusionConfig;
  blocklistMeta: BlocklistMetaMap;
  onChange: (update: (config: FusionConfig) => FusionConfig) => void;
}

/** Site rules. They work without any key: blocked sites are folded away, boosted ones move up. */
export function FiltersSection({ config, blocklistMeta, onChange }: Props) {
  const setJudge = (patch: Partial<FusionConfig['judge']>) => onChange((c) => ({ ...c, judge: { ...c.judge, ...patch } }));
  return (
    <section className="section" id="filters" aria-labelledby="filters-title">
      <h2 id="filters-title">{t('options.filters.title')}</h2>
      <p className="lead">{t('options.filters.lead')}</p>
      <div className="card">
        <div className="card-body flat">
          <DomainInput label={t('options.filters.blockedLabel')} values={config.judge.blockedDomains} onChange={(blockedDomains) => setJudge({ blockedDomains })} placeholder={t('options.filters.blockedPlaceholder')} />
          <p className="note">{t('options.filters.blockedNote')}</p>
        </div>
      </div>
      <div className="card">
        <div className="card-body flat">
          <DomainInput label={t('options.filters.boostedLabel')} values={config.judge.boostedDomains} onChange={(boostedDomains) => setJudge({ boostedDomains })} placeholder={t('options.filters.boostedPlaceholder')} />
          <p className="note">{t('options.filters.boostedNote')}</p>
        </div>
      </div>
      <BlocklistsPanel config={config} meta={blocklistMeta} onChange={onChange} />
    </section>
  );
}
