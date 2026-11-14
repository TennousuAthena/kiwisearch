import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findCjkText } from './helpers/cjk';

const root = join(__dirname, '..');
const repo = resolve(root, '..', '..');
// The interface lives in packages/app and the wire helpers in packages/protocol; the extension keeps its own entrypoints and lib.
const DIRS = [join(root, 'entrypoints'), join(root, 'lib'), join(repo, 'packages', 'app', 'src'), join(repo, 'packages', 'protocol', 'src')];
const CATALOG_DIR = join(repo, 'packages', 'app', 'src', 'i18n', 'catalog');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return path === CATALOG_DIR ? [] : sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts') ? [path] : [];
  });
}

describe('interface text', () => {
  it('lives in the catalog (packages/app/src/i18n/catalog/), not in the components and helpers that show it', () => {
    const files = DIRS.flatMap(sourceFiles);
    expect(files.some((file) => file.endsWith(join('app', 'App.tsx'))), 'the search interface must be among the scanned files').toBe(true);
    const stray = files.flatMap((file) =>
      findCjkText(readFileSync(file, 'utf8'), file).map((hit) => `${relative(repo, file)}:${hit.line}  ${hit.text}`),
    );
    // To fix: move the text into the catalog and read it with t() or tr(). A line of data that only looks like text (a name core
    // writes into a result) can carry the comment `i18n-ignore` instead.
    expect(stray).toEqual([]);
  });
});
