// Both sidebars share limits, persistence and keyboard behavior. The right edge
// grows leftward, so pointer and arrow-key deltas are mirrored there.
export function setupSidebarResize(drawer, {side, name, defaultWidth, other}) {
  const handle = drawer.querySelector('[role="separator"]');
  const stored = Number(localStorage.getItem(`leaf-${name}-width`));
  let width = Number.isFinite(stored) && stored > 0 ? stored : defaultWidth;
  let drag = null;
  const direction = side === 'left' ? 1 : -1;
  const limits = () => {
    const area = drawer.parentElement.clientWidth;
    const otherWidth = other.classList.contains('visible') ? other.getBoundingClientRect().width : 32;
    // Sidebars always consume layout width, including on narrow windows.
    // Keep the text viewport usable instead of covering it with an overlay.
    const available = area - otherWidth - 360;
    return [200, Math.max(200, Math.min(560, available))];
  };
  const apply = () => {
    const [min, max] = limits();
    const actual = Math.max(min, Math.min(max, width));
    drawer.style.setProperty(`--${name}-width`, `${actual}px`);
    handle.setAttribute('aria-valuemin', min);
    handle.setAttribute('aria-valuemax', max);
    handle.setAttribute('aria-valuenow', Math.round(actual));
  };
  const save = () => localStorage.setItem(`leaf-${name}-width`, String(width));
  const finish = () => {
    if (!drag) return;
    drag = null;
    drawer.classList.remove('resizing');
    save();
  };
  handle.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    event.preventDefault();
    drag = {x: event.clientX, width: drawer.getBoundingClientRect().width};
    handle.setPointerCapture(event.pointerId);
    drawer.classList.add('resizing');
  });
  handle.addEventListener('pointermove', event => {
    if (!drag) return;
    const [min, max] = limits();
    width = Math.max(min, Math.min(max, drag.width + direction * (event.clientX - drag.x)));
    apply();
  });
  for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) handle.addEventListener(event, finish);
  handle.addEventListener('dblclick', () => { width = defaultWidth; apply(); save(); });
  handle.addEventListener('keydown', event => {
    const [min, max] = limits();
    const actual = Number(handle.getAttribute('aria-valuenow'));
    if (event.key === 'ArrowLeft') width = actual - 10 * direction;
    else if (event.key === 'ArrowRight') width = actual + 10 * direction;
    else if (event.key === 'Home') width = min;
    else if (event.key === 'End') width = max;
    else return;
    event.preventDefault();
    width = Math.max(min, Math.min(max, width));
    apply(); save();
  });
  apply();
  return apply;
}
