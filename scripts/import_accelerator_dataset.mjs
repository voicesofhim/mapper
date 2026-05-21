#!/usr/bin/env node
/**
 * Build the first accelerator research dataset from anonymized local inputs.
 *
 * This script intentionally runs outside the browser:
 * - parses anonymized interview markdown files
 * - chunks source text
 * - assigns evidence themes
 * - creates local deterministic embedding vectors
 * - computes UMAP x/y coordinates with umap-js
 * - exports Mapper-compatible JSON and optional Turso/libSQL seed SQL
 *
 * Real production use can swap the local embedding function for a hosted
 * embedding model while preserving the same canonical output shape.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { UMAP } from 'umap-js';
import { normalizeAcceleratorExport } from './export_accelerator_domain.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = resolve(__dirname, '..');
const DEFAULT_INPUT_DIR = join(PROJECT_ROOT, 'data/accelerator/raw/anonymized-interviews');
const DEFAULT_EXPORT_PATH = join(PROJECT_ROOT, 'data/accelerator/exports/accelerator-seed.json');
const DEFAULT_DOMAIN_PATH = join(PROJECT_ROOT, 'data/domains/accelerator-seed.json');
const DEFAULT_SQL_PATH = join(PROJECT_ROOT, 'data/accelerator/exports/accelerator-seed.sql');

const SOURCE_TYPES = new Set(['interview', 'prior_interview', 'social', 'mentor_note', 'program_material', 'reflection']);
const EMBEDDING_DIMENSIONS = 96;
const EMBEDDING_MODEL = 'local-hash-evidence-v1';
const PROJECTION_VERSION = 'umap-local-hash-v1';

const THEME_RULES = [
  ['self-direction', ['independent', 'own first', 'self-directed', 'alone', 'autonomy', 'protect the question']],
  ['mentor ambivalence', ['mentor', 'advice', 'coaching', 'too early', 'premature', 'selective']],
  ['trust in mentorship', ['trust', 'cadence', 'rhythm', 'repeatable', 'operating', 'mentor']],
  ['structure need', ['structure', 'milestone', 'weekly', 'plan', 'sequence', 'sprint']],
  ['execution', ['execute', 'execution', 'shipping', 'outreach', 'follow-through', 'tasks']],
  ['ambiguity comfort', ['ambiguity', 'uncertain', 'explore', 'exploratory', 'unknown']],
  ['public-private tension', ['public', 'private', 'identity', 'story', 'confidence', 'uncertainty']],
  ['customer discovery', ['customer', 'discovery', 'interview', 'buyer', 'market']],
  ['learning style', ['learn', 'learning', 'experiment', 'test', 'feedback']],
  ['program design', ['program', 'workshop', 'template', 'curriculum', 'session']],
];

export async function buildAcceleratorDataset(options = {}) {
  const inputDir = resolve(options.inputDir || DEFAULT_INPUT_DIR);
  const maxParticipants = Number(options.maxParticipants || 3);
  const files = (await readdir(inputDir))
    .filter(file => ['.md', '.txt'].includes(extname(file).toLowerCase()))
    .sort()
    .slice(0, maxParticipants);

  if (files.length === 0) {
    throw new Error(`No anonymized interview files found in ${inputDir}`);
  }

  const participants = [];
  const sources = [];
  const chunks = [];
  const themes = new Map();

  for (const file of files) {
    const parsed = parseAnonymizedInterview(await readFile(join(inputDir, file), 'utf8'), file);
    participants.push(parsed.participant);
    sources.push(parsed.source);

    const textChunks = chunkText(parsed.body);
    textChunks.forEach((text, index) => {
      const assignedThemes = inferThemes(text);
      for (const theme of assignedThemes) {
        if (!themes.has(theme)) {
          themes.set(theme, {
            id: slugify(theme),
            name: theme,
            description: describeTheme(theme),
            category: themeCategory(theme),
          });
        }
      }

      const chunkId = `${parsed.source.id}-chunk-${String(index + 1).padStart(2, '0')}`;
      chunks.push({
        id: chunkId,
        participant_id: parsed.participant.id,
        display_code: parsed.participant.display_code,
        source_id: parsed.source.id,
        source_type: parsed.source.source_type,
        chunk_index: index,
        title: makeTitle(text, assignedThemes),
        summary: summarize(text),
        anonymized_text: text,
        excerpt: text,
        themes: assignedThemes,
        sentiment: inferSentiment(text),
        confidence: confidenceFor(text, assignedThemes),
        token_count: estimateTokens(text),
        consent_level: parsed.source.consent_level,
        visibility: parsed.source.visibility,
        source_ref: parsed.source.source_ref,
        contains_sensitive_data: 0,
        redaction_notes: 'Input file is expected to be anonymized before import.',
        metadata_json: {
          sequence: index + 1,
          source_file: file,
          parser: 'import_accelerator_dataset.mjs',
        },
      });
    });
  }

  const embeddings = chunks.map(chunk => buildEmbeddingRecord(chunk));
  const coordinates = computeUmapCoordinates(embeddings);
  const items = chunks.map((chunk, index) => {
    const embedding = embeddings[index];
    const coord = coordinates[index];
    const participant = participants.find(p => p.id === chunk.participant_id);
    const source = sources.find(s => s.id === chunk.source_id);
    return {
      ...chunk,
      participant_id: participant.display_code,
      canonical_participant_id: chunk.participant_id,
      source: sourceToExport(source),
      embedding_metadata: {
        id: embedding.id,
        provider: embedding.embedding_provider,
        model: embedding.embedding_model,
        dimensions: embedding.embedding_dimensions,
        vector_sha256: embedding.vector_sha256,
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
      metadata_json: {
        ...chunk.metadata_json,
        canonical_participant_id: chunk.participant_id,
        source_id: chunk.source_id,
      },
    };
  });

  const raw = {
    domain: {
      id: options.domainId || 'accelerator-seed',
      name: options.domainName || 'Accelerator Seed Interviews',
      parent_id: null,
      level: 'general',
    },
    participants,
    sources,
    themes: [...themes.values()],
    chunks,
    embeddings,
    umap_coordinates: coordinates,
    map_items: items,
    ask_map: buildAskMap(items),
  };

  return normalizeAcceleratorExport(raw, {
    domainId: raw.domain.id,
    domainName: raw.domain.name,
  });
}

export function parseAnonymizedInterview(contents, fileName = 'interview.md') {
  const { frontmatter, body } = splitFrontmatter(contents);
  const participantId = frontmatter.participant_id || slugify(frontmatter.display_code || fileName.replace(/\.[^.]+$/, ''));
  const displayCode = frontmatter.display_code || participantId.toUpperCase();
  const sourceType = frontmatter.source_type || 'interview';
  if (!SOURCE_TYPES.has(sourceType)) {
    throw new Error(`${fileName} has unsupported source_type "${sourceType}"`);
  }

  const sourceId = frontmatter.source_id || `${participantId}-${sourceType}-01`;
  return {
    participant: {
      id: participantId,
      display_code: displayCode,
      role: frontmatter.role || '',
      company_stage: frontmatter.company_stage || '',
      cohort: frontmatter.cohort || '',
      profile_json: parseProfile(frontmatter),
      consent_level: frontmatter.consent_level || 'anonymized_research',
      visibility: frontmatter.visibility || 'researcher',
      anonymization_level: frontmatter.anonymization_level || 'standard',
    },
    source: {
      id: sourceId,
      participant_id: participantId,
      source_type: sourceType,
      title: frontmatter.title || `${displayCode} anonymized interview`,
      label: frontmatter.label || `${displayCode} · ${sourceType.replace(/_/g, ' ')}`,
      source_ref: frontmatter.source_ref || fileName,
      source_uri_hash: sha256(frontmatter.source_ref || fileName),
      collected_at: frontmatter.collected_at || '',
      raw_text_ref: frontmatter.raw_text_ref || '',
      raw_text_allowed: frontmatter.raw_text_allowed === 'true' ? 1 : 0,
      consent_level: frontmatter.consent_level || 'anonymized_research',
      visibility: frontmatter.visibility || 'researcher',
      metadata_json: {
        input_file: fileName,
        anonymized_before_import: true,
      },
    },
    body: normalizeBody(body),
  };
}

export function chunkText(text, maxChars = 420) {
  const paragraphs = text.split(/\n{2,}/).map(p => p.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const units = paragraphs.flatMap(paragraph => {
    if (paragraph.length <= maxChars) return [paragraph];
    return paragraph.split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean);
  });
  const chunks = [];
  let current = '';
  for (const paragraph of units) {
    if (!current) {
      current = paragraph;
    } else if (`${current}\n\n${paragraph}`.length <= maxChars) {
      current = `${current}\n\n${paragraph}`;
    } else {
      chunks.push(current);
      current = paragraph;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

export function buildEmbeddingRecord(chunk) {
  const vector = embedText(`${chunk.title}\n${chunk.summary}\n${chunk.anonymized_text}`);
  const bytes = Buffer.from(Float32Array.from(vector).buffer);
  return {
    id: `${chunk.id}-embedding`,
    chunk_id: chunk.id,
    embedding_provider: 'local',
    embedding_model: EMBEDDING_MODEL,
    embedding_dimensions: EMBEDDING_DIMENSIONS,
    embedding_vector: vector,
    vector_blob_hex: bytes.toString('hex'),
    vector_sha256: sha256(bytes),
    input_sha256: sha256(chunk.anonymized_text),
    metadata_json: {
      note: 'Local deterministic embedding for pipeline validation; replace with production embedding provider for real analysis.',
    },
  };
}

export function computeUmapCoordinates(embeddings) {
  if (embeddings.length === 1) {
    return [{
      id: `${embeddings[0].chunk_id}-umap`,
      chunk_id: embeddings[0].chunk_id,
      embedding_id: embeddings[0].id,
      projection_method: 'umap',
      projection_version: PROJECTION_VERSION,
      umap_x: 0.5,
      umap_y: 0.5,
      params_json: { n_neighbors: 1, min_dist: 0.12, spread: 1.1, seed: 42 },
    }];
  }

  const nNeighbors = Math.max(2, Math.min(6, embeddings.length - 1));
  const random = mulberry32(42);
  const umap = new UMAP({
    nComponents: 2,
    nNeighbors,
    minDist: 0.12,
    spread: 1.1,
    random,
  });
  const points = umap.fit(embeddings.map(e => e.embedding_vector));
  const xs = points.map(p => p[0]);
  const ys = points.map(p => p[1]);
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  const yMin = Math.min(...ys);
  const yMax = Math.max(...ys);

  return embeddings.map((embedding, index) => ({
    id: `${embedding.chunk_id}-umap`,
    chunk_id: embedding.chunk_id,
    embedding_id: embedding.id,
    projection_method: 'umap',
    projection_version: PROJECTION_VERSION,
    umap_x: normalize(points[index][0], xMin, xMax),
    umap_y: normalize(points[index][1], yMin, yMax),
    params_json: { n_neighbors: nNeighbors, min_dist: 0.12, spread: 1.1, seed: 42 },
  }));
}

export function toTursoSeedSql(bundle) {
  const participants = bundle.participants || [];
  const items = bundle.map_items || [];
  const sourceById = new Map(items.map(item => [item.metadata_json?.source_id || item.source?.id, item.source]).filter(([id]) => id));
  const themeNames = [...new Set(items.flatMap(item => item.themes || []))];

  const lines = [
    'pragma foreign_keys = on;',
    'begin transaction;',
  ];

  for (const participant of participants) {
    lines.push(insertSql('participants', {
      id: participant.id,
      display_code: participant.display_code,
      role: participant.role,
      company_stage: participant.company_stage,
      cohort: participant.cohort,
      profile_json: JSON.stringify(participant.profile_json || {}),
      consent_level: participant.consent_level || 'anonymized_research',
      visibility: participant.visibility || 'researcher',
      anonymization_level: participant.anonymization_level || 'standard',
    }));
  }

  for (const source of sourceById.values()) {
    lines.push(insertSql('sources', {
      id: source.id,
      participant_id: source.participant_id,
      source_type: source.source_type,
      title: source.title,
      label: source.label,
      source_ref: source.source_ref,
      source_uri_hash: source.source_uri_hash,
      collected_at: source.collected_at,
      raw_text_ref: source.raw_text_ref,
      raw_text_allowed: source.raw_text_allowed || 0,
      consent_level: source.consent_level || 'anonymized_research',
      visibility: source.visibility || 'researcher',
      metadata_json: JSON.stringify(source.metadata_json || {}),
    }));
  }

  for (const theme of themeNames) {
    lines.push(insertSql('themes', {
      id: slugify(theme),
      name: theme,
      description: describeTheme(theme),
      category: themeCategory(theme),
    }));
  }

  for (const item of items) {
    const sourceId = item.metadata_json?.source_id || item.source?.id;
    const canonicalParticipantId = item.metadata_json?.canonical_participant_id || participantIdForDisplayCode(participants, item.participant_id);
    lines.push(insertSql('chunks', {
      id: item.id,
      participant_id: canonicalParticipantId,
      source_id: sourceId,
      chunk_index: item.metadata_json?.sequence || 0,
      source_type: item.source_type,
      title: item.title,
      summary: item.summary,
      anonymized_text: item.anonymized_text,
      excerpt: item.excerpt,
      sentiment: item.sentiment,
      confidence: item.confidence,
      token_count: item.metadata_json?.token_count || estimateTokens(item.anonymized_text || item.excerpt || ''),
      source_ref: item.source?.source_ref,
      contains_sensitive_data: 0,
      redaction_notes: 'Input file is expected to be anonymized before import.',
      consent_level: item.consent_level,
      visibility: item.visibility || 'researcher',
      metadata_json: JSON.stringify(item.metadata_json || {}),
    }));

    for (const theme of item.themes || []) {
      lines.push(insertSql('chunk_themes', {
        chunk_id: item.id,
        theme_id: slugify(theme),
        confidence: item.confidence || 0.75,
        evidence: item.summary,
      }));
    }

    const embedding = item.embedding_metadata;
    if (embedding) {
      lines.push(insertSql('embeddings', {
        id: embedding.id,
        chunk_id: item.id,
        embedding_provider: embedding.provider,
        embedding_model: embedding.model,
        embedding_dimensions: embedding.dimensions,
        embedding_vector: null,
        vector_sha256: embedding.vector_sha256,
        input_sha256: embedding.input_sha256,
        metadata_json: JSON.stringify({ exported_vector: false }),
      }));
    }

    const projection = item.projection;
    if (projection) {
      lines.push(insertSql('umap_coordinates', {
        id: projection.id,
        chunk_id: item.id,
        embedding_id: embedding?.id || null,
        projection_method: projection.method,
        projection_model: embedding?.model || null,
        projection_version: projection.version,
        umap_x: item.umap_x,
        umap_y: item.umap_y,
        params_json: JSON.stringify(projection.params_json || {}),
      }));
    }
  }

  for (const question of bundle.ask_map?.questions || []) {
    lines.push(insertSql('research_questions', {
      id: question.id,
      query: question.query,
      synthesis: question.answer?.synthesis || '',
      suggested_follow_up: question.answer?.suggested_follow_up || '',
      themes_json: JSON.stringify(question.answer?.themes || question.themes || []),
      participant_codes_json: JSON.stringify(question.answer?.participant_codes || []),
      visibility: 'researcher',
      metadata_json: JSON.stringify({ generated_by: 'import_accelerator_dataset.mjs' }),
    }));
    (question.answer?.highlighted_map_item_ids || []).forEach((chunkId, index) => {
      lines.push(insertSql('question_evidence', {
        question_id: question.id,
        chunk_id: chunkId,
        rank: index + 1,
        rationale: 'Seeded evidence for sample Ask-the-Map response.',
      }));
    });
  }

  lines.push('commit;');
  return `${lines.join('\n')}\n`;
}

function splitFrontmatter(contents) {
  const normalized = contents.replace(/\r\n/g, '\n').trim();
  if (!normalized.startsWith('---\n')) return { frontmatter: {}, body: normalized };
  const end = normalized.indexOf('\n---', 4);
  if (end === -1) return { frontmatter: {}, body: normalized };
  const frontmatterText = normalized.slice(4, end).trim();
  const body = normalized.slice(end + 4).trim();
  const frontmatter = {};
  for (const line of frontmatterText.split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
    frontmatter[key] = value;
  }
  return { frontmatter, body };
}

function normalizeBody(body) {
  return body
    .replace(/^#+\s+/gm, '')
    .replace(/\[[^\]]+\]/g, '[redacted]')
    .replace(/\s+\n/g, '\n')
    .trim();
}

function parseProfile(frontmatter) {
  const keys = ['openness', 'conscientiousness', 'ambiguityComfort', 'trustInMentorship', 'publicPrivateTension'];
  const profile = {};
  for (const key of keys) {
    if (frontmatter[key] == null || frontmatter[key] === '') continue;
    const value = Number(frontmatter[key]);
    if (Number.isFinite(value)) profile[key] = Math.max(0, Math.min(1, value));
  }
  return profile;
}

function inferThemes(text) {
  const lower = text.toLowerCase();
  const matched = THEME_RULES
    .filter(([, terms]) => terms.some(term => lower.includes(term)))
    .map(([theme]) => theme);
  return matched.length ? matched.slice(0, 4) : ['learning style'];
}

function summarize(text) {
  const compact = text.replace(/\s+/g, ' ').trim();
  const firstSentence = compact.split(/(?<=[.!?])\s+/)[0] || compact;
  return firstSentence.length > 180 ? `${firstSentence.slice(0, 177).trim()}...` : firstSentence;
}

function makeTitle(text, themes) {
  const theme = themes[0] || 'evidence';
  const title = theme
    .split(/\s+/)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
  const summary = summarize(text).replace(/^I\s+/i, '').replace(/[.!?]$/, '');
  return summary.length < 44 ? summary : title;
}

function inferSentiment(text) {
  const lower = text.toLowerCase();
  if (/(stuck|worry|uncertain|tension|hard|blocked|afraid|slow)/.test(lower)) return 'mixed';
  if (/(trust|help|clear|useful|momentum|better|learned)/.test(lower)) return 'positive';
  return 'neutral';
}

function confidenceFor(text, themes) {
  const lengthScore = Math.min(0.16, text.length / 5000);
  const themeScore = Math.min(0.12, themes.length * 0.03);
  return Number((0.68 + lengthScore + themeScore).toFixed(2));
}

function estimateTokens(text) {
  return Math.ceil((text || '').split(/\s+/).filter(Boolean).length * 1.25);
}

function embedText(text) {
  const vector = new Array(EMBEDDING_DIMENSIONS).fill(0);
  const tokens = (text.toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) || [])
    .filter(token => !STOPWORDS.has(token));
  for (const token of tokens) {
    const digest = createHash('sha256').update(token).digest();
    const idx = digest.readUInt32BE(0) % EMBEDDING_DIMENSIONS;
    const sign = digest[4] % 2 === 0 ? 1 : -1;
    vector[idx] += sign * (1 + Math.log1p(token.length));
  }
  const norm = Math.hypot(...vector) || 1;
  return vector.map(value => Number((value / norm).toFixed(6)));
}

function buildAskMap(items) {
  const questions = [
    makeQuestion({
      id: 'ask-seed-autonomy-mentorship',
      query: 'Where does mentorship help without reducing autonomy?',
      themes: ['self-direction', 'mentor ambivalence', 'trust in mentorship'],
      items,
      followUp: 'Which mentor formats preserve autonomy while still increasing execution speed?',
    }),
    makeQuestion({
      id: 'ask-seed-structure-execution',
      query: 'Which participants need structure before they can execute?',
      themes: ['structure need', 'execution', 'program design'],
      items,
      followUp: 'What operating cadence appears to unlock execution for each participant?',
    }),
    makeQuestion({
      id: 'ask-seed-public-private',
      query: 'Where do public and private founder identities diverge?',
      themes: ['public-private tension', 'ambiguity comfort'],
      items,
      followUp: 'Which evidence distinguishes public narrative polish from private uncertainty?',
    }),
  ].filter(Boolean);

  return { questions };
}

function makeQuestion({ id, query, themes, items, followUp }) {
  const evidence = items
    .filter(item => (item.themes || []).some(theme => themes.includes(theme)))
    .slice(0, 5);
  if (!evidence.length) return null;

  const participantCodes = [...new Set(evidence.map(item => item.participant_id))];
  const evidenceLines = evidence.map(item => `${item.participant_id}: ${item.summary}`);
  return {
    id,
    query,
    aliases: themes,
    themes,
    answer: {
      synthesis: `Inference: ${participantCodes.join(' and ')} show this pattern in the anonymized seed evidence. The claim is limited to the displayed excerpts and should be checked against fuller researcher notes before use.`,
      supporting_evidence: evidenceLines,
      participant_codes: participantCodes,
      highlighted_map_item_ids: evidence.map(item => item.id),
      themes,
      suggested_follow_up: followUp,
    },
  };
}

function sourceToExport(source) {
  return {
    id: source.id,
    participant_id: source.participant_id,
    source_type: source.source_type,
    title: source.title,
    label: source.label,
    source_ref: source.source_ref,
    source_uri_hash: source.source_uri_hash,
    collected_at: source.collected_at,
    raw_text_ref: source.raw_text_ref,
    raw_text_allowed: source.raw_text_allowed,
    consent_level: source.consent_level,
    visibility: source.visibility,
    metadata_json: source.metadata_json,
  };
}

function describeTheme(theme) {
  const descriptions = {
    'self-direction': 'Evidence that the participant prefers independent problem framing before external input.',
    'mentor ambivalence': 'Evidence of selective, cautious, or conflicted use of mentor advice.',
    'trust in mentorship': 'Evidence describing when mentor guidance is trusted or becomes useful.',
    'structure need': 'Evidence that execution improves with scaffolding, milestones, or cadence.',
    execution: 'Evidence about moving from intention to concrete action.',
    'ambiguity comfort': 'Evidence about tolerance for uncertainty and exploratory work.',
    'public-private tension': 'Evidence of divergence between public narrative and private experience.',
    'customer discovery': 'Evidence related to customer learning and market contact.',
    'learning style': 'Evidence about how the participant learns, tests, and integrates feedback.',
    'program design': 'Evidence about program structures, workshops, or templates.',
  };
  return descriptions[theme] || `Evidence related to ${theme}.`;
}

function themeCategory(theme) {
  if (['self-direction', 'mentor ambivalence', 'trust in mentorship', 'learning style'].includes(theme)) return 'learning';
  if (['structure need', 'execution', 'program design'].includes(theme)) return 'execution';
  if (['public-private tension', 'ambiguity comfort'].includes(theme)) return 'identity';
  return 'research';
}

function participantIdForDisplayCode(participants, displayCode) {
  return participants.find(p => p.display_code === displayCode || p.id === displayCode)?.id || displayCode;
}

function insertSql(table, values) {
  const keys = Object.keys(values);
  const rendered = keys.map(key => sqlValue(values[key]));
  return `insert or replace into ${table} (${keys.join(', ')}) values (${rendered.join(', ')});`;
}

function sqlValue(value) {
  if (value == null || value === '') return 'null';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null';
  return `'${String(value).replace(/'/g, "''")}'`;
}

function normalize(value, min, max) {
  if (max === min) return 0.5;
  const padded = 0.08 + ((value - min) / (max - min)) * 0.84;
  return Number(Math.max(0, Math.min(1, padded)).toFixed(6));
}

function slugify(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'item';
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function mulberry32(seed) {
  return function random() {
    let t = seed += 0x6D2B79F5;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
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
  const bundle = await buildAcceleratorDataset({
    inputDir: args.inputDir || DEFAULT_INPUT_DIR,
    maxParticipants: args.maxParticipants || 3,
    domainId: args.domainId || 'accelerator-seed',
    domainName: args.domainName || 'Accelerator Seed Interviews',
  });

  const exportPath = resolve(args.out || DEFAULT_EXPORT_PATH);
  await mkdir(dirname(exportPath), { recursive: true });
  await writeFile(exportPath, `${JSON.stringify(bundle, null, 2)}\n`);

  if (args.writeDomain !== false && args.writeDomain !== 'false') {
    const domainPath = resolve(args.domainOut || DEFAULT_DOMAIN_PATH);
    await mkdir(dirname(domainPath), { recursive: true });
    await writeFile(domainPath, `${JSON.stringify(bundle, null, 2)}\n`);
  }

  if (args.writeSql !== false && args.writeSql !== 'false') {
    const sqlPath = resolve(args.sqlOut || DEFAULT_SQL_PATH);
    await mkdir(dirname(sqlPath), { recursive: true });
    await writeFile(sqlPath, toTursoSeedSql(bundle));
  }

  console.log(`Imported ${bundle.participants.length} participants and ${bundle.map_items.length} chunks.`);
  console.log(`Exported Mapper JSON: ${exportPath}`);
}

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'when', 'then', 'than', 'but',
  'about', 'have', 'has', 'had', 'was', 'were', 'are', 'our', 'you', 'they', 'them', 'their',
  'there', 'because', 'before', 'after', 'really', 'very', 'just', 'like', 'would', 'could',
  'should', 'need', 'want', 'what', 'where', 'which',
]);

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(err => {
    console.error(err);
    process.exitCode = 1;
  });
}
