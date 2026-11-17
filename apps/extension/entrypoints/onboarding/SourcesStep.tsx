import type { FusionConfig, SourceId } from '@kiwi-search/core';
import { useState } from 'react';
import { t } from '@kiwi-search/app/i18n';
import { ChevronDownIcon, RotateIcon, TriangleAlertIcon } from '@kiwi-search/app/icons';
import { SourceLogo } from '@kiwi-search/app/SourceLogo';
import type { ProbePlan, ProbeResult } from '@/lib/reachability';
import { GROUPS, SOURCE_INFO, sourcesInGroup, type SourceGroup } from '@/lib/sourceCatalog';
import { sourceLabel } from '@/lib/sourceMeta';
import { Switch } from '../options/controls';

export type ProbeState =
  | { status: 'idle' }
  | { status: 'running'; done: number; total: number }
  | { status: 'done'; plan: ProbePlan };

interface Props {
  config: FusionConfig;
  probe: ProbeState;
  results: Partial<Record<SourceId, ProbeResult>>;
  /** Switched off by the check, so the row can say why. */
  autoOff: SourceId[];
  onToggle: (id: SourceId, next: boolean) => void;
  onProbe: () => void;
}

/** The sources, group by group, with what the network check found for each. The web group is open; the others show a summary until opened. */
export function SourcesStep({ config, probe, results, autoOff, onToggle, onProbe }: Props) {
  const [open, setOpen] = useState<Set<SourceGroup>>(() => new Set(['web']));
  const toggleGroup = (group: SourceGroup) => setOpen((current) => {
    const next = new Set(current);
    if (next.has(group)) next.delete(group); else next.add(group);
    return next;
  });

  const reachLabel = (id: SourceId) => {
    if (autoOff.includes(id) && !config.sources[id]?.enabled) return { text: t('onboarding.reach.autoOff'), tone: 'bad' };
    const result = results[id];
    if (!result) return probe.status === 'running' ? { text: t('onboarding.reach.checking'), tone: 'busy' } : null;
    return result.reach === 'ok' ? { text: t('onboarding.reach.ok'), tone: 'ok' } : result.reach === 'limited' ? { text: t('onboarding.reach.limited'), tone: 'warn' } : { text: t('onboarding.reach.unreachable'), tone: 'bad' };
  };

  return (
    <>
      <div className="ob-probe" role="status" aria-live="polite">
        {probe.status === 'running' && <p><span className="ob-spinner" aria-hidden="true" />{t('onboarding.sources.checking', { done: probe.done, total: probe.total })}</p>}
        {probe.status === 'idle' && <p>{t('onboarding.sources.notChecked')}</p>}
        {probe.status === 'done' && <Summary plan={probe.plan} onToggle={onToggle} config={config} />}
        {probe.status !== 'running' && (
          <button type="button" className="btn small" onClick={onProbe}><RotateIcon />{t(probe.status === 'idle' ? 'onboarding.sources.check' : 'onboarding.sources.recheck')}</button>
        )}
      </div>

      {GROUPS.map(({ id: group }) => {
        const ids = sourcesInGroup(group);
        const enabled = ids.filter((id) => config.sources[id]?.enabled);
        const expanded = open.has(group);
        return (
          <section key={group} className="ob-group" aria-labelledby={`ob-group-${group}`}>
            <button type="button" className="ob-group-head" aria-expanded={expanded} aria-controls={`ob-group-body-${group}`} onClick={() => toggleGroup(group)}>
              <span className="ob-group-title" id={`ob-group-${group}`}>{t(`group.${group}.title`)}</span>
              <span className="ob-group-count">{t('onboarding.sources.enabled', { enabled: enabled.length, total: ids.length })}</span>
              <ChevronDownIcon className={expanded ? 'flip' : ''} />
            </button>
            {!expanded && (
              <p className="ob-group-summary">
                {enabled.length ? enabled.map((id) => <span key={id} className={results[id]?.reach === 'unreachable' ? 'ob-chip bad' : 'ob-chip'}><SourceLogo id={id} size={14} />{sourceLabel(id)}</span>) : <span className="note">{t('onboarding.sources.noneOn')}</span>}
              </p>
            )}
            {expanded && (
              <ul className="ob-sources" id={`ob-group-body-${group}`}>
                {ids.map((id) => {
                  const on = !!config.sources[id]?.enabled;
                  const reach = reachLabel(id);
                  const needsKey = on && SOURCE_INFO[id].key === 'required' && !config.sources[id]?.apiKey;
                  return (
                    <li key={id} className={on ? 'ob-source on' : 'ob-source'}>
                      <Switch id={`ob-switch-${id}`} checked={on} label={sourceLabel(id)} onChange={(next) => onToggle(id, next)} />
                      <SourceLogo id={id} />
                      <label className="ob-source-name" htmlFor={`ob-switch-${id}`}>
                        <strong>{sourceLabel(id)}</strong>
                        <span>{needsKey ? t('onboarding.sources.needsKey') : t(`source.blurb.${id}`)}</span>
                      </label>
                      {reach && <span className={`ob-reach ${reach.tone}`}>{reach.tone === 'busy' ? <span className="ob-spinner" aria-hidden="true" /> : reach.tone === 'ok' ? <span className="dot" /> : <TriangleAlertIcon />}{reach.text}</span>}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        );
      })}
    </>
  );
}

function Summary({ plan, config, onToggle }: { plan: ProbePlan; config: FusionConfig; onToggle: (id: SourceId, next: boolean) => void }) {
  const offered = plan.suggest.filter((id) => !config.sources[id]?.enabled);
  return (
    <div className="ob-summary">
      <p>{plan.turnOff.length ? t('onboarding.sources.turnedOff', { count: plan.turnOff.length, names: plan.turnOff.map(sourceLabel).join(t('onboarding.sources.nameSeparator')) }) : t('onboarding.sources.allOk')}</p>
      {!plan.webLeft.length && !plan.suggest.length && <p className="ob-warn">{t('onboarding.sources.noWeb')}</p>}
      {offered.length > 0 && (
        <div className="ob-suggest">
          <span>{t('onboarding.sources.suggest', { count: plan.webLeft.length })}</span>
          {offered.map((id) => <button key={id} type="button" className="btn small" onClick={() => onToggle(id, true)}><SourceLogo id={id} size={14} />{sourceLabel(id)}</button>)}
        </div>
      )}
    </div>
  );
}
