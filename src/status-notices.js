// One visible message, one lifetime. Dismissing UI never changes file state.
export function setupStatusNotices({ container, text, recovery, dismiss, announcement, format = value => value }) {
  let current = null, persistent = null, recoveryAvailable = false, recoveryDismissed = false;
  let timer, announcementTimer;
  const resolvedSave = /^(已保存|已自动保存|已下载保存副本|已载入外部修改|已恢复读取原文件|已开启自动保存)/;
  const quietSave = /^(已自动保存|已开启自动保存|已载入外部修改|已恢复读取原文件)/;
  const render = () => {
    const visible = current || persistent;
    text.textContent = visible ? format(visible.text) : '';
    text.hidden = !visible;
    recovery.hidden = !!visible || !recoveryAvailable || recoveryDismissed;
    container.hidden = !visible && recovery.hidden;
    if (visible) container.dataset.kind = text.dataset.kind = visible.kind;
    else { delete container.dataset.kind; delete text.dataset.kind; }
  };
  function show(message, kind = '', { announce = true } = {}) {
    // A rename or formatting success must not conceal an unresolved save error.
    if (persistent?.kind === 'error' && kind !== 'error' && !(kind === 'saved' && resolvedSave.test(message))) return;
    clearTimeout(timer);
    clearTimeout(announcementTimer);
    announcement.textContent = '';
    if (kind === 'saved' && resolvedSave.test(message)) persistent = null;
    const next = message ? { text: message, kind } : null;
    if (kind === 'error' || kind === 'manual') { persistent = next; current = null; }
    else current = next;
    render();
    if (announce && message && kind !== 'pending' && !quietSave.test(message)) {
      announcementTimer = setTimeout(() => { announcement.textContent = format(message); }, 50);
    }
    if (kind === 'saved' || kind === 'info' || !kind) {
      timer = setTimeout(() => { current = null; render(); }, 4000);
    }
  }
  dismiss.addEventListener('click', () => {
    clearTimeout(timer);
    clearTimeout(announcementTimer);
    announcement.textContent = '';
    if (current) current = null;
    else if (persistent) persistent = null;
    else recoveryDismissed = true;
    render();
    // Removing a focused close button must not strand keyboard navigation.
    if (container.hidden) {
      const shell = document.querySelector('.shell');
      const target = shell?.classList.contains('welcome-state') ? '#welcomeOpenButton'
        : shell?.classList.contains('focus-mode') ? (document.querySelector('#readingPane')?.hidden ? '.cm-content' : '#readingPane')
        : '#saveButton';
      document.querySelector(target)?.focus();
    }
  });
  render();
  return {
    show,
    reset() {
      clearTimeout(timer);
      clearTimeout(announcementTimer);
      current = persistent = null;
      recoveryAvailable = recoveryDismissed = false;
      announcement.textContent = '';
      render();
    },
    recoveryAvailable(available) {
      if (!available) recoveryDismissed = false;
      recoveryAvailable = available;
      render();
    },
  };
}
