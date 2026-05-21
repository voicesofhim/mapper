#!/usr/bin/env node
/**
 * Export accelerator research data into Mapper-compatible static domain JSON.
 *
 * Inputs can be either:
 * - --input path/to/export.json
 * - --turso-url libsql://... --auth-token ...
 *
 * The Turso path expects the canonical schema in scripts/accelerator-schema.sql.
 * UMAP coordinates are treated as precomputed data and are never recomputed in
 * the frontend.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = resolve(__dirname, '..');

const DEFAULT_REGION = { x_min: 0, x_max: 1, y_min: 0, y_max: 1 };

export function normalizeAcceleratorExport(raw, options = {}) {
  const domainId = options.domainId || raw.domain?.id || 'all';
  const domainName = options.domainName || raw.domain?.name || 'Accelerator Research';
  const participants = (raw.participants || []).map(normalizeParticipant);
  const participantIds = new Set(participants.flatMap(p => [p.id, p.display_code].filter(Boolean)));

  const mapItems = (raw.map_items || raw.chunks || []).map((item, index) =>
    normalizeMapItem(item, index, participantIds)
  );

  return {
    schema_version: 'accelerator-demo-v1',
    domain: {
      id: domainId,
      name: domainName,
      parent_id: raw.domain?.parent_id ?? null,
      level: domainId === 'all' ? 'all' : 'general',
      content_model: 'accelerator_research',
      region: raw.domain?.region || computeRegion(mapItems),
      grid_size: raw.domain?.grid_size || 50,
    },
    participants,
    map_items: mapItems,
    articles: mapItems,
    labels: raw.labels || [],
    ask_map: raw.ask_map || { questions: [] },
    questions: raw.questions?.length ? raw.questions : (raw.ask_map?.questions || []),
  };
}

export function buildDomainIndex(domains) {
  return {
    schema_version: 'accelerator-demo-v1',
    domains: domains.map(bundle => ({
      id: bundle.domain.id,
      name: bundle.domain.name,
      parent_id: bundle.domain.parent_id,
      level: bundle.domain.level,
      content_model: 'accelerator_research',
      region: bundle.domain.region,
      grid_size: bundle.domain.grid_size,
      question_count: bundle.questions?.length || bundle.ask_map?.questions?.length || 0,
    })),
  };
}

function normalizeParticipant(row) {
  return {
    id: String(row.id),
    display_code: row.display_code || row.displayCode || String(row.id),
    role: row.role || '',
    company_stage: row.company_stage || row.companyStage || '',
    cohort: row.cohort || '',
    profile_json: parseJson(row.profile_json || row.profileJson || {}, {}),
    consent_level: row.consent_level || row.consentLevel || 'anonymized_research',
    visibility: row.visibility || 'researcher',
    anonymization_level: row.anonymization_level || row.anonymizationLevel || 'standard',
  };
}

function normalizeMapItem(row, index, participantIds) {
  const id = row.id || row.chunk_id || `chunk-${String(index + 1).padStart(4, '0')}`;
  const x = numberOr(row.x, row.umap_x, row.umapX);
  const y = numberOr(row.y, row.umap_y, row.umapY);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error(`Map item ${id} is missing finite precomputed UMAP coordinates.`);
  }

  const participantId = row.participant_id || row.participantId || row.display_code || row.displayCode || '';
  if (participantId && participantIds.size > 0 && !participantIds.has(participantId)) {
    throw new Error(`Map item ${id} references unknown participant ${participantId}.`);
  }

  return {
    id: String(id),
    participant_id: participantId,
    source_type: row.source_type || row.sourceType || 'interview',
    title: row.title || `Evidence ${id}`,
    summary: row.summary || '',
    excerpt: row.excerpt || row.anonymized_text || row.anonymizedText || '',
    anonymized_text: row.anonymized_text || row.anonymizedText || row.excerpt || '',
    themes: Array.isArray(row.themes) ? row.themes : String(row.themes || '').split(',').map(s => s.trim()).filter(Boolean),
    sentiment: row.sentiment || 'unknown',
    confidence: Number(row.confidence ?? 0.75),
    umap_x: x,
    umap_y: y,
    x,
    y,
    metadata_json: parseJson(row.metadata_json || row.metadataJson || {}, {}),
    source: parseJson(row.source || row.source_json || row.sourceJson || {}, {}),
    embedding_metadata: parseJson(row.embedding_metadata || row.embeddingMetadata || {}, {}),
    projection: parseJson(row.projection || row.projection_json || row.projectionJson || {}, {}),
    consent_level: row.consent_level || row.consentLevel || 'anonymized_research',
    visibility: row.visibility || 'researcher',
  };
}

function computeRegion(items) {
  if (!items.length) return DEFAULT_REGION;
  const xs = items.map(i => i.x);
  const ys = items.map(i => i.y);
  const pad = 0.06;
  return {
    x_min: clamp(Math.min(...xs) - pad),
    x_max: clamp(Math.max(...xs) + pad),
    y_min: clamp(Math.min(...ys) - pad),
    y_max: clamp(Math.max(...ys) + pad),
  };
}

function numberOr(...values) {
  for (const value of values) {
    if (value == null || value === '') continue;
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return NaN;
}

function parseJson(value, fallback) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function clamp(value) {
  return Math.max(0, Math.min(1, Number(value)));
}

async function loadFromInput(path) {
  return JSON.parse(await readFile(resolve(path), 'utf8'));
}

async function loadFromTurso(url, authToken) {
  let createClient;
  try {
    ({ createClient } = await import('@libsql/client'));
  } catch {
    throw new Error('Install @libsql/client to export directly from Turso, or use --input with a JSON export.');
  }

  const db = createClient({ url, authToken });
  const participants = (await db.execute(`
    select
      id, display_code, role, company_stage, cohort, profile_json,
      consent_level, visibility, anonymization_level
    from participants
    where consent_level != 'withdrawn'
  `)).rows;
  const sources = (await db.execute('select * from sources where consent_level != "withdrawn"')).rows;
  const sourceById = new Map(sources.map(source => [source.id, source]));
  const themes = (await db.execute('select * from themes')).rows;
  const themeById = new Map(themes.map(theme => [theme.id, theme.name]));
  const chunkThemes = (await db.execute('select * from chunk_themes')).rows;
  const themesByChunk = new Map();
  for (const row of chunkThemes) {
    const list = themesByChunk.get(row.chunk_id) || [];
    list.push(themeById.get(row.theme_id) || row.theme_id);
    themesByChunk.set(row.chunk_id, list);
  }

  const chunks = (await db.execute(`
    select
      c.id,
      c.participant_id as canonical_participant_id,
      p.display_code as participant_id,
      c.source_id,
      c.source_type,
      c.title,
      c.summary,
      c.anonymized_text,
      coalesce(c.excerpt, c.anonymized_text) as excerpt,
      c.sentiment,
      c.confidence,
      c.metadata_json,
      c.consent_level,
      c.visibility,
      u.umap_x,
      u.umap_y,
      e.id as embedding_id,
      e.embedding_provider,
      e.embedding_model,
      e.embedding_dimensions,
      e.vector_sha256,
      e.input_sha256,
      u.id as projection_id,
      u.projection_method,
      u.projection_version,
      u.params_json as projection_params_json
    from chunks c
    join participants p on p.id = c.participant_id
    join umap_coordinates u on u.chunk_id = c.id
    left join embeddings e on e.id = u.embedding_id
    where c.consent_level != 'withdrawn'
      and c.visibility in ('researcher', 'participant', 'public')
  `)).rows;

  let askQuestions = [];
  try {
    const researchQuestions = (await db.execute('select * from research_questions')).rows;
    const questionEvidence = (await db.execute('select * from question_evidence order by rank')).rows;
    askQuestions = researchQuestions.map(question => {
      const highlighted = questionEvidence
        .filter(row => row.question_id === question.id)
        .map(row => row.chunk_id);
      return {
        id: question.id,
        query: question.query,
        themes: parseJson(question.themes_json, []),
        answer: {
          synthesis: question.synthesis,
          supporting_evidence: [],
          participant_codes: parseJson(question.participant_codes_json, []),
          highlighted_map_item_ids: highlighted,
          themes: parseJson(question.themes_json, []),
          suggested_follow_up: question.suggested_follow_up || '',
        },
      };
    });
  } catch {
    askQuestions = [];
  }

  return {
    participants,
    map_items: chunks.map(chunk => ({
      ...chunk,
      themes: themesByChunk.get(chunk.id) || [],
      source: sourceById.get(chunk.source_id) || { id: chunk.source_id },
      metadata_json: {
        ...parseJson(chunk.metadata_json, {}),
        canonical_participant_id: chunk.canonical_participant_id,
        source_id: chunk.source_id,
      },
      embedding_metadata: chunk.embedding_id ? {
        id: chunk.embedding_id,
        provider: chunk.embedding_provider,
        model: chunk.embedding_model,
        dimensions: chunk.embedding_dimensions,
        vector_sha256: chunk.vector_sha256,
        input_sha256: chunk.input_sha256,
      } : {},
      projection: {
        id: chunk.projection_id,
        method: chunk.projection_method,
        version: chunk.projection_version,
        params_json: parseJson(chunk.projection_params_json, {}),
      },
    })),
    ask_map: { questions: askQuestions },
  };
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
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
  const outDir = resolve(args.outDir || join(PROJECT_ROOT, 'data/domains'));
  const domainId = args.domainId || 'all';
  const domainName = args.domainName || (domainId === 'all' ? 'Accelerator Research' : 'Accelerator Demo');

  if (!args.input && !args.tursoUrl) {
    throw new Error('Pass --input export.json or --turso-url libsql://...');
  }

  const raw = args.input
    ? await loadFromInput(args.input)
    : await loadFromTurso(args.tursoUrl, args.authToken || process.env.TURSO_AUTH_TOKEN);

  const bundle = normalizeAcceleratorExport(raw, { domainId, domainName });
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, `${domainId}.json`), `${JSON.stringify(bundle, null, 2)}\n`);

  if (args.writeIndex) {
    const index = buildDomainIndex([bundle]);
    await writeFile(join(outDir, 'index.json'), `${JSON.stringify(index, null, 2)}\n`);
  }

  console.log(`Exported ${bundle.map_items.length} map items to ${join(outDir, `${domainId}.json`)}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(err => {
    console.error(err.message);
    process.exitCode = 1;
  });
}
