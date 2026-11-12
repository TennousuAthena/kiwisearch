import { BROWSER_ENGINES, type FusionConfig, type SourceId } from '@kiwi-search/core';
import { useState } from 'react';
import { browser } from 'wxt/browser';
import { t } from '@/lib/i18n';
import { ChevronDownIcon, ExternalLinkIcon, TriangleAlertIcon } from '@/lib/icons';
import { GROUPS, GROUP_PRESETS, SOURCE_INFO, sourcesInGroup, type SourceGroup } from '@/lib/sourceCatalog';
import type { SourceHealthMap } from '@/lib/sourceHealth';
import { sourceLabel } from '@/lib/sourceMeta';
import { describeSource, type SourceBadge } from '@/lib/sourceView';
import { Field, SecretInput, Switch } from './controls';

type SourceField = 'enabled' | 'apiKey' | 'baseUrl';

interface Props {
  config: FusionConfig;
  health: SourceHealthMap;
  onUpdate: (id: SourceId, field: SourceField, value: boolean | string) => void;
  /** Switches several sources at once (a preset). */
  onSetEnabled: (enabled: Partial<Record<SourceId, boolean>>) => void;
  /** Turning this on needs the user's yes first. */
  onConfirmEnable: (id: SourceId) => void;
}

/** Where a status's action leads: a browser engine's own page, opened in the user's normal window, so they can sign in or solve the captcha as they usually would. */
async function openFor(id: SourceId, action: 'login' | 'verify') {
  const info = SOURCE_INFO[id];
  const engine = (BROWSER_ENGINES as Partial<Record<SourceId, (typeof BROWSER_ENGINES)[keyof typeof BROWSER_ENGINES]>>)[id];
  const url = action === 'login' && info.loginUrl ? info.loginUrl : engine?.buildUrl('kiwi', 10, engine.modes[0]);
  if (url) await browser.tabs.create({ url });
}

export function SourcesSection({ config, health, onUpdate, onSetEnabled, onConfirmEnable }: Props) {
  const [open, setOpen] = useState<Set<SourceId>>(new Set());
  const toggleOpen = (id: SourceId, next?: boolean) =>
    setOpen((current) => {
      const copy = new Set(current);
      if (next ?? !copy.has(id)) copy.add(id);
      else copy.delete(id);
      return copy;
    });

  function row(id: SourceId) {
    const info = SOURCE_INFO[id];
    const settings = config.sources[id] ?? { enabled: false };
    const label = sourceLabel(id);
    const badge = describeSource(id, config, health[id]);
    const hasFields = !!info.key || !!info.baseUrl;
    // A source that can't run without its key opens its fields by itself once it is switched on.
    const needsInput = settings.enabled && (badge?.action === 'key');
    const expanded = hasFields && (needsInput || open.has(id));
    return (
      <li key={id} className={settings.enabled ? 'source on' : 'source'}>
        <div className="source-main">
          <Switch
            checked={settings.enabled}
            label={label}
            onChange={(next) => (next && info.confirm ? onConfirmEnable(id) : onUpdate(id, 'enabled', next))}
          />
          <div className="source-name">
            <strong>{label}</strong>
            <span>{t(`source.blurb.${id}`)}</span>
          </div>
          <div className="source-side">
            {badge && <Badge badge={badge} onAction={(action) => (action === 'key' ? toggleOpen(id, true) : void openFor(id, action))} />}
            {hasFields && (
              <button type="button" className="icon-btn small" aria-expanded={expanded} aria-label={t('options.sources.keyAndAddress', { source: label })} onClick={() => toggleOpen(id)}>
                <ChevronDownIcon className={expanded ? 'flip' : ''} />
              </button>
            )}
          </div>
        </div>
        {expanded && (
          <div className="source-fields">
            {info.baseUrl && (
              <Field label={t('options.sources.serviceAddress')}>
                <input type="url" value={settings.baseUrl ?? ''} placeholder="https://searx.example" onChange={(event) => onUpdate(id, 'baseUrl', event.target.value)} />
              </Field>
            )}
            {info.key && (
              <Field
                label={info.key === 'required' ? t('options.sources.apiKeyRequired') : t('options.sources.apiKeyOptional')}
                hint={
                  info.keyUrl && (
                    <a href={info.keyUrl} target="_blank" rel="noreferrer">
                      {t('options.sources.getKey')} <ExternalLinkIcon />
                    </a>
                  )
                }
              >
                <SecretInput label={t('options.sources.apiKeyOf', { source: label })} value={settings.apiKey ?? ''} placeholder={t('options.sources.keyPlaceholder')} onChange={(next) => onUpdate(id, 'apiKey', next)} />
              </Field>
            )}
          </div>
        )}
      </li>
    );
  }

  return (
    <section className="section" id="sources" aria-labelledby="sources-title">
      <h2 id="sources-title">{t('options.sources.title')}</h2>
      <p className="lead">{t('options.sources.lead')}</p>
      {GROUPS.map((group) => {
        const ids = sourcesInGroup(group.id);
        if (!ids.length) return null;
        const enabled = ids.filter((id) => config.sources[id]?.enabled);
        return (
          <div className="group" key={group.id}>
            <div className="group-head">
              <h3>{t(`group.${group.id}.title`)}</h3>
              <span className="count">
                {t('options.sources.enabledCount', { enabled: enabled.length, total: ids.length })}
              </span>
              <Presets group={group.id} ids={ids} enabled={enabled} onSetEnabled={onSetEnabled} />
            </div>
            <p className="note">{t(`group.${group.id}.lead`)}</p>
            <ul className="sources">{ids.map(row)}</ul>
            {group.id === 'community' && (
              <p className="note">
                {t('options.sources.communityNote')}
              </p>
            )}
          </div>
        );
      })}
    </section>
  );
}

function Presets({ group, ids, enabled, onSetEnabled }: { group: SourceGroup; ids: SourceId[]; enabled: SourceId[]; onSetEnabled: Props['onSetEnabled'] }) {
  const presets = GROUP_PRESETS[group];
  if (!presets?.length) return null;
  return (
    <div className="presets" role="group" aria-label={t('options.sources.presetsLabel')}>
      {presets.map((preset) => {
        const active = preset.on.length === enabled.length && preset.on.every((id) => enabled.includes(id));
        return (
          <button
            key={preset.id}
            type="button"
            className="btn small"
            aria-pressed={active}
            onClick={() => onSetEnabled(Object.fromEntries(ids.map((id) => [id, preset.on.includes(id)])) as Partial<Record<SourceId, boolean>>)}
          >
            {t(preset.labelKey)}
          </button>
        );
      })}
    </div>
  );
}

function Badge({ badge, onAction }: { badge: SourceBadge; onAction: (action: NonNullable<SourceBadge['action']>) => void }) {
  const actionLabel =
    badge.action === 'login' ? t('options.sources.actionLogin') : badge.action === 'verify' ? t('options.sources.actionVerify') : badge.action === 'key' ? t('options.sources.actionKey') : '';
  return (
    <span className="status">
      <span className={`state state-${badge.tone}`} title={badge.hint}>
        {badge.tone === 'warn' || badge.tone === 'bad' ? <TriangleAlertIcon /> : <span className="dot" />}
        {badge.label}
      </span>
      {badge.hint && badge.tone !== 'bad' && <span className="hint">{badge.hint}</span>}
      {badge.action && (
        <button type="button" className="link-btn" onClick={() => onAction(badge.action!)}>
          {actionLabel}
        </button>
      )}
    </span>
  );
}
