import { describe, expect, it } from 'vitest';
import { buildDomainIndex, normalizeAcceleratorExport } from '../../scripts/export_accelerator_domain.mjs';

describe('accelerator Turso/static exporter', () => {
  it('normalizes canonical rows into Mapper-compatible domain JSON', () => {
    const bundle = normalizeAcceleratorExport({
      participants: [{
        id: 'p1',
        display_code: 'P-01',
        role: 'founder',
        company_stage: 'pre-seed',
        cohort: 'demo',
        profile_json: '{"openness":0.8}',
      }],
      chunks: [{
        id: 'c1',
        participant_id: 'P-01',
        source_type: 'interview',
        title: 'Autonomy before advice',
        summary: 'Participant wants to form the question first.',
        anonymized_text: 'I need to wrestle with the problem first.',
        themes: ['self-direction'],
        confidence: 0.9,
        umap_x: 0.25,
        umap_y: 0.35,
        consent_level: 'research-anonymized',
        metadata_json: '{"sequence":1}',
        source: { id: 's1', label: 'Interview' },
      }],
      ask_map: { questions: [] },
    }, { domainId: 'all', domainName: 'Accelerator Research' });

    expect(bundle.schema_version).toBe('accelerator-demo-v1');
    expect(bundle.domain.content_model).toBe('accelerator_research');
    expect(bundle.map_items[0]).toMatchObject({
      id: 'c1',
      x: 0.25,
      y: 0.35,
      umap_x: 0.25,
      umap_y: 0.35,
      consent_level: 'research-anonymized',
    });
    expect(bundle.articles).toBe(bundle.map_items);
  });

  it('throws if exported chunks do not contain precomputed UMAP coordinates', () => {
    expect(() => normalizeAcceleratorExport({
      participants: [{ id: 'p1', display_code: 'P-01' }],
      chunks: [{ id: 'c1', participant_id: 'P-01', title: 'Missing coords' }],
    })).toThrow(/UMAP coordinates/);
  });

  it('builds an accelerator index from exported bundles', () => {
    const bundle = normalizeAcceleratorExport({
      participants: [{ id: 'p1', display_code: 'P-01' }],
      map_items: [{ id: 'm1', participant_id: 'P-01', title: 'Item', x: 0.1, y: 0.2 }],
      ask_map: { questions: [{ id: 'q1' }] },
    }, { domainId: 'accelerator-demo', domainName: 'Accelerator Demo' });

    expect(buildDomainIndex([bundle])).toEqual({
      schema_version: 'accelerator-demo-v1',
      domains: [{
        id: 'accelerator-demo',
        name: 'Accelerator Demo',
        parent_id: null,
        level: 'general',
        content_model: 'accelerator_research',
        region: bundle.domain.region,
        grid_size: 50,
        question_count: 1,
      }],
    });
  });
});
