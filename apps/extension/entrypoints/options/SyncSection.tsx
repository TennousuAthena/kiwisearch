import { useCallback, useEffect, useState } from 'react';
import { t } from '@kiwi-search/app/i18n';
import { DEFAULT_SYNC_RELAY_URL } from '@kiwi-search/protocol';
import type {
  SyncCategoryPrefs,
  SyncJoinConflictMode,
  SyncPeerStatus,
  SyncRuntimeMessage,
  SyncRuntimeResponse,
  SyncStatusSnapshot,
} from '@kiwi-search/protocol';
import { ConfirmDialog, Field, Segmented, SwitchRow } from './controls';

async function sendSyncMessage(message: SyncRuntimeMessage): Promise<SyncRuntimeResponse> {
  const response = (await browser.runtime.sendMessage(message)) as SyncRuntimeResponse | undefined;
  if (!response) {
    return { ok: false, error: 'no response' };
  }
  return response;
}

function channelLabel(channel: SyncPeerStatus['channel']): string {
  if (channel === 'webrtc') return t('options.sync.channelWebrtc');
  if (channel === 'relay') return t('options.sync.channelRelay');
  return t('options.sync.channelNone');
}

function statusSummary(status: SyncStatusSnapshot): string {
  if (!status.enabled) return t('options.sync.statusDisabled');
  if (status.transportState === 'error') {
    return t('options.sync.statusError', { error: status.transportError || '' });
  }
  if (status.transportState === 'connecting') return t('options.sync.statusConnecting');
  if (status.transportState === 'connected') {
    return t('options.sync.statusConnected', { epoch: status.epoch, count: status.recordCount });
  }
  if (status.transportState === 'offline') return t('options.sync.statusOffline');
  return t('options.sync.statusIdle');
}

