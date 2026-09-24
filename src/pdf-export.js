import { setResourceReader, waitForImages } from './resources.js';
import { isTauri, invoke } from '@tauri-apps/api/core';
import { renderPrintDocument } from './print-document.js';
import './pdf-export.css';
import './callout.css';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';

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
  if (!snapshot) throw new Error('导出快照已失效，请从文档重新导出。');
  document.title = snapshot.name.replace(/\.(md|markdown|mdown)$/i, '');
  document.querySelector('#app').innerHTML = `<header class="export-toolbar"><div><strong>导出 PDF</strong><small>当前文档快照 · 不影响原文编辑</small></div><label><input id="properties" type="checkbox">文档属性</label><label><input id="numbered" type="checkbox">标题编号</label><button id="print">保存为 PDF…</button></header><p class="export-help">点击保存，在系统打印窗口中选择「PDF → 存储为 PDF」。可调整纸张和方向。预览不显示实际分页。</p><article class="print-document"></article><p id="export-error" role="alert"></p>`;
  document.querySelector('#numbered').checked = snapshot.numbered;
  const render = () => renderPrintDocument(document.querySelector('article'), snapshot.source, {
    name: snapshot.name, numbered: document.querySelector('#numbered').checked, properties: document.querySelector('#properties').checked,
  });
  for (const input of document.querySelectorAll('input')) input.addEventListener('change', render);
  render();
  let printing = false;
  const print = async () => {
    if (printing) return;
    printing = true;
    try {
      document.querySelector('#export-error').textContent = '';
      await document.fonts.ready;
      await waitForImages(document.querySelector("article"));
      if (native) await invoke('print_export'); else window.print();
    } catch (error) { document.querySelector('#export-error').textContent = `无法打开打印窗口：${error}`; }
    finally { printing = false; }
  };
  document.querySelector('#print').addEventListener('click', print);
  window.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'p') { e.preventDefault(); void print(); }
  });
}
init().catch(error => { document.querySelector('#app').textContent = `导出失败：${error}`; });
