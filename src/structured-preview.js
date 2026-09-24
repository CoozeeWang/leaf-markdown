import { calloutBadge } from './callout-icons.js';
import { sourceMode } from './view-mode.js';
import { StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView, WidgetType } from '@codemirror/view';
import { undo, redo, isolateHistory } from '@codemirror/commands';
import { analyzeMarkdown, propertyRemovalChange } from './markdown-model.js';
import { renderInline } from './inline-preview.js';
import { applyTableWidths } from './table-layout.js';
import { renderPrintDocument } from './print-document.js';
import './callout.css';
import { labels as calloutLabels } from './callout.js';
import { footnoteReader } from './footnote-state.js';
import { renderProperties } from './properties-ui.js';
import { shortcutText } from './platform-shortcuts.js';
import { tableOperation, tableShortcut } from './table-operations.js';
import { tableEdgeControls } from './table-edge-controls.js';

export const toggleFileNameTitle = StateEffect.define();
export const fileNameTitle = StateField.define({create:()=>true,update:(value,tr)=>tr.effects.reduce((v,e)=>e.is(toggleFileNameTitle)?e.value:v,value)});
// Whether the properties region is folded away. The region is a block widget,
// so it only exists in the DOM while it is near the viewport; holding the fold
// in state rather than in the widget's own `hidden` attribute is what lets a
// caller read it at any scroll position and what keeps the fold from being
// undone every time the widget scrolls out and back.
export const toggleProperties = StateEffect.define();
export const propertiesFolded = StateField.define({create:()=>false,update:(value,tr)=>tr.effects.reduce((v,e)=>e.is(toggleProperties)?e.value:v,value)});
export const documentName = StateEffect.define();
export const sourceBlock = StateEffect.define();
export const renderBlock = StateEffect.define();
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
function button(label, text, action) {
  const b = el('button', 'leaf-block-button', text);
  b.type = 'button'; b.title = shortcutText(label); b.setAttribute('aria-label', shortcutText(label));
  b.addEventListener('click', action);
  return b;
}
function edit(view, change, userEvent = 'input') {
  view.dispatch({ changes: change, userEvent });
}

class DefaultTitle extends WidgetType {
  constructor(name, layout) { super(); this.name = name; this.layout = layout; }
  get estimatedHeight() { return this.layout.height; }
  eq(other) { return this.name === other.name; }
  toDOM(view) {
    const box = el('div', 'leaf-default-title');
    box._heightObserver = new ResizeObserver(() => { this.layout.height = box.getBoundingClientRect().height; });
    box._heightObserver.observe(box);
    const title=el('h1','',this.name.replace(/\.(md|markdown|mdown)$/i,''));
    title.tabIndex=0;title.title='双击修改文件名';title.setAttribute('aria-label',`${this.name}，双击或按回车修改文件名`);
    const rename=()=>document.dispatchEvent(new CustomEvent('leaf-rename-document'));
    title.ondblclick=rename;title.onkeydown=e=>{if(['Enter',' '].includes(e.key)){e.preventDefault();e.stopPropagation();rename();}};
    box.append(title);
    return box;
  }
  ignoreEvent() { return true; }
  destroy(dom) { dom._heightObserver?.disconnect(); }
}

class SourceReturn extends WidgetType {
  constructor(from) { super(); this.from = from; }
  eq(other) { return this.from === other.from; }
  toDOM(view) { return button('返回实时渲染', '返回渲染', () => {
    const block = view.state.field(structuredPreview).model.blocks.find(block => block.from === this.from);
    // Do not leave the native text selection inside a source range that is
    // about to be replaced by a non-editable widget.
    const anchor = block ? Math.min(view.state.doc.length, block.to + 1) : this.from;
    view.dispatch({ effects: renderBlock.of(this.from), selection: { anchor } });
    view.focus();
  }); }
  ignoreEvent() { return true; }
}

