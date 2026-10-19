/**
 * Link Safety Utilities
 *
 * Detects and handles unsafe URLs in user-generated content.
 *
 * Strategy:
 *  - extractUrls()      — find all URLs in a plaintext string
 *  - hasUnsafeLinks()   — true if any extracted URL uses a dangerous protocol
 *                         or matches a known-bad pattern
 *  - sanitizeLinks()    — strip or replace unsafe URLs; leave safe ones intact
 *  - classifyUrls()     — return per-URL safety verdicts for moderation tools
 *
 * This module operates on already-HTML-stripped text (sanitize.ts runs first).
 * All checks are pattern-based; no outbound HTTP requests are made.
 */

// ─── Constants ─────────────────────────────────────────────────────────────────

/** Protocols that can execute code or exfiltrate data. */
const DANGEROUS_PROTOCOLS = /^(javascript|data|vbscript|blob|file):/i;

/** Well-known URL shorteners — flag for human review, not auto-block. */
const SHORTENER_DOMAINS = new Set([
  'bit.ly', 'tinyurl.com', 't.co', 'goo.gl', 'ow.ly', 'buff.ly',
  'rebrand.ly', 'short.io', 'bl.ink', 'cutt.ly', 'is.gd', 'v.gd',
]);

/**
 * Domains that are always considered safe (Rentars own domains + major services).
 * Adjust to match your actual domain list.
 */
const SAFE_DOMAINS = new Set([
  'rentars.com', 'www.rentars.com', 'app.rentars.com',
  'github.com', 'google.com', 'apple.com', 'microsoft.com',
]);

// ─── URL extraction ────────────────────────────────────────────────────────────

const URL_REGEX =
  /https?:\/\/[^\s<>"'(){}\[\]|\\^`\u0000-\u001F\u007F-\u009F]+/gi;

/**
 * Extract all http/https URLs from a plaintext string.
 * Returns an empty array for inputs that contain no URLs.
 */
export function extractUrls(text: string): string[] {
  return Array.from(text.matchAll(URL_REGEX)).map((m) => m[0]);
}

// ─── Safety classification ────────────────────────────────────────────────────

export type UrlVerdict = 'safe' | 'shortener' | 'unsafe_protocol' | 'malformed';

export interface UrlClassification {
  url: string;
  verdict: UrlVerdict;
  domain: string | null;
}

/**
 * Classify a single URL.
 */
export function classifyUrl(url: string): UrlClassification {
  // Compact whitespace that might be used to evade protocol detection
  const compact = url.replace(/[\t\r\n ]/g, '');

  if (DANGEROUS_PROTOCOLS.test(compact)) {
    return { url, verdict: 'unsafe_protocol', domain: null };
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { url, verdict: 'malformed', domain: null };
  }

  const domain = parsed.hostname.replace(/^www\./, '').toLowerCase();

  if (SHORTENER_DOMAINS.has(domain)) {
    return { url, verdict: 'shortener', domain };
  }

  return { url, verdict: 'safe', domain };
}

/**
 * Classify all URLs found in `text`.
 */
export function classifyUrls(text: string): UrlClassification[] {
  return extractUrls(text).map(classifyUrl);
}

/**
 * Returns true if the text contains at least one URL that is considered
 * immediately unsafe (dangerous protocol or malformed).
 * URL shorteners are NOT treated as unsafe here — they are flagged for review.
 */
export function hasUnsafeLinks(text: string): boolean {
  return classifyUrls(text).some(
    (c) => c.verdict === 'unsafe_protocol' || c.verdict === 'malformed',
  );
}

/**
 * Returns true if the text contains URL shortener links that need human review.
 */
export function hasShortenerLinks(text: string): boolean {
  return classifyUrls(text).some((c) => c.verdict === 'shortener');
}

/**
 * Remove all URLs with unsafe protocols from `text`.
 * URL shorteners are left in place but callers can flag the content for review.
 * Safe http/https URLs are always preserved.
 */
export function sanitizeLinks(text: string): string {
  return text.replace(URL_REGEX, (match) => {
    const { verdict } = classifyUrl(match);
    if (verdict === 'unsafe_protocol' || verdict === 'malformed') return '[link removed]';
    return match;
  });
}

/**
 * Combined check used by the message service:
 *
 *  - Strip unsafe protocol links
 *  - Return flags so the caller can decide whether to auto-reject or flag for review
 */
export interface LinkCheckResult {
  sanitizedText: string;
  hasUnsafe: boolean;
  hasShortener: boolean;
  classifications: UrlClassification[];
}

export function checkAndSanitizeLinks(text: string): LinkCheckResult {
  const classifications = classifyUrls(text);
  const hasUnsafe = classifications.some(
    (c) => c.verdict === 'unsafe_protocol' || c.verdict === 'malformed',
  );
  const hasShortener = classifications.some((c) => c.verdict === 'shortener');
  const sanitizedText = sanitizeLinks(text);

  return { sanitizedText, hasUnsafe, hasShortener, classifications };
}
