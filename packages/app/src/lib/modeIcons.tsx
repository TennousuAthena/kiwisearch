import type { SearchMode } from '@kiwi-search/core';
import type { ComponentType, SVGProps } from 'react';
import {
  BookOpenTextIcon, CirclePlayIcon, GlobeIcon, GraduationCapIcon, ImageIcon,
  MessageCircleQuestionIcon, MessagesSquareIcon, NewspaperIcon, NotebookIcon,
  ShoppingBagIcon, XBrandIcon,
} from './icons';

type IconMode = SearchMode | 'community';
const MODE_ICONS = {
  web: GlobeIcon,
  images: ImageIcon,
  video: CirclePlayIcon,
  news: NewspaperIcon,
  shopping: ShoppingBagIcon,
  academic: GraduationCapIcon,
  community: MessagesSquareIcon,
  zhihu: MessageCircleQuestionIcon,
  xiaohongshu: NotebookIcon,
  wechat: BookOpenTextIcon,
  x: XBrandIcon,
} satisfies Record<IconMode, ComponentType<SVGProps<SVGSVGElement>>>;

/** Decorative companions to the visible tab labels, sharing their color and state. */
export function ModeIcon({ mode, ...props }: { mode: IconMode } & SVGProps<SVGSVGElement>) {
  const Glyph = MODE_ICONS[mode];
  return <Glyph {...props} />;
}
