import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');

describe('frontend UMAP boundary', () => {
  it('does not import or instantiate UMAP in browser source', () => {
    const files = [
      'src/app.js',
      'src/domain/loader.js',
      'src/viz/renderer.js',
      'src/ui/quiz.js',
      'src/ui/video-panel.js',
    ];

    for (const file of files) {
      const source = readFileSync(resolve(root, file), 'utf8');
      expect(source).not.toMatch(/umap-js|new\s+UMAP|fitUMAP|fit_transform/i);
    }
  });
});
