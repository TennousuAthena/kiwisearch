import ts from 'typescript';

export interface CjkText {
  line: number;
  /** The literal's text with whitespace collapsed; template parts come one at a time, without their `${}` holes. */
  text: string;
}

/** Han, kana, hangul, CJK punctuation and fullwidth forms: anything that says the text is written for a reader of one language. */
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}　-〿＀-￯]/u;

/**
 * Every string, template and JSX text in a source file that contains CJK characters. Comments are not read (they are not
 * part of the syntax tree). A line that carries `i18n-ignore` is skipped: use it for data that only looks like text, such as
 * the names core's engines write into `meta.siteName`.
 */
export function findCjkText(sourceText: string, fileName: string): CjkText[] {
  const file = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true, fileName.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const lines = sourceText.split('\n');
  const found: CjkText[] = [];
  const add = (node: ts.Node, text: string) => {
    if (!CJK.test(text)) return;
    const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line;
    if (lines[line]?.includes('i18n-ignore')) return;
    found.push({ line: line + 1, text: text.replace(/\s+/g, ' ').trim() });
  };
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isJsxText(node)) add(node, node.text);
    else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) add(node, node.text);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}