export function SyncSection() {
  const [status, setStatus] = useState<SyncStatusSnapshot | null>(null);
  const [deviceName, setDeviceName] = useState('');
  const [relayUrl, setRelayUrl] = useState(DEFAULT_SYNC_RELAY_URL);
  const [stunEnabled, setStunEnabled] = useState(false);
  const [stunUrlsText, setStunUrlsText] = useState('');
  const [joinPhrase, setJoinPhrase] = useState('');
  const [conflictMode, setConflictMode] = useState<SyncJoinConflictMode>('group');
  const [revealedPhrase, setRevealedPhrase] = useState<string | null>(null);
  const [copiedPhrase, setCopiedPhrase] = useState(false);
  const [offerCode, setOfferCode] = useState('');
  const [answerCode, setAnswerCode] = useState('');
  const [remoteCode, setRemoteCode] = useState('');
  const [copiedCode, setCopiedCode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmKeys, setConfirmKeys] = useState(false);
  const [confirmRotate, setConfirmRotate] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [confirmRemovePeer, setConfirmRemovePeer] = useState<SyncPeerStatus | null>(null);

  const hydrateFromStatus = useCallback((next: SyncStatusSnapshot, syncInputs: boolean) => {
    setStatus(next);
    if (syncInputs) {
      setDeviceName(next.deviceName);
      setRelayUrl(next.relayUrl);
      setStunEnabled(next.stunEnabled);
      setStunUrlsText(next.stunUrls.join('\n'));
    }
  }, []);

  const refresh = useCallback(async (syncInputs = false) => {
    try {
      const res = await sendSyncMessage({ type: 'kiwi:sync:status' });
      if (res.ok) {
        hydrateFromStatus(res.status, syncInputs);
      }
    } catch {
      // Background might be waking up.
    }
  }, [hydrateFromStatus]);

  useEffect(() => {
    void refresh(true);
    const timer = window.setInterval(() => {
      void refresh(false);
    }, 3000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const parseStunUrls = () =>
    stunUrlsText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

  const runAction = async (
    message: SyncRuntimeMessage,
    onSuccess?: (res: Extract<SyncRuntimeResponse, { ok: true }>) => void,
  ) => {
    setBusy(true);
    setError(null);
    try {
      const res = await sendSyncMessage(message);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      hydrateFromStatus(res.status, true);
      onSuccess?.(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleCreateGroup = () => {
    void runAction(
      {
        type: 'kiwi:sync:create-group',
        deviceName: deviceName.trim() || undefined,
        relayUrl: relayUrl.trim(),
        stunEnabled,
        stunUrls: parseStunUrls(),
      },
      (res) => {
        if (res.phrase) {
          setRevealedPhrase(res.phrase);
          setCopiedPhrase(false);
        }
      },
    );
  };

  const handleJoinGroup = () => {
    void runAction(
      {
        type: 'kiwi:sync:join-group',
        phrase: joinPhrase,
        deviceName: deviceName.trim() || undefined,
        relayUrl: relayUrl.trim(),
        stunEnabled,
        stunUrls: parseStunUrls(),
        conflictMode,
      },
      () => {
        setJoinPhrase('');
      },
    );
  };

  const handleSaveConnection = () => {
    void runAction({
      type: 'kiwi:sync:update-settings',
      deviceName: deviceName.trim() || undefined,
      relayUrl: relayUrl.trim(),
      stunEnabled,
      stunUrls: parseStunUrls(),
    });
  };

  const updateCategory = (key: keyof SyncCategoryPrefs, value: boolean) => {
    if (key === 'keys' && value) {
      setConfirmKeys(true);
      return;
    }
    void runAction({
      type: 'kiwi:sync:update-settings',
      categories: { [key]: value },
    });
  };

  const copyText = async (text: string, kind: 'phrase' | 'code') => {
    try {
      await navigator.clipboard.writeText(text);
      if (kind === 'phrase') {
        setCopiedPhrase(true);
        window.setTimeout(() => setCopiedPhrase(false), 2000);
      } else {
        setCopiedCode(true);
        window.setTimeout(() => setCopiedCode(false), 2000);
      }
    } catch {
      // Ignore clipboard failures in restricted contexts.
    }
  };

  const enabled = Boolean(status?.enabled);

  return (
    <section className="section" id="sync" aria-labelledby="sync-title">
      <h2 id="sync-title">{t('options.sync.title')}</h2>
      <p className="lead">{t('options.sync.lead')}</p>

      {error && (
        <p className="notice save-draft-notice" role="alert">
          {t('options.sync.errorPrefix', { error })}
        </p>
      )}

      {revealedPhrase && (
        <div className="card sync-phrase-card" role="region" aria-label={t('options.sync.phraseBannerTitle')}>
          <div className="card-body flat">
            <h3>{t('options.sync.phraseBannerTitle')}</h3>
            <p className="note">{t('options.sync.phraseBannerNote')}</p>
            <pre className="sync-phrase-box" data-testid="sync-recovery-phrase">{revealedPhrase}</pre>
            <div className="sync-button-row">
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void copyText(revealedPhrase, 'phrase')}
              >
                {copiedPhrase ? t('options.sync.copied') : t('options.sync.copyPhrase')}
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => setRevealedPhrase(null)}
              >
                {t('options.sync.dismissPhrase')}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="card">
        <div className="card-body flat">
          <p className="sync-status-line" data-testid="sync-status-line">
            <strong>{t('options.sync.statusLabel')}: </strong>
            <span>{status ? statusSummary(status) : t('options.sync.statusDisabled')}</span>
          </p>

          <Field label={t('options.sync.deviceNameLabel')}>
            <input
              type="text"
              value={deviceName}
              placeholder={t('options.sync.deviceNamePlaceholder')}
              onChange={(e) => setDeviceName(e.target.value)}
            />
          </Field>

          <Field label={t('options.sync.relayUrlLabel')} hint={t('options.sync.relayUrlHint')} wide>
            <input
              type="url"
              value={relayUrl}
              placeholder={t('options.sync.relayUrlPlaceholder')}
              onChange={(e) => setRelayUrl(e.target.value)}
            />
          </Field>
          {relayUrl !== DEFAULT_SYNC_RELAY_URL && (
            <div className="sync-button-row">
              <button type="button" className="btn small" onClick={() => setRelayUrl(DEFAULT_SYNC_RELAY_URL)}>
                {t('options.sync.restoreRelayDefault')}
              </button>
            </div>
          )}

          <SwitchRow
            checked={stunEnabled}
            onChange={setStunEnabled}
            title={t('options.sync.stunTitle')}
            hint={t('options.sync.stunHint')}
          />

          {stunEnabled && (
            <Field label={t('options.sync.stunUrlsLabel')} wide>
              <textarea
                rows={2}
                value={stunUrlsText}
                placeholder={t('options.sync.stunUrlsPlaceholder')}
                onChange={(e) => setStunUrlsText(e.target.value)}
              />
            </Field>
          )}

          {enabled && (
            <div className="sync-button-row">
              <button type="button" className="btn" disabled={busy} onClick={handleSaveConnection}>
                {t('options.sync.saveConnection')}
              </button>
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() => void runAction({ type: 'kiwi:sync:sync-now' })}
              >
                {t('options.sync.syncNow')}
              </button>
            </div>
          )}
        </div>
      </div>

      {!enabled ? (
        <div className="card">
          <div className="card-body flat">
            <h3>{t('options.sync.setupTitle')}</h3>
            <div className="sync-button-row">
              <button
                type="button"
                className="btn btn-primary"
                data-testid="sync-create-group"
                disabled={busy}
                onClick={handleCreateGroup}
              >
                {busy ? t('options.sync.creating') : t('options.sync.createButton')}
              </button>
            </div>

            <hr className="sync-divider" />

            <Field label={t('options.sync.joinTitle')} wide>
              <textarea
                rows={3}
                data-testid="sync-join-phrase"
                value={joinPhrase}
                placeholder={t('options.sync.joinPlaceholder')}
                onChange={(e) => setJoinPhrase(e.target.value)}
              />
            </Field>

            <Field label={t('options.sync.joinConflictLabel')} wide>
              <Segmented<SyncJoinConflictMode>
                label={t('options.sync.joinConflictLabel')}
                value={conflictMode}
                onChange={setConflictMode}
                options={[
                  { value: 'group', label: t('options.sync.joinConflictGroup') },
                  { value: 'merge', label: t('options.sync.joinConflictMerge') },
                  { value: 'local', label: t('options.sync.joinConflictLocal') },
                ]}
              />
            </Field>

            <div className="sync-button-row">
              <button
                type="button"
                className="btn btn-primary"
                data-testid="sync-join-group"
                disabled={busy || !joinPhrase.trim()}
                onClick={handleJoinGroup}
              >
                {busy ? t('options.sync.joining') : t('options.sync.joinButton')}
              </button>
            </div>
          </div>
        </div>
      ) : (
        <>
          <div className="card">
            <div className="card-body flat">
              <h3>{t('options.sync.categoriesTitle')}</h3>
              <SwitchRow
                checked={status?.categories.search ?? true}
                onChange={(val) => updateCategory('search', val)}
                title={t('options.sync.catSearchTitle')}
                hint={t('options.sync.catSearchHint')}
              />
              <SwitchRow
                checked={status?.categories.filters ?? true}
                onChange={(val) => updateCategory('filters', val)}
                title={t('options.sync.catFiltersTitle')}
                hint={t('options.sync.catFiltersHint')}
              />
              <SwitchRow
                checked={status?.categories.ui ?? true}
                onChange={(val) => updateCategory('ui', val)}
                title={t('options.sync.catUiTitle')}
                hint={t('options.sync.catUiHint')}
              />
              <SwitchRow
                checked={status?.categories.keys ?? false}
                onChange={(val) => updateCategory('keys', val)}
                title={t('options.sync.catKeysTitle')}
                hint={t('options.sync.catKeysHint')}
              />
            </div>
          </div>

          <div className="card">
            <div className="card-body flat">
              <h3>{t('options.sync.devicesTitle')}</h3>
              {!status?.peers.length ? (
                <p className="note">{t('options.sync.devicesEmpty')}</p>
              ) : (
                <ul className="sync-device-list" data-testid="sync-device-list">
                  {status.peers.map((peer) => (
                    <li key={peer.deviceId} className="sync-device-item">
                      <div>
                        <strong>{peer.deviceName}</strong>
                        <span className="sync-device-meta">
                          {' '}
                          {peer.status === 'online'
                            ? t('options.sync.deviceOnline', { channel: channelLabel(peer.channel) })
                            : peer.status === 'removed'
                              ? t('options.sync.deviceRemoved')
                              : t('options.sync.deviceOffline')}
                        </span>
                      </div>
                      {peer.status !== 'removed' && (
                        <button
                          type="button"
                          className="btn small"
                          disabled={busy}
                          onClick={() => setConfirmRemovePeer(peer)}
                        >
                          {t('options.sync.removeDevice')}
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}

              <div className="sync-button-row">
                <button
                  type="button"
                  className="btn"
                  disabled={busy}
                  onClick={() => setConfirmRotate(true)}
                >
                  {t('options.sync.rotatePhrase')}
                </button>
                <button
                  type="button"
                  className="btn"
                  disabled={busy}
                  onClick={() => setConfirmLeave(true)}
                >
                  {t('options.sync.leaveGroup')}
                </button>
              </div>
            </div>
          </div>

          <div className="card">
            <div className="card-body flat">
              <h3>{t('options.sync.manualTitle')}</h3>
              <p className="note">{t('options.sync.manualHint')}</p>
              <div className="sync-button-row">
                <button
                  type="button"
                  className="btn"
                  disabled={busy}
                  onClick={() =>
                    void runAction({ type: 'kiwi:sync:create-code', kind: 'offer' }, (res) => {
                      if (res.code) setOfferCode(res.code);
                    })
                  }
                >
                  {t('options.sync.createOffer')}
                </button>
              </div>

              {offerCode && (
                <Field label={t('options.sync.offerLabel')} wide>
                  <textarea rows={2} readOnly value={offerCode} />
                  <button
                    type="button"
                    className="btn small"
                    onClick={() => void copyText(offerCode, 'code')}
                  >
                    {copiedCode ? t('options.sync.copied') : t('options.sync.copyCode')}
                  </button>
                </Field>
              )}

              <Field label={t('options.sync.remoteCodeLabel')} wide>
                <textarea
                  rows={2}
                  value={remoteCode}
                  placeholder={t('options.sync.remoteCodePlaceholder')}
                  onChange={(e) => setRemoteCode(e.target.value)}
                />
              </Field>

              <div className="sync-button-row">
                <button
                  type="button"
                  className="btn"
                  disabled={busy || !remoteCode.trim()}
                  onClick={() =>
                    void runAction(
                      { type: 'kiwi:sync:create-code', kind: 'answer', offerCode: remoteCode.trim() },
                      (res) => {
                        if (res.code) setAnswerCode(res.code);
                      },
                    )
                  }
                >
                  {t('options.sync.createAnswer')}
                </button>
                <button
                  type="button"
                  className="btn"
                  disabled={busy || !remoteCode.trim()}
                  onClick={() =>
                    void runAction({ type: 'kiwi:sync:accept-code', code: remoteCode.trim() }, () => {
                      setRemoteCode('');
                    })
                  }
                >
                  {t('options.sync.acceptAnswer')}
                </button>
              </div>

              {answerCode && (
                <Field label={t('options.sync.answerLabel')} wide>
                  <textarea rows={2} readOnly value={answerCode} />
                  <button
                    type="button"
                    className="btn small"
                    onClick={() => void copyText(answerCode, 'code')}
                  >
                    {copiedCode ? t('options.sync.copied') : t('options.sync.copyCode')}
                  </button>
                </Field>
              )}
            </div>
          </div>
        </>
      )}

      {confirmKeys && (
        <ConfirmDialog
          title={t('options.sync.keysConfirmTitle')}
          confirmLabel={t('options.sync.keysConfirmAction')}
          onConfirm={() => {
            setConfirmKeys(false);
            void runAction({ type: 'kiwi:sync:update-settings', categories: { keys: true } });
          }}
          onCancel={() => setConfirmKeys(false)}
        >
          {t('options.sync.keysConfirmBody')}
        </ConfirmDialog>
      )}

      {confirmRotate && (
        <ConfirmDialog
          title={t('options.sync.rotateConfirmTitle')}
          confirmLabel={t('options.sync.rotateConfirmAction')}
          onConfirm={() => {
            setConfirmRotate(false);
            void runAction({ type: 'kiwi:sync:rotate-phrase' }, (res) => {
              if (res.phrase) {
                setRevealedPhrase(res.phrase);
                setCopiedPhrase(false);
              }
            });
          }}
          onCancel={() => setConfirmRotate(false)}
        >
          {t('options.sync.rotateConfirmBody')}
        </ConfirmDialog>
      )}

      {confirmLeave && (
        <ConfirmDialog
          title={t('options.sync.leaveConfirmTitle')}
          confirmLabel={t('options.sync.leaveConfirmAction')}
          onConfirm={() => {
            setConfirmLeave(false);
            setRevealedPhrase(null);
            setOfferCode('');
            setAnswerCode('');
            setRemoteCode('');
            void runAction({ type: 'kiwi:sync:leave-group' });
          }}
          onCancel={() => setConfirmLeave(false)}
        >
          {t('options.sync.leaveConfirmBody')}
        </ConfirmDialog>
      )}

      {confirmRemovePeer && (
        <ConfirmDialog
          title={t('options.sync.removeConfirmTitle', { name: confirmRemovePeer.deviceName })}
          confirmLabel={t('options.sync.removeConfirmAction')}
          onConfirm={() => {
            const target = confirmRemovePeer;
            setConfirmRemovePeer(null);
            void runAction({ type: 'kiwi:sync:remove-device', deviceId: target.deviceId }, (res) => {
              if (res.phrase) {
                setRevealedPhrase(res.phrase);
                setCopiedPhrase(false);
              }
            });
          }}
          onCancel={() => setConfirmRemovePeer(null)}
        >
          {t('options.sync.removeConfirmBody')}
        </ConfirmDialog>
      )}
    </section>
  );
}
