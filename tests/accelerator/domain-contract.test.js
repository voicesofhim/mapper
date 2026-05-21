import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const all = JSON.parse(readFileSync(resolve(root, 'data/domains/all.json'), 'utf8'));
const index = JSON.parse(readFileSync(resolve(root, 'data/domains/index.json'), 'utf8'));

describe('accelerator domain contract', () => {
  it('uses the accelerator research schema and Mapper-compatible aliases', () => {
    expect(all.schema_version).toBe('accelerator-demo-v1');
    expect(all.domain.content_model).toBe('accelerator_research');
    expect(all.map_items.length).toBeGreaterThan(0);
    expect(all.articles).toEqual(all.map_items);
    expect(all.questions).toEqual(all.ask_map.questions);
  });

  it('keeps precomputed UMAP coordinates in every map item', () => {
    for (const item of all.map_items) {
      expect(Number.isFinite(item.umap_x)).toBe(true);
      expect(Number.isFinite(item.umap_y)).toBe(true);
      expect(item.x).toBe(item.umap_x);
      expect(item.y).toBe(item.umap_y);
      expect(item.x).toBeGreaterThanOrEqual(0);
      expect(item.x).toBeLessThanOrEqual(1);
      expect(item.y).toBeGreaterThanOrEqual(0);
      expect(item.y).toBeLessThanOrEqual(1);
    }
  });

  it('preserves privacy and source metadata on evidence chunks', () => {
    for (const item of all.map_items) {
      expect(item).toHaveProperty('consent_level');
      expect(item).toHaveProperty('source');
      expect(item.excerpt || item.anonymized_text).toBeTruthy();
      expect(item).not.toHaveProperty('raw_transcript');
    }
  });

  it('grounds Ask-the-Map answers in existing map item IDs', () => {
    const itemIds = new Set(all.map_items.map(item => item.id));
    for (const question of all.ask_map.questions) {
      expect(question.answer.synthesis).toMatch(/^Inference:/);
      expect(question.answer.highlighted_map_item_ids.length).toBeGreaterThan(0);
      for (const id of question.answer.highlighted_map_item_ids) {
        expect(itemIds.has(id)).toBe(true);
      }
    }
  });

  it('registers all accelerator domains in the static index', () => {
    expect(index.schema_version).toBe('accelerator-demo-v1');
    expect(index.domains.map(d => d.id)).toEqual(['all', 'accelerator-demo']);
  });
});
