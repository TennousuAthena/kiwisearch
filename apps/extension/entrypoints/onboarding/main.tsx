import { configureUiPreferences, initializeUiPreferences } from '@kiwi-search/app/uiPreferences';
import { createExtensionPreferenceBackend } from '@/lib/extensionHost';
import { createRoot } from 'react-dom/client';
import '@kiwi-search/app/base.css';
import { initLocale, t } from '@kiwi-search/app/i18n';
import '@kiwi-search/app/uiPreferences.css';
import '../options/style.css';
import './onboarding.css';
import OnboardingApp from './OnboardingApp';

configureUiPreferences(createExtensionPreferenceBackend());
void initializeUiPreferences().catch(() => {});
document.documentElement.lang = initLocale();
document.title = t('onboarding.pageTitle');
createRoot(document.getElementById('root')!).render(<OnboardingApp />);
