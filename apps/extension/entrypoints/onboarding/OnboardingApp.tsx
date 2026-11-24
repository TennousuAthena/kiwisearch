import { DEFAULT_CONFIG, type FusionConfig, type SourceId } from '@kiwi-search/core';
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { browser } from 'wxt/browser';
import { t } from '@kiwi-search/app/i18n';
import type { SyncRuntimeMessage } from '@kiwi-search/protocol';
import { ArrowLeftIcon, ArrowRightIcon, CheckIcon, CircleAlertIcon, GlobeIcon, SearchIcon, SparkleIcon } from '@kiwi-search/app/icons';
import { KiwiLogo } from '@kiwi-search/app/KiwiLogo';
import { SourceLogo } from '@kiwi-search/app/SourceLogo';
import { tidyConfig } from '@/lib/configReset';
import { localSearchUrl, siteSearchUrl } from '@/lib/localUrl';
import { PROBE_URLS, planFromProbe, probeSources, type ProbeResult } from '@/lib/reachability';
import { DEFAULT_BRIDGE, loadBridge, loadConfig, loadOnboarding, saveOnboarding, saveSettings, type BridgeSettings } from '@/lib/settings';
import { SOURCE_INFO } from '@/lib/sourceCatalog';
import { confirmSteps } from '@/lib/sourceConfirm';
import type { SourceHealthMap } from '@/lib/sourceHealth';
import { sourceLabel } from '@/lib/sourceMeta';
import { loadSourceStatus, watchSourceStatus } from '@/lib/sourceStatus';
import { describeSource } from '@/lib/sourceView';
import { useUiSource } from '@/lib/useUiSource';
import { SITE_ORIGIN } from '@/lib/webOrigins';
import { DecisionFields } from '../options/DecisionFields';
import { DefaultSearchSteps } from '../options/DefaultSearchSteps';
import { EnableSourceDialog } from '../options/EnableSourceDialog';
import { InterfaceSource } from '../options/InterfaceSource';
import { LlmFields } from '../options/LlmFields';
import { Field } from '../options/controls';
import { sendSyncMessage, SyncJoinForm } from '../options/SyncJoinForm';
import { useAutosave } from '../options/useAutosave';
import { SourcesStep, type ProbeState } from './SourcesStep';

/** Step 0 is the welcome; the rest are numbered in the progress bar. */
const STEPS = ['welcome', 'sources', 'login', 'ai', 'start'] as const;
type Step = (typeof STEPS)[number];
const LAST = STEPS.length - 1;
const PROBE_IDS = (Object.keys(PROBE_URLS) as SourceId[]).filter((id) => PROBE_URLS[id]);

/**
 * The page a new install opens: what Kiwi is, a network check that switches off the sources this browser cannot reach, sign-ins,
 * the two AI models, and a first search. Every step can be skipped; what is changed is saved as it is changed, like the settings page.
 */
