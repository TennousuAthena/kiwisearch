import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findCjkText } from './helpers/cjk';

const root = join(__dirname, '..');
const CATALOG_DIR = join('lib', 'i18n', 'catalog');

function sourceFiles(dir: string): string[] {
  return readdirSync(join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return path === CATALOG_DIR ? [] : sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts') ? [path] : [];
  });
}

describe('interface text', () => {
  it('lives in the catalog (lib/i18n/catalog/), not in the components and helpers that show it', () => {
    const stray = ['entrypoints', 'lib'].flatMap((dir) =>
      sourceFiles(dir).flatMap((file) => findCjkText(readFileSync(join(root, file), 'utf8'), file).map((hit) => `${relative('.', file)}:${hit.line}  ${hit.text}`)),
    );
    // To fix: move the text into the catalog and read it with t() or tr(). A line of data that only looks like text (a name core
    // writes into a result) can carry the comment `i18n-ignore` instead.
    expect(stray).toEqual([]);
  });
});
