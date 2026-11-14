// Bundles packages/protocol for the test pages (web/protocol.js). Run: node bundle-protocol.mjs
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');
const pnpmDir = join(root, 'node_modules', '.pnpm');
const esbuild = readdirSync(pnpmDir).filter((name) => name.startsWith('esbuild@')).map((name) => join(pnpmDir, name, 'node_modules', 'esbuild', 'bin', 'esbuild')).find(existsSync);
if (!esbuild) throw new Error('esbuild was not found under node_modules/.pnpm; run pnpm install first');
execFileSync(esbuild, [join(root, 'packages', 'protocol', 'src', 'index.ts'), '--bundle', '--format=iife', '--global-name=KiwiProtocol', '--target=es2022', `--outfile=${join(here, 'web', 'protocol.js')}`], { stdio: 'inherit' });
