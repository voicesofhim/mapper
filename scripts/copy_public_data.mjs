#!/usr/bin/env node
/**
 * Copy only public, committed data into dist.
 *
 * Private local previews live under data/private-* and local databases under
 * data/accelerator/local; those paths are intentionally excluded from builds.
 */

import { cp, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const root = resolve(__dirname, '..');

const publicDataPaths = [
  'data/domains',
  'data/videos',
  'data/accelerator/raw',
  'data/accelerator/exports',
];

await rm(join(root, 'dist/data'), { recursive: true, force: true });

for (const relativePath of publicDataPaths) {
  const source = join(root, relativePath);
  if (!existsSync(source)) continue;
  const target = join(root, 'dist', relativePath);
  await mkdir(dirname(target), { recursive: true });
  await cp(source, target, {
    recursive: true,
    filter: src => !src.split(sep).includes('.working'),
  });
}
