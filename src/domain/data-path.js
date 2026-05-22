/** Resolve the static domain bundle directory, with a local-only preview override. */

const DEFAULT_DOMAIN_DIR = 'data/domains';
const STORAGE_KEY = 'mapper.domainDir';

export function getDomainDataDir() {
  const override = readBrowserOverride();
  return override || DEFAULT_DOMAIN_DIR;
}

export function domainDataUrl(fileName, basePath) {
  const base = ensureTrailingSlash(basePath ?? (import.meta.env.BASE_URL || '/mapper/'));
  const dir = getDomainDataDir();
  return `${base}${dir}/${fileName}`.replace(/([^:]\/)\/+/g, '$1');
}

function readBrowserOverride() {
  if (typeof window === 'undefined') return '';

  const params = new URLSearchParams(window.location.search);
  const fromUrl = params.get('domainDir');
  if (fromUrl === 'public') {
    window.localStorage?.removeItem(STORAGE_KEY);
    return '';
  }

  const sanitizedUrlValue = sanitizeDomainDir(fromUrl);
  if (sanitizedUrlValue) {
    window.localStorage?.setItem(STORAGE_KEY, sanitizedUrlValue);
    return sanitizedUrlValue;
  }

  return sanitizeDomainDir(window.localStorage?.getItem(STORAGE_KEY));
}

function sanitizeDomainDir(value) {
  const dir = String(value || '').trim().replace(/^\/+|\/+$/g, '');
  if (!dir) return '';
  if (/^[a-z]+:/i.test(dir) || dir.startsWith('//') || dir.includes('..') || dir.includes('\\')) {
    console.warn(`[domain-data] Ignoring unsafe domainDir override: ${value}`);
    return '';
  }
  return dir;
}

function ensureTrailingSlash(value) {
  return value.endsWith('/') ? value : `${value}/`;
}
