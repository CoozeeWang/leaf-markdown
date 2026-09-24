import {SearchQuery, getSearchQuery, setSearchQuery, findNext, findPrevious, selectMatches, replaceNext, replaceAll, closeSearchPanel} from '@codemirror/search';
import {runScopeHandlers} from '@codemirror/view';
import {uiIcon} from './ui-icons.js';
import {shortcutText} from './platform-shortcuts.js';

export class LeafSearchPanel {
  constructor(view) {
    this.view = view;
    this.dom = document.createElement('div');
    this.dom.className = 'cm-search leaf-search';
    this.dom.setAttribute('role', 'search');
    this.dom.setAttribute('aria-label', '文内查找与替换');
    this.dom.innerHTML = `<div class="leaf-search-main">
      <button type="button" name="toggleReplace" aria-expanded="false" aria-label="展开替换">替换</button>
      <input name="search" main-field="true" placeholder="查找" aria-label="查找" autocomplete="off" spellcheck="false">
      <span class="search-result" role="status" aria-live="polite" aria-atomic="true"></span>
      <button type="button" name="prev"></button><button type="button" name="next"></button>
      <button type="button" name="options" aria-expanded="false">选项</button>
      <button type="button" name="close"></button>
    </div>
    <div class="leaf-search-options" hidden>
      <label><input type="checkbox" name="case">大小写</label>
      <label><input type="checkbox" name="re">正则</label>
      <label><input type="checkbox" name="word">整词</label>
      <button type="button" name="select"></button>
    </div>
    <div class="leaf-search-replace" hidden>
      <input name="replace" placeholder="替换为" aria-label="替换为" autocomplete="off" spellcheck="false">
      <button type="button" name="replace">替换</button><button type="button" name="replaceAll">全部替换</button>
    </div>`;
    this.field = name => this.dom.querySelector(`input[name="${name}"]`);
    this.button = name => this.dom.querySelector(`button[name="${name}"]`);
    const actions = {prev: [findPrevious, '上一处  ⇧⌘G', 'up'], next: [findNext, '下一处  ⌘G', 'down'], select: [selectMatches, '选择全部匹配项', 'selectAll'], close: [closeSearchPanel, '关闭查找  Esc', 'close'], replace: [replaceNext, '替换当前匹配项'], replaceAll: [replaceAll, '替换全部匹配项']};
    for (const [name, [action, label, glyph]] of Object.entries(actions)) {
      const button = this.button(name);
      button.setAttribute('aria-label', shortcutText(label));
      button.dataset.tooltip = shortcutText(label);
      if (glyph) { button.innerHTML = uiIcon(glyph, 16); button.dataset.seriesIcon = glyph; }
      button.addEventListener('click', () => action(view));
    }
    for (const [name, label] of [['case', '区分大小写'], ['re', '使用正则表达式'], ['word', '全字匹配']]) {
      this.field(name).parentElement.dataset.tooltip = label;
    }
    for (const [name, selector] of [['toggleReplace', '.leaf-search-replace'], ['options', '.leaf-search-options']]) {
      this.button(name).addEventListener('click', () => {
        const group = this.dom.querySelector(selector);
        group.hidden = !group.hidden;
        this.button(name).setAttribute('aria-expanded', String(!group.hidden));
        if (name === 'toggleReplace') {
          this.button(name).setAttribute('aria-label', group.hidden ? '展开替换' : '收起替换');
          if (!group.hidden) this.field('replace').focus();
        }
        view.requestMeasure();
      });
    }
    this.dom.addEventListener('input', event => { if (!event.isComposing) this.commit(); });
    this.dom.addEventListener('compositionend', () => this.commit());
    this.dom.addEventListener('keydown', event => {
      if (event.isComposing) return;
      if (runScopeHandlers(view, event, 'search-panel')) event.preventDefault();
      else if (event.key === 'Enter' && event.target === this.field('search')) {
        event.preventDefault(); (event.shiftKey ? findPrevious : findNext)(view);
      } else if (event.key === 'Enter' && event.target === this.field('replace')) {
        event.preventDefault(); if (!this.button('replace').disabled) replaceNext(view);
      }
    });
    this.sync();
  }
  commit() {
    const query = new SearchQuery({search: this.field('search').value, replace: this.field('replace').value, caseSensitive: this.field('case').checked, regexp: this.field('re').checked, wholeWord: this.field('word').checked});
    if (!query.eq(getSearchQuery(this.view.state))) this.view.dispatch({effects: setSearchQuery.of(query)});
  }
  sync() {
    const state = this.view.state, query = getSearchQuery(state);
    for (const name of ['search', 'replace']) if (this.field(name).value !== query[name]) this.field(name).value = query[name];
    for (const [name, key] of [['case', 'caseSensitive'], ['re', 'regexp'], ['word', 'wholeWord']]) this.field(name).checked = query[key];
    if (this.doc !== state.doc || !this.query?.eq(query)) {
      this.doc = state.doc; this.query = query; this.matches = [];
      if (query.valid) {
        const cursor = query.getCursor(state);
        const next = () => cursor.nextOverlapping ? cursor.nextOverlapping() : cursor.next();
        while (!next().done) this.matches.push({from: cursor.value.from, to: cursor.value.to});
      }
    }
    const total = this.matches.length, selection = state.selection.main;
    const index = this.matches.findIndex(match => match.from === selection.from && match.to === selection.to);
    const message = !query.search ? '输入查找内容' : !query.valid ? '正则表达式无效' : !total ? '无匹配' : index >= 0 ? `第 ${index + 1} / ${total} 处` : `共 ${total} 处`;
    const result = this.dom.querySelector('.search-result');
    if (result.textContent !== message) result.textContent = message;
    this.field('search').setAttribute('aria-invalid', String(!!query.search && !query.valid));
    for (const name of ['prev', 'next', 'select', 'replace', 'replaceAll']) this.button(name).disabled = !total || (name.startsWith('replace') && state.readOnly) || (name === 'select' && total > 1000);
    this.button('select').dataset.tooltip = total > 1000 ? '匹配超过 1000 处，无法全部选择' : '选择全部匹配项';
    this.button('toggleReplace').hidden = state.readOnly;
  }
  update() { this.sync(); }
  mount() { this.field('search').select(); }
  get top() { return true; }
  get pos() { return 80; }
}