// Keep YAML source editing in its own native text control. Replacing a large
// mixed-editability section with CodeMirror lines and back can strand WebKit's
// visible-character-range traversal at an editing boundary.
class PropertySource extends WidgetType {
  constructor(from, to, raw) { super(); Object.assign(this, {from, to, raw}); }
  eq(other) { return this.from === other.from && this.to === other.to && this.raw === other.raw; }
  updateDOM(root) {
    root._widget = this;
    const input = root.querySelector('textarea');
    if (input.value !== this.raw) {
      const {selectionStart, selectionEnd} = input;
      input.value = this.raw;
      input.setSelectionRange(Math.min(selectionStart, this.raw.length), Math.min(selectionEnd, this.raw.length));
    }
    return true;
  }
  toDOM(view) {
    const root = el('div', 'leaf-widget-frame'); root._widget = this;
    const section = el('section', 'leaf-structured leaf-yaml');
    const top = el('div', 'leaf-block-top');
    top.append(el('span', '', '文档属性 · 源码'));
    top.append(button('返回实时渲染', '返回渲染', () => {
      const {from, to} = root._widget;
      view.dispatch({effects: renderBlock.of(from), selection: {anchor: Math.min(view.state.doc.length, to + 1)}});
      // Keep focus on a real control when one exists, outside replaced text.
      const control = view.dom.querySelector('.leaf-yaml input, .leaf-yaml button');
      if (control) control.focus(); else view.focus();
    }));
    const input = el('textarea', 'leaf-property-source');
    input.setAttribute('aria-label', '文档属性源码'); input.spellcheck = false;
    input.value = this.raw; input.rows = Math.min(10, Math.max(4, this.raw.split('\n').length));
    input.addEventListener('input', () => {
      const {from, to} = root._widget;
      if (!input.value.trim()) {
        const tail = view.state.doc.sliceString(to);
        const blanks = /^(?:[ \t]*\r?\n)+/.exec(tail)?.[0].length ?? 0;
        view.dispatch({changes:{from,to:to+blanks,insert:''}, effects:renderBlock.of(from), selection:{anchor:from}, userEvent:'delete'});
        view.focus();
      } else edit(view, {from, to, insert: input.value}, 'input.type');
    });
    input.addEventListener('keydown', event => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault(); event.stopPropagation(); (event.shiftKey ? redo : undo)(view);
      }
    });
    section.append(top, input); root.append(section); return root;
  }
  ignoreEvent() { return true; }
}

