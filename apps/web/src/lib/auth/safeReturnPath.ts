/**
 * Return-path sanitizer for post-authentication redirects.
 *
 * Any `next` / `returnTo` value that arrives from the URL (login links, OAuth
 * callbacks, email links) is client-controlled. Only same-origin, in-app paths
 * are accepted. Everything else falls back to a fixed safe route, so a crafted
 * link can never send a freshly authenticated user to an external origin.
 *
 * Rejected examples: `https://evil.test`, `//evil.test`, `/\evil.test`,
 * `javascript:alert(1)`, paths containing control characters, and paths
 * that do not begin with a single `/`.
 */

export const DEFAULT_POST_AUTH_PATH = '/dashboard';

const MAX_PATH_LENGTH = 512;
// Control characters and any whitespace (browsers strip tab/newline/CR from URLs).
// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional control-character guard
const CONTROL_CHARS = /[\u0000-\u001f\u007f\s]/;

export function sanitizeReturnPath(
  candidate: string | null | undefined,
  fallback: string = DEFAULT_POST_AUTH_PATH
): string {
  if (typeof candidate !== 'string') return fallback;
  if (candidate.length === 0 || candidate.length > MAX_PATH_LENGTH) return fallback;
  if (!candidate.startsWith('/')) return fallback;
  // Protocol-relative (`//host`) and backslash variants (`/\host`) escape the origin.
  if (candidate.startsWith('//') || candidate.startsWith('/\\')) return fallback;
  if (CONTROL_CHARS.test(candidate)) return fallback;

  try {
    // Resolve against a dummy origin: anything that changes origin is unsafe.
    const resolved = new URL(candidate, 'https://app.invalid');
    if (resolved.origin !== 'https://app.invalid') return fallback;
  } catch {
    return fallback;
  }

  return candidate;
}
