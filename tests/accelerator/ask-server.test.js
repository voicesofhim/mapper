import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  answerQuery,
  buildAskMapResponse,
  cosineSimilarity,
  embedOllamaQuestion,
  float32ArrayFromBlob,
  loadStaticBundleRows,
  rankEvidence,
  rankStaticEvidence,
} from '../../scripts/ask_map_server.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const root = resolve(__dirname, '../..');

describe('local Ask-the-Map retrieval server helpers', () => {
  it('decodes float32 vector blobs from libSQL rows', () => {
    const bytes = Buffer.from(Float32Array.from([0.25, -0.5, 1]).buffer);
    expect(float32ArrayFromBlob(bytes).map(n => Number(n.toFixed(2)))).toEqual([0.25, -0.5, 1]);
  });

  it('ranks evidence by cosine similarity without using UMAP distance', () => {
    const rows = [
      { id: 'c1', participant_id: 'P-1', source_type: 'interview', themes: 'execution', embedding_vector_array: [1, 0, 0] },
      { id: 'c2', participant_id: 'P-2', source_type: 'mentor_note', themes: 'mentorship', embedding_vector_array: [0, 1, 0] },
      { id: 'c3', participant_id: 'P-3', source_type: 'social', themes: 'identity', embedding_vector_array: [-1, 0, 0] },
    ];

    const ranked = rankEvidence([0.9, 0.1, 0], rows, { topK: 2 });
    expect(ranked.map(row => row.id)).toEqual(['c1', 'c2']);
    expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
  });

  it('builds a cautious grounded answer from retrieved evidence', () => {
    const response = buildAskMapResponse('Who needs structure?', [{
      id: 'c1',
      participant_id: 'P-1',
      source_type: 'interview',
      title: 'Structure before execution',
      summary: 'Participant gains momentum when milestones are explicit.',
      excerpt: 'Anonymized excerpt.',
      themes: ['structure need', 'execution'],
      sentiment: 'mixed',
      confidence: 0.82,
      score: 0.91,
      umap_x: 0.2,
      umap_y: 0.3,
      source_id: 's1',
      source_label: 'Interview',
      source_ref: 'local-anonymized/p1.md',
    }], { model: 'google/embeddinggemma-300M' });

    expect(response.synthesis).toMatch(/^Inference:/);
    expect(response.synthesis).toContain('not a diagnosis');
    expect(response.highlighted_map_item_ids).toEqual(['c1']);
    expect(response.participant_codes).toEqual(['P-1']);
    expect(response.evidence[0]).toMatchObject({
      id: 'c1',
      participant_id: 'P-1',
      score: 0.91,
    });
    expect(response.metadata).toMatchObject({
      local_only: true,
      retrieval_model: 'google/embeddinggemma-300M',
    });
  });

  it('applies privacy-safe filters before returning top evidence', () => {
    const rows = [
      { id: 'c1', participant_id: 'P-1', source_type: 'interview', themes: 'execution', embedding_vector_array: [1, 0] },
      { id: 'c2', participant_id: 'P-1', source_type: 'mentor_note', themes: 'mentorship', embedding_vector_array: [0.9, 0.1] },
      { id: 'c3', participant_id: 'P-2', source_type: 'interview', themes: 'execution', embedding_vector_array: [0.8, 0.2] },
    ];

    const ranked = rankEvidence([1, 0], rows, {
      topK: 5,
      filters: { participantId: 'P-1', sourceType: 'mentor_note' },
    });
    expect(ranked.map(row => row.id)).toEqual(['c2']);
  });

  it('filters vector rows by dataset id', () => {
    const rows = [
      { id: 'c1', dataset_id: 'slab:test', participant_id: 'P-1', source_type: 'interview', themes: 'SLAB', embedding_vector_array: [1, 0] },
      { id: 'c2', dataset_id: 'seed:test', participant_id: 'P-1', source_type: 'interview', themes: 'seed', embedding_vector_array: [1, 0] },
    ];

    const ranked = rankEvidence([1, 0], rows, {
      topK: 5,
      filters: { datasetId: 'slab:test' },
    });
    expect(ranked.map(row => row.id)).toEqual(['c1']);
  });

  it('embeds Ask-the-Map queries through Ollama when selected', async () => {
    const calls = [];
    const vector = await embedOllamaQuestion('Who needs structure?', {
      model: 'mxbai-embed-large:latest',
      ollamaUrl: 'localhost:11434/',
      dimensions: 2,
      fetchImpl: async (url, request) => {
        calls.push({ url, request: JSON.parse(request.body) });
        return {
          ok: true,
          async json() {
            return { embeddings: [[3, 4, 99]] };
          },
        };
      },
    });

    expect(calls[0].url).toBe('http://localhost:11434/api/embed');
    expect(calls[0].request).toMatchObject({
      model: 'mxbai-embed-large:latest',
    });
    expect(calls[0].request.input).toMatch(/^Represent this sentence for searching relevant passages: /);
    expect(vector.map(n => Number(n.toFixed(2)))).toEqual([0.6, 0.8]);
  });

  it('can answer from a selected local domain bundle without stale DB ids', async () => {
    await mkdir(join(root, 'data/private-domains'), { recursive: true });
    const privateRoot = await mkdtemp(join(root, 'data/private-domains/test-ask-'));
    await writeFile(join(privateRoot, 'all.json'), JSON.stringify({
      schema_version: 'accelerator-demo-v1',
      domain: { id: 'all', name: 'SLAB Test', content_model: 'accelerator_research' },
      map_items: [{
        id: 'slab-c1',
        dataset_id: 'slab:test',
        participant_id: 'SLAB-001',
        source_type: 'application',
        title: 'Developer tooling',
        summary: 'The team builds local developer tooling for private agents.',
        excerpt: 'Private agent developer tooling evidence.',
        themes: ['SLAB', 'application-form'],
        confidence: 0.8,
        umap_x: 0.2,
        umap_y: 0.4,
        source: { id: 's1', label: 'Application' },
      }],
    }));

    const domainDir = relative(root, privateRoot);
    const rows = await loadStaticBundleRows(domainDir, 'all');
    const ranked = rankStaticEvidence('developer tooling for private agents', rows, {
      filters: { datasetId: 'slab:test' },
    });
    const response = await answerQuery('developer tooling for private agents', {
      domainDir,
      domainId: 'all',
      filters: { datasetId: 'slab:test' },
      topK: 5,
    });

    expect(ranked.map(row => row.id)).toEqual(['slab-c1']);
    expect(response.highlighted_map_item_ids).toEqual(['slab-c1']);
    expect(response.metadata).toMatchObject({
      local_only: true,
      retrieval_model: 'static-domain-bundle',
    });
  });

  it('returns negative infinity for mismatched vectors', () => {
    expect(cosineSimilarity([1, 2], [1])).toBe(-Infinity);
  });
});
