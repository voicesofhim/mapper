#!/usr/bin/env node
/**
 * Local-only Ask-the-Map retrieval server.
 *
 * This server is intentionally small and boring:
 * - binds to 127.0.0.1 by default;
 * - embeds questions with a local EmbeddingGemma sidecar or local Ollama;
 * - searches local libSQL/Turso seed data by cosine similarity;
 * - returns evidence and map item IDs, not raw transcripts or diagnoses.
 */

import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createClient } from '@libsql/client';
import { AccessToken } from 'livekit-server-sdk';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = resolve(__dirname, '..');

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 8787;
const DEFAULT_DB_PATH = join(PROJECT_ROOT, 'data/accelerator/local/accelerator-seed.sqlite');
const DEFAULT_SCHEMA_PATH = join(PROJECT_ROOT, 'scripts/accelerator-schema.sql');
const DEFAULT_SEED_SQL_PATH = join(PROJECT_ROOT, 'data/accelerator/exports/accelerator-seed.sql');
const DEFAULT_EMBEDDING_MODEL = 'google/embeddinggemma-300M';
const DEFAULT_MODEL_PATH = join(PROJECT_ROOT, 'models/embeddinggemma-300m');
const DEFAULT_PYTHON = join(PROJECT_ROOT, '.venv-embeddinggemma/bin/python');
const DEFAULT_EMBED_SCRIPT = join(PROJECT_ROOT, 'scripts/embed_embeddinggemma.py');
const DEFAULT_EMBED_WORKER_SCRIPT = join(PROJECT_ROOT, 'scripts/embed_embeddinggemma_worker.py');
const DEFAULT_EMBEDDING_PROVIDER = 'embeddinggemma';
const DEFAULT_OLLAMA_EMBEDDING_MODEL = 'qwen3-embedding:4b';
const DEFAULT_OLLAMA_BASE_URL = 'http://127.0.0.1:11434';
const MAX_QUERY_CHARS = 600;
const MAX_TOP_K = 8;
const DEFAULT_TOP_K = 5;
const LOCAL_ORIGIN_RE = /^http:\/\/(127\.0\.0\.1|localhost):\d+$/;
const DEFAULT_LIVEKIT_URL = 'ws://127.0.0.1:7880';
const DEFAULT_LIVEKIT_ROOM = 'mapper-local';
const DEFAULT_LIVEKIT_IDENTITY_PREFIX = 'mapper-researcher';
const DEFAULT_LIVEKIT_API_KEY = 'devkey';
const DEFAULT_LIVEKIT_API_SECRET = 'secret';

export function parseArgs(argv) {
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

export function float32ArrayFromBlob(blob) {
  if (!blob) return [];
  const buffer = blob instanceof ArrayBuffer
    ? blob
    : ArrayBuffer.isView(blob)
      ? blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength)
      : Buffer.isBuffer(blob)
        ? blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength)
        : null;
  if (!buffer || buffer.byteLength % 4 !== 0) return [];
  return Array.from(new Float32Array(buffer));
}

export function cosineSimilarity(a, b) {
  if (!a?.length || !b?.length || a.length !== b.length) return -Infinity;
  let dot = 0;
  let a2 = 0;
  let b2 = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    a2 += a[i] * a[i];
    b2 += b[i] * b[i];
  }
  if (!a2 || !b2) return -Infinity;
  return dot / (Math.sqrt(a2) * Math.sqrt(b2));
}

