/**
 * Anonymized response collection module.
 *
 * After every INTERVAL responses, encodes the current responses as a token
 * (reusing the shareable map link codec) and POSTs it to a Google Apps Script
 * endpoint that appends to a Google Sheet.
 *
 * Also sends a final beacon on page unload to capture partial sessions.
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
  ENDPOINT_URL: 'https://script.google.com/macros/s/AKfycbw55yM6nkllMydqg5LJmofcxd8kxlB85J4xMDSF35N_HmliVXdu_MgkMJmsHmkLYIKP/exec',
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

// ── State tracking ─────────────────────────────────────────────────────────
let _lastSentCount = 0;       // Response count at last successful send
let _cachedQuestions = null;   // Cached allQuestions reference for beforeunload

// ── Send logic ─────────────────────────────────────────────────────────────

/**
 * POST a token to the GAS endpoint. Fire-and-forget (no-cors).
 * @param {string} token - base64url-encoded response token
 * @param {number} responseCount - total responses in the token
 * @param {boolean} [useBeacon=false] - use sendBeacon for page unload
 */
function sendToken(token, responseCount, useBeacon = false) {
  if (!CONFIG.ENDPOINT_URL) return;

  const body = JSON.stringify({
    session_id: SESSION_ID,
    token,
    response_count: responseCount,
  });

  if (useBeacon) {
    // Use fetch with keepalive (survives page unload, follows redirects — unlike sendBeacon)
    try {
      fetch(CONFIG.ENDPOINT_URL, {
        method: 'POST',
        mode: 'no-cors',
        keepalive: true,
        headers: { 'Content-Type': 'application/json' },
        body,
      }).catch(() => {});
    } catch { /* noop */ }
    return;
  }

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
 * Encode and send the current responses.
 * @param {Array} responses
 * @param {Array} allQuestions
 * @param {boolean} [useBeacon=false]
 * @returns {boolean} true if sent
 */
function encodeAndSend(responses, allQuestions, useBeacon = false) {
  if (!allQuestions || allQuestions.length === 0) return false;

  const tokenIndex = buildIndex(allQuestions);
  const token = encodeToken(responses, tokenIndex);
  if (!token) return false;

  sendToken(token, responses.length, useBeacon);
  _lastSentCount = responses.length;
  return true;
}

/**
 * Check whether collection should fire, and if so, encode + send.
 * Called after each response is added to the store.
 *
 * @param {Array} responses - current $responses.get() array
 * @param {Array} allQuestions - full question array (for building token index)
 */
export function maybeCollect(responses, allQuestions) {
  if (!CONFIG.ENABLED) return;
  if (!CONFIG.ENDPOINT_URL) return;
  if (IS_SHARED_VIEW) return;
  if (!isCollectionEnabled()) return;
  if (!responses || responses.length === 0) return;
  if (responses.length % CONFIG.INTERVAL !== 0) return;
  if (responses.length === _lastSentCount) return; // avoid duplicate sends

  _cachedQuestions = allQuestions; // cache for beforeunload

  if (encodeAndSend(responses, allQuestions)) {
    console.debug('[collector] Sent token (%d responses)', responses.length);
  }
}

// ── Page unload: send partial session via beacon ───────────────────────────
if (typeof window !== 'undefined' && !IS_SHARED_VIEW) {
  window.addEventListener('beforeunload', () => {
    if (!CONFIG.ENABLED || !CONFIG.ENDPOINT_URL) return;
    if (!isCollectionEnabled()) return;
    if (!_cachedQuestions) return;

    try {
      const responses = JSON.parse(localStorage.getItem('mapper:responses') || '[]');
      // Only send if we have new responses since last send
      if (responses.length > _lastSentCount && responses.length > 0) {
        encodeAndSend(responses, _cachedQuestions, true);
        console.debug('[collector] Beacon sent (%d responses)', responses.length);
      }
    } catch { /* noop */ }
  });
}
