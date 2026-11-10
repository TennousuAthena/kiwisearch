import { createRoot } from 'react-dom/client';
import '@/lib/base.css';
import './style.css';
import OptionsApp from './OptionsApp';

createRoot(document.getElementById('root')!).render(<OptionsApp />);
