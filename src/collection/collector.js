/**
 * Anonymized response collection module.
 *
 * After every INTERVAL responses, encodes the current responses as a token
 * (reusing the shareable map link codec) and POSTs it to a Google Apps Script
 * endpoint that appends to a Google Sheet.
 *
 * - Fire-and-forget: errors are silently logged, never shown to the user.
 * - Skipped in shared view mode (?t= URL param).
 * - Respects user opt-out preference in localStorage.
 * - Feature-flagged via CONFIG.ENABLED.
 */

import { encodeToken } from '../sharing/token-codec.js';
import { buildIndex } from '../sharing/question-index.js';

// ── Configuration ──────────────────────────────────────────────────────────
const CONFIG = {
  ENABLED: true,
  ENDPOINT_URL: 'https://script.google.com/macros/s/AKfycbwYNqjfV0-6FDHxBoLxpq7bK9HJZfD9EydHQoRgFztfn0ijwelEaIvD_uRMhOlMUu0V/exec',
  INTERVAL: 10,     // Send every N responses
};

// ── Session ID (per page load, not persisted) ──────────────────────────────
const SESSION_ID = typeof crypto !== 'undefined' && crypto.randomUUID
  ? crypto.randomUUID().slice(0, 8)
  : Math.random().toString(16).slice(2, 10);

// ── Preference helpers ─────────────────────────────────────────────────────
const PREF_KEY = 'mapper:collectResponses';

/** Check if the user has opted in to response collection (default: true). */
export function isCollectionEnabled() {
  try {
    const val = localStorage.getItem(PREF_KEY);
    if (val === null) return true; // default: on
    return val === 'true';
  } catch {
    return true;
  }
}

/** Set the user's collection preference. */
export function setCollectionEnabled(value) {
  try {
    localStorage.setItem(PREF_KEY, String(!!value));
  } catch { /* noop — localStorage unavailable */ }
}

// ── Shared view detection ──────────────────────────────────────────────────
const IS_SHARED_VIEW = typeof window !== 'undefined'
  && new URLSearchParams(window.location.search).has('t');

// ── Send logic ─────────────────────────────────────────────────────────────

/**
 * POST a token to the GAS endpoint. Fire-and-forget (no-cors).
 * @param {string} token - base64url-encoded response token
 * @param {number} responseCount - total responses in the token
 * @param {string} domain - active domain ID at time of send
 */
function sendToken(token, responseCount, domain) {
  if (!CONFIG.ENDPOINT_URL) return;

  const body = JSON.stringify({
    session_id: SESSION_ID,
    token,
    response_count: responseCount,
    domain: domain || 'all',
  });

  try {
    fetch(CONFIG.ENDPOINT_URL, {
      method: 'POST',
      mode: 'no-cors',
      headers: { 'Content-Type': 'application/json' },
      body,
    }).catch(err => {
      console.warn('[collector] Send failed:', err.message || err);
    });
  } catch (err) {
    console.warn('[collector] Send failed:', err.message || err);
  }
}

/**
 * Check whether collection should fire, and if so, encode + send.
 * Called after each response is added to the store.
 *
 * @param {Array} responses - current $responses.get() array
 * @param {Array} allQuestions - full question array (for building token index)
 * @param {string} activeDomain - current $activeDomain value
 */
export function maybeCollect(responses, allQuestions, activeDomain) {
  if (!CONFIG.ENABLED) return;
  if (!CONFIG.ENDPOINT_URL) return;
  if (IS_SHARED_VIEW) return;
  if (!isCollectionEnabled()) return;
  if (!responses || responses.length === 0) return;
  if (responses.length % CONFIG.INTERVAL !== 0) return;
  if (!allQuestions || allQuestions.length === 0) return;

  const tokenIndex = buildIndex(allQuestions);
  const token = encodeToken(responses, tokenIndex);
  if (!token) return;

  sendToken(token, responses.length, activeDomain);
  console.debug('[collector] Sent token (%d responses)', responses.length);
}
