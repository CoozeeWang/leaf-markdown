import { t, h, setText } from './i18n.js';
export function confirmDocumentClose(name) {
  return new Promise(resolve => {
    const previousFocus = document.activeElement;
    const backdrop = document.createElement('div');
    backdrop.className = 'close-document-backdrop';
    backdrop.innerHTML = `<section class="close-document-dialog" role="alertdialog" aria-modal="true" aria-labelledby="close-document-title" aria-describedby="close-document-description">
      <h2 id="close-document-title">${h("close_document_dialog.save_changes_before_closing")}</h2>
      <p id="close-document-description"></p>
      <footer><button type="button" data-choice="discard">${h("close_document_dialog.close_without_saving")}</button><button type="button" data-choice="cancel">${h("close_document_dialog.keep_editing")}</button><button type="button" data-choice="save">${h("close_document_dialog.save_and_close")}</button></footer>
    </section>`;
    setText(backdrop.querySelector('p'), () => t("close_document_dialog.has_unsaved_changes", {"name": name}));
    const buttons = [...backdrop.querySelectorAll('button')];
    function finish(choice) {
      document.removeEventListener('keydown', onKey, true);
      backdrop.remove(); previousFocus?.focus(); resolve(choice);
    }
    function onKey(event) {
      event.stopPropagation();
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === 'Escape') { event.preventDefault(); finish('cancel'); }
      if (event.key === 'Tab') {
        event.preventDefault();
        const index = buttons.indexOf(document.activeElement);
        buttons[(index + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length].focus();
      }
    }
    buttons.forEach(button => { button.onclick = () => finish(button.dataset.choice); });
    document.body.append(backdrop);
    document.addEventListener('keydown', onKey, true);
    buttons[2].focus();
  });
}
