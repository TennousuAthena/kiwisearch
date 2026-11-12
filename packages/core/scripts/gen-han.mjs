// Writes packages/core/src/han.ts from OpenCC's one-character Traditional -> Simplified table (read as plain data, nothing is run).
// Usage: node packages/core/scripts/gen-han.mjs <TSCharacters.txt> packages/core/src/han.ts
// The table: https://raw.githubusercontent.com/BYVoid/OpenCC/master/data/dictionary/TSCharacters.txt (Apache License 2.0; the committed
// han.ts was made from the copy of 2026-11-12, 4148 entries, 2965 of them kept).
import fs from 'node:fs';

const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error('usage: node gen-han.mjs <TSCharacters.txt> <out.ts>');

const traditional = [];
const simplified = [];
for (const line of fs.readFileSync(input, 'utf8').split('\n')) {
  if (!line || line.startsWith('#')) continue;
  const [key, values] = line.split('\t');
  if (!key || !values) continue;
  const from = Array.from(key);
  const to = Array.from(values.trim().split(/\s+/)[0] ?? '');
  // One character each way, and an actual change; OpenCC's multi-character keys are phrases.
  if (from.length !== 1 || to.length !== 1 || from[0] === to[0]) continue;
  // Only the BMP: titles with a character from a supplementary plane are rare and the string stays plain.
  if (from[0].codePointAt(0) > 0xffff || to[0].codePointAt(0) > 0xffff) continue;
  traditional.push(from[0]);
  simplified.push(to[0]);
}
if (traditional.length < 2500) throw new Error(`only ${traditional.length} pairs: the table looks wrong`);

const wrap = (text) => text.match(/.{1,60}/gu).map((chunk) => `  '${chunk}'`).join(' +\n');

fs.writeFileSync(
  output,
  `/**
 * Traditional -> Simplified, one character each, so that two titles written in the two scripts compare equal ("計算機" and "计算机").
 * Characters only: the vocabulary differences between regions ("軟體" / "软件") are not touched.
 *
 * Generated from OpenCC's TSCharacters.txt (https://github.com/BYVoid/OpenCC, Apache License 2.0, Copyright the OpenCC authors):
 * the first simplified form of every key that is one character in the basic plane, ${traditional.length} pairs. The two strings below
 * are parallel: the n-th character of one is the n-th of the other. Regenerate with packages/core/scripts/gen-han.mjs.
 */
const TRADITIONAL =
${wrap(traditional.join(''))};
const SIMPLIFIED =
${wrap(simplified.join(''))};

let table: Map<string, string> | undefined;

/** The text with every Traditional character replaced by its Simplified form; anything else is left as it is. */
export function foldHan(text: string): string {
  if (!table) {
    table = new Map();
    const from = Array.from(TRADITIONAL);
    const to = Array.from(SIMPLIFIED);
    from.forEach((char, index) => table!.set(char, to[index]));
  }
  let out = '';
  for (const char of text) out += table.get(char) ?? char;
  return out;
}
`,
);
console.log(`${traditional.length} pairs written`);
