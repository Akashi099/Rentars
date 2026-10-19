/**
 * Parses the TRUST_PROXY setting into the value Express expects for `trust proxy`.
 *
 * Behind a load balancer, `req.ip` is the proxy's address unless Express is told
 * which hops to trust. Without this, every client shares one rate-limit bucket.
 *
 * Accepted values:
 *   unset / "" / "false"  → do not trust forwarding headers (default)
 *   "<n>" (integer ≥ 1)    → trust the last n hops in X-Forwarded-For
 *   "10.0.0.0/8,loopback"  → trust only these addresses or subnets
 *
 * "true" is rejected: it trusts any client-supplied X-Forwarded-For value,
 * which lets an attacker pick their own rate-limit key.
 */
export type TrustProxySetting = false | number | string[];

export function parseTrustProxy(raw: string | undefined): TrustProxySetting {
  const value = raw?.trim() ?? '';
  if (value === '' || value === 'false') return false;

  if (value === 'true') {
    throw new Error(
      'TRUST_PROXY=true is not allowed: it trusts any client-supplied X-Forwarded-For. ' +
        'Set a hop count (e.g. "1") or an explicit list of trusted proxy addresses.'
    );
  }

  if (/^\d+$/.test(value)) {
    const hops = Number(value);
    if (hops < 1) throw new Error('TRUST_PROXY hop count must be at least 1');
    return hops;
  }

  const entries = value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (entries.length === 0) return false;
  return entries;
}
