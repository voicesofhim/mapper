import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  buildAcceleratorDataset,
  chunkText,
  computeUmapCoordinates,
  parseAnonymizedInterview,
} from '../../scripts/import_accelerator_dataset.mjs';

const root = resolve(import.meta.dirname, '../..');

describe('accelerator dataset importer', () => {
  it('parses anonymized interview frontmatter into participant and source records', () => {
    const parsed = parseAnonymizedInterview(`---
participant_id: p-test
display_code: P-T
source_type: interview
consent_level: anonymized_research
openness: 0.7
---

I need structure before execution.
`, 'p-test.md');

    expect(parsed.participant).toMatchObject({
      id: 'p-test',
      display_code: 'P-T',
      consent_level: 'anonymized_research',
    });
    expect(parsed.participant.profile_json.openness).toBe(0.7);
    expect(parsed.source.raw_text_allowed).toBe(0);
  });

  it('chunks source text and computes precomputed UMAP coordinates outside the browser', () => {
    const chunks = chunkText('I need structure. Mentor advice helps when it becomes a cadence.\n\nPublic certainty and private uncertainty diverge.');
    expect(chunks.length).toBeGreaterThan(0);

    const coords = computeUmapCoordinates([
      { id: 'e1', chunk_id: 'c1', embedding_vector: [1, 0, 0] },
      { id: 'e2', chunk_id: 'c2', embedding_vector: [0, 1, 0] },
      { id: 'e3', chunk_id: 'c3', embedding_vector: [0, 0, 1] },
    ]);
    expect(coords).toHaveLength(3);
    for (const coord of coords) {
      expect(coord.projection_method).toBe('umap');
      expect(coord.umap_x).toBeGreaterThanOrEqual(0);
      expect(coord.umap_x).toBeLessThanOrEqual(1);
      expect(coord.umap_y).toBeGreaterThanOrEqual(0);
      expect(coord.umap_y).toBeLessThanOrEqual(1);
    }
  });

  it('builds the seed domain from 2-3 anonymized interviews', async () => {
    const bundle = await buildAcceleratorDataset({
      inputDir: resolve(root, 'data/accelerator/raw/anonymized-interviews'),
      maxParticipants: 3,
      domainId: 'accelerator-seed',
    });

    expect(bundle.participants).toHaveLength(3);
    expect(bundle.map_items.length).toBeGreaterThanOrEqual(6);
    expect(bundle.ask_map.questions.length).toBeGreaterThan(0);
    expect(bundle.map_items[0]).toHaveProperty('embedding_metadata');
    expect(bundle.map_items[0]).toHaveProperty('projection');
  });

  it('writes a static seed domain artifact for Mapper compatibility', () => {
    const seed = JSON.parse(readFileSync(resolve(root, 'data/domains/accelerator-seed.json'), 'utf8'));
    expect(seed.domain.id).toBe('accelerator-seed');
    expect(seed.map_items.length).toBeGreaterThanOrEqual(6);
    expect(seed.map_items.every(item => Number.isFinite(item.umap_x) && Number.isFinite(item.umap_y))).toBe(true);
  });
});
