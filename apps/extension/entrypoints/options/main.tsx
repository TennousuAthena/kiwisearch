import { configureUiPreferences, initializeUiPreferences } from '@kiwi-search/app/uiPreferences';
import { createExtensionPreferenceBackend } from '@/lib/extensionHost';
import { createRoot } from 'react-dom/client';
import '@kiwi-search/app/base.css';
import { initLocale, t } from '@kiwi-search/app/i18n';
import './style.css';
import OptionsApp from './OptionsApp';

configureUiPreferences(createExtensionPreferenceBackend());
void initializeUiPreferences().catch(() => {});
document.documentElement.lang = initLocale();
document.title = t('options.pageTitle');
createRoot(document.getElementById('root')!).render(<OptionsApp />);
