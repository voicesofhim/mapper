#!/usr/bin/env node
/**
 * Inspect and ingest a partner-owned private dataset without committing source
 * data. The adapter is intentionally schema-flexible: it inventories JSON,
 * JSONL, Markdown, and text exports, proposes an approval contract, then only
 * embeds fields approved by a local review file.
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve } from 'node:path';
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
  slugify,
} from './lib/privacy.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = resolve(__dirname, '..');

const DEFAULT_DATASET_ID = 'partner:local-preview';
const DEFAULT_DATASET_NAME = 'Partner Private Dataset';
const DEFAULT_DOMAIN_ID = 'all';
const DEFAULT_DOMAIN_NAME = 'Partner Private Dataset';
const DEFAULT_PRIVATE_DOMAIN_DIR = join(PROJECT_ROOT, 'data/private-domains/partner');
const DEFAULT_PRIVATE_EXPORT_DIR = join(PROJECT_ROOT, 'data/private-exports/partner');
const SUPPORTED_EXTENSIONS = new Set(['.json', '.jsonl', '.ndjson', '.md', '.markdown', '.txt']);
const IGNORED_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.venv', 'venv', '__pycache__']);
const TEXT_FIELD_HINTS = [
  'text', 'content', 'excerpt', 'summary', 'notes', 'note', 'transcript', 'description',
  'rationale', 'evidence', 'profile_summary', 'analysis', 'reflection', 'bio', 'answer',
];
const LABEL_FIELD_HINTS = [
  'label', 'labels', 'tag', 'tags', 'theme', 'themes', 'trait', 'traits', 'skill', 'skills',
  'need', 'needs', 'offer', 'offers', 'personality', 'profile', 'dimension', 'dimensions',
  'taxonomy', 'category', 'categories',
];
const SUBJECT_FIELD_HINTS = [
  'participant_id', 'participantId', 'subject_id', 'subjectId', 'founder_id', 'founderId',
  'profile_id', 'profileId', 'person_id', 'personId', 'user_id', 'userId', 'team_id', 'teamId',
];

export async function inspectPartnerDataset(options = {}) {
  const sourcePath = resolveRequiredSource(options.sourcePath || options.source || process.env.PARTNER_DATASET_PATH);
  const files = await collectInputFiles(sourcePath);
  const records = [];
  const fieldStats = new Map();
  const privacyFindings = [];
  const skippedFiles = [];

  for (const filePath of files) {
    try {
      const loaded = await loadRecordsFromFile(filePath, sourcePath);
      records.push(...loaded);
      for (const record of loaded) {
        inventoryValue(record.value, '', fieldStats, privacyFindings, record);
      }
    } catch (error) {
      skippedFiles.push({ path: relative(sourcePath, filePath), reason: error.message });
    }
  }

  const candidateRecords = records
    .map(record => analyzeRecord(record))
    .filter(record => record.textFields.length > 0 || record.labelFields.length > 0);
  const labelInventory = buildLabelInventory(candidateRecords);
  const cooccurrence = buildCooccurrence(candidateRecords);
  const ontologyCandidates = buildOntologyCandidates(labelInventory, cooccurrence);
  const recommendedTextFields = recommendFields(fieldStats, 'text');
  const recommendedLabelFields = recommendFields(fieldStats, 'label');
  const deniedFields = recommendDeniedFields(fieldStats);
  const approvalTemplate = buildApprovalTemplate({
    datasetId: options.datasetId || DEFAULT_DATASET_ID,
    datasetName: options.datasetName || DEFAULT_DATASET_NAME,
    sourcePath,
    recommendedTextFields,
    recommendedLabelFields,
    deniedFields,
    ontologyCandidates,
  });

  return {
    mode: 'inspect',
    source_path: sourcePath,
    generated_at: options.generatedAt || new Date().toISOString(),
    files: {
      scanned: files.length,
      skipped: skippedFiles,
    },
    records: {
      loaded: records.length,
      candidate_records: candidateRecords.length,
      with_text: candidateRecords.filter(record => record.textFields.length > 0).length,
      with_labels: candidateRecords.filter(record => record.labelFields.length > 0).length,
    },
    field_inventory: [...fieldStats.values()]
      .sort((a, b) => b.count - a.count || a.path.localeCompare(b.path)),
    privacy_findings: summarizePrivacyFindings(privacyFindings),
    label_inventory: labelInventory,
    tag_cooccurrence: cooccurrence.slice(0, 100),
    ontology_candidates: ontologyCandidates,
    recommended_text_fields: recommendedTextFields,
    recommended_label_fields: recommendedLabelFields,
    denied_fields: deniedFields,
    sample_records: candidateRecords.slice(0, 25).map(summarizeCandidateRecord),
    approval_template: approvalTemplate,
  };
}

export async function buildPartnerDataset(options = {}) {
  const sourcePath = resolveRequiredSource(options.sourcePath || options.source || process.env.PARTNER_DATASET_PATH);
  const approval = await loadApproval(options.approvalPath || options.approval, options.approvalObject);
  if (!approval.approved && !options.allowDraftApproval) {
    throw new Error('Partner ingest requires an approval file with "approved": true. Run inspect mode first, review the template, then pass --approval.');
  }

  const inspection = await inspectPartnerDataset({
    sourcePath,
    datasetId: approval.dataset_id || options.datasetId,
    datasetName: approval.dataset_name || options.datasetName,
    generatedAt: options.importedAt,
  });
  const datasetId = approval.dataset_id || options.datasetId || DEFAULT_DATASET_ID;
  const datasetName = approval.dataset_name || options.datasetName || DEFAULT_DATASET_NAME;
  const domainId = options.domainId || approval.domain_id || DEFAULT_DOMAIN_ID;
  const domainName = options.domainName || approval.domain_name || datasetName || DEFAULT_DOMAIN_NAME;
  const importedAt = options.importedAt || new Date().toISOString();
  const importBatchId = options.importBatchId ||
    `${datasetId}:${sha256(`${sourcePath}:${importedAt}`).slice(0, 12)}:${importedAt.replace(/[:.]/g, '-')}`;

  const files = await collectInputFiles(sourcePath);
  const rawRecords = [];
  for (const filePath of files) {
    rawRecords.push(...await loadRecordsFromFile(filePath, sourcePath));
  }

  const approvedTextFields = new Set(approval.approved_text_fields || []);
  const approvedLabelFields = new Set(approval.approved_label_fields || []);
  const deniedFields = new Set(approval.denied_fields || []);
  const labelMerges = approval.label_merges || {};
  const approvedTagTypes = approvedTagTypesForApproval(approval);
  const records = rawRecords
    .map(record => analyzeRecord(record))
    .filter(record => record.textFields.some(field => isApprovedPath(field.path, approvedTextFields, deniedFields)));

  const participantByKey = new Map();
  const participants = [];
  const sources = [];
  const chunks = [];
  const sourceIds = new Set();
  let skippedTextFields = 0;
  let redactedFields = 0;

  for (const record of records) {
    const subjectKey = subjectKeyForRecord(record);
    let participant = participantByKey.get(subjectKey);
    if (!participant) {
      const displayCode = `PRT-${String(participants.length + 1).padStart(3, '0')}`;
      participant = {
        id: `${datasetId}:participant:${sha256(subjectKey).slice(0, 16)}`,
        dataset_id: datasetId,
        display_code: displayCode,
        role: safeText(valueForAnyPath(record.value, ['role', 'title', 'persona']) || 'partner subject'),
        company_stage: safeText(valueForAnyPath(record.value, ['company_stage', 'stage']) || ''),
        cohort: approval.cohort || '',
        profile_json: participantProfileForRecord(record, approval),
        consent_level: approval.consent_level || 'private_research',
        visibility: approval.visibility || 'researcher',
        anonymization_level: approval.anonymization_level || 'strict',
      };
      participantByKey.set(subjectKey, participant);
      participants.push(participant);
    }

    const approvedLabels = labelsForRecord(record, approvedLabelFields, deniedFields, labelMerges)
      .filter(tag => approvedTagTypes.size === 0 || approvedTagTypes.has(tag.type));
    const themes = visibleThemesForTags(approvedLabels, approval.dataset_theme || 'PARTNER');

    for (const textField of record.textFields) {
      if (!isApprovedPath(textField.path, approvedTextFields, deniedFields)) {
        skippedTextFields += 1;
        continue;
      }
      const redacted = redactSensitiveText(textField.value);
      if (redacted.redacted) redactedFields += 1;
      if (shouldSkipLowSignalContent(redacted.text)) {
        skippedTextFields += 1;
        continue;
      }

      const sourceType = sourceTypeForRecord(record, textField, approval);
      const sourceId = `source_${sha256(`${datasetId}:${record.file}:${record.pointer}:${textField.path}`).slice(0, 20)}`;
      const chunkId = `${datasetId}:chunk:${sha256(`${record.file}:${record.pointer}:${textField.path}:${redacted.text}`).slice(0, 24)}`;
      const summary = firstSentenceSummary(redacted.text);
      const contentSha = sha256(redacted.text);

      if (!sourceIds.has(sourceId)) {
        sourceIds.add(sourceId);
        sources.push({
          id: sourceId,
          dataset_id: datasetId,
          import_batch_id: importBatchId,
          participant_id: participant.id,
          source_type: sourceType,
          title: sourceTitleFor(record, textField, participant.display_code),
          label: `${participant.display_code} · ${textField.path}`,
          source_ref: safeText(record.file),
          source_uri_hash: sha256(record.file),
          collected_at: safeText(valueForAnyPath(record.value, ['created_at', 'createdAt', 'date', 'timestamp']) || ''),
          raw_text_ref: '',
          raw_text_allowed: 0,
          source_path: record.file,
          external_id: record.externalId,
          content_sha256: contentSha,
          consent_level: approval.consent_level || 'private_research',
          visibility: approval.visibility || 'researcher',
          metadata_json: {
            importer: 'scripts/import_partner_dataset.mjs',
            record_pointer: record.pointer,
            approved_text_field: textField.path,
            source_file_sha256: sha256(record.file),
          },
        });
      }

      chunks.push({
        id: chunkId,
        dataset_id: datasetId,
        import_batch_id: importBatchId,
        participant_id: participant.id,
        display_code: participant.display_code,
        source_id: sourceId,
        source_type: sourceType,
        chunk_index: chunks.length + 1,
        external_id: record.externalId,
        content_sha256: contentSha,
        title: sourceTitleFor(record, textField, participant.display_code),
        summary,
        anonymized_text: redacted.text,
        excerpt: redacted.text,
        themes,
        tags: [
          { type: 'dataset', name: approval.dataset_theme || 'PARTNER', origin: 'importer', confidence: 1 },
          ...approvedLabels,
        ],
        sentiment: 'unknown',
        confidence: Number(approval.default_confidence ?? 0.72),
        token_count: estimateTokens(redacted.text),
        source_ref: safeText(record.file),
        contains_sensitive_data: redacted.redacted ? 1 : 0,
        redaction_notes: redacted.redacted
          ? 'Partner importer redacted contact or secret-like patterns before storage and embedding.'
          : 'No contact or secret-like patterns detected by local importer.',
        consent_level: approval.consent_level || 'private_research',
        visibility: approval.visibility || 'researcher',
        metadata_json: {
          dataset_id: datasetId,
          import_batch_id: importBatchId,
          canonical_participant_id: participant.id,
          source_id: sourceId,
          source_path: record.file,
          source_file_sha256: sha256(record.file),
          record_pointer: record.pointer,
          external_id: record.externalId,
          approved_text_field: textField.path,
          original_label_count: approvedLabels.length,
          token_count: estimateTokens(redacted.text),
        },
      });
    }
  }

  if (chunks.length === 0) {
    throw new Error('No approved partner chunks were produced. Check approved_text_fields and denied_fields in the approval file.');
  }

  const embeddings = await buildEmbeddingRecords(chunks, {
    embeddingProvider: options.embeddingProvider || approval.embedding_provider || process.env.ACCELERATOR_EMBEDDING_PROVIDER || 'local',
    embeddingModel: options.embeddingModel || approval.embedding_model || process.env.EMBEDDING_MODEL,
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
    source_repo_url: '',
    cohort: approval.cohort || '',
    status: 'local_preview',
    metadata_json: {
      importer: 'scripts/import_partner_dataset.mjs',
      privacy: 'approval-gated-redacted-before-embedding',
      source_path_sha256: sha256(sourcePath),
      ontology_version: approval.ontology_version || 'candidate',
    },
  };
  const importBatch = {
    id: importBatchId,
    dataset_id: datasetId,
    repo_url: '',
    repo_commit_sha: '',
    imported_at: importedAt,
    importer_name: 'scripts/import_partner_dataset.mjs',
    metadata_json: {
      approval_sha256: sha256(JSON.stringify(approval)),
      source_path_sha256: sha256(sourcePath),
      redacted_fields: redactedFields,
      skipped_text_fields: skippedTextFields,
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
    ask_map: buildAskMap(mapItems, approval.dataset_theme || 'PARTNER'),
  }, { domainId, domainName });

  return {
    ...normalized,
    dataset,
    import_batch: importBatch,
    import_summary: {
      participants: participants.length,
      sources: sources.length,
      chunks: chunks.length,
      skipped_text_fields: skippedTextFields,
      redacted_fields: redactedFields,
      ontology_candidates: inspection.ontology_candidates.length,
    },
    ontology_report: {
      label_inventory: inspection.label_inventory,
      ontology_candidates: inspection.ontology_candidates,
      tag_cooccurrence: inspection.tag_cooccurrence,
    },
  };
}

async function collectInputFiles(sourcePath) {
  const info = await stat(sourcePath);
  if (info.isFile()) return SUPPORTED_EXTENSIONS.has(extname(sourcePath).toLowerCase()) ? [sourcePath] : [];
  const files = [];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) await walk(join(dir, entry.name));
        continue;
      }
      if (entry.isFile() && SUPPORTED_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
        files.push(join(dir, entry.name));
      }
    }
  }
  await walk(sourcePath);
  return files.sort();
}

async function loadRecordsFromFile(filePath, sourceRoot) {
  const extension = extname(filePath).toLowerCase();
  const contents = await readFile(filePath, 'utf8');
  const file = relative(sourceRoot, filePath) || filePath;
  if (extension === '.json') {
    return extractJsonRecords(JSON.parse(contents), { file, pointer: '$' });
  }
  if (extension === '.jsonl' || extension === '.ndjson') {
    return contents.split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)
      .flatMap((line, index) => extractJsonRecords(JSON.parse(line), { file, pointer: `$[${index}]` }));
  }
  return [{
    file,
    pointer: '$',
    externalId: sha256(`${file}:${contents}`).slice(0, 16),
    value: {
      id: file.replace(/\.[^.]+$/, ''),
      content: contents,
      source_file: file,
    },
  }];
}

function extractJsonRecords(value, context) {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => extractJsonRecords(entry, {
      file: context.file,
      pointer: `${context.pointer}[${index}]`,
      parentSubjectKey: context.parentSubjectKey,
    }));
  }
  if (!value || typeof value !== 'object') return [];

  const records = [];
  const subjectKey = explicitSubjectKey(value) || context.parentSubjectKey;
  if (looksLikeRecord(value)) {
    records.push({
      file: context.file,
      pointer: context.pointer,
      externalId: String(value.id || value.record_id || value.uuid || sha256(`${context.file}:${context.pointer}`).slice(0, 16)),
      parentSubjectKey: context.parentSubjectKey,
      value,
    });
  }

  for (const [key, entry] of Object.entries(value)) {
    if (Array.isArray(entry) && entry.some(item => item && typeof item === 'object')) {
      records.push(...entry.flatMap((item, index) => extractJsonRecords(item, {
        file: context.file,
        pointer: `${context.pointer}.${key}[${index}]`,
        parentSubjectKey: subjectKey,
      })));
    }
  }

  return records.length ? records : [{
    file: context.file,
    pointer: context.pointer,
    externalId: String(value.id || sha256(`${context.file}:${context.pointer}`).slice(0, 16)),
    parentSubjectKey: context.parentSubjectKey,
    value,
  }];
}

function looksLikeRecord(value) {
  const keys = Object.keys(value);
  return keys.some(key => hintIncludes(key, TEXT_FIELD_HINTS) || hintIncludes(key, LABEL_FIELD_HINTS) || SUBJECT_FIELD_HINTS.includes(key));
}

function inventoryValue(value, path, stats, privacyFindings, record) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => inventoryValue(entry, `${path}[]`, stats, privacyFindings, record));
    return;
  }
  if (!value || typeof value !== 'object') {
    if (!path) return;
    const stat = stats.get(path) || {
      path,
      count: 0,
      text_like: false,
      label_like: false,
      sensitive_field: false,
      sample_values: [],
    };
    stat.count += 1;
    stat.text_like = stat.text_like || isTextLikePath(path);
    stat.label_like = stat.label_like || isLabelLikePath(path);
    stat.sensitive_field = stat.sensitive_field || path.split('.').some(shouldSkipSensitiveField);
    if (stat.sample_values.length < 5 && value != null && String(value).trim()) {
      stat.sample_values.push(redactSensitiveText(String(value)).text.slice(0, 120));
    }
    stats.set(path, stat);
    if (stat.sensitive_field || containsSensitivePattern(value)) {
      privacyFindings.push({
        file: record.file,
        pointer: record.pointer,
        path,
        reason: stat.sensitive_field ? 'sensitive-field-name' : 'sensitive-looking-value',
      });
    }
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    const nextPath = path ? `${path}.${key}` : key;
    inventoryValue(entry, nextPath, stats, privacyFindings, record);
  }
}

function analyzeRecord(record) {
  const textFields = [];
  const labelFields = [];
  visitLeafValues(record.value, '', (path, value) => {
    if (path.split('.').some(shouldSkipSensitiveField)) return;
    if (typeof value === 'string' && isTextLikePath(path) && !shouldSkipLowSignalContent(value) && value.trim().length >= 24) {
      textFields.push({ path, value: redactSensitiveText(value).text });
    }
    if (isLabelLikePath(path)) {
      const labels = extractLabels(value, path);
      if (labels.length) labelFields.push({ path, labels });
    }
  });
  return {
    ...record,
    textFields,
    labelFields,
  };
}

function visitLeafValues(value, path, visitor) {
  if (Array.isArray(value)) {
    visitor(path, value);
    value.forEach((entry, index) => visitLeafValues(entry, `${path}[]${typeof entry === 'object' ? '' : ''}`, visitor));
    return;
  }
  if (value && typeof value === 'object') {
    visitor(path, value);
    for (const [key, entry] of Object.entries(value)) {
      visitLeafValues(entry, path ? `${path}.${key}` : key, visitor);
    }
    return;
  }
  visitor(path, value);
}

function extractLabels(value, path) {
  const labels = [];
  if (typeof value === 'string') {
    const parts = value.includes(',') ? value.split(',') : [value];
    labels.push(...parts.map(label => label.trim()).filter(label => label.length > 1));
  } else if (Array.isArray(value)) {
    for (const entry of value) {
      if (typeof entry === 'string') labels.push(entry);
      else if (entry && typeof entry === 'object') {
        const name = entry.name || entry.label || entry.tag || entry.value || entry.id;
        if (name) labels.push(String(name));
      }
    }
  } else if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      if (shouldSkipSensitiveField(key)) continue;
      if (typeof entry === 'boolean' && entry) labels.push(key);
      else if (typeof entry === 'number' && Number.isFinite(entry)) labels.push(`${key}:${entry}`);
      else if (typeof entry === 'string' && entry.trim() && entry.length < 80) labels.push(`${key}:${entry}`);
    }
  }
  return labels
    .map(label => ({ type: inferTagType(path, label), name: normalizeTagName(label) }))
    .filter(tag => tag.name && !/^null|none|n\/a$/i.test(tag.name));
}

function buildLabelInventory(records) {
  const inventory = new Map();
  for (const record of records) {
    const seen = new Set();
    for (const field of record.labelFields) {
      for (const label of field.labels) {
        const key = `${label.type}:${label.name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const item = inventory.get(key) || {
          type: label.type,
          name: label.name,
          normalized_name: slugify(label.name),
          count: 0,
          fields: {},
          example_record_ids: [],
        };
        item.count += 1;
        item.fields[field.path] = (item.fields[field.path] || 0) + 1;
        if (item.example_record_ids.length < 5) item.example_record_ids.push(`${record.file}${record.pointer}`);
        inventory.set(key, item);
      }
    }
  }
  return [...inventory.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

function buildCooccurrence(records) {
  const pairs = new Map();
  for (const record of records) {
    const labels = [...new Set(record.labelFields.flatMap(field =>
      field.labels.map(label => `${label.type}:${label.name}`)
    ))].sort();
    for (let i = 0; i < labels.length; i += 1) {
      for (let j = i + 1; j < labels.length; j += 1) {
        const key = `${labels[i]}|||${labels[j]}`;
        pairs.set(key, (pairs.get(key) || 0) + 1);
      }
    }
  }
  return [...pairs.entries()]
    .map(([key, count]) => {
      const [a, b] = key.split('|||');
      return { a, b, count };
    })
    .sort((a, b) => b.count - a.count || a.a.localeCompare(b.a));
}

function buildOntologyCandidates(labelInventory, cooccurrence) {
  const bySlug = new Map();
  for (const label of labelInventory) {
    const slug = label.normalized_name.replace(/\b(needs?|has|is|high|low)-/g, '');
    const group = bySlug.get(`${label.type}:${slug}`) || {
      proposed_tag: `${label.type}:${slug || label.normalized_name}`,
      type: label.type,
      canonical_name: slug || label.normalized_name,
      aliases: [],
      count: 0,
      confidence: 0,
      review_status: 'candidate',
      evidence: [],
      common_cooccurrences: [],
    };
    group.aliases.push(label.name);
    group.count += label.count;
    group.evidence.push(...label.example_record_ids.slice(0, 2));
    bySlug.set(`${label.type}:${slug}`, group);
  }
  const candidates = [...bySlug.values()]
    .map(candidate => ({
      ...candidate,
      aliases: [...new Set(candidate.aliases)].slice(0, 12),
      evidence: [...new Set(candidate.evidence)].slice(0, 8),
      confidence: Number(Math.min(0.9, 0.45 + Math.log1p(candidate.count) / 8).toFixed(2)),
      common_cooccurrences: cooccurrence
        .filter(pair => candidate.aliases.some(alias => pair.a.endsWith(`:${alias}`) || pair.b.endsWith(`:${alias}`)))
        .slice(0, 5),
    }))
    .sort((a, b) => b.count - a.count || a.proposed_tag.localeCompare(b.proposed_tag));
  return candidates;
}

function buildApprovalTemplate({ datasetId, datasetName, sourcePath, recommendedTextFields, recommendedLabelFields, deniedFields, ontologyCandidates }) {
  return {
    approved: false,
    review_note: 'Set approved to true only after reviewing import-report.md, privacy-findings.json, and ontology-candidates.json.',
    dataset_id: datasetId,
    dataset_name: datasetName,
    dataset_theme: 'PARTNER',
    source_path_sha256: sha256(sourcePath),
    consent_level: 'private_research',
    visibility: 'researcher',
    anonymization_level: 'strict',
    default_source_type: 'derived_analysis',
    ontology_version: 'partner-candidate-v0',
    approved_text_fields: recommendedTextFields.map(field => field.path),
    approved_label_fields: recommendedLabelFields.map(field => field.path),
    denied_fields: deniedFields.map(field => field.path),
    approved_tag_types: [...new Set(ontologyCandidates.map(candidate => candidate.type))],
    label_merges: Object.fromEntries(ontologyCandidates.slice(0, 20).flatMap(candidate =>
      candidate.aliases.map(alias => [`${candidate.type}:${alias}`, candidate.proposed_tag])
    )),
    embedding_provider: 'local',
  };
}

function summarizeCandidateRecord(record) {
  return {
    file: record.file,
    pointer: record.pointer,
    external_id: record.externalId,
    text_fields: record.textFields.slice(0, 8).map(field => ({
      path: field.path,
      preview: redactSensitiveText(field.value).text.slice(0, 240),
    })),
    label_fields: record.labelFields.slice(0, 8),
  };
}

function recommendFields(stats, kind) {
  return [...stats.values()]
    .filter(stat => kind === 'text' ? stat.text_like && !stat.sensitive_field : stat.label_like && !stat.sensitive_field)
    .sort((a, b) => b.count - a.count || a.path.localeCompare(b.path))
    .slice(0, 40)
    .map(stat => ({ path: stat.path, count: stat.count, sample_values: stat.sample_values }));
}

function recommendDeniedFields(stats) {
  return [...stats.values()]
    .filter(stat => stat.sensitive_field)
    .sort((a, b) => b.count - a.count || a.path.localeCompare(b.path))
    .map(stat => ({ path: stat.path, count: stat.count, reason: 'sensitive-field-name' }));
}

function summarizePrivacyFindings(findings) {
  const byPath = new Map();
  for (const finding of findings) {
    const item = byPath.get(finding.path) || { path: finding.path, count: 0, reasons: {}, examples: [] };
    item.count += 1;
    item.reasons[finding.reason] = (item.reasons[finding.reason] || 0) + 1;
    if (item.examples.length < 5) item.examples.push({ file: finding.file, pointer: finding.pointer });
    byPath.set(finding.path, item);
  }
  return [...byPath.values()].sort((a, b) => b.count - a.count || a.path.localeCompare(b.path));
}

function labelsForRecord(record, approvedLabelFields, deniedFields, labelMerges) {
  const tags = [];
  for (const field of record.labelFields) {
    if (!isApprovedPath(field.path, approvedLabelFields, deniedFields)) continue;
    for (const label of field.labels) {
      const merge = labelMerges[`${label.type}:${label.name}`] || labelMerges[label.name];
      if (merge && merge.includes(':')) {
        const [type, ...rest] = merge.split(':');
        tags.push({ type, name: rest.join(':'), origin: 'ontology_candidate', confidence: 0.8, rationale: `Merged from ${label.type}:${label.name}` });
      } else {
        tags.push({ ...label, origin: 'partner_import', confidence: 0.75 });
      }
    }
  }
  const unique = new Map();
  for (const tag of tags) unique.set(`${tag.type}:${tag.name}`, tag);
  return [...unique.values()];
}

function approvedTagTypesForApproval(approval) {
  const types = new Set(approval.approved_tag_types || []);
  for (const target of Object.values(approval.label_merges || {})) {
    if (typeof target === 'string' && target.includes(':')) {
      types.add(target.split(':')[0]);
    }
  }
  return types;
}

function participantProfileForRecord(record, approval) {
  const allowed = new Set(approval.approved_profile_fields || []);
  if (!allowed.size) return {
    source_record_sha256: sha256(`${record.file}:${record.pointer}`),
    profile_policy: 'profile fields withheld unless approved_profile_fields is set',
  };
  const profile = {};
  for (const path of allowed) {
    if (path.split('.').some(shouldSkipSensitiveField)) continue;
    const value = valueAtPath(record.value, path);
    if (value != null) profile[path] = safeMetadata(value);
  }
  profile.source_record_sha256 = sha256(`${record.file}:${record.pointer}`);
  return profile;
}

function visibleThemesForTags(tags, datasetTheme) {
  return [
    datasetTheme,
    ...tags
      .filter(tag => ['personality_trait', 'participant_skill', 'participant_need', 'support_need', 'collaboration_style', 'tension', 'partner_label'].includes(tag.type))
      .map(tag => tag.name),
  ].filter(Boolean).slice(0, 8);
}

function buildAskMap(items, datasetTheme) {
  const queries = [
    'Which participants share similar support needs?',
    'What personality or collaboration patterns appear in this dataset?',
    'Where do existing partner labels cluster together?',
  ];
  return {
    questions: queries.map((query, index) => {
      const matches = items
        .map(item => ({ item, score: scoreItem(item, query) }))
        .sort((a, b) => b.score - a.score || b.item.confidence - a.item.confidence)
        .slice(0, 5)
        .map(entry => entry.item);
      const participantCodes = [...new Set(matches.map(item => item.participant_id))];
      const themes = [...new Set([datasetTheme, ...matches.flatMap(item => item.themes || [])])].slice(0, 8);
      return {
        id: `partner-sample-${index + 1}`,
        query,
        aliases: themes,
        themes,
        answer: {
          synthesis: matches.length
            ? `Inference: the nearest approved partner evidence for ${participantCodes.join(', ')} is shown below. Treat this as a review prompt, not a final ontology decision.`
            : 'No approved partner evidence matched this question.',
          supporting_evidence: matches.map(item => `${item.participant_id}: ${item.summary}`),
          participant_codes: participantCodes,
          highlighted_map_item_ids: matches.map(item => item.id),
          themes,
          suggested_follow_up: 'Which proposed tags should be promoted, merged, or rejected?',
        },
      };
    }),
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
    ...(item.tags || []).map(tag => `${tag.type} ${tag.name}`),
  ].join(' ').toLowerCase();
  return terms.reduce((total, term) => total + (haystack.includes(term) ? 1 : 0), 0);
}

function sourceTitleFor(record, textField, displayCode) {
  const title = valueForAnyPath(record.value, ['title', 'name', 'label']);
  return safeText(title || `${displayCode} ${textField.path}`);
}

function sourceTypeForRecord(record, textField, approval) {
  const overrides = approval.source_type_by_field || {};
  return overrides[textField.path] || overrides[textField.path.split('.').at(-1)] || approval.default_source_type || 'derived_analysis';
}

function subjectKeyForRecord(record) {
  if (record.parentSubjectKey) return record.parentSubjectKey;
  const explicit = explicitSubjectKey(record.value);
  if (explicit) return explicit;
  const loose = valueForAnyPath(record.value, SUBJECT_FIELD_HINTS);
  return loose ? `loose:${loose}` : `record:${record.file}:${record.pointer}`;
}

function explicitSubjectKey(value) {
  for (const path of SUBJECT_FIELD_HINTS) {
    const fieldValue = valueAtPath(value, path);
    if (fieldValue != null && String(fieldValue).trim()) return `${path}:${String(fieldValue).trim()}`;
  }
  return '';
}

function valueForAnyPath(value, paths) {
  for (const path of paths) {
    const direct = valueAtPath(value, path);
    if (direct != null && direct !== '') return direct;
  }
  let found;
  visitLeafValues(value, '', (path, entry) => {
    if (found != null) return;
    const basename = path.split('.').at(-1);
    if (paths.includes(basename) && entry != null && typeof entry !== 'object') found = entry;
  });
  return found;
}

function valueAtPath(value, path) {
  return String(path).split('.').reduce((current, key) => {
    if (current == null) return undefined;
    return current[key];
  }, value);
}

function isApprovedPath(path, approved, denied) {
  if (matchesPathSet(path, denied)) return false;
  return approved.size === 0 || matchesPathSet(path, approved);
}

function matchesPathSet(path, set) {
  if (!set || set.size === 0) return false;
  const basename = path.split('.').at(-1);
  return set.has(path) || set.has(basename);
}

function isTextLikePath(path) {
  const basename = path.split('.').at(-1) || path;
  return hintIncludes(basename, TEXT_FIELD_HINTS);
}

function isLabelLikePath(path) {
  const basename = path.split('.').at(-1) || path;
  return hintIncludes(basename, LABEL_FIELD_HINTS);
}

function hintIncludes(value, hints) {
  const normalized = String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '_');
  return hints.some(hint => normalized === hint || normalized.includes(hint));
}

function inferTagType(path, label) {
  const text = `${path} ${label}`.toLowerCase();
  if (/skill|capabilit|expertise/.test(text)) return 'participant_skill';
  if (/need|gap|blocker|support/.test(text)) return 'participant_need';
  if (/offer|help/.test(text)) return 'help_offer';
  if (/personality|trait|profile|dimension|openness|conscientious|agency/.test(text)) return 'personality_trait';
  if (/collab|mentor|advice|working_style|working-style/.test(text)) return 'collaboration_style';
  if (/risk|tension|concern|conflict/.test(text)) return 'tension';
  if (/theme/.test(text)) return 'theme';
  return 'partner_label';
}

function containsSensitivePattern(value) {
  const text = String(value ?? '');
  return /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(text) ||
    /\b(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)\d{3}[-.\s]?\d{4}\b/.test(text) ||
    /\b(?:API[_-]?KEY|SECRET|TOKEN|PASSWORD|PRIVATE[_-]?KEY)\b/i.test(text);
}

function estimateTokens(text) {
  return Math.ceil(String(text || '').split(/\s+/).filter(Boolean).length * 1.25);
}

async function loadApproval(path, approvalObject) {
  if (approvalObject) return approvalObject;
  if (!path) {
    const defaultPath = join(DEFAULT_PRIVATE_EXPORT_DIR, 'import-approval.json');
    if (existsSync(defaultPath)) return JSON.parse(await readFile(defaultPath, 'utf8'));
    throw new Error(`Missing approval file. Run: npm run import:partner -- --source <path> --mode inspect, then review ${defaultPath}`);
  }
  return JSON.parse(await readFile(resolve(path), 'utf8'));
}

function resolveRequiredSource(sourcePath) {
  if (!sourcePath) throw new Error('Pass --source /path/to/partner/export or set PARTNER_DATASET_PATH.');
  const resolved = resolve(sourcePath);
  if (!existsSync(resolved)) throw new Error(`Partner source path does not exist: ${resolved}`);
  return resolved;
}

function markdownReport(report) {
  const lines = [
    '# Partner Dataset Import Inspection',
    '',
    `Generated: ${report.generated_at}`,
    `Source path SHA-256: ${sha256(report.source_path)}`,
    '',
    '## Summary',
    '',
    `- Files scanned: ${report.files.scanned}`,
    `- Records loaded: ${report.records.loaded}`,
    `- Candidate records: ${report.records.candidate_records}`,
    `- Records with text: ${report.records.with_text}`,
    `- Records with labels: ${report.records.with_labels}`,
    `- Privacy finding groups: ${report.privacy_findings.length}`,
    `- Ontology candidates: ${report.ontology_candidates.length}`,
    '',
    '## Recommended Text Fields',
    '',
    ...report.recommended_text_fields.slice(0, 20).map(field => `- ${field.path} (${field.count})`),
    '',
    '## Recommended Label Fields',
    '',
    ...report.recommended_label_fields.slice(0, 20).map(field => `- ${field.path} (${field.count})`),
    '',
    '## Privacy Findings',
    '',
    ...(report.privacy_findings.length
      ? report.privacy_findings.slice(0, 20).map(field => `- ${field.path} (${field.count}): ${Object.keys(field.reasons).join(', ')}`)
      : ['- None found by local regex/name scan.']),
    '',
    '## Top Ontology Candidates',
    '',
    ...report.ontology_candidates.slice(0, 30).map(candidate =>
      `- ${candidate.proposed_tag} (${candidate.count}) aliases: ${candidate.aliases.join(', ')}`
    ),
    '',
    '## Next Step',
    '',
    'Review `import-approval.template.json`, save an edited copy as `import-approval.json`, set `approved` to `true`, then run ingest mode.',
  ];
  return `${lines.join('\n')}\n`;
}

async function writeInspectionArtifacts(report, outDir) {
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, 'import-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(join(outDir, 'import-report.md'), markdownReport(report));
  await writeFile(join(outDir, 'label-inventory.json'), `${JSON.stringify(report.label_inventory, null, 2)}\n`);
  await writeFile(join(outDir, 'tag-cooccurrence.json'), `${JSON.stringify(report.tag_cooccurrence, null, 2)}\n`);
  await writeFile(join(outDir, 'privacy-findings.json'), `${JSON.stringify(report.privacy_findings, null, 2)}\n`);
  await writeFile(join(outDir, 'ontology-candidates.json'), `${JSON.stringify(report.ontology_candidates, null, 2)}\n`);
  await writeFile(join(outDir, 'sample-records.json'), `${JSON.stringify(report.sample_records, null, 2)}\n`);
  await writeFile(join(outDir, 'import-approval.template.json'), `${JSON.stringify(report.approval_template, null, 2)}\n`);
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
  const mode = args.mode || 'inspect';
  const exportOutDir = resolve(args.exportOutDir || DEFAULT_PRIVATE_EXPORT_DIR);

  if (mode === 'inspect') {
    const report = await inspectPartnerDataset({
      sourcePath: args.source,
      datasetId: args.datasetId,
      datasetName: args.datasetName,
    });
    await writeInspectionArtifacts(report, exportOutDir);
    console.log(`Inspected ${report.records.candidate_records} candidate partner records.`);
    console.log(`Wrote review artifacts: ${exportOutDir}`);
    console.log(`Edit approval template: ${join(exportOutDir, 'import-approval.template.json')}`);
    return;
  }

  if (mode !== 'ingest') throw new Error(`Unsupported mode "${mode}". Use --mode inspect or --mode ingest.`);

  const bundle = await buildPartnerDataset({
    sourcePath: args.source,
    approvalPath: args.approval,
    domainId: args.domainId,
    domainName: args.domainName,
    importedAt: args.importedAt,
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
  const exportOut = resolve(args.out || join(exportOutDir, 'partner-export.json'));
  const sqlOut = resolve(args.sqlOut || join(exportOutDir, 'partner-seed.sql'));

  await mkdir(domainOutDir, { recursive: true });
  await mkdir(dirname(exportOut), { recursive: true });
  await writeFile(join(domainOutDir, `${frontendBundle.domain.id}.json`), `${JSON.stringify(frontendBundle, null, 2)}\n`);
  await writeFile(join(domainOutDir, 'index.json'), `${JSON.stringify(buildDomainIndex([frontendBundle]), null, 2)}\n`);
  await writeFile(exportOut, `${JSON.stringify(frontendBundle, null, 2)}\n`);
  await writeFile(join(exportOutDir, 'ontology-report.json'), `${JSON.stringify(bundle.ontology_report, null, 2)}\n`);

  if (args.writeSql !== false && args.writeSql !== 'false') {
    await mkdir(dirname(sqlOut), { recursive: true });
    await writeFile(sqlOut, toTursoSeedSql(bundle));
  }

  console.log(`Imported ${bundle.import_summary.participants} participants, ${bundle.import_summary.sources} sources, ${bundle.import_summary.chunks} chunks.`);
  console.log(`Wrote private browser bundle: ${domainOutDir}`);
  console.log('Preview with: /mapper/?domainDir=data/private-domains/partner');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
