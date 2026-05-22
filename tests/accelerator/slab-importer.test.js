import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildSlabDataset } from '../../scripts/import_slab_dataset.mjs';
import { stripEmbeddingVectors, toTursoSeedSql } from '../../scripts/import_accelerator_dataset.mjs';

describe('SLAB dataset adapter', () => {
  it('redacts contact details, buckets records by dataset, and tags every item as SLAB', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'mapper-slab-fixture-'));
    const profileDir = join(repo, 'data/shape-rotator-spring-2026/profiles/subject-alpha');
    await mkdir(profileDir, { recursive: true });
    await writeFile(join(profileDir, 'profile-manifest.yaml'), [
      'subject_id: subject-alpha',
      'team_display: Example Team',
      'team_tagline: Local research fixture',
    ].join('\n'));
    await writeFile(join(profileDir, 'evidence-store.json'), JSON.stringify({
      schema_version: 'fixture-v1',
      subject_id: 'subject-alpha',
      evidence: [
        {
          id: 'ev-001',
          source_family: 'application-form',
          source_field: 'founder_notes',
          source_mode: 'self_reported',
          depth_level: 'primary',
          acquisition_method: 'repo_fixture',
          content: 'We are building privacy tooling. Contact founder@example.com after the demo.',
          content_format: 'text',
          provenance: 'fixture',
          public_safe: false,
        },
        {
          id: 'ev-002',
          source_family: 'application-form',
          source_field: 'contact email',
          content: 'private@example.com',
          content_format: 'text',
        },
      ],
    }, null, 2));

    const bundle = await buildSlabDataset({
      repoPath: repo,
      importedAt: '2026-05-22T00:00:00.000Z',
      embeddingProvider: 'local',
    });
    const frontend = stripEmbeddingVectors(bundle);
    const sql = toTursoSeedSql(bundle);

    expect(bundle.dataset).toMatchObject({
      id: 'slab:shape-rotator-spring-2026',
      status: 'local_preview',
    });
    expect(bundle.import_summary).toMatchObject({
      participants: 1,
      chunks: 1,
      skipped_records: 1,
    });
    expect(bundle.map_items[0].participant_id).toBe('SLAB-001');
    expect(bundle.map_items[0].themes).toContain('SLAB');
    expect(bundle.map_items[0].tags).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'dataset', name: 'SLAB' }),
    ]));
    expect(bundle.map_items[0].anonymized_text).toContain('[redacted-email]');
    expect(JSON.stringify(frontend)).not.toContain('founder@example.com');
    expect(frontend.map_items[0].embedding_metadata.vector_blob_hex).toBeUndefined();
    expect(sql).toContain('insert or replace into datasets');
    expect(sql).toContain('insert or replace into chunk_tags');
    expect(sql).not.toContain('founder@example.com');
  });
});
