// CodeMirror owns its IME state, including Safari's recovery for a missing DOM
// compositionend. Do not duplicate that state in an event-only Set.
export function isCommittedCompositionInput(event) {
  return event.type === 'input' && event.isComposing === false &&
    ['insertText', 'insertFromComposition'].includes(event.inputType);
}

export function createCompositionGuard({scope, view, popup = () => null}) {
  const controls = new Set();
  const start = event => {
    const target = event.target;
    // Textareas/inputs inside CodeMirror widgets own their native composition;
    // the surrounding contentDOM is not their source of truth.
    if (target.closest?.('.cm-content') && !target.closest?.('input,textarea')) return;
    controls.add(target);
  };
  const end = event => controls.delete(event.target);
  const input = event => {
    if (isCommittedCompositionInput(event)) controls.delete(event.target);
  };
  scope.addEventListener('compositionstart', start, true);
  scope.addEventListener('compositionend', end, true);
  scope.addEventListener('input', input, true);
  return {
    status() {
      const sources = new Set();
      if (view.compositionStarted) sources.add('main-editor');
      for (const node of scope.querySelectorAll('.cm-editor')) {
        if (node._leafNoteEditor?.view.compositionStarted) sources.add('nested-editor');
      }
      if (popup()?._leafComposing) sources.add('footnote-popup');
      for (const node of controls) {
        if (!node.isConnected || !scope.contains(node)) controls.delete(node);
        else sources.add('input-control');
      }
      return {pending: sources.size > 0, sources: [...sources],
        document_focused: scope.ownerDocument.hasFocus?.() ?? null};
    },
    destroy() {
      scope.removeEventListener('compositionstart', start, true);
      scope.removeEventListener('compositionend', end, true);
      scope.removeEventListener('input', input, true);
      controls.clear();
    },
  };
}
