import markUrl from '../../../design/brand/kiwi-green/mark.svg';
import { t } from './i18n';

/** The approved SVG supplies the silhouette; currentColor supplies the active theme. */
export function KiwiLogo({ fullName = false }: { fullName?: boolean }) {
  return (
    <span className="kiwi-logo">
      <span className="kiwi-logo-mark" style={{ maskImage: `url("${markUrl}")` }} aria-hidden="true" />
      <span>{t(fullName ? 'brand.name' : 'brand.shortName')}</span>
    </span>
  );
}
