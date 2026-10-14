// Display-only presets. Never derive document formatting from these values.
export const BODY_ZOOM_LEVELS = Object.freeze([50, 75, 90, 100, 110, 125, 150, 200]);

export function stepBodyZoom(current, direction) {
  const index = BODY_ZOOM_LEVELS.indexOf(current);
  return BODY_ZOOM_LEVELS[Math.max(0, Math.min(BODY_ZOOM_LEVELS.length - 1, (index < 0 ? 3 : index) + direction))];
}

export function bodyZoomShortcut(event, platform = globalThis.navigator?.userAgentData?.platform || globalThis.navigator?.platform || '') {
  const mac = /mac|iphone|ipad|ipod/i.test(platform);
  if (event.isComposing || event.keyCode === 229 || event.altKey || !event.shiftKey
      || !(mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey)) return null;
  // Shift changes the character on =, - and 0. Match the underlying key, and
  // keep a character fallback for synthetic/accessibility keyboard events.
  const code = event.code || ({'=': 'Equal', '+': 'Equal', '-': 'Minus', '_': 'Minus', '0': 'Digit0', ')': 'Digit0'}[event.key]);
  return ({Equal: 'in', Minus: 'out', Digit0: 'reset'})[code] || null;
}
