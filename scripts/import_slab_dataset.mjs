#!/usr/bin/env node
/**
 * Convert a local SLAB checkout into Mapper-compatible research bundles.
 *
 * This adapter intentionally writes to ignored local paths by default:
 * - data/private-domains/slab/*.json for browser preview
 * - data/private-exports/slab/*.sql for local Turso/libSQL seeding
 *
 * The source repo and generated evidence bundles can contain private excerpts.
 * Keep them local unless the team has explicitly approved a sanitized fixture.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  buildEmbeddingRecords,
  computeUmapCoordinates,
  stripEmbeddingVectors,
  toTursoSeedSql,
} from './import_accelerator_dataset.mjs';
import { normalizeAcceleratorExport, buildDomainIndex } from './export_accelerator_domain.mjs';
import {
  firstSentenceSummary,
  normalizeTagName,
  redactSensitiveText,
  safeMetadata,
  safeText,
  sha256,
  shouldSkipLowSignalContent,
  shouldSkipSensitiveField,
} from './lib/privacy.mjs';

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = resolve(__dirname, '..');
const SLAB_REPO_URL = 'https://github.com/N0V3LT0K3NS/SLAB';
const DEFAULT_COHORT = 'shape-rotator-spring-2026';
const DEFAULT_DATASET_ID = `slab:${DEFAULT_COHORT}`;
const DEFAULT_DOMAIN_ID = 'all';
const DEFAULT_DOMAIN_NAME = 'SLAB Shape Rotator Spring 2026';
const DEFAULT_PRIVATE_DOMAIN_DIR = join(PROJECT_ROOT, 'data/private-domains/slab');
const DEFAULT_PRIVATE_EXPORT_DIR = join(PROJECT_ROOT, 'data/private-exports/slab');

export async function buildSlabDataset(options = {}) {
  const repoPath = resolve(options.repoPath || process.env.SLAB_REPO_PATH || '../SLAB');
  const cohort = options.cohort || DEFAULT_COHORT;
  const datasetId = options.datasetId || DEFAULT_DATASET_ID;
  const datasetName = options.datasetName || `SLAB ${cohort}`;
  const domainId = options.domainId || DEFAULT_DOMAIN_ID;
  const domainName = options.domainName || DEFAULT_DOMAIN_NAME;
  const profilesDir = join(repoPath, 'data', cohort, 'profiles');

  if (!existsSync(profilesDir)) {
    throw new Error(`SLAB profiles directory does not exist: ${profilesDir}`);
  }

  const repoCommitSha = await gitCommit(repoPath);
  const importedAt = options.importedAt || new Date().toISOString();
  const importBatchId = options.importBatchId ||
    `${datasetId}:${repoCommitSha.slice(0, 12)}:${importedAt.replace(/[:.]/g, '-')}`;

  const subjectDirs = (await readdir(profilesDir, { withFileTypes: true }))
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort();

  const participants = [];
  const sources = [];
  const chunks = [];
  const sourceIds = new Set();
  let skipped = 0;

  for (const [subjectIndex, subjectDir] of subjectDirs.entries()) {
    const profileDir = join(profilesDir, subjectDir);
    const evidencePath = join(profileDir, 'evidence-store.json');
    if (!existsSync(evidencePath)) continue;

    const store = JSON.parse(await readFile(evidencePath, 'utf8'));
    const subjectId = store.subject_id || subjectDir;
    const participantCode = `SLAB-${String(subjectIndex + 1).padStart(3, '0')}`;
    const participantId = `${datasetId}:subject:${sha256(subjectId).slice(0, 16)}`;
    const manifest = await loadManifest(profileDir, subjectId);

    participants.push({
      id: participantId,
      dataset_id: datasetId,
      display_code: participantCode,
      role: 'SLAB subject',
      company_stage: 'unknown',
      cohort,
      profile_json: {
        external_subject_sha256: sha256(subjectId),
        team_tagline: safeText(manifest.teamTagline || ''),
      },
      consent_level: 'private_research',
      visibility: 'researcher',
      anonymization_level: 'strict',
    });

    for (const record of store.evidence || []) {
      if (!record?.id || record.content == null) {
        skipped += 1;
        continue;
      }
      if (shouldSkipSensitiveField(record.source_field) || shouldSkipLowSignalContent(record.content)) {
        skipped += 1;
        continue;
      }

      const redacted = redactSensitiveText(record.content);
      if (!redacted.text || shouldSkipLowSignalContent(redacted.text)) {
        skipped += 1;
        continue;
      }

      const sourceFamily = normalizeTagName(record.source_family || 'unknown-source');
      const sourceMode = normalizeTagName(record.source_mode || '');
      const depthLevel = normalizeTagName(record.depth_level || '');
      const sourceType = sourceTypeForFamily(sourceFamily);
      const sourcePath = `data/${cohort}/profiles/${subjectDir}/evidence-store.json`;
      const sourceId = sourceIdFor(datasetId, subjectId, record);
      const chunkId = `${datasetId}:chunk:${sha256(`${subjectId}:${record.id}`).slice(0, 24)}`;
      const sourceField = safeText(record.source_field || '');
      const title = [participantCode, sourceFamily, sourceField].filter(Boolean).join(' · ');
      const summary = firstSentenceSummary(redacted.text);
      const tags = tagsForRecord(record);
      const themes = visibleThemeTags(record);
      const contentSha = sha256(redacted.text);

      if (!sourceIds.has(sourceId)) {
        sourceIds.add(sourceId);
        sources.push({
          id: sourceId,
          dataset_id: datasetId,
          import_batch_id: importBatchId,
          participant_id: participantId,
          source_type: sourceType,
          title,
          label: title,
          source_ref: safeText(record.provenance || ''),
          source_uri_hash: sha256(String(record.provenance || sourcePath)),
          collected_at: safeText(record.acquisition_date || ''),
          raw_text_ref: '',
          raw_text_allowed: 0,
          source_path: sourcePath,
          external_id: record.id,
          content_sha256: contentSha,
          consent_level: 'private_research',
          visibility: 'researcher',
          metadata_json: {
            source_family: sourceFamily,
            source_field: sourceField,
            source_mode: sourceMode,
            depth_level: depthLevel,
            provenance: safeText(record.provenance || ''),
            consent_scope: safeText(record.consent_scope || ''),
            public_safe: Boolean(record.public_safe),
            content_format: safeText(record.content_format || ''),
          },
        });
      }

      chunks.push({
        id: chunkId,
        dataset_id: datasetId,
        import_batch_id: importBatchId,
        participant_id: participantId,
        display_code: participantCode,
        source_id: sourceId,
        source_type: sourceType,
        chunk_index: chunkIndex(record),
        external_id: record.id,
        content_sha256: contentSha,
        title,
        summary,
        anonymized_text: redacted.text,
        excerpt: redacted.text,
        themes,
        tags,
        sentiment: 'unknown',
        confidence: 0.75,
        token_count: estimateTokens(redacted.text),
        source_ref: safeText(record.provenance || ''),
        contains_sensitive_data: redacted.redacted ? 1 : 0,
        redaction_notes: redacted.redacted
          ? 'Importer redacted contact or secret-like patterns before storage and embedding.'
          : 'No contact or secret-like patterns detected by local importer.',
        consent_level: 'private_research',
        visibility: 'researcher',
        metadata_json: {
          dataset_id: datasetId,
          import_batch_id: importBatchId,
          canonical_participant_id: participantId,
          external_subject_sha256: sha256(subjectId),
          external_id: record.id,
          sequence: chunkIndex(record),
          source_id: sourceId,
          source_path: sourcePath,
          source_family: sourceFamily,
          source_field: sourceField,
          source_mode: sourceMode,
          depth_level: depthLevel,
          manipulability_class: normalizeTagName(record.manipulability_class || ''),
          acquisition_method: normalizeTagName(record.acquisition_method || ''),
          acquisition_date: safeText(record.acquisition_date || ''),
          source_mode_rationale: safeText(record.source_mode_rationale || ''),
          depth_level_rationale: safeText(record.depth_level_rationale || ''),
          family_metadata: safeMetadata(record.family_metadata || {}),
        },
      });
    }
  }

  if (chunks.length === 0) {
    throw new Error(`No usable SLAB evidence records found in ${profilesDir}`);
  }

  const embeddings = await buildEmbeddingRecords(chunks, {
    embeddingProvider: options.embeddingProvider || process.env.ACCELERATOR_EMBEDDING_PROVIDER || 'local',
    embeddingModel: options.embeddingModel || process.env.EMBEDDING_MODEL,
    embeddingModelPath: options.embeddingModelPath || process.env.EMBEDDING_MODEL_PATH,
    embeddingDimensions: options.embeddingDimensions || process.env.EMBEDDING_DIMENSIONS,
    embeddingPromptName: options.embeddingPromptName,
    embeddingCommand: options.embeddingCommand,
    embeddingScript: options.embeddingScript,
    embeddingDevice: options.embeddingDevice,
    embeddingBatchSize: options.embeddingBatchSize,
    embeddingGemmaRunner: options.embeddingGemmaRunner,
  });
  const coordinates = computeUmapCoordinates(embeddings);

  const sourceById = new Map(sources.map(source => [source.id, source]));
  const mapItems = chunks.map((chunk, index) => {
    const embedding = embeddings[index];
    const coord = coordinates[index];
    return {
      ...chunk,
      participant_id: chunk.display_code,
      source: sourceById.get(chunk.source_id),
      embedding_metadata: {
        id: embedding.id,
        provider: embedding.embedding_provider,
        model: embedding.embedding_model,
        dimensions: embedding.embedding_dimensions,
        vector_sha256: embedding.vector_sha256,
        vector_blob_hex: embedding.vector_blob_hex,
        input_sha256: embedding.input_sha256,
      },
      projection: {
        id: coord.id,
        method: coord.projection_method,
        version: coord.projection_version,
        params_json: coord.params_json,
      },
      umap_x: coord.umap_x,
      umap_y: coord.umap_y,
      x: coord.umap_x,
      y: coord.umap_y,
    };
  });

  const dataset = {
    id: datasetId,
    name: datasetName,
    source_repo_url: SLAB_REPO_URL,
    cohort,
    status: 'local_preview',
    metadata_json: {
      importer: 'scripts/import_slab_dataset.mjs',
      privacy: 'redacted-before-storage-and-embedding',
      removable_bucket: datasetId,
    },
  };
  const importBatch = {
    id: importBatchId,
    dataset_id: datasetId,
    repo_url: SLAB_REPO_URL,
    repo_commit_sha: repoCommitSha,
    imported_at: importedAt,
    importer_name: 'scripts/import_slab_dataset.mjs',
    metadata_json: {
      cohort,
      repo_path_sha256: sha256(repoPath),
      skipped_records: skipped,
    },
  };

  const normalized = normalizeAcceleratorExport({
    domain: {
      id: domainId,
      name: domainName,
      parent_id: null,
      level: domainId === 'all' ? 'all' : 'general',
    },
    participants,
    sources,
    map_items: mapItems,
    ask_map: buildAskMap(mapItems),
  }, { domainId, domainName });

  return {
    ...normalized,
    dataset,
    import_batch: importBatch,
    import_summary: {
      participants: participants.length,
      sources: sources.length,
      chunks: chunks.length,
      skipped_records: skipped,
    },
  };
}

function sourceTypeForFamily(sourceFamily) {
  if (sourceFamily === 'interview-transcript') return 'interview';
  if (sourceFamily === 'application-form') return 'application';
  if (/github|website|x-post|x-profile|arxiv|whitepaper|paper/i.test(sourceFamily)) {
    return 'public_trace';
  }
  if (/deep-research|council|perceiver|claim|prediction|roleplay/i.test(sourceFamily)) {
    return 'derived_analysis';
  }
  return 'unknown';
}

function sourceIdFor(datasetId, subjectId, record) {
  return `source_${sha256([
    datasetId,
    subjectId,
    record.source_family,
    record.source_field,
    record.provenance,
  ].join('|')).slice(0, 20)}`;
}

function chunkIndex(record) {
  const match = String(record.id || '').match(/(\d+)$/);
  return match ? Number(match[1]) : 0;
}

function tagsForRecord(record) {
  return [
    ['dataset', 'SLAB'],
    ['source_family', record.source_family],
    ['source_mode', record.source_mode],
    ['depth_level', record.depth_level],
    ['manipulability_class', record.manipulability_class],
    ['acquisition_method', record.acquisition_method],
  ]
    .map(([type, name]) => ({ type, name: normalizeTagName(name) }))
    .filter(tag => tag.name && !/^unknown|null$/i.test(tag.name));
}

function visibleThemeTags(record) {
  return [
    'SLAB',
    ...tagsForRecord(record)
      .filter(tag => ['source_family', 'source_mode', 'depth_level'].includes(tag.type))
      .map(tag => tag.name),
  ].slice(0, 8);
}

function buildAskMap(items) {
  const queries = [
    'Which teams talk about cryptography and data privacy?',
    'Where do teams describe customer traction?',
    'Which founders seem most focused on developer tooling?',
    'What evidence points to uncertainty around go-to-market?',
    'Which teams have the strongest public technical traces?',
  ];

  return {
    questions: queries.map((query, index) => buildQuestion(query, items, index)),
  };
}

function buildQuestion(query, items, index) {
  const matches = items
    .map(item => ({ item, score: scoreItem(item, query) }))
    .sort((a, b) => b.score - a.score || b.item.confidence - a.item.confidence)
    .slice(0, 5)
    .map(entry => entry.item);
  const participantCodes = [...new Set(matches.map(item => item.participant_id))];
  const themes = [...new Set(matches.flatMap(item => item.themes || []))].slice(0, 8);

  return {
    id: `slab-sample-${index + 1}`,
    query,
    aliases: themes,
    themes,
    answer: {
      synthesis: matches.length
        ? `Inference: the nearest local SLAB evidence for ${participantCodes.join(', ')} is shown below. This is retrieval over redacted imported evidence chunks, not a diagnosis or claim beyond displayed sources.`
        : 'No local evidence matched this question.',
      supporting_evidence: matches.map(item => `${item.participant_id}: ${item.summary}`),
      participant_codes: participantCodes,
      highlighted_map_item_ids: matches.map(item => item.id),
      themes,
      suggested_follow_up: 'Which of these evidence points should we inspect next?',
    },
  };
}

function scoreItem(item, query) {
  const terms = query.toLowerCase().split(/\W+/).filter(term => term.length > 3);
  const haystack = [
    item.participant_id,
    item.title,
    item.summary,
    item.excerpt,
    ...(item.themes || []),
  ].join(' ').toLowerCase();
  return terms.reduce((total, term) => total + (haystack.includes(term) ? 1 : 0), 0);
}

function estimateTokens(text) {
  return Math.ceil(String(text || '').split(/\s+/).filter(Boolean).length * 1.25);
}

async function loadManifest(profileDir, subjectId) {
  const manifestPath = join(profileDir, 'profile-manifest.yaml');
  if (!existsSync(manifestPath)) return { subjectId, teamDisplay: subjectId };
  const contents = await readFile(manifestPath, 'utf8');
  return {
    subjectId: yamlTopLevelValue(contents, 'subject_id') || subjectId,
    teamDisplay: yamlTopLevelValue(contents, 'team_display') || subjectId,
    teamTagline: yamlTopLevelValue(contents, 'team_tagline') || '',
  };
}

function yamlTopLevelValue(contents, key) {
  const match = contents.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
  if (!match) return '';
  return safeText(match[1].trim().replace(/^["']|["']$/g, ''));
}

async function gitCommit(repoPath) {
  try {
    const { stdout } = await execFileAsync('git', ['-C', repoPath, 'rev-parse', 'HEAD']);
    return stdout.trim();
  } catch {
    return 'unknown';
  }
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) args[key] = true;
    else args[key] = argv[++i];
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const bundle = await buildSlabDataset({
    repoPath: args.repo,
    cohort: args.cohort,
    datasetId: args.datasetId,
    datasetName: args.datasetName,
    domainId: args.domainId,
    domainName: args.domainName,
    embeddingProvider: args.embeddingProvider,
    embeddingModel: args.embeddingModel,
    embeddingModelPath: args.embeddingModelPath,
    embeddingDimensions: args.embeddingDimensions,
    embeddingPromptName: args.embeddingPromptName,
    embeddingCommand: args.embeddingCommand,
    embeddingScript: args.embeddingScript,
    embeddingDevice: args.embeddingDevice,
    embeddingBatchSize: args.embeddingBatchSize,
  });
  const frontendBundle = stripEmbeddingVectors(bundle);
  const domainOutDir = resolve(args.domainOutDir || DEFAULT_PRIVATE_DOMAIN_DIR);
  const exportOut = resolve(args.out || join(DEFAULT_PRIVATE_EXPORT_DIR, 'slab-export.json'));
  const sqlOut = resolve(args.sqlOut || join(DEFAULT_PRIVATE_EXPORT_DIR, 'slab-seed.sql'));

  await mkdir(domainOutDir, { recursive: true });
  await mkdir(dirname(exportOut), { recursive: true });
  await writeFile(join(domainOutDir, `${frontendBundle.domain.id}.json`), `${JSON.stringify(frontendBundle, null, 2)}\n`);
  await writeFile(join(domainOutDir, 'index.json'), `${JSON.stringify(buildDomainIndex([frontendBundle]), null, 2)}\n`);
  await writeFile(exportOut, `${JSON.stringify(frontendBundle, null, 2)}\n`);

  if (args.writeSql !== false && args.writeSql !== 'false') {
    await mkdir(dirname(sqlOut), { recursive: true });
    await writeFile(sqlOut, toTursoSeedSql(bundle));
  }

  console.log(`Imported ${bundle.import_summary.participants} SLAB participants, ${bundle.import_summary.sources} sources, ${bundle.import_summary.chunks} chunks.`);
  console.log(`Skipped ${bundle.import_summary.skipped_records} low-signal or sensitive-field records.`);
  console.log(`Wrote private browser bundle: ${domainOutDir}`);
  console.log(`Preview with: /mapper/?domainDir=data/private-domains/slab`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
