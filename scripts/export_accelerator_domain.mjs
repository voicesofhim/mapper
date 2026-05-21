#!/usr/bin/env node
/**
 * Export accelerator research data into Mapper-compatible static domain JSON.
 *
 * Inputs can be either:
 * - --input path/to/export.json
 * - --turso-url libsql://... --auth-token ...
 *
 * The Turso path expects canonical tables named participants, sources, chunks,
 * chunk_themes, and themes. UMAP coordinates are treated as precomputed data.
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
    consent_level: row.consent_level || row.consentLevel || 'research-anonymized',
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
  const participants = (await db.execute('select * from participants')).rows;
  const sources = (await db.execute('select * from sources')).rows;
  const sourceById = new Map(sources.map(source => [source.id, source]));
  const chunks = (await db.execute('select * from chunks')).rows;
  const themes = (await db.execute('select * from themes')).rows;
  const themeById = new Map(themes.map(theme => [theme.id, theme.name]));
  const chunkThemes = (await db.execute('select * from chunk_themes')).rows;
  const themesByChunk = new Map();
  for (const row of chunkThemes) {
    const list = themesByChunk.get(row.chunk_id) || [];
    list.push(themeById.get(row.theme_id) || row.theme_id);
    themesByChunk.set(row.chunk_id, list);
  }

  return {
    participants,
    map_items: chunks.map(chunk => ({
      ...chunk,
      themes: themesByChunk.get(chunk.id) || [],
      source: sourceById.get(chunk.source_id) || { id: chunk.source_id },
    })),
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