export function rankEvidence(queryVector, rows, options = {}) {
  const filters = options.filters || {};
  const topK = Math.max(1, Math.min(MAX_TOP_K, Number(options.topK || DEFAULT_TOP_K)));
  return rows
    .map(row => {
      const vector = row.embedding_vector_array || float32ArrayFromBlob(row.embedding_vector);
      return {
        ...row,
        themes: parseThemes(row.themes),
        score: cosineSimilarity(queryVector, vector),
      };
    })
    .filter(row => Number.isFinite(row.score))
    .filter(row => !filters.datasetId || filters.datasetId === 'all' || row.dataset_id === filters.datasetId)
    .filter(row => !filters.participantId || filters.participantId === 'all' || row.participant_id === filters.participantId)
    .filter(row => !filters.sourceType || filters.sourceType === 'all' || row.source_type === filters.sourceType)
    .filter(row => !filters.theme || filters.theme === 'all' || row.themes.includes(filters.theme))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

export function rankStaticEvidence(query, rows, options = {}) {
  const filters = options.filters || {};
  const terms = tokenizeQuery(query);
  const topK = Math.max(1, Math.min(MAX_TOP_K, Number(options.topK || DEFAULT_TOP_K)));
  return rows
    .filter(row => !filters.datasetId || filters.datasetId === 'all' || row.dataset_id === filters.datasetId)
    .filter(row => !filters.participantId || filters.participantId === 'all' || row.participant_id === filters.participantId)
    .filter(row => !filters.sourceType || filters.sourceType === 'all' || row.source_type === filters.sourceType)
    .filter(row => !filters.theme || filters.theme === 'all' || (row.themes || []).includes(filters.theme))
    .map(row => ({ ...row, score: staticEvidenceScore(row, terms) }))
    .filter(row => row.score > 0)
    .sort((a, b) => b.score - a.score || b.confidence - a.confidence)
    .slice(0, topK);
}

export function buildAskMapResponse(query, matches, options = {}) {
  const participantCodes = [...new Set(matches.map(row => row.participant_id).filter(Boolean))];
  const themes = [...new Set(matches.flatMap(row => row.themes || []))].slice(0, 6);
  const itemIds = matches.map(row => row.id);
  const topThemes = themes.length ? ` around ${themes.slice(0, 3).join(', ')}` : '';
  const scope = participantCodes.length ? ` for ${participantCodes.join(', ')}` : '';
  const synthesis = matches.length
    ? `Inference: the nearest local evidence${scope}${topThemes} is shown below. This is retrieval over anonymized excerpts, not a diagnosis or a claim beyond the displayed sources.`
    : 'No local evidence matched strongly enough. Try a narrower question or add more approved source material.';

  return {
    query,
    synthesis,
    participant_codes: participantCodes,
    themes,
    highlighted_map_item_ids: itemIds,
    supporting_evidence: matches.map(row => `${row.participant_id}: ${row.summary || row.excerpt}`),
    evidence: matches.map(row => ({
      id: row.id,
      participant_id: row.participant_id,
      participant_code: row.participant_id,
      source_type: row.source_type,
      title: row.title,
      summary: row.summary,
      excerpt: row.excerpt || row.anonymized_text,
      themes: row.themes || [],
      sentiment: row.sentiment,
      confidence: row.confidence,
      score: Number(row.score.toFixed(4)),
      x: row.umap_x,
      y: row.umap_y,
      umap_x: row.umap_x,
      umap_y: row.umap_y,
      source: {
        id: row.source_id,
        label: row.source_label,
        source_ref: row.source_ref,
      },
    })),
    follow_up: options.followUp || 'Which one of these evidence points should we inspect more closely?',
    metadata: {
      local_only: true,
      retrieval_model: options.model || DEFAULT_EMBEDDING_MODEL,
      query_sha256: sha256(query),
      retrieved_count: matches.length,
      generated_by: 'ask_map_server.mjs',
    },
  };
}

export async function ensureLocalDatabase(options = {}) {
  const dbPath = resolve(options.dbPath || DEFAULT_DB_PATH);
  const schemaPath = resolve(options.schemaPath || DEFAULT_SCHEMA_PATH);
  const seedSqlPath = resolve(options.seedSqlPath || DEFAULT_SEED_SQL_PATH);
  await mkdir(dirname(dbPath), { recursive: true });
  const url = `file:${dbPath}`;
  const db = createClient({ url });
  const exists = await fileExists(dbPath);
  const seeded = exists && !options.rebuildDb ? await hasSeedData(db) : false;
  if (!seeded || options.rebuildDb) {
    const schema = await readFile(schemaPath, 'utf8');
    const seed = await readFile(seedSqlPath, 'utf8');
    await db.executeMultiple(schema);
    await db.executeMultiple(seed);
  }
  return { db, dbPath };
}

export async function loadEvidenceRows(db, options = {}) {
  const filters = [];
  const args = {};
  if (options.embeddingProvider) {
    filters.push('e.embedding_provider = :embeddingProvider');
    args.embeddingProvider = options.embeddingProvider;
  }
  if (options.model) {
    filters.push('e.embedding_model = :embeddingModel');
    args.embeddingModel = options.model;
  }
  if (Number(options.dimensions) > 0) {
    filters.push('e.embedding_dimensions = :embeddingDimensions');
    args.embeddingDimensions = Number(options.dimensions);
  }

  const result = await db.execute(`
    select
      c.id,
      c.dataset_id,
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
      c.consent_level,
      c.visibility,
      s.label as source_label,
      s.source_ref,
      e.embedding_model,
      e.embedding_dimensions,
      e.embedding_vector,
      u.umap_x,
      u.umap_y,
      group_concat(t.name, '||') as themes
    from chunks c
    join participants p on p.id = c.participant_id
    join sources s on s.id = c.source_id
    join embeddings e on e.chunk_id = c.id
    join umap_coordinates u on u.embedding_id = e.id
    left join chunk_themes ct on ct.chunk_id = c.id
    left join themes t on t.id = ct.theme_id
    where c.consent_level != 'withdrawn'
      and c.visibility in ('researcher', 'participant', 'public')
      and c.contains_sensitive_data = 0
      and e.embedding_vector is not null
      ${filters.length ? `and ${filters.join('\n      and ')}` : ''}
    group by c.id, e.id, u.id
  `, args);
  return result.rows;
}

export async function loadStaticBundleRows(domainDir, domainId = 'all') {
  const bundlePath = safeDomainBundlePath(domainDir, domainId);
  const bundle = JSON.parse(await readFile(bundlePath, 'utf8'));
  return (bundle.map_items || bundle.articles || []).map(item => ({
    id: item.id,
    dataset_id: item.dataset_id || item.metadata_json?.dataset_id || item.source?.dataset_id || '',
    participant_id: item.participant_id,
    source_id: item.metadata_json?.source_id || item.source?.id || '',
    source_type: item.source_type,
    title: item.title,
    summary: item.summary,
    anonymized_text: item.anonymized_text,
    excerpt: item.excerpt || item.anonymized_text,
    themes: Array.isArray(item.themes) ? item.themes : [],
    sentiment: item.sentiment || 'unknown',
    confidence: Number(item.confidence ?? 0.75),
    source_label: item.source?.label || item.source?.title || '',
    source_ref: item.source?.source_ref || '',
    umap_x: Number(item.umap_x ?? item.x),
    umap_y: Number(item.umap_y ?? item.y),
  }));
}

export async function embedQuestion(query, options = {}) {
  if (options.embedder) {
    return options.embedder.embed(query, { promptName: 'Retrieval-query' });
  }
  if (options.embeddingProvider === 'ollama') {
    return embedOllamaQuestion(query, options);
  }
  const python = options.python || DEFAULT_PYTHON;
  const script = options.embedScript || DEFAULT_EMBED_SCRIPT;
  const modelPath = options.modelPath || DEFAULT_MODEL_PATH;
  const dimensions = options.dimensions || 768;
  const payload = { items: [{ id: 'query', text: query }] };
  const args = [
    script,
    '--model', modelPath,
    '--prompt-name', 'Retrieval-query',
    '--dimensions', String(dimensions),
    '--batch-size', '1',
  ];
  if (options.device) args.push('--device', options.device);
  const result = await runJsonProcess(python, args, payload);
  const vector = result.items?.[0]?.embedding;
  if (!Array.isArray(vector)) throw new Error('EmbeddingGemma did not return a query vector.');
  return vector.map(Number);
}

export async function embedOllamaQuestion(query, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (!fetchImpl) throw new Error('fetch is required for Ollama embedding requests.');
  const model = options.model || DEFAULT_OLLAMA_EMBEDDING_MODEL;
  const baseUrl = normalizeOllamaBaseUrl(options.ollamaUrl || process.env.OLLAMA_HOST || DEFAULT_OLLAMA_BASE_URL);
  const dimensions = Number(options.dimensions || process.env.OLLAMA_EMBEDDING_DIMENSIONS || 0) || undefined;
  const queryPrefix = options.ollamaQueryPrefix ?? process.env.OLLAMA_QUERY_PREFIX ?? defaultOllamaQueryPrefix(model);
  const response = await fetchImpl(`${baseUrl}/api/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      input: withPrefix(query, queryPrefix),
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => response.statusText);
    throw new Error(`Ollama embeddings request failed: ${response.status} ${detail}`);
  }

  const json = await response.json();
  const vector = json.embeddings?.[0];
  if (!Array.isArray(vector)) throw new Error('Ollama did not return a query vector.');
  return coerceEmbeddingVector(vector, dimensions);
}

export async function createEmbeddingWorker(options = {}) {
  const python = options.python || DEFAULT_PYTHON;
  const script = options.workerScript || DEFAULT_EMBED_WORKER_SCRIPT;
  const modelPath = options.modelPath || DEFAULT_MODEL_PATH;
  const dimensions = Number(options.dimensions || 768);
  const args = [
    script,
    '--model', modelPath,
    '--dimensions', String(dimensions),
    '--batch-size', String(options.batchSize || 1),
  ];
  if (options.device) args.push('--device', options.device);

  const child = spawn(python, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  let nextId = 0;
  let stdoutBuffer = '';
  let stderr = '';
  let readyResolve;
  let readyReject;
  const ready = new Promise((resolvePromise, reject) => {
    readyResolve = resolvePromise;
    readyReject = reject;
  });

  child.stdout.on('data', data => {
    stdoutBuffer += data.toString();
    let newline;
    while ((newline = stdoutBuffer.indexOf('\n')) !== -1) {
      const line = stdoutBuffer.slice(0, newline).trim();
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch (err) {
        readyReject(new Error(`Embedding worker returned invalid JSON: ${err.message}`));
        continue;
      }
      if (message.type === 'ready') {
        readyResolve(message);
        continue;
      }
      const request = pending.get(message.id);
      if (!request) continue;
      pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error));
      else request.resolve(message);
    }
  });

  child.stderr.on('data', data => { stderr += data.toString(); });
  child.on('error', err => {
    readyReject(err);
    for (const request of pending.values()) request.reject(err);
    pending.clear();
  });
  child.on('close', code => {
    const err = new Error(`Embedding worker exited with ${code}: ${stderr}`);
    readyReject(err);
    for (const request of pending.values()) request.reject(err);
    pending.clear();
  });

  await ready;

  return {
    embed(text, requestOptions = {}) {
      const id = `ask-${++nextId}`;
      const payload = {
        id,
        items: [{ id: 'query', text }],
        prompt_name: requestOptions.promptName || 'Retrieval-query',
      };
      return new Promise((resolvePromise, reject) => {
        pending.set(id, {
          resolve: message => {
            const vector = message.items?.[0]?.embedding;
            if (!Array.isArray(vector)) reject(new Error('Embedding worker did not return a query vector.'));
            else resolvePromise(vector.map(Number));
          },
          reject,
        });
        child.stdin.write(`${JSON.stringify(payload)}\n`);
      });
    },
    close() {
      child.kill();
    },
  };
}

export async function answerQuery(query, context) {
  const cleanQuery = sanitizeQuery(query);
  if (shouldUseStaticBundleRetrieval(context)) {
    const rows = await loadStaticBundleRows(context.domainDir, context.domainId || 'all');
    const matches = rankStaticEvidence(cleanQuery, rows, {
      topK: context.topK,
      filters: context.filters,
    });
    return buildAskMapResponse(cleanQuery, matches, {
      model: 'static-domain-bundle',
      followUp: 'Which of these local evidence points should we inspect more closely?',
    });
  }
  if (!context.embedder && context.embeddingProvider !== 'ollama') {
    context.embedder = await createEmbeddingWorker(context);
  }
  const queryVector = await embedQuestion(cleanQuery, context);
  const rows = await loadEvidenceRows(context.db, {
    embeddingProvider: context.embeddingProvider,
    model: context.model,
    dimensions: context.dimensions,
  });
  const matches = rankEvidence(queryVector, rows, {
    topK: context.topK,
    filters: context.filters,
  });
  return buildAskMapResponse(cleanQuery, matches, { model: context.model });
}

export async function createAskMapServer(options = {}) {
  const { db, dbPath } = await ensureLocalDatabase(options);
  const embeddingProvider = options.embeddingProvider || DEFAULT_EMBEDDING_PROVIDER;
  const context = {
    db,
    dbPath,
    embedder: options.embedder || null,
    embeddingProvider,
    python: options.python || DEFAULT_PYTHON,
    embedScript: options.embedScript || DEFAULT_EMBED_SCRIPT,
    model: options.model || (embeddingProvider === 'ollama' ? DEFAULT_OLLAMA_EMBEDDING_MODEL : DEFAULT_EMBEDDING_MODEL),
    modelPath: options.modelPath || DEFAULT_MODEL_PATH,
    dimensions: Number(options.dimensions || (embeddingProvider === 'ollama' ? 0 : 768)),
    ollamaUrl: options.ollamaUrl,
    ollamaQueryPrefix: options.ollamaQueryPrefix,
    device: options.device,
    topK: Number(options.topK || DEFAULT_TOP_K),
  };

  const server = createServer(async (req, res) => {
    try {
      setCorsHeaders(req, res);
      const requestUrl = new URL(req.url || '/', 'http://127.0.0.1');
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }
      if (req.method === 'GET' && requestUrl.pathname === '/health') {
        writeJson(res, 200, { ok: true, local_only: true, db_path: dbPath });
        return;
      }
      if ((req.method === 'GET' || req.method === 'POST') && requestUrl.pathname === '/api/livekit-token') {
        const body = req.method === 'POST' ? await readJsonBody(req) : {};
        const room = sanitizeLiveKitValue(body.room || requestUrl.searchParams.get('room'), DEFAULT_LIVEKIT_ROOM);
        const identitySeed = body.identity || requestUrl.searchParams.get('identity');
        const identity = sanitizeLiveKitValue(
          identitySeed,
          `${DEFAULT_LIVEKIT_IDENTITY_PREFIX}-${Math.random().toString(36).slice(2, 8)}`
        );
        const tokenResponse = await buildLiveKitToken({ room, identity });
        writeJson(res, 200, tokenResponse);
        return;
      }
      if (req.method !== 'POST' || requestUrl.pathname !== '/api/ask-map') {
        writeJson(res, 404, { error: 'not_found' });
        return;
      }

      const body = await readJsonBody(req);
      const query = sanitizeQuery(body.query);
      const response = await answerQuery(query, {
        ...context,
        topK: body.topK,
        filters: body.filters || {},
        domainDir: body.domainDir,
        domainId: body.domainId,
        retrievalMode: body.retrievalMode,
      });
      writeJson(res, 200, response);
    } catch (err) {
      const message = err?.message || 'Unknown local retrieval error.';
      const status = /question is required|too long|invalid json/i.test(message) ? 400 : 500;
      writeJson(res, status, {
        error: status === 400 ? 'bad_request' : 'local_retrieval_failed',
        message,
        local_only: true,
      });
    }
  });
  server.on('close', () => context.embedder?.close?.());

  return { server, context };
}

function sanitizeLiveKitValue(value, fallback) {
  const clean = String(value || fallback || '')
    .replace(/[^\w.@:-]/g, '-')
    .slice(0, 96)
    .replace(/^-+|-+$/g, '');
  return clean || fallback;
}

async function buildLiveKitToken(options = {}) {
  const apiKey = process.env.LIVEKIT_API_KEY || DEFAULT_LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET || DEFAULT_LIVEKIT_API_SECRET;
  const url = process.env.LIVEKIT_URL || DEFAULT_LIVEKIT_URL;
  const room = sanitizeLiveKitValue(options.room, DEFAULT_LIVEKIT_ROOM);
  const identity = sanitizeLiveKitValue(options.identity, `${DEFAULT_LIVEKIT_IDENTITY_PREFIX}-local`);
  const token = new AccessToken(apiKey, apiSecret, { identity });
  token.addGrant({
    room,
    roomJoin: true,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
  });
  return {
    token: await token.toJwt(),
    url,
    room,
    identity,
    local_only: true,
  };
}

function readJsonBody(req) {
  return new Promise((resolvePromise, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (data.length > 4096) {
        reject(new Error('Request body too long.'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolvePromise(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error('Invalid JSON request body.'));
      }
    });
    req.on('error', reject);
  });
}

function sanitizeQuery(query) {
  const clean = String(query || '').replace(/\s+/g, ' ').trim();
  if (!clean) throw new Error('Question is required.');
  if (clean.length > MAX_QUERY_CHARS) throw new Error(`Question is too long. Keep it under ${MAX_QUERY_CHARS} characters.`);
  return clean;
}

function runJsonProcess(command, args, payload) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', data => { stdout += data.toString(); });
    child.stderr.on('data', data => { stderr += data.toString(); });
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) {
        reject(new Error(`Embedding sidecar exited with ${code}: ${stderr || stdout}`));
        return;
      }
      try {
        resolvePromise(JSON.parse(stdout));
      } catch (err) {
        reject(new Error(`Embedding sidecar returned invalid JSON: ${err.message}`));
      }
    });
    child.stdin.end(`${JSON.stringify(payload)}\n`);
  });
}

function setCorsHeaders(req, res) {
  const origin = req.headers.origin;
  if (origin && LOCAL_ORIGIN_RE.test(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS, GET');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function writeJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(`${JSON.stringify(payload)}\n`);
}

function parseThemes(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  return String(value).split('||').map(theme => theme.trim()).filter(Boolean);
}

function safeDomainBundlePath(domainDir, domainId) {
  const cleanDir = String(domainDir || '')
    .trim()
    .replace(/^\/+|\/+$/g, '');
  const cleanDomainId = String(domainId || 'all').replace(/[^a-zA-Z0-9_-]/g, '');
  if (!cleanDir || /^[a-z]+:/i.test(cleanDir) || cleanDir.startsWith('//') || cleanDir.includes('..') || cleanDir.includes('\\')) {
    throw new Error('Unsafe domainDir.');
  }
  if (!cleanDir.startsWith('data/private-domains/') && cleanDir !== 'data/domains') {
    throw new Error('domainDir must point to a local Mapper data directory.');
  }
  const path = resolve(PROJECT_ROOT, cleanDir, `${cleanDomainId || 'all'}.json`);
  if (!path.startsWith(`${PROJECT_ROOT}${sep}`)) throw new Error('Unsafe domain bundle path.');
  return path;
}

function tokenizeQuery(query) {
  return String(query || '')
    .toLowerCase()
    .match(/[a-z][a-z0-9-]{2,}/g)
    ?.filter(token => !STATIC_STOPWORDS.has(token)) || [];
}

function staticEvidenceScore(row, terms) {
  if (!terms.length) return 0;
  const title = String(row.title || '').toLowerCase();
  const summary = String(row.summary || '').toLowerCase();
  const excerpt = String(row.excerpt || row.anonymized_text || '').toLowerCase();
  const themes = (row.themes || []).join(' ').toLowerCase();
  const participant = String(row.participant_id || '').toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (title.includes(term)) score += 4;
    if (themes.includes(term)) score += 3;
    if (summary.includes(term)) score += 2;
    if (excerpt.includes(term)) score += 1;
    if (participant.includes(term)) score += 1;
  }
  return Number((score / Math.max(1, terms.length)).toFixed(4));
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function shouldUseStaticBundleRetrieval(context) {
  if (!context.domainDir) return false;
  if (context.retrievalMode === 'static') return true;
  if (context.retrievalMode === 'vector') return false;
  return context.embeddingProvider !== 'ollama';
}

function coerceEmbeddingVector(rawVector, dimensions) {
  let vector = Array.from(rawVector || [], Number);
  if (dimensions && vector.length > dimensions) {
    vector = vector.slice(0, dimensions);
  }
  if (!vector.length || vector.some(value => !Number.isFinite(value))) {
    throw new Error('Embedding provider returned an empty or non-finite vector.');
  }
  const norm = Math.hypot(...vector) || 1;
  return vector.map(value => value / norm);
}

function normalizeOllamaBaseUrl(value) {
  const url = String(value || DEFAULT_OLLAMA_BASE_URL).trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(url)) return `http://${url}`;
  return url;
}

function defaultOllamaQueryPrefix(model) {
  const lower = String(model || '').toLowerCase();
  if (lower.includes('nomic')) return 'search_query: ';
  if (lower.includes('mxbai')) return 'Represent this sentence for searching relevant passages: ';
  return '';
}

function withPrefix(text, prefix) {
  return prefix ? `${prefix}${text}` : text;
}

async function fileExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function hasSeedData(db) {
  try {
    const result = await db.execute('select count(*) as count from embeddings where embedding_vector is not null');
    return Number(result.rows[0]?.count || 0) > 0;
  } catch {
    return false;
  }
}

const STATIC_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'when', 'then', 'than', 'but',
  'about', 'have', 'has', 'had', 'was', 'were', 'are', 'our', 'you', 'they', 'them', 'their',
  'there', 'because', 'before', 'after', 'really', 'very', 'just', 'like', 'would', 'could',
  'should', 'need', 'want', 'what', 'where', 'which', 'who', 'how', 'does',
]);

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { server, context } = await createAskMapServer({
    host: args.host || process.env.ASK_MAP_HOST || DEFAULT_HOST,
    port: args.port || process.env.ASK_MAP_PORT || DEFAULT_PORT,
    dbPath: args.dbPath || process.env.ASK_MAP_DB_PATH || DEFAULT_DB_PATH,
    rebuildDb: args.rebuildDb || process.env.ASK_MAP_REBUILD_DB === '1',
    embeddingProvider: args.embeddingProvider || process.env.EMBEDDING_PROVIDER || DEFAULT_EMBEDDING_PROVIDER,
    python: args.embeddingCommand || process.env.EMBEDDING_COMMAND || DEFAULT_PYTHON,
    embedScript: args.embeddingScript || process.env.EMBEDDING_SCRIPT || DEFAULT_EMBED_SCRIPT,
    model: args.embeddingModel || process.env.EMBEDDING_MODEL,
    modelPath: args.embeddingModelPath || process.env.EMBEDDING_MODEL_PATH || DEFAULT_MODEL_PATH,
    dimensions: args.embeddingDimensions || process.env.EMBEDDING_DIMENSIONS,
    ollamaUrl: args.ollamaUrl || process.env.OLLAMA_HOST || DEFAULT_OLLAMA_BASE_URL,
    ollamaQueryPrefix: args.ollamaQueryPrefix,
    device: args.embeddingDevice || process.env.EMBEDDING_DEVICE,
    topK: args.topK || process.env.ASK_MAP_TOP_K || DEFAULT_TOP_K,
  });
  const host = args.host || process.env.ASK_MAP_HOST || DEFAULT_HOST;
  const port = Number(args.port || process.env.ASK_MAP_PORT || DEFAULT_PORT);
  server.listen(port, host, () => {
    console.log(`[ask-map] Local retrieval server listening at http://${host}:${port}`);
    console.log(`[ask-map] Database: ${context.dbPath}`);
    console.log('[ask-map] Endpoint: POST /api/ask-map');
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(err => {
    console.error(err);
    process.exitCode = 1;
  });
}
