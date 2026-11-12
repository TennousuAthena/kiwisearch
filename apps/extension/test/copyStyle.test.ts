import { describe, expect, it } from 'vitest';
import { zhCN } from '../lib/i18n/zh-CN';

/**
 * The part of the copy rules in DESIGN.md ("Copy") that a machine can check, run over every message of the Chinese catalog.
 * It cannot tell whether a sentence is clear or friendly; it catches the words and marks the rules ban, and keeps the glossary
 * honest. A message that must break a rule goes in `EXEMPT` with the reason.
 */

/** Messages that may break the rule named, and why. Keep this short. */
const EXEMPT: Record<string, { rule: string; why: string }> = {};

const messages = (Object.entries(zhCN) as [string, string][]).filter(([key]) => !key.endsWith('.raw'));

/**
 * The message with `{placeholders}` and `<tags>` taken out, so that what is left is the text a reader sees around them. A
 * placeholder becomes a neutral mark: what it holds (a name, a number) is up to the caller, and the spacing rule must not
 * guess at it.
 */
const bare = (text: string) => text.replace(/\{\w+\}/g, '□').replace(/<\/?[a-zA-Z][\w-]*>/g, '');

interface Rule {
  name: string;
  /** What to write instead; shown in the failure. */
  fix: string;
  test: RegExp;
}

const RULES: Rule[] = [
  { name: 'no “您”', fix: 'Use “你”, or leave the pronoun out.', test: /您/ },
  { name: 'no “我的” / “我们”', fix: 'Name the thing (“AI 模型”), and call the software “Kiwi” or leave the subject out.', test: /我的|我们/ },
  { name: 'no exclamation marks', fix: 'Say it plainly; Kiwi has no moment that calls for one.', test: /[！!]/ },
  { name: 'no “「」” quotes', fix: 'Quote interface names with “”.', test: /[「」]/ },
  { name: 'no words that point at a place on the page', fix: 'Name the thing instead of “上面的” / “下面的”.', test: /上面|下面|上方|下方/ },
  { name: 'no “点此”', fix: 'Link text says where it goes or what it does.', test: /点此/ },
  { name: 'no colloquial words', fix: 'Write the plain word (DESIGN.md, “句式与用词”).', test: /就够|都行|也行|管得很严|小号|误伤|放行|点名|开小差|就可以了|不准|就能/ },
  { name: 'no over-formal words', fix: '倘若、假使、假若 → 如果; 若要 → 要 / 如果要; 仅是 → 只是.', test: /倘若|假使|假若|若要|仅是/ },
  { name: 'no double negatives', fix: 'Say what is, not what is not not.', test: /不是不|不[^，。；：]{0,6}就不/ },
  { name: 'glossary: AI 模型', fix: 'Use “AI 模型”, not LLM / 大模型 / 聊天模型.', test: /LLM|大模型|聊天模型/ },
  { name: 'glossary: 备用 / 改用', fix: 'Use “备用” or “改用”, not 代替 / 兜底.', test: /代替|兜底/ },
  { name: 'glossary: 智能学术搜索', fix: 'Use “智能学术搜索”, not 智能检索.', test: /智能检索/ },
  { name: 'glossary: 置信度', fix: 'Use “置信度”, not 把握.', test: /把握/ },
  { name: 'glossary: 人机验证', fix: 'Use “人机验证” for what the user has to do; 验证码 only for the picture or slider itself.', test: /验证码/ },
  { name: 'glossary: API Key', fix: 'Use “API Key”, not 密钥 / 秘钥.', test: /密钥|秘钥/ },
  { name: 'glossary: API 地址 / 服务地址', fix: 'Use “API 地址” or “服务地址”, not Base URL / Endpoint.', test: /Base URL|Endpoint/i },
  { name: 'glossary: 登录', fix: 'Write 登录, not 登陆.', test: /登陆/ },
  { name: 'glossary: 设置', fix: 'Use “设置” / “未设置”, not 配置 / 配好.', test: /配置|配好/ },
  { name: 'glossary: 已隐藏', fix: 'Results that are hidden are “已隐藏”; do not say 过滤掉.', test: /过滤掉/ },
  { name: 'a space between Chinese and Latin letters or digits', fix: 'Write “3 个文件”, “AI 模型”.', test: /[\p{Script=Han}][A-Za-z0-9]|[A-Za-z0-9][\p{Script=Han}]/u },
];

describe('the copy rules', () => {
  for (const rule of RULES) {
    it(rule.name, () => {
      const broken = messages
        .filter(([key]) => EXEMPT[key]?.rule !== rule.name)
        .filter(([, text]) => rule.test.test(bare(text)))
        .map(([key, text]) => `${key}: ${text}`);
      expect(broken, rule.fix).toEqual([]);
    });
  }

  it('lists only exemptions that are still needed', () => {
    for (const [key, { rule, why }] of Object.entries(EXEMPT)) {
      const found = RULES.find((r) => r.name === rule);
      expect(found, `${key}: unknown rule "${rule}"`).toBeDefined();
      expect(key in zhCN, `${key} is not a message any more`).toBe(true);
      expect(why.trim(), key).not.toBe('');
      expect(found!.test.test(bare((zhCN as Record<string, string>)[key])), `${key} no longer breaks "${rule}"; drop the exemption`).toBe(true);
    }
  });
});
