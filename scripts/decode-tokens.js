#!/usr/bin/env node

/**
 * Offline token decoder for Knowledge Mapper response collection.
 *
 * Reads tokens from a CSV or JSON file (exported from the Google Sheet)
 * and decodes each into structured response data.
 *
 * Usage:
 *   node scripts/decode-tokens.js --input tokens.csv --format csv > decoded.csv
 *   node scripts/decode-tokens.js --input tokens.json --format json > decoded.json
 *
 * Input CSV format (from Google Sheet):
 *   Timestamp, Session ID, Token, Response Count, Domain
 *
 * Output includes: session_id, timestamp, question_id, is_correct, is_skipped
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { inflate } from 'pako';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Inline token decoder (avoids importing browser-only modules) ───────

function base64urlToBytes(str) {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const pad = (4 - (b64.length % 4)) % 4;
  const padded = b64 + '='.repeat(pad);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function decodeTokenRaw(base64urlString) {
  try {
    const compressed = base64urlToBytes(base64urlString);
    const bytes = inflate(compressed, { raw: true });
    if (bytes.length < 3) return null;

    const version = bytes[0];
    const count = (bytes[1] << 8) | bytes[2];
    const entries = [];

    for (let i = 0; i < count; i++) {
      const offset = 3 + i * 3;
      if (offset + 2 >= bytes.length) break;
      const index = (bytes[offset] << 8) | bytes[offset + 1];
      const value = bytes[offset + 2];
      entries.push({
        index,
        is_correct: value === 2,
        is_skipped: value === 1,
      });
    }

    return { version, entries };
  } catch (err) {
    console.error('[decoder] Failed to decode token:', err.message);
    return null;
  }
}

// ── Question index builder ─────────────────────────────────────────────

async function loadQuestionIndex() {
  // Load all domain bundles and merge questions (matching browser boot flow)
  const dataDir = resolve(__dirname, '..', 'data', 'domains');
  const { readdirSync } = await import('fs');
  const files = readdirSync(dataDir).filter(f => f.endsWith('.json') && f !== 'all.json');

  const allQuestions = new Map();

  // Load all.json first (boot bundle with 50 questions)
  const allBundle = JSON.parse(readFileSync(resolve(dataDir, 'all.json'), 'utf-8'));
  for (const q of allBundle.questions) allQuestions.set(q.id, q);

  // Load all domain bundles to get the full 2500 questions
  for (const file of files) {
    try {
      const bundle = JSON.parse(readFileSync(resolve(dataDir, file), 'utf-8'));
      if (bundle.questions) {
        for (const q of bundle.questions) allQuestions.set(q.id, q);
      }
    } catch { /* skip malformed files */ }
  }

  // Sort deterministically — must match buildIndex() in question-index.js exactly
  // (uses < / > comparison, NOT localeCompare)
  const sorted = [...allQuestions.values()].sort((a, b) => {
    const da = (a.domain_ids?.[0] || '');
    const db = (b.domain_ids?.[0] || '');
    if (da < db) return -1;
    if (da > db) return 1;
    if (a.id < b.id) return -1;
    if (a.id > b.id) return 1;
    return 0;
  });

  const indexToQuestion = new Map();
  sorted.forEach((q, i) => indexToQuestion.set(i, q));

  return indexToQuestion;
}

// ── Input parsing ──────────────────────────────────────────────────────

function parseCSVInput(content) {
  const lines = content.trim().split('\n');
  // Skip header row
  const records = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(',').map(s => s.trim());
    if (parts.length < 3) continue;
    records.push({
      timestamp: parts[0],
      session_id: parts[1],
      token: parts[2],
      response_count: parseInt(parts[3], 10) || 0,
      domain: parts[4] || 'all',
    });
  }
  return records;
}

function parseJSONInput(content) {
  const data = JSON.parse(content);
  return Array.isArray(data) ? data : [data];
}

// ── Main ───────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  let inputFile = null;
  let outputFormat = 'csv';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--input' && args[i + 1]) inputFile = args[++i];
    else if (args[i] === '--format' && args[i + 1]) outputFormat = args[++i];
    else if (args[i] === '--help') {
      console.log('Usage: node scripts/decode-tokens.js --input <file> --format <csv|json>');
      process.exit(0);
    }
  }

  if (!inputFile) {
    console.error('Error: --input <file> is required');
    process.exit(1);
  }

  const content = readFileSync(resolve(inputFile), 'utf-8');
  const isJSON = inputFile.endsWith('.json');
  const records = isJSON ? parseJSONInput(content) : parseCSVInput(content);

  console.error(`[decoder] Loading question index...`);
  const indexToQuestion = await loadQuestionIndex();
  console.error(`[decoder] Loaded ${indexToQuestion.size} questions`);
  console.error(`[decoder] Decoding ${records.length} tokens...`);

  const decoded = [];

  for (const record of records) {
    const result = decodeTokenRaw(record.token);
    if (!result) {
      console.error(`[decoder] Failed to decode token from session ${record.session_id}`);
      continue;
    }

    for (const entry of result.entries) {
      const q = indexToQuestion.get(entry.index);
      decoded.push({
        session_id: record.session_id,
        timestamp: record.timestamp,
        domain: record.domain,
        question_index: entry.index,
        question_id: q?.id || `unknown_${entry.index}`,
        question_text: q?.question_text || '',
        correct_answer: q ? q.options?.[q.correct_answer] || '' : '',
        is_correct: entry.is_correct,
        is_skipped: entry.is_skipped,
      });
    }
  }

  // Output
  if (outputFormat === 'json') {
    console.log(JSON.stringify(decoded, null, 2));
  } else {
    // CSV
    console.log('session_id,timestamp,domain,question_index,question_id,question_text,correct_answer,is_correct,is_skipped');
    for (const row of decoded) {
      const text = `"${(row.question_text || '').replace(/"/g, '""')}"`;
      const answer = `"${(row.correct_answer || '').replace(/"/g, '""')}"`;
      console.log(`${row.session_id},${row.timestamp},${row.domain},${row.question_index},${row.question_id},${text},${answer},${row.is_correct},${row.is_skipped}`);
    }
  }

  console.error(`[decoder] Decoded ${decoded.length} responses from ${records.length} tokens`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
