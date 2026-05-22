import { describe, expect, it } from 'vitest';
import {
  buildAskMapResponse,
  cosineSimilarity,
  float32ArrayFromBlob,
  rankEvidence,
} from '../../scripts/ask_map_server.mjs';

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

  it('returns negative infinity for mismatched vectors', () => {
    expect(cosineSimilarity([1, 2], [1])).toBe(-Infinity);
  });
});
