// Pointer and keyboard share one candidate: the focused menu item.
const menus = '.action-popover, .heading-popover, .callout-popover, .recent-popover, .mode-popover, .leaf-table-menu';
export function installMenuInteraction() {
  document.addEventListener('pointermove', event => {
    const button = event.target.closest('button');
    if (!button || button.disabled || !button.closest(menus)) return;
    if (document.activeElement !== button) button.focus({preventScroll: true});
  });
  document.addEventListener('keydown', event => {
    if (event.defaultPrevented) return;
    const menu = event.target.closest(menus);
    if (!menu) return;
    const items = [...menu.querySelectorAll('button:not(:disabled)')];
    const index = items.indexOf(document.activeElement);
    const next = {ArrowDown: (index + 1) % items.length, ArrowUp: (index - 1 + items.length) % items.length,
      ArrowRight: (index + 1) % items.length, ArrowLeft: (index - 1 + items.length) % items.length,
      Home: 0, End: items.length - 1}[event.key];
    if (next !== undefined) {
      event.preventDefault();
      items[next]?.focus();
      items[next]?.scrollIntoView({block: 'nearest', inline: 'nearest'});
    }
  });
}
