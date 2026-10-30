import { t, h, currentLanguage, setText, setAttr, localizedElement } from './i18n.js';
import './recovery.css';

export function setupWelcomeRecovery({ invoke, welcome }) {
  const hint = document.createElement('p');
  hint.className = 'welcome-recovery-hint';
  hint.hidden = true;
  hint.append(localizedElement('span', '', () => t('MO0116') + ' '));
  const button = document.createElement('button');
  button.type = 'button';
  setText(button, () => t("recovery_dialog.view"));
  setAttr(button, 'aria-label', () => t("recovery_dialog.view_recoverable_drafts"));
  button.onclick = () => showRecovery({ invoke, drafts: true });
  hint.append(button);
  welcome.querySelector('.welcome-card').append(hint);
  let generation = 0;
  async function refresh() {
    if (welcome.hidden) return;
    const token = ++generation;
    try {
      const entries = await invoke('recovery_list', { drafts: true });
      if (token === generation) hint.hidden = entries.length === 0;
    } catch {
      // A failed lookup is not evidence of recoverable content. The recovery
      // command remains available and reports read failures in its dialog.
      if (token === generation) hint.hidden = true;
    }
  }
  window.addEventListener('focus', refresh);
  document.addEventListener('leaf-recovery-changed', refresh);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void refresh();
  });
  void refresh();
}

