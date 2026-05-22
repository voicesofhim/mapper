import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  buildAcceleratorDataset,
  buildEmbeddingRecords,
  chunkText,
  computeUmapCoordinates,
  parseAnonymizedInterview,
  stripEmbeddingVectors,
  toTursoSeedSql,
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
    expect(bundle.map_items[0].embedding_metadata.vector_blob_hex).toBeTruthy();
    expect(bundle.map_items[0]).toHaveProperty('projection');
  });

  it('can use OpenAI embeddings with a mocked provider response', async () => {
    const calls = [];
    const fetchImpl = async (url, request) => {
      calls.push({ url, request: JSON.parse(request.body), auth: request.headers.Authorization });
      return {
        ok: true,
        async json() {
          return {
            data: [
              { index: 0, embedding: [0.1, 0.2, 0.3, 0.4] },
              { index: 1, embedding: [0.4, 0.3, 0.2, 0.1] },
            ],
          };
        },
      };
    };

    const embeddings = await buildEmbeddingRecords([
      { id: 'c1', title: 'One', summary: 'Summary', anonymized_text: 'Anonymized text one.', themes: ['learning'], source_type: 'interview' },
      { id: 'c2', title: 'Two', summary: 'Summary', anonymized_text: 'Anonymized text two.', themes: ['execution'], source_type: 'mentor_note' },
    ], {
      embeddingProvider: 'openai',
      embeddingModel: 'text-embedding-3-small',
      embeddingDimensions: 4,
      apiKey: 'test-key',
      fetchImpl,
    });

    expect(calls[0].url).toBe('https://api.openai.com/v1/embeddings');
    expect(calls[0].auth).toBe('Bearer test-key');
    expect(calls[0].request).toMatchObject({
      model: 'text-embedding-3-small',
      encoding_format: 'float',
      dimensions: 4,
    });
    expect(embeddings[0]).toMatchObject({
      embedding_provider: 'openai',
      embedding_model: 'text-embedding-3-small',
      embedding_dimensions: 4,
    });
    expect(embeddings[0].vector_blob_hex).toBeTruthy();
    expect(computeUmapCoordinates(embeddings)[0].projection_version).toBe('umap-openai-text-embedding-3-small-v1');
  });

  it('can use local EmbeddingGemma embeddings with a mocked sidecar response', async () => {
    const sidecarCalls = [];
    const embeddings = await buildEmbeddingRecords([
      { id: 'c1', title: 'One', summary: 'Summary', anonymized_text: 'Anonymized text one.', themes: ['learning'], source_type: 'interview' },
      { id: 'c2', title: 'Two', summary: 'Summary', anonymized_text: 'Anonymized text two.', themes: ['execution'], source_type: 'mentor_note' },
    ], {
      embeddingProvider: 'embeddinggemma',
      embeddingModel: 'google/embeddinggemma-300M',
      embeddingDimensions: 4,
      embeddingPromptName: 'Retrieval-document',
      embeddingBatchSize: 2,
      embeddingGemmaRunner: async (items, options) => {
        sidecarCalls.push({ items, options });
        return [
          [0.1, 0.2, 0.3, 0.4],
          [0.4, 0.3, 0.2, 0.1],
        ];
      },
    });

    expect(sidecarCalls[0].items).toHaveLength(2);
    expect(sidecarCalls[0].options).toMatchObject({
      model: 'google/embeddinggemma-300M',
      dimensions: 4,
      promptName: 'Retrieval-document',
      batchSize: 2,
    });
    expect(embeddings[0]).toMatchObject({
      embedding_provider: 'embeddinggemma',
      embedding_model: 'google/embeddinggemma-300M',
      embedding_dimensions: 4,
    });
    expect(embeddings[0].metadata_json).toMatchObject({
      runtime: 'sentence-transformers',
      prompt_name: 'Retrieval-document',
      local_only: true,
      input_redaction: 'anonymized_text_only',
    });
    expect(embeddings[0].vector_blob_hex).toBeTruthy();
    expect(computeUmapCoordinates(embeddings)[0].projection_version).toBe('umap-embeddinggemma-google-embeddinggemma-300m-v1');
  });

  it('stores vector blobs in Turso SQL but strips them from frontend JSON', async () => {
    const bundle = await buildAcceleratorDataset({
      inputDir: resolve(root, 'data/accelerator/raw/anonymized-interviews'),
      maxParticipants: 1,
      domainId: 'accelerator-seed',
    });
    const sql = toTursoSeedSql(bundle);
    const frontend = stripEmbeddingVectors(bundle);

    expect(sql).toMatch(/embedding_vector.+X'[a-f0-9]+'/);
    expect(frontend.map_items[0].embedding_metadata.vector_blob_hex).toBeUndefined();
  });

  it('writes a static seed domain artifact for Mapper compatibility', () => {
    const seed = JSON.parse(readFileSync(resolve(root, 'data/domains/accelerator-seed.json'), 'utf8'));
    expect(seed.domain.id).toBe('accelerator-seed');
    expect(seed.map_items.length).toBeGreaterThanOrEqual(6);
    expect(seed.map_items.every(item => Number.isFinite(item.umap_x) && Number.isFinite(item.umap_y))).toBe(true);
    expect(seed.map_items.some(item => item.embedding_metadata?.vector_blob_hex)).toBe(false);
  });
});
