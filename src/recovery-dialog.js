import './recovery.css';

export function setupWelcomeRecovery({ invoke, welcome }) {
  const hint = document.createElement('p');
  hint.className = 'welcome-recovery-hint';
  hint.hidden = true;
  hint.append('有可恢复的草稿 · ');
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = '查看';
  button.setAttribute('aria-label', '查看可恢复的草稿');
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
  dialog.innerHTML = `<header><h2 id="recovery-title">${drafts ? '恢复草稿' : '历史版本与草稿'}</h2><button type="button" data-close aria-label="关闭恢复窗口">关闭</button></header>
    <p class="recovery-intro">${drafts ? '预览后作为新文档打开，检查后请手动保存。' : '恢复只修改编辑区，可撤销；检查后请手动保存。'}</p>
    <div class="recovery-layout"><div class="recovery-list" role="grid" tabindex="0" aria-label="可恢复版本"></div><textarea readonly aria-label="版本源码预览" spellcheck="false"></textarea></div>
    <p class="recovery-status" role="status"></p>
    <footer><button type="button" data-apply disabled>${drafts ? '作为新文档打开' : '恢复到编辑区'}</button></footer>
    <p class="recovery-help">仅保存在本机，最多保留 20 个历史版本。</p>`;
  dialog.setAttribute('aria-labelledby', 'recovery-title');
  const confirmation = document.createElement('div');
  confirmation.className = 'recovery-confirm'; confirmation.hidden = true;
  confirmation.innerHTML = `<section class="close-document-dialog recovery-clear-dialog" role="alertdialog" aria-modal="true" aria-labelledby="recovery-clear-title" aria-describedby="recovery-clear-description">
    <h2 id="recovery-clear-title">删除该草稿？</h2>
    <p id="recovery-clear-description"><strong></strong><br>只删除选中的记录，无法撤销。原文件和其他记录不受影响。</p>
    <footer><button type="button" data-cancel-clear>取消</button><button type="button" data-confirm-clear>删除该草稿</button></footer>
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
    clear.setAttribute('aria-label', entries[selected]?.kind === 'saved' ? '删除该版本' : '删除该草稿'); clear.title = clear.getAttribute('aria-label'); apply.disabled = busy || content === null;
  };
  async function select() {
    const token = ++generation;
    content = null; preview.value = ''; apply.disabled = true; clear.disabled = true; resetClear();
    const entry = entries[selected];
    if (!entry) { layout.hidden = true; status.textContent = '暂无可恢复记录。'; return; }
    for (const option of list.children) option.setAttribute('aria-selected', String(Number(option.dataset.index) === selected));
    list.setAttribute('aria-activedescendant', `recovery-option-${selected}`);
    list.children[selected]?.querySelector('.recovery-delete-cell').append(clear);
    list.children[selected]?.scrollIntoView({ block: 'nearest' });
    status.textContent = '正在读取版本…';
    try {
      const value = await invoke('recovery_read', { key: entry.key, id: entry.id });
      if (token !== generation || !dialog.isConnected) return;
      clear.setAttribute('aria-label', entry.kind === 'saved' ? '删除该版本' : '删除该草稿'); clear.title = clear.getAttribute('aria-label');
      content = value; preview.value = value; apply.disabled = false; clear.disabled = false;
      status.textContent = entry.source || '未命名文档';
    } catch (error) { if (token === generation) status.textContent = `读取失败：${error}`; }
  }
  async function refresh() {
    generation++; content = null; list.removeAttribute('aria-activedescendant');
    list.replaceChildren(); preview.value = ''; apply.disabled = true; clear.disabled = true;
    status.textContent = '正在读取恢复记录…';
    try {
      entries = await invoke('recovery_list', { drafts });
      if (!dialog.isConnected) return;
      layout.hidden = entries.length === 0;
      entries.forEach((entry, index) => {
        const option = document.createElement('div');
        option.id = `recovery-option-${index}`; option.dataset.index = String(index);
        option.setAttribute('role', 'row'); option.setAttribute('aria-selected', 'false');
        const name = entry.source?.split(/[\\/]/).pop() || '未命名文档';
        const title = document.createElement('span'), detail = document.createElement('span');
        title.className = 'recovery-version-title'; detail.className = 'recovery-version-detail';
        const kind = entry.kind === 'draft' ? '草稿' : '保存前版本';
        title.textContent = drafts ? name : kind;
        detail.textContent = `${drafts ? kind + ' · ' : ''}${new Date(entry.timestamp).toLocaleString()} · ${Math.ceil(entry.bytes / 1024)} KB`;
        option.title = `${entry.source || name}\n${detail.textContent}`;
        const textCell = document.createElement('div'), deleteCell = document.createElement('div');
        textCell.setAttribute('role', 'gridcell'); deleteCell.setAttribute('role', 'gridcell');
        deleteCell.className = 'recovery-delete-cell';
        const remove = clear.cloneNode(true); remove.removeAttribute('data-clear'); remove.dataset.deleteRecord = ''; remove.disabled = false;
        remove.setAttribute('aria-label', `${entry.kind === 'saved' ? '删除该版本' : '删除该草稿'}：${name}`); remove.title = remove.getAttribute('aria-label');
        remove.onclick = event => { event.stopPropagation(); requestDelete(entry); }; deleteCell.append(remove);
        textCell.append(title, detail); option.append(textCell, deleteCell);
        option.onclick = () => { if (!busy) { selected = index; list.focus(); void select(); } };
        list.append(option);
      });
      selected = entries.length ? 0 : -1;
      await select();
    } catch (error) { status.textContent = `读取失败：${error}`; }
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
      status.textContent = `恢复失败：${error}`;
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
    const action = clearEntry.kind === 'saved' ? '删除该版本' : '删除该草稿';
    confirmation.querySelector('h2').textContent = action + '？';
    confirmClear.textContent = action;
    confirmation.querySelector('strong').textContent = clearEntry.source?.split(/[\\/]/).pop() || '未命名文档';
    confirmation.querySelector('strong').title = clearEntry.source || '未命名文档';
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
    } catch (error) { status.textContent = `删除失败：${error}`; clear.disabled = false; apply.disabled = content === null; }
    finally { setBusy(false); resetClear(); (clear.disabled ? list : clear).focus(); }
  };
  list.focus();
  await refresh();
}