class StructuredBlock extends WidgetType {
  constructor(block, raw, layout, selected = false) { super(); this.block = block; this.raw = raw; this.layout = layout; this.selected = selected; }
  get estimatedHeight() { return this.layout.height; }
  eq(other) { return this.block.from === other.block.from && this.raw === other.raw && this.selected === other.selected; }
  updateDOM(dom, view) {
    dom = dom.firstElementChild;
    // Keep the focused control alive across source transactions (including IME).
    if (dom._widget.block.kind !== this.block.kind) return false;
    if (this.block.kind === 'yaml' && dom._widget.block.fields.length !== this.block.fields.length) return false;
    if (this.block.kind === 'yaml' && this.block.fields.some((f,i) => {
      const old=dom._widget.block.fields[i];
      return f.key!==old.key || typeof f.value!==typeof old.value ||
        ((Array.isArray(f.value)||Array.isArray(old.value)) && JSON.stringify(f.value)!==JSON.stringify(old.value));
    })) return false;
    if (this.block.kind === 'table' && (dom._widget.block.columns !== this.block.columns || dom._widget.block.rows.length !== this.block.rows.length)) return false;
    dom._widget = this;
    dom.classList.toggle('leaf-block-selected', this.selected);
    if (this.block.kind === 'callout') { dom._syncCallout?.(); return true; }
    for (const input of dom.querySelectorAll('[data-field]')) {
      const field = this.block.fields?.[Number(input.dataset.field)];
      if (!field?.editable) return false;
      if (input.type === 'checkbox') input.checked = field.value;
      else if (input.value !== String(field.value)) input.value = field.value;
    }
    for (const input of dom.querySelectorAll('[data-row]')) {
      const cell = this.block.rows?.[Number(input.dataset.row)]?.cells[Number(input.dataset.col)];
      if (!cell) return false;
      const value = cell.value.replace(/<br\s*\/?\s*>/gi, '\n');
      if (input !== dom._writingCell && input.value !== value) {
        const start = input.selectionStart, end = input.selectionEnd, direction = input.selectionDirection;
        input.value = value;
        if (input === document.activeElement) input.setSelectionRange(Math.min(start, input.value.length), Math.min(end, input.value.length), direction);
      }
      renderInline(input.previousElementSibling, cell.value);
    }
    if (this.block.kind === 'table') {
      // Keep the column geometry stable during a keystroke/IME composition.
      // Recompute on blur so the caret does not move visually with every edit.
      dom._resizeCells?.();
    }
    return true;
  }
  toDOM(view) {
    const root = el('section', `leaf-structured leaf-${this.block.kind === 'callout' ? 'callout-widget' : this.block.kind}`);
    // CodeMirror measures the widget border box, not its external margins.
    // Put vertical spacing inside a measured wrapper so hit testing and the
    // height map agree with the actual screen positions below this block.
    const frame = el('div', 'leaf-widget-frame'); frame.append(root);
    root._widget = this;
    root.classList.toggle('leaf-block-selected', this.selected);
    // A source edit rebuilds CodeMirror's height map before updateDOM runs.
    // Retain the measured block height across transactions, otherwise a tall
    // table is briefly estimated as one line and virtualized out under focus.
    root._heightObserver = new ResizeObserver(() => {
      if (root.isConnected) root._widget.layout.height = frame.getBoundingClientRect().height;
    });
    root._heightObserver.observe(frame);
    const top = el('div', 'leaf-block-top');
    top.append(el('span', '', this.block.kind === 'yaml' ? '文档属性' : this.block.kind === 'callout' ? '提示块' : '表格'));
    top.append(button('编辑此块 Markdown 源码', '‹/›', () => {
      const {from, to, kind} = root._widget.block;
      view.dispatch({ effects: sourceBlock.of(from), selection: { anchor: kind === 'yaml' ? Math.min(view.state.doc.length, to + 1) : from } });
      if (kind === 'yaml') view.dom.querySelector('.leaf-property-source')?.focus();
      else view.focus();
    }));
    if (this.block.kind === 'yaml') root.append(top);
    root.addEventListener('keydown', event => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault(); event.stopPropagation(); (event.shiftKey ? redo : undo)(view);
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        if (root._widget.block.kind === 'callout') {
          const b = root._widget.block;
          view.dispatch({selection:{anchor:b.from, head:b.to}});
        }
        view.focus();
      }
    });
    if (this.block.kind === 'callout') {
      this.calloutDOM(root, view);
    }
    else if (this.block.kind === 'yaml') this.yamlDOM(root, view);
    else this.tableDOM(root, view);
    if (this.block.kind !== 'yaml') {
      const source = button('编辑 Markdown 源码', '', () => {
        const from = root._widget.block.from;
        view.dispatch({ effects: sourceBlock.of(from), selection: { anchor: from } });
        view.focus();
      });
      source.classList.add('leaf-block-source');
      source.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m8 7-5 5 5 5m8-10 5 5-5 5m-3-14-2 18"/></svg>';
      root.append(source);
    }
    return frame;
  }
  calloutDOM(root, view) {
    const deleteBlock = () => {
      const b = root._widget.block;
      view.dispatch({changes:{from:b.from, to:b.to, insert:''}, selection:{anchor:b.from},
        userEvent:'delete', annotations:isolateHistory.of('full'), scrollIntoView:true});
      view.focus();
    };
    const box = el(this.block.fold ? 'details' : 'section', 'leaf-callout'); root.append(box);
    if (this.block.fold) box.open = this.block.fold !== '-';
    box.addEventListener('toggle', () => view.requestMeasure());
    const typeControl = el('span', 'leaf-callout-type-control');
    const typeIcon = el('span', 'leaf-callout-type-icon'); typeIcon.setAttribute('aria-hidden', 'true');
    const typeMenu = el('select'); typeMenu.setAttribute('aria-label', '提示块类型'); typeMenu.title = '更改提示块类型或编辑源码';
    for (const [value, label] of Object.entries(calloutLabels)) {
      const option = el('option', '', label); option.value = value; typeMenu.append(option);
    }
    const sourceOption = el('option', '', '编辑 Markdown 源码…'); sourceOption.value = '__source'; typeMenu.append(sourceOption);
    typeControl.append(typeIcon, typeMenu);
    typeControl.addEventListener('click', event => event.stopPropagation());
    typeMenu.addEventListener('change', () => {
      const b = root._widget.block;
      if (typeMenu.value === '__source') {
        view.dispatch({effects:sourceBlock.of(b.from), selection:{anchor:b.from}}); view.focus(); return;
      }
      edit(view, {from:b.from, to:b.to, insert:b.raw.replace(/\[![\w-]+\]/, `[!${typeMenu.value}]`)});
    });
    const controls = [];
    for (const [field, label] of [['title', '提示块标题'], ['body', '提示块内容']]) {
      const wrap = el(field === 'title' && this.block.fold ? 'summary' : 'div', `leaf-callout-edit leaf-callout-${field}`);
      const preview = el('div', 'leaf-callout-preview');
      const input = el('textarea'); input.rows = 1;
      input.setAttribute('aria-label', label);
      const resize = () => { input.style.height = 'auto'; input.style.height = `${Math.max(30, input.scrollHeight)}px`; view.requestMeasure(); };
      preview.addEventListener('click', event => {
        if (event.target.closest('a') || event.target.closest('summary') && field === 'body') return;
        if (wrap.tagName === 'SUMMARY' && event.detail < 2) return;
        event.preventDefault(); wrap.classList.add('is-editing'); input.focus(); resize();
      });
      input.addEventListener('focus', resize);
      input.addEventListener('blur', () => { wrap.classList.remove('is-editing'); view.requestMeasure(); });
      input.addEventListener('keydown', event => {
        if (event.isComposing) return;
        const b = root._widget.block;
        if ((event.key === 'Backspace' || event.key === 'Delete') && !input.value && !b.customTitle.trim() && !b.body.trim()) {
          event.preventDefault(); event.stopPropagation(); deleteBlock();
        }
      });
      input.addEventListener('input', event => {
        const b = root._widget.block, caret = [input.selectionStart, input.selectionEnd];
        const newline = b.raw.includes('\r\n') ? '\r\n' : '\n';
        const lines = b.raw.split(/\r?\n/);
        let insert;
        if (field === 'title') {
          lines[0] = lines[0].replace(/(\[![\w-]+\][+-]?)[^\r\n]*$/, (_, marker) => marker + ' ' + input.value.replace(/\r?\n/g, ' '));
          insert = lines.join(newline);
        } else insert = lines[0] + newline + input.value.split(/\r?\n/).map(line => '> ' + line).join(newline);
        edit(view, {from:b.from, to:b.to, insert}, event.inputType === 'deleteByCut' ? 'delete.cut' : 'input');
        if (input.isConnected) { input.setSelectionRange(...caret); resize(); }
      });
      if (field === 'title') wrap.append(typeControl);
      wrap.append(preview, input); box.append(wrap);
      controls.push({field, preview, input});
    }
    root._syncCallout = () => {
      const b = root._widget.block; box.dataset.type = b.type;
      // A callout's words are drawn from a text area, so the citation pass never
      // walks them: the preview has to be handed the document's own numbers, or a
      // hand-typed "[^1]" shows as the text it is written as and the number only
      // appears in the reading view.
      const notes = footnoteReader(view.state);
      typeMenu.value = b.type;
      typeIcon.innerHTML = calloutBadge(b.type);
      for (const {field, preview, input} of controls) {
        const value = field === 'title' ? b.customTitle : b.body;
        if (input.value !== value) input.value = value;
        if (field === 'title') input.placeholder = calloutLabels[b.type];
        if (field === 'title') renderInline(preview, b.title, notes);
        else renderPrintDocument(preview, b.body, {fallbackTitle:false, expandCallouts:false, footnotes: notes});
        if (!preview.textContent) preview.textContent = field === 'title' ? '标题' : '输入内容…';
      }
    };
    root._syncCallout();
  }
  yamlDOM(root, view) {
    const body = el('div', 'leaf-property-body');
    // A freshly built widget takes the fold from state, so a region folded
    // before it scrolled away comes back folded.
    body.hidden = view.state.field(propertiesFolded);
    root.firstChild.prepend(button('折叠或展开文档属性', '⌄', () => {
      const folded = !view.state.field(propertiesFolded);
      body.hidden = folded;
      // The fold lives in state so it outlives this widget; recording it here
      // rather than rebuilding decorations keeps the click from disturbing the
      // caret and the scroll position.
      view.dispatch({effects: toggleProperties.of(folded)});
      view.requestMeasure();
    }));
    root.append(body);
    renderProperties(body, () => root._widget.block, (field, insert) => {
      if (field) {
        const raw = view.state.doc.sliceString(field.from, field.to);
        if (raw.endsWith('\n')) insert += raw.endsWith('\r\n') ? '\r\n' : '\n';
        edit(view, {from: field.from, to: field.to, insert});
      } else edit(view, {from: root._widget.block.to - 3, insert});
    }, () => view.focus(), () => {
      const b=root._widget.block;
      const raw=view.state.doc.sliceString(b.from,b.to);
      if(b.fields.length || !/^(?:\uFEFF)?---\r?\n\s*\r?\n(?:---|\.\.\.)$/.test(raw))return;
      const blanks=/^(?:[ \t]*\r?\n)+/.exec(view.state.doc.sliceString(b.to))?.[0].length ?? 0;
      view.dispatch({changes:{from:b.from,to:b.to+blanks,insert:''},effects:renderBlock.of(b.from),userEvent:'delete'});
    }, index => {
      const change=propertyRemovalChange(view.state.doc.toString(),index);
      if(!change)return;
      view.dispatch({changes:change,userEvent:'delete',annotations:isolateHistory.of('full')});
      view.focus();
    });
  }
  tableDOM(root, view) {
    const wrap = el('div', 'leaf-table-scroll'), table = el('table');
    root.append(wrap); wrap.append(table);
    const act = (axis,index,remove=false,r=0,c=0) => {
      const b=root._widget.block, insert=tableOperation(b,axis,index,remove);
      if(insert===null)return;
      const nextRow=axis==='row'?Math.min(index,b.rows.length-(remove?2:0)):r;
      const nextCol=axis==='col'?Math.min(index,b.columns-(remove?2:0)):c;
      view.dispatch({changes:{from:b.from,to:b.to,insert},selection:{anchor:b.from},
        userEvent:remove?'delete':'input',annotations:isolateHistory.of('full')});
      view.focus();
      requestAnimationFrame(()=>{
        const fresh=[...view.dom.querySelectorAll('.leaf-table')].find(n=>n._widget?.block.from===b.from);
        const input=fresh?.querySelector(`textarea[data-row="${Math.max(0,nextRow)}"][data-col="${Math.max(0,nextCol)}"]`);
        input?.focus();input?.scrollIntoView({block:'nearest',inline:'nearest'});
      });
    };
    applyTableWidths(table, this.block);
    table.style.minWidth = "max(300px, var(--table-min-width, 0px))";
    let pending = 0;
    root._resizeCells = () => {
      cancelAnimationFrame(pending);
      pending = requestAnimationFrame(() => {
        if (!root.isConnected) return;
        for (const input of root.querySelectorAll('textarea:focus')) {
          input.style.height = 'auto'; input.style.height = `${Math.max(30, input.scrollHeight)}px`;
        }
        view.requestMeasure();
      });
    };
    let previousWidth = -1;
    root._resizeObserver = new ResizeObserver(entries => {
      const width = entries[0].contentRect.width;
      if (width !== previousWidth) { previousWidth = width; root._resizeCells(); }
    });
    root._resizeObserver.observe(wrap);
    this.block.rows.forEach((row, r) => {
      const tr = el('tr'); table.append(tr);
      for (let c = 0; c < this.block.columns; c++) {
        const td = el(r === 0 ? 'th' : 'td');
        const preview = el('div', 'leaf-cell-preview');
        renderInline(preview, row.cells[c]?.value ?? '');
        preview.style.textAlign = this.block.align[c];
        const input = el('textarea');
        input.rows = 1; input.value = (row.cells[c]?.value ?? '').replace(/<br\s*\/?\s*>/gi, '\n');
        input.dataset.row = r; input.dataset.col = c;
        input.setAttribute('aria-label', `第 ${r + 1} 行，第 ${c + 1} 列`);
        input.style.textAlign = this.block.align[c];
        const resize = () => { input.style.height = 'auto'; input.style.height = `${Math.max(30, input.scrollHeight)}px`; view.requestMeasure(); };
        input.addEventListener('input', event => {
          const caret = [input.selectionStart, input.selectionEnd, input.selectionDirection];
          root._widget.layout.height = root.parentElement.getBoundingClientRect().height;
          const block = root._widget.block, current = block.rows[r], cell = current.cells[c];
          const value = input.value.replace(/\r?\n/g, '<br>').replace(/\|/g, '\\|');
          root._writingCell = input;
          try {
          if (cell) edit(view, { from: cell.segmentFrom, to: cell.segmentTo, insert: ` ${value} ` }, event.inputType === 'deleteByCut' ? 'delete.cut' : 'input');
          else {
            const values = Array.from({ length: block.columns }, (_, i) => i === c ? value : current.cells[i]?.raw ?? '');
            edit(view, { from: current.from, to: current.to, insert: `| ${values.join(' | ')} |` });
          }
          } finally { root._writingCell = null; }
          resize();
          // WebKit may reset a textarea selection when its widget is measured
          // or its normalized value is assigned during the source transaction.
          if (input.isConnected && document.activeElement === input) input.setSelectionRange(...caret);
        });
        input.addEventListener('keydown', event => {
          if (event.isComposing) return;
          const shortcut=tableShortcut(event);
          if(shortcut){event.preventDefault();event.stopPropagation();act(shortcut[0],(shortcut[0]==='row'?r:c)+shortcut[1],false,r,c);return;}
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault(); leaveTable(root, view); return;
          }
          if (event.key === 'Enter') {
            event.preventDefault(); event.stopPropagation();
            input.setRangeText('\n', input.selectionStart, input.selectionEnd, 'end');
            input.dispatchEvent(new InputEvent('input', {bubbles:true,inputType:'insertLineBreak',data:null}));
            return;
          }
          if (event.key === 'Tab') {
            const inputs = [...root.querySelectorAll('textarea')], next = inputs[inputs.indexOf(input) + (event.shiftKey ? -1 : 1)];
            event.preventDefault();
            if (next) next.focus();
            else leaveTable(root, view, event.shiftKey);
          }
        });
        preview.addEventListener('click', () => { input.focus(); resize(); });
        td.addEventListener('mousedown', event => {
          if (event.target === input || event.metaKey || event.ctrlKey) return;
          event.preventDefault(); input.focus(); resize();
        });
        input.addEventListener('focus', resize);
        input.addEventListener('blur', () => {
          applyTableWidths(table, root._widget.block); root._resizeCells();
        });
        td.append(preview, input); tr.append(td);
        requestAnimationFrame(resize);
      }
    });
    tableEdgeControls(root,table,act);
    const after = button('在表格后继续正文', '继续正文 ↓', () => leaveTable(root, view));
    after.classList.add('leaf-table-exit');
    root.append(after);
  }
  ignoreEvent() { return true; }
  destroy(dom) { const root=dom.firstElementChild; root?._resizeObserver?.disconnect(); root?._heightObserver?.disconnect(); }
}

