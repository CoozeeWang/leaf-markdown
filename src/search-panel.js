import { t, h, setAttr } from './i18n.js';
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
    setAttr(this.dom, 'aria-label', () => t("search_panel.find_and_replace_in_document"));
    this.dom.innerHTML = `<div class="leaf-search-main">
      <input name="search" main-field="true" placeholder="${t("editor.find")}" data-i18n-placeholder="editor.find" aria-label="${t("editor.find")}" data-i18n-aria-label="editor.find" autocomplete="off" spellcheck="false">
      <div class="leaf-search-actions"><span class="search-result" role="status" aria-live="polite" aria-atomic="true"></span>
      <button type="button" name="prev"></button><button type="button" name="next"></button>
      <button type="button" name="toggleReplace" aria-expanded="false" aria-label="${t("search_panel.show_replace")}" data-i18n-aria-label="search_panel.show_replace">${h("editor.replace")}</button>
      <button type="button" name="options" aria-expanded="false">${h("search_panel.options")}</button>
      <button type="button" name="close"></button></div>
    </div>
    <div class="leaf-search-options" hidden>
      <label><input type="checkbox" name="case">${h("editor.match_case")}</label>
      <label><input type="checkbox" name="re">${h("editor.regex")}</label>
      <label><input type="checkbox" name="word">${h("editor.whole_words")}</label>
      <button type="button" name="select"></button>
    </div>
    <div class="leaf-search-replace" hidden>
      <input name="replace" placeholder="${t("editor.replace_with")}" data-i18n-placeholder="editor.replace_with" aria-label="${t("editor.replace_with")}" data-i18n-aria-label="editor.replace_with" autocomplete="off" spellcheck="false">
      <div class="leaf-search-actions"><button type="button" name="replace">${h("editor.replace")}</button><button type="button" name="replaceAll">${h("editor.replace_all")}</button></div>
    </div>`;
    this.field = name => this.dom.querySelector(`input[name="${name}"]`);
    this.button = name => this.dom.querySelector(`button[name="${name}"]`);
    const actions = {prev: [findPrevious, "search_panel.previous_match_g", 'up'], next: [findNext, "search_panel.next_match_g", 'down'], select: [selectMatches, "search_panel.select_all_matches", 'selectAll'], close: [closeSearchPanel, "search_panel.close_search_esc", 'close'], replace: [replaceNext, "search_panel.replace_current_match"], replaceAll: [replaceAll, "search_panel.replace_all_matches"]};
    for (const [name, [action, label, glyph]] of Object.entries(actions)) {
      const button = this.button(name);
      setAttr(button, 'aria-label', () => shortcutText(t(label)));
      setAttr(button, 'data-tooltip', () => shortcutText(t(label)));
      if (glyph) { button.innerHTML = uiIcon(glyph, 16); button.dataset.seriesIcon = glyph; }
      button.addEventListener('click', () => action(view));
    }
    for (const [name, label] of [['case', "search_panel.match_case"], ['re', "search_panel.use_regular_expressions"], ['word', "search_panel.match_whole_words"]]) {
      setAttr(this.field(name).parentElement, 'data-tooltip', () => t(label));
    }
    for (const [name, selector] of [['toggleReplace', '.leaf-search-replace'], ['options', '.leaf-search-options']]) {
      this.button(name).addEventListener('click', () => {
        const group = this.dom.querySelector(selector);
        group.hidden = !group.hidden;
        this.button(name).setAttribute('aria-expanded', String(!group.hidden));
        if (name === 'toggleReplace') {
          setAttr(this.button(name), 'aria-label', () => group.hidden ? t("search_panel.show_replace") : t("search_panel.hide_replace"));
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
    const message = !query.search ? t("search_panel.enter_search_text") : !query.valid ? t("search_panel.invalid_regular_expression") : !total ? t("search_panel.no_matches") : index >= 0 ? t("search_panel.match_of", {"index": index + 1, "total": total}) : t("search_panel.matches", {"total": total});
    const result = this.dom.querySelector('.search-result');
    if (result.textContent !== message) result.textContent = message;
    this.field('search').setAttribute('aria-invalid', String(!!query.search && !query.valid));
    for (const name of ['prev', 'next', 'select', 'replace', 'replaceAll']) this.button(name).disabled = !total || (name.startsWith('replace') && state.readOnly) || (name === 'select' && total > 1000);
    this.button('select').dataset.tooltipKind=total>1000?'operation':'control';
    setAttr(this.button('select'), 'data-tooltip', () => total > 1000 ? t("search_panel.more_than_1_000_matches_cannot_select") : t("search_panel.select_all_matches"));
    this.button('toggleReplace').hidden = state.readOnly;
  }
  update() { this.sync(); }
  mount() { this.field('search').select(); }
  get top() { return true; }
  get pos() { return 80; }
}
