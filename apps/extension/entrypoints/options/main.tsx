import { initializeUiPreferences } from '@/lib/uiPreferences';
import { createRoot } from 'react-dom/client';
import '@/lib/base.css';
import { initLocale, t } from '@/lib/i18n';
import './style.css';
import OptionsApp from './OptionsApp';

void initializeUiPreferences().catch(() => {});
document.documentElement.lang = initLocale();
document.title = t('options.pageTitle');
createRoot(document.getElementById('root')!).render(<OptionsApp />);
