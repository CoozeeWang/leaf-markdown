// Custom listbox: native macOS select menus ignore per-option font families.
// The hidden select remains the preference value/event adapter, not a second UI.
export function setupFontPicker(select, { label }) {
  select.hidden = true;
  select.removeAttribute('aria-label');
  select.removeAttribute('data-i18n-aria-label');
  const trigger = document.createElement('button');
  trigger.type = 'button'; trigger.className = 'body-font-trigger';
  trigger.id = `${select.id}Button`;
  trigger.setAttribute('role', 'combobox');
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');
  trigger.setAttribute('aria-describedby', 'bodyFontStatus');
  const list = document.createElement('div');
  list.id = `${select.id}List`; list.className = 'body-font-list'; list.hidden = true;
  list.setAttribute('role', 'listbox');
  trigger.setAttribute('aria-controls', list.id);
  select.after(trigger, list);
  let choices = [], current = '', cursor = 0, prefix = '', typedAt = 0;
  const isOpen = () => !list.hidden;
  function close() {
    list.hidden = true; trigger.setAttribute('aria-expanded', 'false');
    trigger.removeAttribute('aria-activedescendant');
  }
  function highlight(index) {
    cursor = (index + choices.length) % choices.length;
    [...list.children].forEach((option, i) => option.classList.toggle('candidate', i === cursor));
    const option = list.children[cursor];
    if (option) { trigger.setAttribute('aria-activedescendant', option.id); option.scrollIntoView({ block: 'nearest' }); }
  }
  function open() {
    if (!choices.length) return;
    document.dispatchEvent(new CustomEvent('leaf-font-picker-open', { detail: trigger.id }));
    list.hidden = false; trigger.setAttribute('aria-expanded', 'true');
    const rect = trigger.getBoundingClientRect(), margin = 8;
    const below = window.innerHeight - rect.bottom - margin, above = rect.top - margin;
    const down = below >= Math.min(220, list.scrollHeight) || below >= above;
    list.style.width = `${Math.min(rect.width, window.innerWidth - margin * 2)}px`;
    list.style.left = `${Math.max(margin, Math.min(rect.left, window.innerWidth - rect.width - margin))}px`;
    list.style.maxHeight = `${Math.max(40, Math.min(220, down ? below : above))}px`;
    list.style.top = down ? `${rect.bottom + 4}px` : '';
    list.style.bottom = down ? '' : `${window.innerHeight - rect.top + 4}px`;
    highlight(Math.max(0, choices.findIndex(font => font.id === current)));
  }
  function choose(index) {
    select.value = choices[index].id;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    close(); trigger.focus();
  }
  trigger.addEventListener('click', () => {
    trigger.focus({ preventScroll: true });
    isOpen() ? close() : open();
  });
  trigger.addEventListener('keydown', event => {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Tab' && isOpen()) {
      // WebKit/macOS may skip mouse-focused buttons during native Tab traversal.
      // Move to the adjacent visible settings control before dismissing the list.
      event.preventDefault(); event.stopPropagation(); close();
      const scope = select.closest('#appearancePopover');
      const controls = [...scope.querySelectorAll('button, select, input, [tabindex]')]
        .filter(control => !control.disabled && control.tabIndex >= 0 && control.getClientRects().length);
      const next = controls[controls.indexOf(trigger) + (event.shiftKey ? -1 : 1)];
      (next || trigger).focus({ preventScroll: true });
      return;
    }
    if (event.key === 'Escape' && isOpen()) { event.preventDefault(); event.stopPropagation(); close(); return; }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault(); event.stopPropagation();
      if (!isOpen()) open();
      else if (event.key === 'ArrowDown') highlight(cursor + 1);
      else if (event.key === 'ArrowUp') highlight(cursor - 1);
      if (event.key === 'Home') highlight(0);
      if (event.key === 'End') highlight(choices.length - 1);
    } else if (['Enter', ' '].includes(event.key)) {
      event.preventDefault(); event.stopPropagation();
      if (isOpen()) choose(cursor); else open();
    } else if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault();
      if (!isOpen()) open();
      prefix = Date.now() - typedAt > 700 ? event.key : prefix + event.key; typedAt = Date.now();
      const index = choices.findIndex(font => font.label.toLocaleLowerCase().startsWith(prefix.toLocaleLowerCase()));
      if (index >= 0) highlight(index);
    }
  });
  list.addEventListener('pointerdown', event => event.preventDefault());
  list.addEventListener('pointermove', event => {
    const option = event.target.closest('[role="option"]');
    if (option) highlight(Number(option.dataset.index));
  });
  list.addEventListener('click', event => {
    const option = event.target.closest('[role="option"]');
    if (option) choose(Number(option.dataset.index));
  });
  document.addEventListener('pointerdown', event => { if (!trigger.parentElement.contains(event.target)) close(); });
  document.addEventListener('focusin', event => { if (!trigger.parentElement.contains(event.target)) close(); });
  document.addEventListener('leaf-font-picker-open', event => { if (event.detail !== trigger.id) close(); });
  document.addEventListener('scroll', event => { if (!list.contains(event.target)) close(); }, true);
  window.addEventListener('resize', close);
  // Closing settings must also close its font list before the next opening.
  const panel = select.closest('#appearancePopover');
  if (panel) new MutationObserver(() => { if (panel.hidden) close(); }).observe(panel, { attributes: true, attributeFilter: ['hidden'] });
  return {
    update(next, selected, fallbackLabel) {
      close(); choices = next; current = selected;
      trigger.setAttribute('aria-label', label()); list.setAttribute('aria-label', label());
      const font = choices.find(choice => choice.id === selected);
      trigger.textContent = font?.label || fallbackLabel;
      trigger.style.fontFamily = font?.family ? `${JSON.stringify(font.family)}, var(--ui-font)` : '';
      trigger.disabled = !choices.length;
      list.replaceChildren(...choices.map((choice, index) => {
        const option = document.createElement('div');
        option.id = `${select.id}Option-${choice.id}`; option.dataset.index = index;
        option.dataset.fontId = choice.id; option.setAttribute('role', 'option');
        option.setAttribute('aria-selected', String(choice.id === selected));
        option.textContent = choice.label;
        option.style.fontFamily = `${JSON.stringify(choice.family)}, var(--ui-font)`;
        return option;
      }));
    },
  };
}
