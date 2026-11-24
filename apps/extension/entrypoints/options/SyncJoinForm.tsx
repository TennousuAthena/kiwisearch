import { useState } from 'react';
import { t } from '@kiwi-search/app/i18n';
import type { SyncJoinConflictMode, SyncRuntimeMessage, SyncRuntimeResponse } from '@kiwi-search/protocol';
import { Field, Segmented } from './controls';

export async function sendSyncMessage(message: SyncRuntimeMessage): Promise<SyncRuntimeResponse> {
  return await browser.runtime.sendMessage(message) ?? { ok: false, error: t('options.ux.loadFailed') };
}

export function SyncJoinForm({ deviceName, busy, onJoin }: {
  deviceName: string;
  busy: boolean;
  onJoin: (message: Extract<SyncRuntimeMessage, { type: 'kiwi:sync:join-group' }>) => void;
}) {
  const [phrase, setPhrase] = useState('');
  const [conflictMode, setConflictMode] = useState<SyncJoinConflictMode>('group');
  return (
    <form onSubmit={(event) => {
      event.preventDefault();
      if (!busy && phrase.trim()) onJoin({ type: 'kiwi:sync:join-group', phrase: phrase.trim(), deviceName: deviceName.trim() || undefined, conflictMode });
    }}>
      <Field label={t('options.sync.joinTitle')} wide>
        <textarea rows={3} data-testid="sync-join-phrase" value={phrase} placeholder={t('options.sync.joinPlaceholder')}
          autoComplete="off" spellCheck={false} onChange={(event) => setPhrase(event.target.value)} />
      </Field>
      <Field label={t('options.sync.joinConflictLabel')} wide>
        <Segmented<SyncJoinConflictMode> label={t('options.sync.joinConflictLabel')} value={conflictMode}
          onChange={setConflictMode} options={[
            { value: 'group', label: t('options.sync.joinConflictGroup') },
            { value: 'merge', label: t('options.sync.joinConflictMerge') },
            { value: 'local', label: t('options.sync.joinConflictLocal') },
          ]} />
      </Field>
      <div className="sync-button-row">
        <button type="submit" className="btn btn-primary" data-testid="sync-join-group" disabled={busy || !phrase.trim()}>
          {busy ? t('options.sync.joining') : t('options.sync.joinButton')}
        </button>
      </div>
    </form>
  );
}
