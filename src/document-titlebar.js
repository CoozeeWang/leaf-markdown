// Keep the filename centered on the window, independent of either side's width.
export function setupDocumentTitlebar(topbar) {
  const shell = topbar.closest('.shell');
  const brand = topbar.querySelector('.brand');
  const actions = topbar.querySelector('.topbar-actions');
  const layout = () => {
    const bar = topbar.getBoundingClientRect();
    if (!bar.width) return;
    const left = brand.getBoundingClientRect().right - bar.left;
    const right = bar.right - actions.getBoundingClientRect().left;
    // Include the unsaved dot and a gap on both sides without shifting the title.
    const available = bar.width - 2 * (Math.max(left, right) + 16);
    const stacked = available < 64;
    shell.classList.toggle('titlebar-stacked', stacked);
    topbar.style.setProperty('--document-title-width', `${Math.min(300, stacked ? bar.width - 64 : available)}px`);
  };
  const observer = new ResizeObserver(layout);
  for (const element of [topbar, brand, actions]) observer.observe(element);
  layout();
  return () => observer.disconnect();
}