function leaveTable(root, view, before = false) {
  const b = root._widget.block;
  const at = before ? b.from : b.to;
  view.dispatch({changes:{from:at,insert:'\n\n'},
    selection:{anchor:before ? at : at+2},scrollIntoView:true,
    userEvent:'input',annotations:isolateHistory.of('full')});
  view.focus();
}

function build(state, name, sources, remembered = [], previousLayouts = new Map(), yamlSource = null) {
  const source = state.doc.toString(), model = analyzeMarkdown(source), ranges = [];
  const layouts = new Map();
  // Keep previously recognized prefixes when an edit removes their parent heading.
  // Hints are position-mapped and cleared on document load; they never touch source.
  for (const heading of model.headings) {
    const c = heading.candidate;
    if (!heading.legacyPrefix && c && remembered.some(p => p.from === c.from && p.to === c.to && p.parts.join('.') === c.parts.join('.'))) heading.legacyPrefix = c;
  }
  const titleLayout = previousLayouts.get('title:0') ?? {height:-1};
  layouts.set('title:0', titleLayout);
  if (state.field(fileNameTitle, false) !== false) ranges.push(Decoration.widget({ widget: new DefaultTitle(name, titleLayout), block: true, side: -1 }).range(0));
  if (yamlSource) {
    const {from, to} = yamlSource;
    const widget = new PropertySource(from, to, source.slice(from, to));
    ranges.push(from === to
      ? Decoration.widget({widget, block:true, side:1}).range(from)
      : Decoration.replace({widget, block:true}).range(from, to));
  }
  for (const block of model.blocks) {
    if (yamlSource && block.from < yamlSource.to && block.to > yamlSource.from) continue;
    const key = `${block.kind}:${block.from}`;
    const layout = previousLayouts.get(key) ?? {height:-1};
    layouts.set(key, layout);
    const selected = state.selection.ranges.some(r => !r.empty && r.from < block.to && r.to > block.from);
    if (sources.has(block.from) || selected && block.kind !== 'callout') {
      ranges.push(Decoration.widget({ widget: new SourceReturn(block.from), block: true, side: -1 }).range(block.from));
    } else ranges.push(Decoration.replace({ widget: new StructuredBlock(block, source.slice(block.from, block.to), layout, selected), block: true }).range(block.from, block.to));
  }
  return { name, sources, model, layouts, yamlSource, decorations: Decoration.set(ranges, true) };
}

