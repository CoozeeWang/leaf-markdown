// Only the verified Ripple Segment Dev v2 contract is supported. Production
// schemes require their own reviewed contract; never treat arbitrary schemes as files.
const fields = ['project', 'recording', 'model', 'version', 'segment', 'identity'];
export function safeAppLink(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[^\x21-\x7e]/.test(value) || !value.startsWith('ripple-segment-dev://open/v2?')) return null;
  const pairs = value.slice('ripple-segment-dev://open/v2?'.length).split('&');
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
