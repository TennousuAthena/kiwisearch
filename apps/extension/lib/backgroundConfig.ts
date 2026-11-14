import { browser } from 'wxt/browser';
import { applySettingsPatch, type DomainPreferenceState, type SettingsUpdate, type SettingsUpdateResponse } from './configUpdates';
import { normalizeDomain } from '@kiwi-search/protocol';
import { loadBridge, loadConfig } from './settings';

let writes: Promise<unknown> = Promise.resolve();
const REVISION_KEY = 'domainPreferenceRevisions';

async function loadDomainRevisions(): Promise<Record<string, string>> {
  const stored = (await browser.storage.local.get(REVISION_KEY))[REVISION_KEY];
  return stored && typeof stored === 'object' && !Array.isArray(stored) ? { ...stored } as Record<string, string> : {};
}

export function isConfigUpdateMessage(message: unknown): message is SettingsUpdate {
  return !!message && typeof message === 'object' && (message as { type?: unknown }).type === 'kiwi:update-settings';
}

/** The service worker is the single writer for config and bridge changes from every extension page. */
export function handleConfigUpdate(message: unknown): Promise<SettingsUpdateResponse> {
  const job = writes.then(async (): Promise<SettingsUpdateResponse> => {
    if (!isConfigUpdateMessage(message)) throw new Error('Invalid settings update');
    if ('domain' in message || 'undo' in message) {
      const domain = normalizeDomain('undo' in message ? message.undo.domain : message.domain);
      if (!domain) throw new Error('Invalid domain');
      const config = await loadConfig();
      const revisions = await loadDomainRevisions();
      const before: DomainPreferenceState = { blocked: config.judge.blockedDomains.includes(domain), boosted: config.judge.boostedDomains.includes(domain) };
      let after: DomainPreferenceState;
      if ('undo' in message) {
        const expected = message.undo.after;
        if (revisions[domain] !== message.undo.revision || before.blocked !== expected.blocked || before.boosted !== expected.boosted) return { ok: true, restored: false };
        after = message.undo.before;
      } else {
        if (!['block', 'boost', 'clear'].includes(message.action)) throw new Error('Invalid domain action');
        after = { blocked: message.action === 'block', boosted: message.action === 'boost' };
      }
      config.judge.blockedDomains = config.judge.blockedDomains.filter((value) => value !== domain);
      config.judge.boostedDomains = config.judge.boostedDomains.filter((value) => value !== domain);
      if (after.blocked) config.judge.blockedDomains.push(domain);
      if (after.boosted) config.judge.boostedDomains.push(domain);
      const revision = crypto.randomUUID();
      if ('undo' in message) delete revisions[domain];
      else revisions[domain] = revision;
      await browser.storage.local.set({ config, [REVISION_KEY]: revisions });
      return 'undo' in message ? { ok: true, restored: true } : { ok: true, undo: { domain, before, after, revision } };
    }
    const changes: Record<string, unknown> = {};
    if (message.config?.length) {
      changes.config = applySettingsPatch(await loadConfig(), message.config);
      const domains = message.config.filter((patch) => patch.path[0] === 'judge' && ['blockedDomains', 'boostedDomains'].includes(patch.path[1]));
      if (domains.length) {
        const revisions = await loadDomainRevisions();
        for (const patch of domains) {
          if ('add' in patch) for (const domain of [...patch.add, ...patch.subtract]) delete revisions[domain];
          else for (const domain of Object.keys(revisions)) delete revisions[domain];
        }
        changes[REVISION_KEY] = revisions;
      }
    }
    if (message.bridge?.length) changes.bridge = applySettingsPatch(await loadBridge(), message.bridge);
    if (Object.keys(changes).length) await browser.storage.local.set(changes);
    return { ok: true };
  }).catch((error: unknown): SettingsUpdateResponse => ({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  writes = job;
  return job;
}
