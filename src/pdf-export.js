import { t, h, onLanguageChange, setText } from './i18n.js';
import { setResourceReader, waitForImages } from './resources.js';
import { isTauri, invoke } from '@tauri-apps/api/core';
import { renderPrintDocument } from './print-document.js';
import './pdf-export.css';
import './callout.css';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';

// Theme affects export controls only; the paper has its own light palette.
const systemTheme = matchMedia('(prefers-color-scheme: dark)');
function updateExportTheme() {
  const preference = localStorage.getItem('leaf-theme') || 'system';
  document.documentElement.dataset.exportTheme = preference === 'dark' || (preference !== 'light' && systemTheme.matches) ? 'dark' : 'light';
}
updateExportTheme();
systemTheme.addEventListener('change', updateExportTheme);
window.addEventListener('storage', event => {
  if (event.key === 'leaf-theme' || event.key === null) updateExportTheme();
});
window.addEventListener('focus', updateExportTheme);

async function init() {
  const native = isTauri();
  if (native) setResourceReader(relative => invoke("read_resource", { relative }));
  document.documentElement.classList.toggle('native-print', native);
  if (native) {
    const pageStyle = document.createElement('style');
    pageStyle.textContent = '@page { margin: 0; }';
    document.head.append(pageStyle);
  }
  if (native) await listen('leaf-close', () => getCurrentWindow().destroy());
  const key = new URLSearchParams(location.search).get('export');
  const snapshot = native ? await invoke('export_snapshot') : JSON.parse(sessionStorage.getItem(key));
  if (!native) sessionStorage.removeItem(key);
  if (!snapshot) throw new Error(t("pdf_export.this_export_preview_is_no_longer_available"));
  document.title = snapshot.name.replace(/\.(md|markdown|mdown)$/i, '');
  document.querySelector('#app').innerHTML = `<header class="export-toolbar"><div><strong>${h("pdf_export.export_pdf")}</strong><small>${h("pdf_export.export_preview_of_the_current_document_editing")}</small></div><label><input id="properties" type="checkbox">${h("pdf_export.document_properties")}</label><label><input id="numbered" type="checkbox">${h("pdf_export.heading_numbering")}</label><button id="print">${h("pdf_export.save_as_pdf")}</button></header><p class="export-help">${h(/win/i.test(navigator.platform) ? 'MO0254' : 'pdf_export.click_save_then_choose_pdf_save_as')}</p><article class="print-document"></article><p id="export-error" role="alert"></p>`;
  document.querySelector('#numbered').checked = snapshot.numbered;
  const render = () => renderPrintDocument(document.querySelector('article'), snapshot.source, {
    name: snapshot.name, numbered: document.querySelector('#numbered').checked, properties: document.querySelector('#properties').checked,
  });
  for (const input of document.querySelectorAll('input')) input.addEventListener('change', render);
  render();
  onLanguageChange(render);
  let printing = false;
  const print = async () => {
    if (printing) return;
    printing = true;
    try {
      document.querySelector('#export-error').textContent = '';
      await document.fonts.ready;
      await waitForImages(document.querySelector("article"), { allowPlaceholders: true });
      if (native) await invoke('print_export'); else window.print();
    } catch (error) { setText(document.querySelector('#export-error'), () => t("pdf_export.could_not_open_the_print_dialog", {"error": error})); }
    finally { printing = false; }
  };
  document.querySelector('#print').addEventListener('click', print);
  window.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'p') { e.preventDefault(); void print(); }
  });
}
init().catch(error => { setText(document.querySelector('#app'), () => t("pdf_export.export_failed", {"error": error})); });
