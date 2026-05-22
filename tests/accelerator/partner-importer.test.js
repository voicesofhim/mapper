import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildPartnerDataset, inspectPartnerDataset } from '../../scripts/import_partner_dataset.mjs';
import { stripEmbeddingVectors, toTursoSeedSql } from '../../scripts/import_accelerator_dataset.mjs';

describe('partner dataset adapter', () => {
  it('inspects private exports and proposes approval-gated ontology artifacts', async () => {
    const source = await makePartnerFixture();
    const report = await inspectPartnerDataset({
      sourcePath: source,
      datasetId: 'partner:test',
      datasetName: 'Partner Test',
      generatedAt: '2026-05-22T00:00:00.000Z',
    });

    expect(report.records.candidate_records).toBeGreaterThanOrEqual(2);
    expect(report.recommended_text_fields.map(field => field.path)).toContain('profile_summary');
    expect(report.recommended_label_fields.some(field => field.path.includes('labels'))).toBe(true);
    expect(report.privacy_findings.some(finding => finding.path === 'email')).toBe(true);
    expect(report.label_inventory).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'personality_trait', name: 'high agency' }),
      expect.objectContaining({ type: 'participant_need', name: 'needs structure' }),
    ]));
    expect(report.ontology_candidates.some(candidate => candidate.proposed_tag.startsWith('personality_trait:'))).toBe(true);
    expect(report.approval_template.approved).toBe(false);
    expect(report.approval_template.denied_fields).toContain('email');
  });

  it('ingests only approved fields, redacts private values, and exports local mapper data', async () => {
    const source = await makePartnerFixture();
    const approval = {
      approved: true,
      dataset_id: 'partner:test',
      dataset_name: 'Partner Test',
      dataset_theme: 'PARTNER',
      consent_level: 'private_research',
      visibility: 'researcher',
      anonymization_level: 'strict',
      default_source_type: 'derived_analysis',
      approved_text_fields: ['profile_summary', 'content'],
      approved_label_fields: ['labels', 'personality.traits', 'support_needs'],
      denied_fields: ['email', 'phone'],
      approved_tag_types: ['dataset', 'personality_trait', 'participant_need', 'partner_label'],
      label_merges: {
        'personality_trait:high agency': 'personality_trait:high_agency',
        'participant_need:needs structure': 'support_need:execution_structure',
      },
      embedding_provider: 'local',
    };

    const bundle = await buildPartnerDataset({
      sourcePath: source,
      approvalObject: approval,
      importedAt: '2026-05-22T00:00:00.000Z',
      embeddingProvider: 'local',
    });
    const frontend = stripEmbeddingVectors(bundle);
    const sql = toTursoSeedSql(bundle);

    expect(bundle.dataset).toMatchObject({
      id: 'partner:test',
      name: 'Partner Test',
      status: 'local_preview',
    });
    expect(bundle.import_summary.participants).toBe(2);
    expect(bundle.import_summary.chunks).toBeGreaterThanOrEqual(3);
    expect(bundle.map_items.every(item => item.themes.includes('PARTNER'))).toBe(true);
    expect(bundle.map_items.some(item => item.tags.some(tag => tag.type === 'personality_trait' && tag.name === 'high_agency'))).toBe(true);
    expect(JSON.stringify(frontend)).not.toContain('founder@example.com');
    expect(JSON.stringify(frontend)).not.toContain('555-123-4567');
    expect(frontend.map_items[0].embedding_metadata.vector_blob_hex).toBeUndefined();
    expect(sql).toContain('insert or replace into datasets');
    expect(sql).toContain('insert or replace into chunk_tags');
    expect(sql).not.toContain('founder@example.com');
  });
});

async function makePartnerFixture() {
  const source = await mkdtemp(join(tmpdir(), 'mapper-partner-fixture-'));
  await mkdir(join(source, 'exports'), { recursive: true });
  await writeFile(join(source, 'exports', 'profiles.json'), JSON.stringify([
    {
      participant_id: 'alpha',
      email: 'founder@example.com',
      profile_summary: 'This founder shows high agency and wants selective expert guidance. Phone 555-123-4567 should be redacted.',
      labels: ['high agency', 'mentor selective'],
      support_needs: ['needs structure'],
      personality: {
        traits: ['systems thinker'],
      },
      evidence: [
        {
          id: 'ev-1',
          content: 'They need an execution cadence before the next sprint and respond well to concrete accountability.',
          labels: ['execution drift'],
        },
      ],
    },
    {
      participant_id: 'beta',
      profile_summary: 'This participant has strong technical depth and needs go to market support.',
      labels: ['technical depth'],
      support_needs: ['gtm help'],
    },
  ], null, 2));
  return source;
}