export const structuredPreview = StateField.define({
  create: state => build(state, '未命名', new Set()),
  update(value, tr) {
    let name = value.name;
    let sources = new Set([...value.sources].map(p => tr.changes.mapPos(p)));
    let yamlSource = value.yamlSource && {
      from: tr.changes.mapPos(value.yamlSource.from, -1),
      to: tr.changes.mapPos(value.yamlSource.to, 1),
    };
    for (const effect of tr.effects) {
      if (effect.is(documentName)) { name = effect.value; sources = new Set(); yamlSource = null; }
      if (effect.is(sourceBlock)) {
        const yaml = value.model.blocks.find(b => b.kind === 'yaml' && b.from === effect.value);
        if (yaml) yamlSource = yamlSource ? null : {from: yaml.from, to: yaml.to};
      }
      if (effect.is(sourceBlock)) sources.has(effect.value) ? sources.delete(effect.value) : sources.add(effect.value);
      if (effect.is(renderBlock)) {
        sources.delete(effect.value);
        if (yamlSource?.from === effect.value) yamlSource = null;
      }
    }
    const remembered = tr.effects.some(e => e.is(documentName)) ? [] : value.model.headings.filter(h => h.legacyPrefix).map(h => ({
      ...h.legacyPrefix, from: tr.changes.mapPos(h.legacyPrefix.from, 1), to: tr.changes.mapPos(h.legacyPrefix.to, -1),
    }));
    const layouts = new Map([...value.layouts].map(([key, layout]) => {
      const [kind, from] = key.split(':');
      return [`${kind}:${kind === 'title' ? 0 : tr.changes.mapPos(Number(from))}`, layout];
    }));
    return tr.docChanged || tr.selection || tr.effects.length ? build(tr.state, name, sources, remembered, layouts, yamlSource) : value;
  },
  provide: field => [EditorView.decorations.compute([field, sourceMode], state => state.field(sourceMode, false) ? Decoration.none : state.field(field).decorations),
    EditorView.atomicRanges.of(view => (view.state.field(sourceMode, false) ? Decoration.none : view.state.field(field).decorations))],
});
