import { copyKeys, resolveMessage, onLanguageChange } from './i18n.js';
// One visible message, one lifetime. Dismissing UI never changes file state.
export function setupStatusNotices({ container, text, recovery, actions, dismiss, announcement, format = value => value }) {
  let current = null, persistent = null, recoveryAvailable = false, recoveryDismissed = false;
  let timer, announcementTimer;
  const resolvedSave = /^(已保存|已自动保存|已下载保存副本|已载入外部修改|已恢复读取原文件|已开启自动保存|已重新定位原文件)/;
  const resolvedKeys = new Set(['UI0194','UI0195','UI0197','UI0198','UI0188','MO0032','MO0036','MO0037','MO0042','MO0044'].map(id => copyKeys[id]));
  const quietKeys = new Set(['UI0194','UI0188','UI0198','MO0042','MO0044'].map(id => copyKeys[id]));
  const resolved = message => message?.key ? resolvedKeys.has(copyKeys[message.key] || message.key) : resolvedSave.test(message);
  const quiet = message => message?.key ? quietKeys.has(copyKeys[message.key] || message.key) : quietSave.test(message);
  const quietSave = /^(已自动保存|已开启自动保存|已载入外部修改|已恢复读取原文件)/;
  const render = () => {
    const visible = current || persistent;
    text.textContent = visible ? format(resolveMessage(visible.text)) : '';
    text.hidden = !visible;
    recovery.hidden = !!visible || !recoveryAvailable || recoveryDismissed;
    if (actions) {
      actions.replaceChildren();
      for (const action of visible?.actions || []) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = resolveMessage(action.label);
        button.addEventListener('click', () => { void action.run(); });
        actions.append(button);
      }
      actions.hidden = !visible?.actions?.length;
    }
    container.hidden = !visible && recovery.hidden;
    if (visible) container.dataset.kind = text.dataset.kind = visible.kind;
    else { delete container.dataset.kind; delete text.dataset.kind; }
  };
  const sameMessage = (a, b) => a?.key && b?.key ? a.key === b.key && JSON.stringify(a.values) === JSON.stringify(b.values) : a === b;
  function show(message, kind = '', { announce = true, actions: choices } = {}) {
    // A rename or formatting success must not conceal an unresolved save error.
    if (persistent?.kind === 'error' && kind !== 'error' && !(kind === 'saved' && resolved(message))) return;
    clearTimeout(timer);
    clearTimeout(announcementTimer);
    announcement.textContent = '';
    if (kind === 'saved' && resolved(message)) persistent = null;
    const next = message ? { text: message, kind, actions: choices } : null;
    if (kind === 'error' || kind === 'manual') { persistent = next; current = null; }
    else current = next;
    render();
    if (announce && message && kind !== 'pending' && !quiet(message)) {
      announcementTimer = setTimeout(() => { announcement.textContent = format(resolveMessage(message)); }, 50);
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
  onLanguageChange(() => {
    // Live-region announcements describe past actions, not current UI. Don't
    // leave an old-language announcement or repeat it when switching language.
    clearTimeout(announcementTimer);
    announcement.textContent = '';
    render();
  });
  render();
  return {
    refresh: render,
    show,
    clear(message) {
      if (!message || !sameMessage(persistent?.text, message)) return;
      clearTimeout(announcementTimer);
      announcement.textContent = '';
      persistent = null;
      render();
    },
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
