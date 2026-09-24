const observedMenus = new WeakSet();

// Measure the visible panel rather than assuming that its CSS width won the cascade.
export function positionMenu(menu, anchor) {
  const edge = 8, gap = 6;
  menu.style.maxWidth = `${Math.max(0, innerWidth - edge * 2)}px`;
  menu.style.maxHeight = `${Math.max(0, innerHeight - edge * 2)}px`;
  const box = menu.getBoundingClientRect();
  const border = box.height - menu.clientHeight;
  const naturalHeight = menu.scrollHeight + border;
  const below = Math.max(0, innerHeight - edge - anchor.bottom - gap);
  const above = Math.max(0, anchor.top - gap - edge);
  const openBelow = naturalHeight <= below || below >= above;
  menu.style.maxHeight = `${openBelow ? below : above}px`;
  const height = menu.getBoundingClientRect().height;
  menu.style.left = `${Math.max(edge, Math.min(anchor.left, innerWidth - box.width - edge))}px`;
  menu.style.top = `${Math.max(edge, openBelow ? anchor.bottom + gap : anchor.top - gap - height)}px`;
  menu.scrollTop = 0;
  if (!observedMenus.has(menu)) {
    observedMenus.add(menu);
    menu.addEventListener('focusin', event => {
      const item = event.target.closest('button');
      if (!item) return;
      const panel = menu.getBoundingClientRect(), target = item.getBoundingClientRect();
      if (target.bottom > panel.bottom - edge) menu.scrollTop += target.bottom - panel.bottom + edge;
      else if (target.top < panel.top + edge) menu.scrollTop -= panel.top + edge - target.top;
    });
  }
}
