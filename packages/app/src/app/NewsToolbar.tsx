import type { NewsOptions } from '@kiwi-search/core';
import { t } from '../i18n';
import { RotateIcon } from '../lib/icons';
import { NEWS_RANGES, NEWS_SORTS } from '../lib/news';

interface Props {
  value: NewsOptions;
  onChange: (value: NewsOptions) => void;
  onRefresh?: () => void;
  busy?: boolean;
}

export function NewsToolbar({ value, onChange, onRefresh, busy }: Props) {
  return (
    <div className="news-toolbar">
      <div className="chips" role="group" aria-label={t('newtab.news.rangeLabel')}>
        {NEWS_RANGES.map((range) => (
          <button key={range} type="button" className="chip" aria-pressed={value.range === range} onClick={() => onChange({ ...value, range })}>
            {t(`newtab.news.range.${range}`)}
          </button>
        ))}
      </div>
      <div className="news-toolbar-actions">
        <div className="chips" role="group" aria-label={t('newtab.news.sortLabel')}>
          {NEWS_SORTS.map((sort) => (
            <button key={sort} type="button" className="chip" aria-pressed={value.sort === sort} onClick={() => onChange({ ...value, sort })}>
              {t(`newtab.news.sort.${sort}`)}
            </button>
          ))}
        </div>
        {onRefresh && (
          <button type="button" className="news-refresh" disabled={busy} onClick={onRefresh}>
            <RotateIcon />
            {t('newtab.news.refresh')}
          </button>
        )}
      </div>
    </div>
  );
}
