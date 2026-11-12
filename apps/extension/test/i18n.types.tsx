// Type-level tests for `createI18n`: `tsc` runs them (`pnpm typecheck`), vitest does not. Every `@ts-expect-error` below
// must still be an error, and every other line must compile; an unused `@ts-expect-error` is itself an error.
import type { ReactNode } from 'react';
import { createI18n, type ParamArgs, type Params, type Tags } from '../lib/i18n/runtime';

const source = {
  'a.plain': '没有参数',
  'a.count': '{count} 条结果（{duration}）',
  'a.rich': '见<link>设置</link>和<code>k</code>，共 {n} 项',
  'mode.web': '全部',
  'mode.images': '图片',
  'sample.raw': 'POST { "a": 1 } <id>',
} as const;

const i18n = createI18n(source, 'zh-CN');
const { t } = i18n;

t('a.plain');
t('a.count', { count: 3, duration: '1.2 秒' });
// @ts-expect-error missing key
t('nope');
// @ts-expect-error missing params
t('a.count');
// @ts-expect-error wrong param name
t('a.count', { count: 3, time: 1 });
// @ts-expect-error params on a message that takes none
t('a.plain', { x: 1 });

declare const mode: 'web' | 'images';
t(`mode.${mode}`);
declare const other: 'web' | 'x';
// @ts-expect-error `mode.x` does not exist, so the table is not exhaustive
t(`mode.${other}`);

type P = Params<(typeof source)['a.count']>;
const p: P = 'count';
const p2: P = 'duration';
// @ts-expect-error not a placeholder
const p3: P = 'other';
type G = Tags<(typeof source)['a.rich']>;
const g: G = 'link';
const g2: G = 'code';
// @ts-expect-error closing tags are not tags
const g3: G = '/link';
type Args = ParamArgs<(typeof source)['sample.raw']>;
const args: Args = [];
type RichT = Record<Tags<(typeof source)['a.rich']>, (c: ReactNode) => ReactNode>;
const tags: RichT = { link: (c) => c, code: (c) => c };
export { p, p2, p3, g, g2, g3, args, tags };
