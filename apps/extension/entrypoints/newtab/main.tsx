import { initializeUiPreferences } from '@/lib/uiPreferences';
import { createRoot } from 'react-dom/client';
import '@/lib/base.css';
import { initLocale } from '@/lib/i18n';
import './style.css';
import App from './App';

void initializeUiPreferences().catch(() => {});
document.documentElement.lang = initLocale();
createRoot(document.getElementById('root')!).render(<App />);
