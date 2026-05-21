import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const schema = readFileSync(resolve(root, 'scripts/accelerator-schema.sql'), 'utf8');

describe('accelerator canonical Turso schema', () => {
  it('models participants, sources, chunks, themes, embeddings, UMAP, and privacy fields', () => {
    for (const table of [
      'participants',
      'sources',
      'chunks',
      'themes',
      'chunk_themes',
      'embeddings',
      'umap_coordinates',
      'research_questions',
      'question_evidence',
    ]) {
      expect(schema).toContain(`create table if not exists ${table}`);
    }

    expect(schema).toContain('consent_level');
    expect(schema).toContain('visibility');
    expect(schema).toContain('anonymization_level');
    expect(schema).toContain('embedding_model');
    expect(schema).toContain('umap_x real not null');
    expect(schema).toContain('mapper_export_items');
  });
});