export default function OnboardingApp() {
  const [config, setConfig] = useState<FusionConfig>(() => structuredClone(DEFAULT_CONFIG));
  const [bridge, setBridge] = useState<BridgeSettings>(DEFAULT_BRIDGE);
  const [health, setHealth] = useState<SourceHealthMap>({});
  const [loaded, setLoaded] = useState(false);
  const [step, setStep] = useState(0);
  const [showJoin, setShowJoin] = useState(false);
  const [joined, setJoined] = useState(false);
  const [joinBusy, setJoinBusy] = useState(false);
  const [joinError, setJoinError] = useState('');
  const [deviceName, setDeviceName] = useState('');
  const [probe, setProbe] = useState<ProbeState>({ status: 'idle' });
  const [results, setResults] = useState<Partial<Record<SourceId, ProbeResult>>>({});
  const [autoOff, setAutoOff] = useState<SourceId[]>([]);
  const [confirming, setConfirming] = useState<SourceId | null>(null);
  const [query, setQuery] = useState('');
  const baseline = useRef<{ config: FusionConfig; bridge: BridgeSettings } | null>(null);
  const configRef = useRef(config);
  configRef.current = config;
  // Sources the user switched by hand: the check never changes them afterwards.
  const touched = useRef(new Set<SourceId>());
  const probeRun = useRef<AbortController | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const { source: uiSource, homeUrl } = useUiSource();

  useEffect(() => {
    void Promise.all([loadConfig(), loadBridge(), loadSourceStatus().catch(() => ({})), loadOnboarding()]).then(([nextConfig, nextBridge, nextHealth, state]) => {
      const tidy = tidyConfig(nextConfig);
      baseline.current = { config: tidy, bridge: nextBridge };
      setConfig(tidy);
      setBridge(nextBridge);
      setHealth(nextHealth);
      // A guide left halfway resumes where it was; a finished one, opened again from the settings page, starts over.
      if (!state.done && state.step && state.step > 0 && state.step <= LAST) setStep(state.step);
      setLoaded(true);
    });
    const stop = watchSourceStatus(setHealth);
    let active = true;
    void sendSyncMessage({ type: 'kiwi:sync:status' }).then((reply) => {
      if (active && reply.ok && reply.status.enabled) setJoined(true);
    }).catch(() => {});
    return () => { active = false; stop(); probeRun.current?.abort(); };
  }, []);

  const { state: saveState, error: saveError, retry } = useAutosave({ config, bridge }, loaded, async (value, superseded) => {
    if (!baseline.current) return;
    if (!superseded?.length && JSON.stringify(value) === JSON.stringify(baseline.current)) return;
    await saveSettings(value, baseline.current, superseded);
    baseline.current = value;
  });

  useEffect(() => {
    if (!loaded || !joined || saveState === 'saving' || saveState === 'error') return;
    let active = true;
    let request = 0;
    const reload = async () => {
      const serial = ++request;
      const next = tidyConfig(await loadConfig());
      if (!active || serial !== request || !baseline.current || configRef.current !== baseline.current.config) return;
      if (JSON.stringify(next) === JSON.stringify(baseline.current.config)) return;
      baseline.current = { ...baseline.current, config: next };
      configRef.current = next;
      setConfig(next);
    };
    const refresh = () => { void reload().catch(() => {}); };
    const onChanged = (changes: Record<string, unknown>, area: string) => {
      if (area === 'local' && 'config' in changes) refresh();
    };
    browser.storage.onChanged.addListener(onChanged);
    refresh();
    return () => {
      active = false;
      browser.storage.onChanged.removeListener(onChanged);
    };
  }, [joined, loaded, saveState]);

  const handleJoin = async (message: Extract<SyncRuntimeMessage, { type: 'kiwi:sync:join-group' }>) => {
    setJoinBusy(true);
    setJoinError('');
    try {
      const status = await sendSyncMessage({ type: 'kiwi:sync:status' });
      const reply = !status.ok || status.status.enabled ? status : await sendSyncMessage(message);
      if (reply.ok) setJoined(true);
      else setJoinError(reply.error);
    } catch {
      setJoinError(t('options.ux.loadFailed'));
    } finally {
      setJoinBusy(false);
    }
  };

  const go = useCallback((next: number) => {
    setStep(next);
    void saveOnboarding({ done: false, step: next });
    window.scrollTo({ top: 0 });
    requestAnimationFrame(() => heading.current?.focus());
  }, []);

  const setEnabled = (id: SourceId, on: boolean) =>
    setConfig((current) => ({ ...current, sources: { ...current.sources, [id]: { ...(current.sources[id] ?? { enabled: false }), enabled: on } } }));

  const toggle = (id: SourceId, next: boolean) => {
    touched.current.add(id);
    if (next && confirmSteps(id).length) { setConfirming(id); return; }
    setEnabled(id, next);
  };

  const runProbe = () => {
    probeRun.current?.abort();
    const run = new AbortController();
    probeRun.current = run;
    setResults({});
    setAutoOff([]);
    let done = 0;
    setProbe({ status: 'running', done, total: PROBE_IDS.length });
    void probeSources(globalThis.fetch.bind(globalThis), PROBE_IDS, {
      signal: run.signal,
      onResult: (id, result) => {
        done += 1;
        setResults((current) => ({ ...current, [id]: result }));
        setProbe({ status: 'running', done, total: PROBE_IDS.length });
      },
    }).then((all) => {
      if (run.signal.aborted) return;
      const plan = planFromProbe(configRef.current, all, touched.current);
      setConfig((current) => {
        const sources = { ...current.sources };
        for (const id of plan.turnOff) if (!touched.current.has(id)) sources[id] = { ...(sources[id] ?? { enabled: false }), enabled: false };
        return { ...current, sources };
      });
      setAutoOff(plan.turnOff);
      setProbe({ status: 'done', plan });
    });
  };

  const finish = async (search?: string) => {
    await saveOnboarding({ done: true });
    const q = search?.trim();
    const appUrl = browser.runtime.getURL('/app.html');
    location.href = q ? (uiSource === 'local' ? localSearchUrl(appUrl, q, 'web') : siteSearchUrl(q, 'web')) : uiSource === 'local' ? appUrl : `${SITE_ORIGIN}/`;
  };
  const skipAll = async () => {
    await saveOnboarding({ done: true });
    location.href = browser.runtime.getURL('/options.html');
  };

  if (!loaded) return <div className="options-page onboarding"><main className="ob-main" aria-busy="true"><KiwiLogo fullName /></main></div>;

  const current: Step = STEPS[step];
  const platforms = (Object.keys(SOURCE_INFO) as SourceId[]).filter((id) => SOURCE_INFO[id].login && config.sources[id]?.enabled && results[id]?.reach !== 'unreachable');

  const nav = (extra?: ReactNode) => (
    <div className="ob-nav">
      <button type="button" className="btn" onClick={() => go(step - 1)}><ArrowLeftIcon />{t('onboarding.back')}</button>
      <span className="ob-nav-gap" />
      {extra}
      <button type="button" className="btn btn-primary" onClick={() => go(step + 1)}>{t('onboarding.next')}<ArrowRightIcon /></button>
    </div>
  );

  return (
    <div className="options-page onboarding">
      <header className="ob-bar">
        <a className="ob-brand" href={homeUrl} aria-label={t('brand.home')}><KiwiLogo fullName /></a>
        <span className={`save-state ${saveState}`} role="status">
          {saveState === 'saving' && t('options.app.saving')}
          {saveState === 'saved' && <><CheckIcon /> {t('options.app.saved')}</>}
          {saveState === 'error' && <><CircleAlertIcon /> {t('options.app.saveFailed', { error: saveError })}</>}
        </span>
        {saveState === 'error' && <button type="button" className="btn small" onClick={retry}>{t('options.ux.retrySave')}</button>}
        {current !== 'start' && <button type="button" className="link-btn ob-skip" disabled={joinBusy} onClick={() => void skipAll()}>{t('onboarding.skip')}</button>}
      </header>

      <main className="ob-main">
        {current === 'welcome' && showJoin ? (
          <section aria-labelledby="ob-title">
            <h1 id="ob-title" ref={heading} tabIndex={-1}>{t('onboarding.sync.title')}</h1>
            {joined ? (
              <>
                <p role="status" className="ob-lead">{t('onboarding.sync.joined')}</p>
                <button type="button" className="btn btn-primary" onClick={() => go(LAST)}>{t('onboarding.next')}<ArrowRightIcon /></button>
              </>
            ) : (
              <>
                <p className="ob-lead">{t('onboarding.sync.lead')}</p>
                <Field label={t('options.sync.deviceNameLabel')}>
                  <input value={deviceName} onChange={(event) => setDeviceName(event.target.value)} />
                </Field>
                <SyncJoinForm deviceName={deviceName} busy={joinBusy} onJoin={(message) => void handleJoin(message)} />
                {joinError && <p role="alert">{t('options.sync.errorPrefix', { error: joinError })}</p>}
              </>
            )}
            <button type="button" className="btn" disabled={joinBusy} onClick={() => {
              setShowJoin(false);
              setJoinError('');
              requestAnimationFrame(() => heading.current?.focus());
            }}><ArrowLeftIcon />{t('onboarding.back')}</button>
          </section>
        ) : current === 'welcome' ? (
          <section className="ob-welcome" aria-labelledby="ob-title">
            <h1 id="ob-title" ref={heading} tabIndex={-1}>{t('onboarding.welcome.title')}</h1>
            <p className="ob-lead">{t('onboarding.welcome.lead')}</p>
            <ul className="ob-points">
              <li><GlobeIcon /><div><strong>{t('onboarding.welcome.point1Title')}</strong><p>{t('onboarding.welcome.point1')}</p></div></li>
              <li><SearchIcon /><div><strong>{t('onboarding.welcome.point2Title')}</strong><p>{t('onboarding.welcome.point2')}</p></div></li>
              <li><SparkleIcon /><div><strong>{t('onboarding.welcome.point3Title')}</strong><p>{t('onboarding.welcome.point3')}</p></div></li>
            </ul>
            <p className="note">{t('onboarding.welcome.privacy')}</p>
            <div className="ob-start">
              <button type="button" className="btn btn-primary ob-big" onClick={() => { go(1); runProbe(); }}>{t('onboarding.welcome.start')}<ArrowRightIcon /></button>
              <button type="button" className="btn ob-big" onClick={() => {
                setShowJoin(true);
                requestAnimationFrame(() => heading.current?.focus());
              }}>{t('onboarding.sync.title')}</button>
              <p className="note">{t('onboarding.welcome.probeNote')}</p>
            </div>
          </section>
        ) : (
          <>
            <Progress step={step} onGo={go} />
            <p className="ob-step-count">{t('onboarding.stepCount', { step, total: LAST })}</p>

            {current === 'sources' && (
              <section aria-labelledby="ob-title">
                <h1 id="ob-title" ref={heading} tabIndex={-1}>{t('onboarding.sources.title')}</h1>
                <p className="ob-lead">{t('onboarding.sources.lead')}</p>
                <SourcesStep config={config} probe={probe} results={results} autoOff={autoOff} onToggle={toggle} onProbe={runProbe} />
                {nav()}
              </section>
            )}

            {current === 'login' && (
              <section aria-labelledby="ob-title">
                <h1 id="ob-title" ref={heading} tabIndex={-1}>{t('onboarding.login.title')}</h1>
                <p className="ob-lead">{t('onboarding.login.lead')}</p>
                {platforms.length ? (
                  <ul className="ob-platforms">
                    {platforms.map((id) => {
                      // Only what a search has actually seen; right after installing there is nothing to say yet.
                      const badge = health[id] ? describeSource(id, config, health[id]) : null;
                      return (
                        <li key={id}>
                          <SourceLogo id={id} />
                          <span className="ob-platform-name">{sourceLabel(id)}</span>
                          {badge && <span className={`state state-${badge.tone}`}>{badge.label}</span>}
                          <a className="btn small" href={SOURCE_INFO[id].loginUrl} target="_blank" rel="noreferrer">{t('onboarding.login.action')}</a>
                        </li>
                      );
                    })}
                  </ul>
                ) : <p className="note">{t('onboarding.login.none')}</p>}
                {nav()}
              </section>
            )}

            {current === 'ai' && (
              <section aria-labelledby="ob-title">
                <h1 id="ob-title" ref={heading} tabIndex={-1}>{t('onboarding.ai.title')}</h1>
                <p className="ob-lead">{t('onboarding.ai.lead')}</p>
                <div className="card">
                  <strong className="card-title">{t('onboarding.ai.modelTitle')}</strong>
                  <p className="card-lead">{t('onboarding.ai.modelLead')}</p>
                  <div className="card-body">
                    <LlmFields value={config.llm} label={t('onboarding.ai.modelTitle')} onChange={(patch) => setConfig((c) => ({ ...c, llm: { ...c.llm, ...patch } }))} />
                  </div>
                </div>
                <div className="card">
                  <strong className="card-title">{t('onboarding.ai.decisionTitle')}</strong>
                  <p className="card-lead">{t('onboarding.ai.decisionLead')}</p>
                  <div className="card-body">
                    <DecisionFields judge={config.judge} onChange={(patch) => setConfig((c) => ({ ...c, judge: { ...c.judge, provider: 'systemone', ...patch } }))} />
                  </div>
                </div>
                <p className="note">{t('onboarding.ai.privacy')}</p>
                {nav(<button type="button" className="btn" onClick={() => go(step + 1)}>{t('onboarding.skipStep')}</button>)}
              </section>
            )}

            {current === 'start' && (
              <section aria-labelledby="ob-title">
                <h1 id="ob-title" ref={heading} tabIndex={-1}>{t('onboarding.start.title')}</h1>
                <p className="ob-lead">{t('onboarding.start.lead')}</p>
                <div className="card">
                  <strong className="card-title">{t('onboarding.start.uiTitle')}</strong>
                  <div className="card-body"><InterfaceSource /></div>
                </div>
                <div className="card">
                  <strong className="card-title">{t('onboarding.start.tryTitle')}</strong>
                  <div className="card-body">
                    <form className="ob-search" role="search" onSubmit={(event: FormEvent) => { event.preventDefault(); if (query.trim()) void finish(query); }}>
                      <SearchIcon />
                      <input type="search" aria-label={t('onboarding.start.queryLabel')} placeholder={t('onboarding.start.placeholder')} value={query} onChange={(event) => setQuery(event.target.value)} />
                      <button type="submit" className="btn btn-primary" disabled={!query.trim()}>{t('onboarding.start.search')}</button>
                    </form>
                    <div className="presets" role="group" aria-label={t('onboarding.start.examplesLabel')}>
                      {(['onboarding.start.example1', 'onboarding.start.example2', 'onboarding.start.example3'] as const).map((key) => (
                        <button key={key} type="button" className="btn small" onClick={() => void finish(t(key))}>{t(key)}</button>
                      ))}
                    </div>
                  </div>
                </div>
                <details className="card ob-details">
                  <summary className="card-title">{t('onboarding.start.defaultTitle')}</summary>
                  <div className="card-body"><DefaultSearchSteps /></div>
                </details>
                <div className="ob-nav">
                  <button type="button" className="btn" onClick={() => go(step - 1)}><ArrowLeftIcon />{t('onboarding.back')}</button>
                  <span className="ob-nav-gap" />
                  <button type="button" className="btn" onClick={() => void finish()}>{t('onboarding.start.finish')}</button>
                </div>
                <p className="note ob-finish-note">{t('onboarding.start.finishNote')}</p>
              </section>
            )}
          </>
        )}
      </main>

      {confirming && (
        <EnableSourceDialog
          id={confirming}
          onEnable={() => { setEnabled(confirming, true); setConfirming(null); }}
          onCancel={() => setConfirming(null)}
        />
      )}
    </div>
  );
}

function Progress({ step, onGo }: { step: number; onGo: (step: number) => void }) {
  const labels = [t('onboarding.step.sources'), t('onboarding.step.login'), t('onboarding.step.ai'), t('onboarding.step.start')];
  return (
    <ol className="ob-progress" aria-label={t('onboarding.progressLabel')}>
      {labels.map((label, i) => {
        const n = i + 1;
        const state = n < step ? 'done' : n === step ? 'current' : 'todo';
        return (
          <li key={label} className={state}>
            <button type="button" aria-current={state === 'current' ? 'step' : undefined} onClick={() => onGo(n)}>
              <span className="ob-progress-mark" aria-hidden="true">{state === 'done' ? <CheckIcon /> : n}</span>
              <span>{label}</span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}
