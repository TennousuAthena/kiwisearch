import { useState } from 'react';
import { t } from '../i18n';
import { ResultPopover } from './ResultPopover';

export type SiteAction = 'only' | 'exclude' | 'block' | 'boost';
export type SiteActionHandler = (action: SiteAction, domain: string) => void | Promise<void>;

/** The caller owns filtering and persistent writes; this menu never reads or writes config. */
export function ResultActions({ url, onSiteAction }: { url: string; onSiteAction: SiteActionHandler }) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  let domain: string;
  try { const parsed = new URL(url); if (!/^https?:$/.test(parsed.protocol)) return null; domain = parsed.hostname.replace(/^www\./i, ''); }
  catch { return null; }
  const run = async (action: SiteAction, close: () => void) => {
    setBusy(true); setFailed(false);
    try { await onSiteAction(action, domain); close(); }
    catch { setFailed(true); }
    finally { setBusy(false); }
  };
  return (
    <ResultPopover label={t('resultUx.site.menu', { domain })} triggerClass="result-site-trigger" trigger={
      <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" /></svg>
    }>
      {(close) => <>
        <p className="result-ux-popover-title">{domain}</p>
        <p className="result-ux-popover-note">{t('resultUx.site.temporary')}</p>
        {(['only', 'exclude'] as const).map((action) => <button key={action} className="result-ux-menu-item" disabled={busy} onClick={() => void run(action, close)}>{t(`resultUx.site.${action}`)}</button>)}
        <p className="result-ux-popover-note result-ux-separator">{t('resultUx.site.persistent')}</p>
        {(['block', 'boost'] as const).map((action) => <button key={action} className="result-ux-menu-item" disabled={busy} onClick={() => void run(action, close)}>{t(`resultUx.site.${action}`)}</button>)}
        {failed && <p role="alert" className="result-ux-error">{t('resultUx.site.failed')}</p>}
      </>}
    </ResultPopover>
  );
}