export async function showRecovery({ invoke, restore, drafts = false }) {
  if (document.querySelector('.recovery-dialog')) return;
  const previousFocus = document.activeElement;
  const backdrop = document.createElement('div');
  backdrop.className = 'recovery-backdrop';
  const dialog = document.createElement('section');
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.tabIndex = -1;
  dialog.className = 'recovery-dialog';
  dialog.innerHTML = `<header><h2 id="recovery-title">${drafts ? t("recovery_dialog.recover_drafts") : t("recovery_dialog.versions_drafts")}</h2><button type="button" data-close aria-label="${t("recovery_dialog.close_recovery_dialog")}" data-i18n-aria-label="recovery_dialog.close_recovery_dialog">${h("editor.close")}</button></header>
    <p class="recovery-intro">${drafts ? t("recovery_dialog.preview_and_open_as_a_new_document") : t("recovery_dialog.restoring_replaces_the_content_in_the_editor")}</p>
    <div class="recovery-layout"><div class="recovery-list" role="grid" tabindex="0" aria-label="${t("recovery_dialog.recoverable_versions")}" data-i18n-aria-label="recovery_dialog.recoverable_versions"></div><textarea readonly aria-label="${t("recovery_dialog.version_source_preview")}" data-i18n-aria-label="recovery_dialog.version_source_preview" spellcheck="false"></textarea></div>
    <p class="recovery-status" role="status"></p>
    <footer><button type="button" data-apply disabled>${drafts ? t("recovery_dialog.open_as_new_document") : t("recovery_dialog.restore_to_editor")}</button></footer>
    <p class="recovery-help">${h("recovery_dialog.stored_only_on_this_device_up_to")}</p>`;
  dialog.setAttribute('aria-labelledby', 'recovery-title');
  const confirmation = document.createElement('div');
  confirmation.className = 'recovery-confirm'; confirmation.hidden = true;
  confirmation.innerHTML = `<section class="close-document-dialog recovery-clear-dialog" role="alertdialog" aria-modal="true" aria-labelledby="recovery-clear-title" aria-describedby="recovery-clear-description">
    <h2 id="recovery-clear-title">${h("recovery_dialog.delete_this_draft")}</h2>
    <p id="recovery-clear-description"><strong></strong><br>${h("recovery_dialog.only_the_selected_record_will_be_deleted")}</p>
    <footer><button type="button" data-cancel-clear>${h("recovery_dialog.cancel")}</button><button type="button" data-confirm-clear>${h("recovery_dialog.delete_this_draft_mo0132")}</button></footer>
  </section>`;
  backdrop.append(dialog, confirmation);
  document.body.append(backdrop);
  const list = dialog.querySelector('[role=grid]'), preview = dialog.querySelector('textarea');
  const status = dialog.querySelector('[role=status]'), apply = dialog.querySelector('[data-apply]'), clear = document.createElement('button');
  clear.type = 'button'; clear.dataset.clear = ''; clear.disabled = true;
  clear.innerHTML = '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 10v7m4-7v7"/></svg>';
  const cancelClear = confirmation.querySelector('[data-cancel-clear]'), confirmClear = confirmation.querySelector('[data-confirm-clear]');
  const layout = dialog.querySelector('.recovery-layout');
  let entries = [], selected = -1, content = null, generation = 0, clearing = false, busy = false, clearEntry = null;
  const resetClear = () => {
    clearing = false; clearEntry = null; confirmation.hidden = true; dialog.inert = false;
    setAttr(clear, 'aria-label', () => entries[selected]?.kind === 'saved' ? t("recovery_dialog.delete_this_version") : t("recovery_dialog.delete_this_draft_mo0132")); setAttr(clear,'data-tooltip',()=>clear.getAttribute('aria-label')); apply.disabled = busy || content === null;
  };
  async function select() {
    const token = ++generation;
    content = null; preview.value = ''; apply.disabled = true; clear.disabled = true; resetClear();
    const entry = entries[selected];
    if (!entry) { layout.hidden = true; setText(status, () => t("recovery_dialog.no_recovery_records_available")); return; }
    for (const option of list.children) option.setAttribute('aria-selected', String(Number(option.dataset.index) === selected));
    list.setAttribute('aria-activedescendant', `recovery-option-${selected}`);
    list.children[selected]?.querySelector('.recovery-delete-cell').append(clear);
    list.children[selected]?.scrollIntoView({ block: 'nearest' });
    setText(status, () => t("recovery_dialog.loading_version"));
    try {
      const value = await invoke('recovery_read', { key: entry.key, id: entry.id });
      if (token !== generation || !dialog.isConnected) return;
      setAttr(clear, 'aria-label', () => entry.kind === 'saved' ? t("recovery_dialog.delete_this_version") : t("recovery_dialog.delete_this_draft_mo0132")); setAttr(clear,'data-tooltip',()=>clear.getAttribute('aria-label'));
      content = value; preview.value = value; apply.disabled = false; clear.disabled = false;
      setText(status, () => entry.source || t("desktop.untitled_document"));
    } catch (error) { if (token === generation) setText(status, () => t("recovery_dialog.failed_to_load", {"error": error})); }
  }
  async function refresh() {
    generation++; content = null; list.removeAttribute('aria-activedescendant');
    list.replaceChildren(); preview.value = ''; apply.disabled = true; clear.disabled = true;
    setText(status, () => t("recovery_dialog.loading_recovery_records"));
    try {
      entries = await invoke('recovery_list', { drafts });
      if (!dialog.isConnected) return;
      layout.hidden = entries.length === 0;
      entries.forEach((entry, index) => {
        const option = document.createElement('div');
        option.id = `recovery-option-${index}`; option.dataset.index = String(index);
        option.setAttribute('role', 'row'); option.setAttribute('aria-selected', 'false');
        const name = entry.source?.split(/[\\/]/).pop() || t("desktop.untitled_document");
        const title = document.createElement('span'), detail = document.createElement('span');
        title.className = 'recovery-version-title'; detail.className = 'recovery-version-detail';
        const kind = entry.kind === 'draft' ? t("recovery_dialog.draft") : t("recovery_dialog.pre_save_version");
        setText(title, () => drafts ? name : (entry.kind === 'draft' ? t('recovery_dialog.draft') : t('recovery_dialog.pre_save_version')));
        setText(detail, () => t(drafts ? 'MO0244' : 'MO0243', {kind: entry.kind === 'draft' ? t('recovery_dialog.draft') : t('recovery_dialog.pre_save_version'), date: new Date(entry.timestamp).toLocaleString(currentLanguage()), size: Math.ceil(entry.bytes / 1024)}));
        option.dataset.tooltipKind='operation';setAttr(option,'data-tooltip',()=>`${entry.source || name}\n${detail.textContent}`);
        const textCell = document.createElement('div'), deleteCell = document.createElement('div');
        textCell.setAttribute('role', 'gridcell'); deleteCell.setAttribute('role', 'gridcell');
        deleteCell.className = 'recovery-delete-cell';
        const remove = clear.cloneNode(true); remove.removeAttribute('data-clear'); remove.dataset.deleteRecord = ''; remove.disabled = false;
        setAttr(remove, 'aria-label', () => t(entry.kind === 'saved' ? 'MO0240' : 'MO0241', {name})); setAttr(remove,'data-tooltip',()=>remove.getAttribute('aria-label'));
        remove.onclick = event => { event.stopPropagation(); requestDelete(entry); }; deleteCell.append(remove);
        textCell.append(title, detail); option.append(textCell, deleteCell);
        option.onclick = () => { if (!busy) { selected = index; list.focus(); void select(); } };
        list.append(option);
      });
      selected = entries.length ? 0 : -1;
      await select();
    } catch (error) { setText(status, () => t("recovery_dialog.failed_to_load", {"error": error})); }
  }
  function close() {
    if (busy) return;
    generation++; document.removeEventListener('keydown', trapKeys, true);
    backdrop.remove(); previousFocus?.focus();
    document.dispatchEvent(new Event('leaf-recovery-changed'));
  }
  function trapKeys(event) {
    if (event.isComposing || event.keyCode === 229) { event.stopPropagation(); return; }
    if (clearing) {
      event.stopImmediatePropagation();
      if (event.key === 'Escape') { event.preventDefault(); if (!busy) { resetClear(); clear.focus(); } }
      if (event.key === 'Tab') {
        event.preventDefault();
        if (!busy) (document.activeElement === cancelClear ? confirmClear : cancelClear).focus();
      }
      return;
    }
    if (event.target === list && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      if (!busy && entries.length) {
        selected = event.key === 'Home' ? 0 : event.key === 'End' ? entries.length - 1 : Math.max(0, Math.min(entries.length - 1, selected + (event.key === 'ArrowDown' ? 1 : -1)));
        void select();
      }
    }
    if (event.key === 'Escape' && clearing && !busy) { event.preventDefault(); event.stopPropagation(); resetClear(); clear.focus(); return; }
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return; }
    if (event.key === 'Tab') {
      const controls = [...dialog.querySelectorAll('button:not(:disabled), [role=grid], textarea')].filter(el => el.getClientRects().length);
      const index = controls.indexOf(document.activeElement);
      if (index < 0 || (event.shiftKey ? index === 0 : index === controls.length - 1)) {
        event.preventDefault(); controls[event.shiftKey ? controls.length - 1 : 0]?.focus();
      }
    }
    // Keep editor shortcuts outside this dialog from changing the document.
    event.stopPropagation();
  }
  document.addEventListener('keydown', trapKeys, true);
  dialog.querySelector('[data-close]').onclick = close;
  cancelClear.onclick = () => { resetClear(); clear.focus(); };
  function setBusy(value) {
    busy = value; list.setAttribute('aria-disabled', String(value)); cancelClear.disabled = value; confirmClear.disabled = value;
  }
  apply.onclick = async () => {
    if (content === null || busy || clearing) return;
    setBusy(true); apply.disabled = true; clear.disabled = true;
    try {
      const entry = entries[selected];
      if (drafts) await invoke('recovery_open', { key: entry.key, id: entry.id });
      else await restore(content);
      setBusy(false); close();
    } catch (error) {
      setText(status, () => t("recovery_dialog.could_not_restore", {"error": error}));
      setBusy(false); apply.disabled = false; clear.disabled = false;
    }
  };
  clear.onclick = event => {
    event.stopPropagation();
    requestDelete(entries[selected]);
  };
  function requestDelete(entry) {
    if (busy || clearing || !entry) return;
    clearEntry = entry; clearing = true;
    const action = clearEntry.kind === 'saved' ? t("recovery_dialog.delete_this_version") : t("recovery_dialog.delete_this_draft_mo0132");
    setText(confirmation.querySelector('h2'), () => t(clearEntry.kind === 'saved' ? 'MO0242' : 'recovery_dialog.delete_this_draft'));
    setText(confirmClear, () => t(clearEntry.kind === 'saved' ? 'recovery_dialog.delete_this_version' : 'recovery_dialog.delete_this_draft_mo0132'));
    setText(confirmation.querySelector('strong'), () => clearEntry.source?.split(/[\\/]/).pop() || t("desktop.untitled_document"));
    confirmation.querySelector('strong').dataset.tooltipKind='operation';setAttr(confirmation.querySelector('strong'), 'data-tooltip', () => clearEntry.source || t("desktop.untitled_document"));
    confirmation.hidden = false; dialog.inert = true; apply.disabled = true;
    cancelClear.focus();
  };
  confirmClear.onclick = async () => {
    if (busy || !clearing || !clearEntry) return;
    const {key, id} = clearEntry;
    setBusy(true); apply.disabled = true; clear.disabled = true;
    try {
      await invoke('recovery_delete', { key, id });
      document.dispatchEvent(new Event('leaf-recovery-changed'));
      await refresh();
    } catch (error) { setText(status, () => t("recovery_dialog.could_not_delete", {"error": error})); clear.disabled = false; apply.disabled = content === null; }
    finally { setBusy(false); resetClear(); (clear.disabled ? list : clear).focus(); }
  };
  list.focus();
  await refresh();
}
