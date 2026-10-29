// Verified Ripple production and development v2 contracts only.
const prefixes = ['ripple-transcript://open/v2?', 'ripple-segment-dev://open/v2?'];
const fields = ['project', 'recording', 'model', 'version', 'segment', 'identity'];
export function safeAppLink(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[^\x21-\x7e]/.test(value)) return null;
  const prefix = prefixes.find(prefix => value.startsWith(prefix));
  if (!prefix) return null;
  const pairs = value.slice(prefix.length).split('&');
  if (pairs.length !== fields.length) return null;
  const seen = new Set();
  for (const pair of pairs) {
    const [key, id, extra] = pair.split('=');
    if (extra !== undefined || !fields.includes(key) || seen.has(key) || !/^[A-Za-z0-9_-]{1,160}$/.test(id ?? '')) return null;
    if (key === 'identity' && !/^[a-f0-9-]{36}$/.test(id)) return null;
    seen.add(key);
  }
  return value;
}
