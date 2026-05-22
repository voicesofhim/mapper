import { createHash } from 'node:crypto';

const SENSITIVE_FIELD_PATTERNS = [
  /\bemail\b/i,
  /\be-mail\b/i,
  /\bphone\b/i,
  /\bprimary contact\b/i,
  /\bcontact\b.*\bemail\b/i,
  /\btimestamp\b/i,
  /\btimezone\b/i,
  /\bvisa\b/i,
  /\bpassword\b/i,
  /\bsecret\b/i,
  /\btoken\b/i,
  /\bprivate[_-]?key\b/i,
];

const LOW_SIGNAL_CONTENT_PATTERNS = [
  /^GH_FETCH_FAILED\b/i,
  /^n\/a$/i,
  /^none$/i,
  /^null$/i,
  /^-$/i,
];

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function slugify(value, fallback = 'item') {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || fallback;
}

export function shouldSkipSensitiveField(fieldName) {
  const value = String(fieldName ?? '');
  return SENSITIVE_FIELD_PATTERNS.some(pattern => pattern.test(value));
}

export function shouldSkipLowSignalContent(content) {
  const value = String(content ?? '').trim();
  if (!value) return true;
  return LOW_SIGNAL_CONTENT_PATTERNS.some(pattern => pattern.test(value));
}

export function redactSensitiveText(input) {
  const original = String(input ?? '');
  const text = original
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted-email]')
    .replace(/\b(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)\d{3}[-.\s]?\d{4}\b/g, '[redacted-phone]')
    .replace(/\b([A-Z0-9_]*(?:API[_-]?KEY|SECRET|TOKEN|PASSWORD|PRIVATE[_-]?KEY)[A-Z0-9_]*)\s*[:=]\s*[^\s`'"]+/gi, '$1=[redacted-secret]')
    .replace(/(mailto:)[^\s)]+/gi, '$1[redacted-email]')
    .replace(/[ \t]+\n/g, '\n')
    .trim();

  return {
    text,
    redacted: text !== original.trim(),
  };
}

export function safeText(input) {
  return redactSensitiveText(input).text;
}

export function firstSentenceSummary(text, maxLength = 220) {
  const compact = String(text || '').replace(/\s+/g, ' ').trim();
  const sentence = compact.split(/(?<=[.!?])\s+/)[0] || compact;
  return sentence.length > maxLength ? `${sentence.slice(0, maxLength - 3).trim()}...` : sentence;
}

export function normalizeTagName(value) {
  return safeText(value).replace(/\s+/g, ' ').trim();
}

export function safeMetadata(value) {
  if (value == null) return value;
  if (typeof value === 'string') return safeText(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map(entry => safeMetadata(entry));
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !shouldSkipSensitiveField(key))
        .map(([key, entry]) => [key, safeMetadata(entry)])
    );
  }
  return undefined;
}

export function buildEmbeddingDocument(input) {
  const content = safeText(input.content);
  const safeTags = (input.tags ?? [])
    .map(normalizeTagName)
    .filter(Boolean)
    .slice(0, 12);

  return [
    input.title ? `Title: ${safeText(input.title)}` : '',
    input.participantLabel ? `Subject: ${safeText(input.participantLabel)}` : '',
    input.sourceType ? `Source type: ${safeText(input.sourceType)}` : '',
    input.sourceFamily ? `Source family: ${safeText(input.sourceFamily)}` : '',
    input.sourceMode ? `Source mode: ${safeText(input.sourceMode)}` : '',
    input.depthLevel ? `Depth level: ${safeText(input.depthLevel)}` : '',
    input.summary ? `Summary: ${safeText(input.summary)}` : '',
    safeTags.length > 0 ? `Tags: ${safeTags.join(', ')}` : '',
    'Content:',
    content,
  ].filter(Boolean).join('\n');
}
