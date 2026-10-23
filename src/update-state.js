// Native revisions order both events and the initial snapshot.
export function mergeUpdateSnapshot(current, incoming) {
  if (!incoming || !Number.isSafeInteger(incoming.state_revision) || incoming.state_revision < 0) return current;
  if (current && incoming.state_revision <= current.state_revision) return current;
  return incoming;
}
