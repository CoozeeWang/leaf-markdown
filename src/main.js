import { t, h, aliases, languagePreference, setLanguagePreference, onLanguageChange, refreshTranslations, setText, setAttr, message as translatedMessage } from './i18n.js';
import { calloutBadge } from './callout-icons.js';
import { inlineRename } from './inline-rename.js';
import { setupStatusNotices } from './status-notices.js';
import { positionMenu } from './menu-position.js';
import {installMenuInteraction} from './menu-interaction.js';
installMenuInteraction();
import { setupWriting } from './writing-tools.js';
import { loadedLocalImagePaths, refreshImages, retryMissingImages, setMovedMissingImages } from './resources.js';
import { showRecovery, setupWelcomeRecovery } from './recovery-dialog.js';
import { createLeafEditor, createLeafNoteEditor } from './editor.js';
import { setupSidebarResize } from './outline-resize.js';
import './style.css';
import { renderPrintDocument } from './print-document.js';
import { frontmatter } from './markdown-model.js';
import './reading.css';
import { desktop, desktopRevealDocument, desktopExportBundle, desktopRename, desktopOpen, desktopNew, desktopSave, desktopHasPath, initDesktop, desktopTitle, desktopEdited, desktopRestore, desktopRecoveryPaused, desktopRun, chooseAttachments } from './desktop.js';
import { invoke } from '@tauri-apps/api/core';
import { shortcutText, renderShortcutText, renderTooltipText } from './platform-shortcuts.js';
import { labels as calloutLabels } from './callout.js';
import { indexFootnotes, notePanelRows } from './footnotes.js';
import { uiIcon, uiIconPaths } from './ui-icons.js';
import {readingFolding} from './outline-folding.js';

const welcome = t("main.leaf_a_lightweight_markdown_editor");
const leafDev = typeof __LEAF_DESKTOP_DEV__ !== 'undefined' && __LEAF_DESKTOP_DEV__ && desktop;
const leafName = leafDev ? 'Leaf Dev' : 'Leaf';

const state = {
  fileHandle: null,
  fileName: t("main.untitled_md"),
  content: welcome,
  savedContent: welcome,
  diskContent: welcome,
  lastModified: 0,
  saveTimer: null,
  saving: false,
  conflict: false,
  theme: localStorage.getItem('leaf-theme') || 'system',
  showLineNumbers: localStorage.getItem('leaf-line-numbers') === 'true',
  showBlankMarkers: localStorage.getItem('leaf-blank-markers') === 'true',
  showFileNameTitle: localStorage.getItem('leaf-file-name-title') !== 'false',
  showHeadingNumbers: localStorage.getItem('leaf-heading-numbers') === 'true',
  fontSize: Number(localStorage.getItem('leaf-reading-v2-size')) || 17,
  contentWidth: Number(localStorage.getItem('leaf-reading-v2-width')) || 780,
  fontFamily: localStorage.getItem('leaf-reading-v2-font') || 'sans',
  focusMode: false,
  outline: [],
  // The signature of the notes the panel is currently showing, so a redraw can be
  // skipped when a keystroke in the document changed nothing about them, and the
  // shape of the list on its own, so a change to one note's words patches that row
  // instead of rebuilding all of them.
  notesSignature: '',
  notesSkeleton: '',
  reading: false,
  source: false,
};

const iconPaths = {
  ...uiIconPaths,
  language: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 4 6 4 9s-1 6-4 9c-3-3-4-6-4-9s1-6 4-9Z"/>',
  attach: '<path d="m9 12 6-6a3 3 0 0 1 4 4l-9 9a5 5 0 0 1-7-7l9-9"/>',
  link: '<path d="m10 13 4-4m-6 6-2 2a3 3 0 0 1-4-4l5-5a3 3 0 0 1 4 0m2 8a3 3 0 0 0 4 0l5-5a3 3 0 0 0-4-4l-2 2"/>',
  paste: '<path d="M9 4H5v17h14V4h-4"/><rect x="9" y="2" width="6" height="4" rx="1"/><path d="M8 11h8M8 15h6"/>',
  copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>',
  callout: '<path d="M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-5 3v-3H3V6a2 2 0 0 1 2-2Z"/><path d="M12 8v4m0 3h.01"/>',
  edit: '<path d="m16 3 5 5-12 12-6 1 1-6Z M14 5l5 5"/>',
  read: '<path d="M3 4h6a3 3 0 0 1 3 3v14a4 4 0 0 0-4-2H3Zm18 0h-6a3 3 0 0 0-3 3v14a4 4 0 0 1 4-2h5Z"/>',
  newfile: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6M9 15h6M12 12v6"/>',
  tidy: '<path d="M4 5h16M4 19h16M8 9l4 3 4-3M8 15l4-3 4 3"/>',
  commands: '<path d="M3 5h17M3 10h8M3 15h5"/><circle cx="15.5" cy="15" r="4"/><path d="m18.5 18 3 3"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  quote: '<path d="M9 11H5a3 3 0 0 1 3-3V6a5 5 0 0 0-5 5v7h6Zm12 0h-4a3 3 0 0 1 3-3V6a5 5 0 0 0-5 5v7h6Z"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13"/><circle cx="3.5" cy="6" r=".7" fill="currentColor"/><circle cx="3.5" cy="12" r=".7" fill="currentColor"/><circle cx="3.5" cy="18" r=".7" fill="currentColor"/>',
  ordered: '<path d="M10 6h11M10 12h11M10 18h11M4 4v4M3 8h2M3 11h2l-2 3h2M3 17h1.5a1 1 0 0 1 0 2H3"/>',
  code: '<path d="m8 9-3 3 3 3m8-6 3 3-3 3m-3-8-2 10"/>',
  codeblock: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m8 9-2 3 2 3m4 0h5"/>',
  table: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M3 15h18M9 4v16M15 4v16"/>',
  appearance: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"/>',
  focus: '<path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3"/>',
  chevron: '<path d="m8 10 4 4 4-4"/>',
};

function icon(name, size = 18) {
  return `<svg class="ui-icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${iconPaths[name]}</svg>`;
}

function languageControl(id, welcome = false) {
  return `<button type="button" id="${id}" class="language-control quick-language-button ${welcome ? 'welcome-icon' : 'icon-control'}" data-tooltip="${t('UI0256')}" data-i18n-data-tooltip="settings.language" aria-label="${t('UI0256')}" data-i18n-aria-label="settings.language" aria-haspopup="menu" aria-controls="languagePopover" aria-expanded="false">${icon('language', 17)}</button>`;
}

document.querySelector('#app').innerHTML = shortcutText(`
  <main class="shell welcome-state${desktop && new URLSearchParams(location.search).has('document') ? ' document-loading' : ''}">
    <header class="topbar">
      <div class="brand">
        <img class="brand-mark" src="/leaf-icon.png" alt="" aria-hidden="true" />
        <span class="brand-copy"><strong>${leafName}</strong><small>${leafDev ? h('dev.subtitle') : h('main.markdown_editor')}</small></span>
      </div>
      <div class="topbar-actions">
        <div class="document-controls">
          <div class="document-primary">
            ${desktop ? '' : `<button id="openButton" class="primary icon-control" aria-label="${t("main.open_file")}" data-i18n-aria-label="main.open_file" data-tooltip="${t("main.open_file_o")}" data-i18n-data-tooltip="main.open_file_o">${icon('open')}</button>`}
            <button id="recentButton" class="icon-control" aria-label="${t("main.open_recent")}" data-i18n-aria-label="main.open_recent" data-tooltip="${t("main.open_recent")}" data-i18n-data-tooltip="main.open_recent">${icon('history')}</button>
            <button id="documentMenuButton" class="filename" aria-label="${t("main.document_actions")}" data-i18n-aria-label="main.document_actions" aria-haspopup="menu" aria-expanded="false"><span id="fileName"></span>${icon('chevron', 13)}</button>
          </div>
          <span id="dirty" class="dirty" aria-label="${t("main.unsaved")}" data-i18n-aria-label="main.unsaved"></span>
        </div>
        <button id="readingToggle" class="icon-control" aria-label="${t("main.switch_to_reading_mode")}" data-i18n-aria-label="main.switch_to_reading_mode" aria-pressed="false" data-tooltip="${t("main.switch_to_reading_mode_r")}" data-i18n-data-tooltip="main.switch_to_reading_mode_r">${icon('edit')}</button>
        <button id="searchButton" class="icon-control" aria-label="${t("main.find")}" data-i18n-aria-label="main.find" data-tooltip="${t("main.find_in_document_f")}" data-i18n-data-tooltip="main.find_in_document_f">${icon('search')}</button>
        <button id="commandsButton" class="icon-control" aria-label="${t("main.command_palette")}" data-i18n-aria-label="main.command_palette" data-tooltip="${t("main.command_palette_p")}" data-i18n-data-tooltip="main.command_palette_p">${icon('commands')}</button>
        <button id="saveButton" class="icon-control" aria-label="${t("main.save")}" data-i18n-aria-label="main.save" data-tooltip="${t("main.save_s")}" data-i18n-data-tooltip="main.save_s">${icon('save')}</button>
        <button id="exportMenuButton" class="icon-control" aria-label="${t("main.export")}" data-i18n-aria-label="main.export" aria-haspopup="menu" aria-expanded="false" data-tooltip="${t("main.export_e")}" data-i18n-data-tooltip="main.export_e">${icon('export')}</button>
        <button id="appearanceButton" class="icon-control" aria-label="${t("main.settings")}" data-i18n-aria-label="main.settings" aria-haspopup="dialog" aria-expanded="false" data-tooltip="${t("main.settings_ui0021")}" data-i18n-data-tooltip="main.settings_ui0021">${icon('appearance', 16)}</button>
        ${languageControl('editorLanguageSelect')}
      </div>
    </header>

    <nav class="format-toolbar" aria-label="${t("main.formatting_toolbar")}" data-i18n-aria-label="main.formatting_toolbar">
      <button id="undoButton" aria-label="${t("main.undo")}" data-i18n-aria-label="main.undo" data-tooltip="${t("main.undo_z")}" data-i18n-data-tooltip="main.undo_z">${icon('undo')}</button>
      <button id="redoButton" aria-label="${t("main.redo")}" data-i18n-aria-label="main.redo" data-tooltip="${t("main.redo_z")}" data-i18n-data-tooltip="main.redo_z">${icon('redo')}</button>
      <span class="toolbar-divider"></span>
      <button id="headingButton" class="heading-control" aria-label="${t("main.heading_level")}" data-i18n-aria-label="main.heading_level" aria-haspopup="menu" aria-expanded="false" data-tooltip="${t("main.heading_level_1_6_body_text_0")}" data-i18n-data-tooltip="main.heading_level_1_6_body_text_0"><span>H</span>${icon('chevron', 13)}</button>
      <span class="toolbar-divider"></span>
      <button data-format="bold" aria-label="${t("main.bold")}" data-i18n-aria-label="main.bold" data-tooltip="${t("main.bold_b")}" data-i18n-data-tooltip="main.bold_b"><span class="format-glyph bold">B</span></button>
      <button data-format="italic" aria-label="${t("main.italic")}" data-i18n-aria-label="main.italic" data-tooltip="${t("main.italic_i")}" data-i18n-data-tooltip="main.italic_i"><span class="format-glyph italic">I</span></button>
      <button data-format="highlight" aria-label="${t('main.highlight')}" data-i18n-aria-label="main.highlight">${icon('highlight')}</button>
      <button data-format="strike" aria-label="${t("main.strikethrough")}" data-i18n-aria-label="main.strikethrough" data-tooltip="${t("main.strikethrough_x")}" data-i18n-data-tooltip="main.strikethrough_x"><span class="format-glyph strike">S</span></button>
      <button data-format="sup" aria-label="${t("main.superscript")}" data-i18n-aria-label="main.superscript" data-tooltip="${t("main.superscript_ui0036")}" data-i18n-data-tooltip="main.superscript_ui0036"><span class="format-glyph">x<sup>2</sup></span></button>
      <button data-format="sub" aria-label="${t("main.subscript")}" data-i18n-aria-label="main.subscript" data-tooltip="${t("main.subscript_ui0038")}" data-i18n-data-tooltip="main.subscript_ui0038"><span class="format-glyph">x<sub>2</sub></span></button>
      <button data-format="footnote" aria-label="${t("main.insert_footnote")}" data-i18n-aria-label="main.insert_footnote" data-tooltip="${t("main.insert_footnote_f")}" data-i18n-data-tooltip="main.insert_footnote_f">${icon('footnote')}</button>
      <span class="toolbar-divider"></span>
      <button data-format="quote" aria-label="${t("main.blockquote")}" data-i18n-aria-label="main.blockquote" data-tooltip="${t("main.blockquote")}" data-i18n-data-tooltip="main.blockquote">${icon('quote')}</button>
      <button data-format="bullet" aria-label="${t("main.bulleted_list")}" data-i18n-aria-label="main.bulleted_list" data-tooltip="${t("main.bulleted_list_8")}" data-i18n-data-tooltip="main.bulleted_list_8">${icon('list')}</button>
      <button data-format="ordered" aria-label="${t("main.numbered_list")}" data-i18n-aria-label="main.numbered_list" data-tooltip="${t("main.numbered_list_7")}" data-i18n-data-tooltip="main.numbered_list_7">${icon('ordered')}</button>
      <span class="toolbar-divider"></span>
      <button data-format="code" aria-label="${t("main.inline_code")}" data-i18n-aria-label="main.inline_code" data-tooltip="${t("main.inline_code")}" data-i18n-data-tooltip="main.inline_code">${icon('code')}</button>
      <button data-format="codeblock" aria-label="${t("main.code_block")}" data-i18n-aria-label="main.code_block" data-tooltip="${t("main.code_block")}" data-i18n-data-tooltip="main.code_block">${icon('codeblock')}</button>
      <button data-format="table" aria-label="${t("main.insert_table")}" data-i18n-aria-label="main.insert_table" data-tooltip="${t("main.insert_table")}" data-i18n-data-tooltip="main.insert_table">${icon('table')}</button>
      <span class="toolbar-narrow-break" aria-hidden="true"></span><button id="calloutButton" aria-label="${t("main.insert_callout")}" data-i18n-aria-label="main.insert_callout" data-tooltip="${t("main.insert_callout")}" data-i18n-data-tooltip="main.insert_callout" aria-haspopup="dialog" aria-expanded="false">${icon('callout')}</button>
      <span class="toolbar-spacer"></span>
      <button id="tidyBlankLines" aria-label="${t("main.tidy_paragraph_spacing")}" data-i18n-aria-label="main.tidy_paragraph_spacing" data-tooltip="${t("UI0051")}" data-i18n-data-tooltip="main.tidy_paragraph_spacing_ui0051">${icon('tidy')}</button>
      <button id="displayButton" aria-label="${t("main.display")}" data-i18n-aria-label="main.display" aria-haspopup="dialog" aria-expanded="false" data-tooltip="${t("main.display")}" data-i18n-data-tooltip="main.display">${icon('eye')}</button>
    </nav>

    <div id="statusNotice" class="status-notice" hidden>
      <span id="saveStatus" class="save-status" hidden></span>
      <button id="recoveryNotice" class="recovery-notice" hidden>${h("main.recovery_available_view")}</button>
      <span id="statusActions" class="status-actions" hidden></span>
      <button id="dismissStatus" class="dismiss-status" aria-label="${t("main.dismiss_notice")}" data-i18n-aria-label="main.dismiss_notice" data-tooltip="${t("main.dismiss_notice")}" data-i18n-data-tooltip="main.dismiss_notice">${icon('close', 14)}</button>
    </div>
    <span id="statusAnnouncement" class="status-announcement" role="status" aria-live="polite" aria-atomic="true"></span>

    <section class="document-area">
      <div id="editor" class="editor-host"></div>
      <section id="welcomeScreen" class="welcome-screen" ${desktop && new URLSearchParams(location.search).get('document') === '1' ? 'hidden' : ''} aria-label="${t("main.welcome_to_leaf")}" data-i18n-aria-label="main.welcome_to_leaf">
        <button id="welcomeSettings" class="welcome-settings icon-control" aria-label="${t("main.settings_ui0056")}" data-i18n-aria-label="main.settings_ui0056" data-tooltip="${t("main.settings_ui0056")}" data-i18n-data-tooltip="main.settings_ui0056">${icon('appearance', 16)}</button>
        <div class="welcome-card">
          <img class="welcome-mark" src="/leaf-icon.png" alt="" aria-hidden="true" />
          <h1 class="welcome-title"><span class="welcome-name">${leafName}</span><span class="welcome-description">${leafDev ? h('dev.subtitle') : h('main.lightweight_markdown_editor')}</span></h1>
          <div class="welcome-actions">
            <button id="welcomeNewButton" class="welcome-primary">${icon('newfile', 17)}<span>${h("main.new_document")}</span></button>
            <button id="welcomeOpenButton" class="welcome-primary">${icon('open', 17)}<span>${h("main.open_file_ui0060")}</span></button>
            <button id="welcomeRecentButton" class="welcome-icon" aria-label="${t("main.open_recent_ui0061")}" data-i18n-aria-label="main.open_recent_ui0061" data-tooltip="${t("main.open_recent_ui0061")}" data-i18n-data-tooltip="main.open_recent_ui0061">${icon('history', 17)}</button>
            ${languageControl('welcomeLanguageSelect', true)}
          </div>
        </div>
        <p class="welcome-drop-hint">${h("main.drop_a_markdown_file_to_open_it")}</p>
      </section>
      <section id="readingPane" class="reading-pane" aria-label="${t("main.reading_mode")}" data-i18n-aria-label="main.reading_mode" tabindex="0" hidden><article class="reading-document"></article></section>
      <button id="outlineButton" class="sidebar-rail sidebar-rail-left" aria-label="${t("main.expand_outline")}" data-i18n-aria-label="main.expand_outline" aria-controls="outlineDrawer" aria-expanded="false" data-tooltip="${t("main.expand_outline")}" data-i18n-data-tooltip="main.expand_outline">${icon('outline')}</button>
      <aside id="outlineDrawer" class="outline-drawer" aria-label="${t("main.document_outline")}" data-i18n-aria-label="main.document_outline">
        <div class="outline-resizer" role="separator" aria-label="${t("main.resize_outline")}" data-i18n-aria-label="main.resize_outline" aria-orientation="vertical" tabindex="0" title="${t("main.drag_to_resize_double_click_to_reset")}" data-i18n-title="main.drag_to_resize_double_click_to_reset"></div>
        <div class="drawer-header"><strong>${h("main.outline")}</strong><button data-close="outline" class="icon-control" aria-label="${t("main.collapse_outline")}" data-i18n-aria-label="main.collapse_outline" data-tooltip="${t("main.collapse_outline")}" data-i18n-data-tooltip="main.collapse_outline" aria-controls="outlineDrawer" aria-expanded="true">${icon('outline')}</button></div>
        <div id="outlineList" class="outline-list"></div>
      </aside>
      <aside id="notesDrawer" class="notes-drawer" aria-label="${t("main.footnotes")}" data-i18n-aria-label="main.footnotes">
        <div class="notes-resizer" role="separator" aria-label="${t("main.resize_footnotes_panel")}" data-i18n-aria-label="main.resize_footnotes_panel" aria-orientation="vertical" tabindex="0" title="${t("main.drag_to_resize_double_click_to_reset")}" data-i18n-title="main.drag_to_resize_double_click_to_reset"></div>
        <div class="drawer-header"><strong>${h("main.footnotes")}<span id="notesCount" class="drawer-count"></span></strong><button data-close="notes" class="icon-control" aria-label="${t("main.collapse_footnotes")}" data-i18n-aria-label="main.collapse_footnotes" data-tooltip="${t("main.collapse_footnotes")}" data-i18n-data-tooltip="main.collapse_footnotes" aria-controls="notesDrawer" aria-expanded="true">${icon('notes')}</button></div>
        <div id="notesList" class="notes-list"></div>
      </aside>
      <button id="notesButton" class="sidebar-rail sidebar-rail-right" aria-label="${t("main.expand_footnotes")}" data-i18n-aria-label="main.expand_footnotes" aria-controls="notesDrawer" aria-expanded="false" aria-pressed="false" data-tooltip="${t("main.expand_footnotes")}" data-i18n-data-tooltip="main.expand_footnotes">${icon('notes')}</button>
    </section>

    <footer class="statusbar">
      <span class="cursor-and-save"><span id="cursorStatus">${h("main.line_1_column_1")}</span><span id="saveIndicator" role="status"></span></span>
      <span id="stats"></span>
      <button id="focusButton" class="status-button icon-control" aria-label="${t("main.focus_mode")}" data-i18n-aria-label="main.focus_mode" data-tooltip="${t("main.focus_mode_press_esc_to_exit")}" data-i18n-data-tooltip="main.focus_mode_press_esc_to_exit">${icon('focus', 15)}</button>
    </footer>

    <div id="dropOverlay" class="drop-overlay">${h("main.drop_to_open_a_markdown_file")}</div>

    <section id="appearancePopover" class="popover appearance-popover" role="dialog" aria-label="${t("main.settings_ui0078")}" data-i18n-aria-label="main.settings_ui0078" tabindex="-1" hidden>
      <div class="settings-heading"><h2>${h("main.settings_ui0078")}</h2><button id="settingsClose" aria-label="${t("main.close_settings")}" data-i18n-aria-label="main.close_settings">${icon('close')}</button></div>
      <div class="settings-tabs" role="tablist" aria-label="${t("main.settings_categories")}" data-i18n-aria-label="main.settings_categories">
        <button id="settingsTab-appearance" role="tab" data-settings-tab="appearance" aria-controls="settingsPanel-appearance">${h("main.appearance_typography")}</button>
        <button id="settingsTab-recovery" role="tab" data-settings-tab="recovery" aria-controls="settingsPanel-recovery">${h("main.saving_recovery")}</button>
      </div>
      <div class="appearance-scroll" tabindex="-1">
      <section id="settingsPanel-appearance" role="tabpanel" aria-labelledby="settingsTab-appearance" data-settings-panel="appearance">
      <fieldset class="appearance-group" aria-label="${t("main.theme")}" data-i18n-aria-label="main.theme">
      <label class="setting-row"><span>${h("main.theme")}</span>
        <span class="ui-select"><select id="themeSelect"><option value="system" data-i18n="main.system_default">${t("main.system_default")}</option><option value="light" data-i18n="main.light">${t("main.light")}</option><option value="dark" data-i18n="main.dark">${t("main.dark")}</option></select>${icon('chevron', 16)}</span>
      </label>
      </fieldset>
      <fieldset class="appearance-group" aria-label="${t("main.body_typography")}" data-i18n-aria-label="main.body_typography">
      <label class="setting-row"><span>${h("main.body_font")}</span>
        <span class="ui-select"><select id="fontFamilySelect"><option value="serif" data-i18n="main.serif">${t("main.serif")}</option><option value="sans" data-i18n="main.system_sans_serif">${t("main.system_sans_serif")}</option><option value="mono" data-i18n="main.monospace">${t("main.monospace")}</option></select>${icon('chevron', 16)}</span>
      </label>
      <label class="setting-slider"><span>${h("main.body_font_size")}</span><span class="slider-control"><input id="fontSizeInput" type="range" min="14" max="24" step="1" /><output id="fontSizeValue"></output></span></label>
      <label class="setting-slider"><span>${h("main.maximum_body_width")}</span><span class="slider-control"><input id="contentWidthInput" type="range" min="600" max="1100" step="20" /><output id="contentWidthValue"></output></span></label>
      </fieldset>
      </section>
      <section id="settingsPanel-recovery" role="tabpanel" aria-labelledby="settingsTab-recovery" data-settings-panel="recovery" hidden>
      ${desktop ? `<fieldset class="appearance-group" aria-label="${t("main.recovery_records")}" data-i18n-aria-label="main.recovery_records"><label class="setting-row"><span>${h("main.version_draft_retention")}</span><span class="ui-select"><select id="recoveryRetentionSelect" aria-label="${t("main.version_draft_retention")}" data-i18n-aria-label="main.version_draft_retention" disabled><option value="7" data-i18n="main.7_days">${t("main.7_days")}</option><option value="30" selected data-i18n="main.30_days">${t("main.30_days")}</option><option value="90" data-i18n="main.90_days">${t("main.90_days")}</option></select>${icon('chevron',16)}</span></label></fieldset>` : ''}
      <div class="settings-recovery-action"><button id="settingsRecovery" class="settings-action">${h(desktop ? "main.view_recoverable_drafts" : "main.restore_version_before_last_save")}</button></div>
      ${desktop ? '' : `<p class="setting-hint">${h("main.restoring_replaces_the_current_editor_content_and")}</p>`}
      </section>
      </div>
      <div class="appearance-scroll-hint" hidden aria-hidden="true">${h("main.scroll_down_for_more")}</div>
      <p class="settings-about"><strong id="settingsVersion">${h("main.leaf")}</strong><span id="settingsBuild" hidden></span></p>
    </section>

    <section id="languagePopover" class="popover action-popover" role="menu" aria-label="${t('UI0256')}" data-i18n-aria-label="settings.language" hidden>
      <button type="button" role="menuitemradio" data-language="system" aria-checked="false">${h('settings.system_default')}</button>
      <button type="button" role="menuitemradio" data-language="zh-Hans" aria-checked="false">简体中文</button>
      <button type="button" role="menuitemradio" data-language="zh-Hant-TW" aria-checked="false">繁體中文（台灣）</button>
      <button type="button" role="menuitemradio" data-language="en" aria-checked="false">English</button>
    </section>
    <section id="documentPopover" class="popover action-popover" role="menu" aria-label="${t("main.current_document_actions")}" data-i18n-aria-label="main.current_document_actions" hidden>
      ${desktop ? `<button id="documentReveal" role="menuitem">${h("main.show_in_file_manager")}</button><button id="documentRename" role="menuitem">${h("main.rename")}</button>` : ''}
      <button id="documentHistory" role="menuitem">${h(desktop ? "main.versions_drafts" : "main.restore_version_before_last_save_ui0107")}</button>
    </section>

    <section id="exportPopover" class="popover action-popover" role="menu" aria-label="${t("main.export_ui0108")}" data-i18n-aria-label="main.export_ui0108" hidden>
      <button id="exportButton" role="menuitem">${h("main.export_pdf")}<kbd>⌘E</kbd></button>
      <button id="exportBundleButton" role="menuitem" ${desktop ? '' : 'hidden'}>${h("main.export_document_attachments")}</button>
    </section>

    <section id="displayPopover" class="popover action-popover display-popover" role="dialog" aria-label="${t("main.display_ui0111")}" data-i18n-aria-label="main.display_ui0111" hidden>
      <div class="popover-title">${h("main.display_ui0111")}</div>
      <label class="setting-check"><input id="documentPropertiesToggle" type="checkbox" /><span>${h("main.document_properties")}</span></label>
      <label class="setting-check"><input id="fileNameTitleToggle" type="checkbox" /><span>${h("main.show_file_name_above_text")}</span></label>
      <label class="setting-check"><input id="lineNumberToggle" type="checkbox" /><span>${h("main.source_line_numbers")}</span></label>
      <label class="setting-check"><input id="blankMarkerToggle" type="checkbox" /><span class="setting-label">${h("main.formatting_marks")}<small class="setting-inline-hint">${h("main.paragraph_end_line_break")}</small></span></label>
      <label class="setting-check"><input id="headingNumberSetting" type="checkbox" /><span class="setting-label">${h("main.multilevel_heading_numbering")}<small class="setting-inline-hint">${h("main.display_only_original_text_unchanged")}</small></span></label>
      <p id="markerModeHint" class="setting-hint"></p>
      <button id="markerEditMode" class="settings-action" hidden>${h("main.switch_to_edit_mode_to_view_formatting")}</button>
    </section>

    <section id="recentPopover" class="popover recent-popover" hidden>
      <div class="popover-title">${h("main.open_recent_ui0120")}</div>
      <div id="recentList" class="recent-list"><span class="empty-hint">${h("main.no_recent_files")}</span></div>
    </section>

    <section id="headingPopover" class="popover heading-popover" hidden>
      <div class="heading-grid">
        <button data-format="heading0" aria-label="${t("main.body_text")}" data-i18n-aria-label="main.body_text" data-tooltip="${t("main.set_to_body_text_0")}" data-i18n-data-tooltip="main.set_to_body_text_0">¶</button>
        <button data-format="heading1" aria-label="${t("main.heading_1")}" data-i18n-aria-label="main.heading_1" data-tooltip="${t("main.heading_1_1")}" data-i18n-data-tooltip="main.heading_1_1">H1</button>
        <button data-format="heading2" aria-label="${t("main.heading_2")}" data-i18n-aria-label="main.heading_2" data-tooltip="${t("main.heading_2_2")}" data-i18n-data-tooltip="main.heading_2_2">H2</button>
        <button data-format="heading3" aria-label="${t("main.heading_3")}" data-i18n-aria-label="main.heading_3" data-tooltip="${t("main.heading_3_3")}" data-i18n-data-tooltip="main.heading_3_3">H3</button>
        <button data-format="heading4" aria-label="${t("main.heading_4")}" data-i18n-aria-label="main.heading_4" data-tooltip="${t("main.heading_4_4")}" data-i18n-data-tooltip="main.heading_4_4">H4</button>
        <button data-format="heading5" aria-label="${t("main.heading_5")}" data-i18n-aria-label="main.heading_5" data-tooltip="${t("main.heading_5_5")}" data-i18n-data-tooltip="main.heading_5_5">H5</button>
        <button data-format="heading6" aria-label="${t("main.heading_6")}" data-i18n-aria-label="main.heading_6" data-tooltip="${t("main.heading_6_6")}" data-i18n-data-tooltip="main.heading_6_6">H6</button>
      </div>
    </section>

    <div id="palette" class="modal-backdrop" hidden>
      <section class="command-palette" role="dialog" aria-modal="true" aria-label="${t("main.command_palette_ui0136")}" data-i18n-aria-label="main.command_palette_ui0136">
        <input id="paletteInput" type="search" placeholder="${t("main.search_commands")}" data-i18n-placeholder="main.search_commands" aria-label="${t("main.search_commands_ui0138")}" data-i18n-aria-label="main.search_commands_ui0138" role="combobox" aria-autocomplete="list" aria-controls="paletteList" aria-expanded="false" autocomplete="off" />
        <div id="paletteList" class="palette-list" role="listbox" aria-label="${t("main.command_results")}" data-i18n-aria-label="main.command_results"></div>
        <div id="paletteEmpty" class="palette-empty" role="status" hidden>${h("main.no_matching_commands_try_another_keyword")}</div>
        <div class="palette-help">${h("main.select_enter_run_esc_close")}</div>
      </section>
    </div>
    <div id="tooltip" class="ui-tooltip" role="tooltip" hidden></div>
    <section id="calloutPopover" class="popover callout-popover" role="dialog" aria-label="${t("main.callout_type")}" data-i18n-aria-label="main.callout_type" hidden>
      <div class="popover-title">${h("main.insert_callout")}</div>
      <div class="callout-types">${Object.entries(calloutLabels).map(([key,label])=>`<button data-format="callout-${key}">${calloutBadge(key)}<span data-callout-label="${key}">${label}</span></button>`).join('')}</div>
    </section>
  </main>
`);

const shell = document.querySelector('.shell');
const fileNameElement = document.querySelector('#fileName');
const dirtyElement = document.querySelector('#dirty');
const statsElement = document.querySelector('#stats');
const cursorStatus = document.querySelector('#cursorStatus');
const outlineDrawer = document.querySelector('#outlineDrawer');

const outlineList = document.querySelector('#outlineList');

// The version line in 设置 comes from the constants vite.config.js injects at
// build time. Any context that never went through vite -- a unit test importing
// this module directly, or a build outside a git checkout -- leaves them
// undefined, which the typeof guards absorb.
const leafVersion = typeof __LEAF_VERSION__ === 'string' ? __LEAF_VERSION__ : '';
const leafBuild = typeof __LEAF_BUILD__ === 'string' ? __LEAF_BUILD__ : '';
document.querySelector('#settingsVersion').textContent = `${leafName} ${leafVersion}`.trim();
const settingsBuild = document.querySelector('#settingsBuild');
setText(settingsBuild, () => leafBuild ? t("main.build", {"build": leafBuild}) : '');
settingsBuild.hidden = !leafBuild;
const appearancePopover = document.querySelector('#appearancePopover');
const recentPopover = document.querySelector('#recentPopover');
const headingPopover = document.querySelector('#headingPopover');
const calloutPopover = document.querySelector('#calloutPopover');
const documentPopover = document.querySelector('#documentPopover');
const exportPopover = document.querySelector('#exportPopover');
const languagePopover = document.querySelector('#languagePopover');
const displayPopover = document.querySelector('#displayPopover');
const displayButton = document.querySelector('#displayButton');
const palette = document.querySelector('#palette');
const paletteInput = document.querySelector('#paletteInput');
const paletteList = document.querySelector('#paletteList');
const dropOverlay = document.querySelector('#dropOverlay');
const tooltip = document.querySelector('#tooltip');
const welcomeScreen = document.querySelector('#welcomeScreen');

const statusNotices = setupStatusNotices({
  container: document.querySelector('#statusNotice'),
  text: document.querySelector('#saveStatus'),
  recovery: document.querySelector('#recoveryNotice'),
  actions: document.querySelector('#statusActions'),
  dismiss: document.querySelector('#dismissStatus'),
  announcement: document.querySelector('#statusAnnouncement'),
  saveIndicator: document.querySelector('#saveIndicator'),
  format: shortcutText,
});
const setStatus = statusNotices.show;
const showSaveNotice = text => setStatus(text, 'saved', { announce: false });

function renameCurrentDocument(){
  if(shell.classList.contains('welcome-state')||document.querySelector('.inline-rename'))return;
  const extension=state.fileName.match(/\.(md|markdown|mdown)$/i)?.[0]||'.md';
  const stem=state.fileName.endsWith(extension)?state.fileName.slice(0,-extension.length):state.fileName;
  const anchor=(state.reading?reader.querySelector('.leaf-file-name-title'):document.querySelector('.leaf-default-title h1'))
    || document.querySelector('#documentMenuButton');
  inlineRename({anchor,value:stem,apply:async name=>{
    if(!desktop)throw new Error(t("main.to_rename_the_file_on_disk_use"));
    await desktopRename(name+extension);
    if(state.reading)renderReading();
  }});
}
document.addEventListener('leaf-rename-document',renameCurrentDocument);


function updateDocumentChrome() {
  const changed = state.content !== state.savedContent;
  fileNameElement.textContent = state.fileName;
  dirtyElement.textContent = changed ? '●' : '';
  dirtyElement.hidden = !changed;
  document.title = shell.classList.contains('welcome-state')
    ? t('main.app_title', { app: leafName })
    : `${changed ? '• ' : ''}${state.fileName} — ${leafName}`;
  setText(statsElement, () => `${t('main.characters', { count: state.content.length })} · ${t('main.words', { count: state.content.split(/\s+/).filter(Boolean).length })}`);
  desktopTitle(document.title);
  editor.setFileName(state.fileName);
}

function currentTheme() {
  if (state.theme !== 'system') return state.theme;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function updateAppearance() {
  document.documentElement.dataset.theme = currentTheme();
  shell.dataset.font = state.fontFamily;
  shell.style.setProperty('--editor-font-size', `${state.fontSize}px`);
  shell.style.setProperty('--content-width', `${state.contentWidth}px`);
  document.querySelector('#themeSelect').value = state.theme;
  document.querySelector('#fontFamilySelect').value = state.fontFamily;
  document.querySelector('#fontSizeInput').value = state.fontSize;
  document.querySelector('#fontSizeValue').textContent = `${state.fontSize}px`;
  document.querySelector('#contentWidthInput').value = state.contentWidth;
  document.querySelector('#contentWidthValue').textContent = `${state.contentWidth}px`;
  document.querySelector('#fileNameTitleToggle').checked = state.showFileNameTitle;
  document.querySelector('#lineNumberToggle').checked = state.showLineNumbers;
}

function parseOutline(markdown) {
  const result = [];
  let fenced = false;
  markdown.split('\n').forEach((line, index) => {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    if (fenced) return;
    const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*$/);
    if (heading) result.push({ level: heading[1].length, text: heading[2], line: index + 1 });
  });
  return result;
}

const collapsedOutline = new Set();
let outlineCursorLine = 1;
let outlineFrame = 0;
function scheduleOutlineCurrent() {
  if (outlineFrame) return;
  outlineFrame = requestAnimationFrame(() => {
    outlineFrame = 0;
    let line = outlineCursorLine;
    if (state.reading) {
      line = 0;
      const top = readingPane.getBoundingClientRect().top + 40;
      for (const heading of reader.querySelectorAll('h1[data-source-line],h2[data-source-line],h3[data-source-line],h4[data-source-line],h5[data-source-line],h6[data-source-line]')) {
        if (heading.getClientRects().length && heading.getBoundingClientRect().top <= top) line = Number(heading.dataset.sourceLine);
      }
    }
    const current = state.outline.findLast(item => item.line <= line);
    for (const button of outlineList.querySelectorAll('.outline-item')) {
      if (Number(button.dataset.line) === current?.line) button.setAttribute('aria-current', 'location');
      else button.removeAttribute('aria-current');
      setAttr(button, 'title', () => t(state.reading ? 'UI0147' : 'UI0148', { heading: button.textContent }));
    }
  });
}
function renderOutline(markdown = state.content) {
  scheduleOutlineCurrent();
  const outline=parseOutline(markdown);
  // Cursor-only navigation must not replace the clicked button between the
  // first and second click of a double-click.
  if(outlineList.childElementCount && JSON.stringify(outline)===JSON.stringify(state.outline))return;
  state.outline = outline;
  outlineList.replaceChildren();
  if (!state.outline.length) {
    outlineList.innerHTML = `<span class="empty-hint">${h("main.no_headings_in_this_document")}</span>`;
    return;
  }
  const root = document.createElement('ul');
  root.className = 'outline-tree';
  outlineList.append(root);
  const stack = [{level: 0, children: root, key: '', counts: new Map()}];
  for (const [index, item] of state.outline.entries()) {
    while (stack.at(-1).level >= item.level) stack.pop();
    const parent = stack.at(-1);
    const identity = JSON.stringify([item.level, item.text]);
    const occurrence = parent.counts.get(identity) || 0;
    parent.counts.set(identity, occurrence + 1);
    const key = `${parent.key}/${identity}:${occurrence}`;
    const node = document.createElement('li');
    const row = document.createElement('div');
    row.className = 'outline-row';
    node.append(row);
    parent.children.append(node);
    const children = document.createElement('ul');
    children.className = 'outline-children';
    children.id = `outline-children-${index}`;
    const hasChildren = state.outline[index + 1]?.level > item.level;
    if (hasChildren) {
      const toggle = document.createElement('button');
      toggle.className = 'outline-disclosure';
      toggle.innerHTML = icon('chevron', 13);
      toggle.setAttribute('aria-controls', children.id);
      const update = () => {
        const open = !collapsedOutline.has(key);
        children.hidden = !open;
        toggle.setAttribute('aria-expanded', String(open));
        setAttr(toggle, 'aria-label', () => t(!collapsedOutline.has(key) ? 'UI0150' : 'UI0151', { heading: item.text }));
      };
      toggle.addEventListener('click', () => {
        if (collapsedOutline.has(key)) collapsedOutline.delete(key);
        else collapsedOutline.add(key);
        update();
      });
      update();
      row.append(toggle);
      node.append(children);
    } else {
      const spacer = document.createElement('span');
      spacer.className = 'outline-disclosure-spacer';
      spacer.setAttribute('aria-hidden', 'true');
      row.append(spacer);
    }
    stack.push({level: item.level, children, key, counts: new Map()});
    const button = document.createElement('button');
    button.className = 'outline-item';
    button.dataset.line = item.line;
    button.dataset.level = item.level;
    button.style.setProperty('--level', item.level);
    button.textContent = item.text;
    setAttr(button, 'title', () => t("main.click_to_jump_double_click_to_rename_ui0152"));
    button.addEventListener('click', () => {
      if(state.reading) reader.querySelector(`[data-source-line="${item.line}"]`)?.scrollIntoView({block:'start'});
      else editor.goToLine(item.line);
    });
    button.addEventListener('dblclick', () => {
      if(state.reading)return;
      const original=editor.view.state.doc.line(item.line).text;
      const input=document.createElement('input');
      input.className='outline-rename';input.value=item.text;
      setAttr(input, 'aria-label', () => t("main.rename_heading"));
      button.replaceWith(input);input.focus();input.select();
      let finished=false;
      const finish=save=>{
        if(finished)return;finished=true;
        if(save && input.value.trim()!==item.text && !editor.renameHeading(item.line,original,input.value))
          setStatus(translatedMessage("main.heading_is_empty_or_the_original_text"),'info');
        if(input.isConnected)input.replaceWith(button);
      };
      input.addEventListener('blur',()=>finish(true));
      input.addEventListener('keydown',event=>{
        if(event.isComposing)return;
        if(event.key==='Enter'||event.key==='Escape'){
          event.preventDefault();event.stopPropagation();finish(event.key==='Enter');
        }
      });
    });
    row.append(button);
  }
}

// ------------------------------------------------------------- notes panel

const notesDrawer = document.querySelector('#notesDrawer');
const notesList = document.querySelector('#notesList');
const notesButton = document.querySelector('#notesButton');
const outlineButton = document.querySelector('#outlineButton');
const resizeOutline = setupSidebarResize(outlineDrawer, {side: 'left', name: 'outline', defaultWidth: 280, other: notesDrawer});
const resizeNotes = setupSidebarResize(notesDrawer, {side: 'right', name: 'notes', defaultWidth: 300, other: outlineDrawer});
const refreshSidebarWidths = () => { resizeOutline(); resizeNotes(); };
window.addEventListener('resize', refreshSidebarWidths);
const narrowSidebar = window.matchMedia('(max-width: 1000px)');
narrowSidebar.addEventListener('change', () => {
  if (narrowSidebar.matches && outlineDrawer.classList.contains('visible') && notesDrawer.classList.contains('visible')) setOutlineDrawer(false);
  refreshSidebarWidths();
});
let measuredNotesWidth = 0;
new ResizeObserver(([entry]) => {
  if (!entry.contentRect.width || entry.contentRect.width === measuredNotesWidth) return;
  measuredNotesWidth = entry.contentRect.width;
  for (const body of notesDrawer.querySelectorAll('.note-body')) fitNoteBody(body);
}).observe(notesDrawer);

function setOutlineDrawer(open) {
  if (open && narrowSidebar.matches && notesDrawer.classList.contains('visible')) setNotesDrawer(false);
  outlineDrawer.classList.toggle('visible', open);
  outlineButton.hidden = open;
  outlineButton.setAttribute('aria-expanded', String(open));
  refreshSidebarWidths();
}

const notesCount = document.querySelector('#notesCount');

// The panel is a view of the document, never a second copy of it: every row is
// built from the same index the editor numbers its citations with, so the list
// and the page cannot disagree. The only thing kept between redraws is the
// signature of what is on screen.
function renderNotes() {
  const rows = notePanelRows(indexFootnotes(state.content));
  const signature = JSON.stringify([state.reading, state.source, rows]);
  if (signature === state.notesSignature) return;
  // A drawer that is closed has no width to lay a textarea out in, so a height
  // measured now would be fixed to the wrong width; the redraw waits for the next
  // open, where the signature is dropped and this runs again from scratch.
  // Rebuilding under the caret is worse: it would take the words out from under
  // the fingers -- and out of an unfinished pinyin run.
  if (!notesDrawer.classList.contains('visible')) return;
  if (notesList.contains(document.activeElement) && state.notesMode === (state.reading?'reading':state.source?'source':'edit')) {
    // Keep the focused textarea (including its IME state), but update every
    // card's identity and number before another card can be edited.
    for (const card of notesList.querySelectorAll('.note-card')) {
      const row = rows.find(row => row.label === card.dataset.label);
      if (!row) continue;
      Object.assign(card._noteRow, row);
      card.dataset.number = row.number ?? '';
      card.dataset.state = row.state;
      const number = card.querySelector('.note-number');
      number.textContent = row.number ?? `[${row.label}]`;
      setAttr(number, 'aria-label', () => t("main.jump_to_footnote", {"note": row.number ?? row.label}));
      const body = card.querySelector('.note-body');
      setAttr(body, 'aria-label', () => t("main.content_of_footnote", {"note": row.number ?? row.label}));
      syncNoteBody(card, row);
      if (row.state === 'complete') card.querySelector('.note-card-head')?.remove();
    }
    notesCount.textContent = rows.filter(row => row.number !== null).length || '';
    state.notesSignature = signature;
    return;
  }
  state.notesSignature = signature;

  // Which notes there are, as opposed to what they say. Writing a note in the
  // editor, or in the box under a fresh marker, arrives one keystroke at a time,
  // and rebuilding a row per keystroke would cost a textarea per note in the
  // document each time. Same notes, different words: patch the words.
  const skeleton = JSON.stringify([state.reading, state.source, rows.map(row => [row.label, row.number, row.state])]);
  if (skeleton === state.notesSkeleton) {
    for (const row of rows) {
      const body = notesList.querySelector(`.note-card[data-label="${CSS.escape(row.label)}"] .note-body`);
      if (body) syncNoteBody(body.closest('.note-card'), row);
    }
    return;
  }
  state.notesSkeleton = skeleton;

  const numbered = rows.filter(row => row.number !== null).length;
  notesCount.textContent = numbered ? `${numbered}` : '';
  for (const card of notesList.querySelectorAll('.note-card')) card._noteEditor?.destroy();
  state.notesMode = state.reading?'reading':state.source?'source':'edit';
  notesList.replaceChildren();
  if (!rows.length) {
    notesList.innerHTML = `<span class="empty-hint">${h("main.no_footnotes_in_this_document")}</span>`;
    return;
  }
  const measure = [];
  for (const row of rows) notesList.append(noteCard(row, measure));
  for (const fit of measure) fit();
}

function syncNoteBody(card, row) {
  Object.assign(card._noteRow, row);
  if (card._noteUpdating) return;
  if (card._noteEditor) card._noteEditor.sync(row.body);
  else renderPrintDocument(card.querySelector('.note-body'),row.body,{fallbackTitle:false,footnotes:{map:new Map(),link:false,seen:new Map()}});
}

function fitNoteBody(body) {
  if (!body.clientWidth) return;
  body.style.height = 'auto';
  body.style.height = `${body.scrollHeight}px`;
}

function noteCard(row, measure) {
  const card = document.createElement('div');
  card.className = 'note-card';
  card._noteRow = row;
  card.dataset.label = row.label;
  card.dataset.number = row.number === null ? '' : String(row.number);
  card.dataset.state = row.state;

  const head = document.createElement('div');
  head.className = 'note-card-head';
  const number = document.createElement('button');
  number.type = 'button';
  number.className = 'note-number';
  // A note that has no definition yet has no number either, so the row is named
  // by the label as it is written in the file.
  number.textContent = row.number === null ? `[${row.label}]` : String(row.number);
  setAttr(number, 'title', () => t("main.jump_to_footnote_marker_in_body"));
  setAttr(number, 'aria-label', () => t("main.jump_to_footnote", {"note": row.number ?? row.label}));
  number.addEventListener('click', () => gotoNote(row));
  if (row.state === 'unreferenced') head.append(statusNote(t("main.footnote_marker_no_longer_in_body")));
  if (row.state === 'undefined') {
    const hint = statusNote(t("main.missing_footnote_definition"));
    setAttr(hint, 'title', () => t("main.no_definition_found_for_footnote_check_for", {"label": row.label}));
    head.append(hint);
  }

  const body = document.createElement('div');
  body.className = 'note-body';
  if (state.reading) {
    body.classList.add('note-reading');
    renderPrintDocument(body, row.body, {fallbackTitle:false, footnotes:{map:new Map(),link:false,seen:new Map()}});
  } else {
    card._noteEditor = createLeafNoteEditor({parent:body,doc:row.body,source:state.source,
      label:t('main.content_of_footnote',{note:row.number??row.label}),
      onChange: value => {
        card._noteUpdating=true;
        try { editor.setFootnoteBody(card._noteRow.label,value); }
        finally { card._noteUpdating=false; }
      },
      onUndo:()=>editor.undo(),onRedo:()=>editor.redo(),onLeave:()=>editor.focus()});
  }
  if(card._noteEditor) setAttr(card._noteEditor.view.contentDOM,'aria-label',()=>t('main.content_of_footnote',{note:card._noteRow.number??card._noteRow.label}));
  // A source-value accessor keeps diagnostics independent of rendering.
  Object.defineProperty(body,'value',{get:()=>card._noteEditor?.value()??card._noteRow.body});

  // The number goes beside the text, so a row reads the way its definition does
  // in the file instead of stacking the two as separate blocks.
  const main = document.createElement('div');
  main.className = 'note-card-main';
  main.append(body);
  // The head carries only what the file says and how the note is doing. A plain
  // note has neither, and an empty row would push the text away from its number.
  // It sits under the text so the number always lines up with the first line.
  if (head.childElementCount) main.append(head);
  card.append(number, main);
  if (!state.reading) {
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'note-delete';
    remove.innerHTML = uiIcon('trash', 15);
    setAttr(remove, 'aria-label', () => t("main.delete_footnote"));
    setAttr(remove, 'title', () => t("main.delete_this_footnote_and_all_its_references"));
    remove.addEventListener('mousedown', event => event.preventDefault());
    remove.addEventListener('click', () => editor.deleteFootnote(card._noteRow.label));
    card.append(remove);
  }
  return card;
}

function statusNote(text) {
  const span = document.createElement('span');
  span.className = 'note-hint';
  span.textContent = text;
  return span;
}

// A note is reached from either side: the number on a row puts its citation back
// in front of the reader, and a click on a citation in the text brings the panel
// up with that note in it.
function gotoNote(row) {
  if (!state.reading) return editor.goToNote(row.label);
  if (row.number === null) return;
  reader.querySelector(`#fn-${row.number}`)?.scrollIntoView({ block: 'start' });
}

function setNotesDrawer(open) {
  if (open && narrowSidebar.matches && outlineDrawer.classList.contains('visible')) setOutlineDrawer(false);
  notesButton.hidden = open;
  notesButton.setAttribute('aria-expanded', String(open));
  notesDrawer.classList.toggle('visible', open);
  notesButton.setAttribute('aria-pressed', String(open));
  refreshSidebarWidths();
  // A closed panel keeps nothing: the next open reads the document again, so the
  // rows left over from an earlier document can never be shown.
  if (!open) { state.notesSignature = ''; state.notesSkeleton = ''; return; }
  renderNotes();
}

function toggleNotesDrawer() {
  setNotesDrawer(!notesDrawer.classList.contains('visible'));
}

function revealNote(label) {
  setNotesDrawer(true);
  const card = notesList.querySelector(`.note-card[data-label="${CSS.escape(label)}"]`);
  if (!card) return;
  markActiveNote(card);
  card.scrollIntoView({ block: 'nearest' });
  card._noteEditor?.focus();
}

function markActiveNote(card) {
  for (const other of notesList.querySelectorAll('.note-card.active')) other.classList.remove('active');
  card.classList.add('active');
}

// A keystroke in a note leaves the caret in the panel, so the redraw waits for
// the blur rather than stealing the words mid-word.
notesList.addEventListener('focusout', () => {
  state.notesSignature = '';
  requestAnimationFrame(renderNotes);
});

function scheduleSave() {
  clearTimeout(state.saveTimer);
  if (desktop) {
    desktopEdited();
    if (desktopRecoveryPaused()) { setStatus(translatedMessage("main.autosave_paused_after_recovery_review_and_save"), 'manual'); return; }
    if (desktopHasPath()) {
      setStatus(translatedMessage("main.waiting_to_autosave"), 'pending');
      state.saveTimer = setTimeout(() => desktopSave(false, false), 800);
    } else setStatus(translatedMessage("main.press_s_to_choose_where_to_save"), 'manual');
    return;
  }
  if (!state.fileHandle) {
    setStatus(translatedMessage("main.press_s_to_choose_where_to_save"), 'manual');
    return;
  }
  if (state.conflict) {
    setStatus(translatedMessage("main.file_changed_externally_autosave_paused_save_as"), 'error');
    return;
  }
  setStatus(translatedMessage("main.waiting_to_autosave"), 'pending');
  state.saveTimer = setTimeout(() => saveToHandle(true), 800);
}

const undoButton = document.querySelector('#undoButton');
const redoButton = document.querySelector('#redoButton');

function updateHeadingControl(level) {
  const button = document.querySelector('#headingButton');
  const label = level === null ? t("main.mixed_levels") : level === 0 ? t("main.body_text_ui0170") : t(['UI0122','UI0124','UI0126','UI0128','UI0130','UI0132','UI0134'][level]);
  button.querySelector('span').textContent = level === null ? 'H' : level === 0 ? '¶' : `H${level}`;
  setAttr(button, 'aria-label', () => t("main.heading_level_ui0172", {"label": label}));
  setAttr(button, 'data-tooltip', () => shortcutText(t("main.heading_level_1_6_body_text_0_ui0173", {"label": label})));
  for (const item of document.querySelectorAll('.heading-grid button')) {
    item.setAttribute('aria-pressed', String(level !== null && Number(item.dataset.format.at(-1)) === level));
  }
}

const editor = createLeafEditor({
  parent: document.querySelector('#editor'),
  doc: welcome,
  showLineNumbers: state.showLineNumbers,
  showBlankMarkers: state.showBlankMarkers,
  showFileNameTitle: state.showFileNameTitle,
  showHeadingNumbers: state.showHeadingNumbers,
  onChange(content, labels) {
    for (const card of notesList.querySelectorAll('.note-card')) {
      const label = labels?.get(card.dataset.label);
      if (label !== undefined) { card.dataset.label = label; card._noteRow.label = label; }
    }
    state.content = content;
    updateDocumentChrome();
    updateHistoryControls();
    renderNotes();
    scheduleSave();
  },
  onCursor(position) {
    outlineCursorLine = position.line;
    scheduleOutlineCurrent();
    setText(cursorStatus, () => t("main.line_column", {"line": position.line, "column": position.column}));
    updateHeadingControl(position.headingLevel);
  },
  onOutlineChange: renderOutline,
  onNoteActivate: revealNote,
  onSave: () => saveFile(),
  onExport: exportPdf,
  onSaveAs: () => desktop ? desktopSave(true) : saveFile(),
  onOpen: () => openFile(),
  onCommandPalette: () => openPalette(),
});

updateHeadingControl(editor.headingLevel());

const writing = setupWriting({ editor, desktop, invoke, icon, status: setStatus,
  choose: chooseAttachments, save: () => desktopHasPath() ? Promise.resolve(true) : desktopSave(),
  serialized: desktopRun,
  editable: () => !shell.classList.contains('welcome-state') && !state.reading,

});
document.addEventListener('leaf-heading-link', event => {
  if (state.reading) reader.querySelector(`[data-source-line="${event.detail}"]`)?.scrollIntoView({block:'start'});
  else editor.goToLine(event.detail);
});
setAttr(document.querySelector('[data-format="highlight"]'), 'data-tooltip', () => shortcutText(`${t('main.highlight')}  ⌘=`));
setAttr(document.querySelector('[data-format="code"]'), 'data-tooltip', () => shortcutText(`${t('main.inline_code')}  ⌘⌥C`));

// History lives in the editor state, so ask the editor rather than track edits
// separately: opening a file, undoing back to the start and redoing all move
// what is available. Both buttons are disabled on an empty history instead of
// offering an action that would do nothing.
function updateHistoryControls() {
  const depth = editor.historyDepth();
  undoButton.disabled = depth.undo === 0;
  redoButton.disabled = depth.redo === 0;
}

const readingPane = document.querySelector('#readingPane');
const reader = readingPane.querySelector('article');
reader.addEventListener('dblclick',event=>{if(event.target.closest('.leaf-file-name-title'))renameCurrentDocument();});
reader.addEventListener('keydown',event=>{if(event.target.matches('.leaf-file-name-title')&&['Enter',' '].includes(event.key)){event.preventDefault();renameCurrentDocument();}});
readingPane.addEventListener('scroll', scheduleOutlineCurrent, {passive: true});
readingPane.addEventListener('click', scheduleOutlineCurrent);
new ResizeObserver(scheduleOutlineCurrent).observe(readingPane);
new ResizeObserver(scheduleOutlineCurrent).observe(reader);
function renderReading() {
  scheduleOutlineCurrent();
  renderPrintDocument(reader,state.content,{name:state.fileName,numbered:state.showHeadingNumbers,properties:true,expandCallouts:false,fallbackTitle:false,fileNameTitle:state.showFileNameTitle,sourcePositions:true});
  const title=reader.querySelector('.leaf-file-name-title');if(title){title.tabIndex=0;setAttr(title, 'title', () => t("main.double_click_to_rename_the_file"));setAttr(title, 'aria-label', () => t("main.double_click_or_press_enter_to_rename", {"fileName": state.fileName}));}
  for (const table of reader.querySelectorAll('table')) {
    const wrap = document.createElement('div'); wrap.className = 'reading-table-scroll';
    wrap.tabIndex = 0; wrap.setAttribute('role', 'region'); setAttr(wrap, 'aria-label', () => t("main.horizontally_scrollable_table"));
    table.before(wrap); wrap.append(table);
  }
  for (const pre of reader.querySelectorAll('pre[data-language]')) {
    const label = document.createElement('span'); label.className = 'reading-code-label'; label.textContent = pre.dataset.language;
    pre.prepend(label);
  }
  readingFolding(reader);
}
function toggleReading() {
  scheduleOutlineCurrent();
  if(shell.classList.contains('welcome-state'))return;
  closePopovers();
  state.reading=!state.reading;
  editor.setReading(state.reading);
  shell.classList.toggle('reading-mode',state.reading);
  readingPane.hidden=!state.reading;
  state.source=false; editor.setSource(false);
  updateModeControl();
  if(state.reading){
    renderReading();readingPane.focus();
    const line=editor.view.state.doc.lineAt(editor.view.state.selection.main.head).number;
    const heading=[...reader.querySelectorAll('[data-source-line]')].reverse().find(el=>Number(el.dataset.sourceLine)<=line);
    if(heading)heading.scrollIntoView({block:'start'});
  }
  else editor.focus();
  // The panel stops offering an edit in the reading view, and goes back to
  // offering one here, so it is redrawn with the mode.
  renderNotes();
}
const modePopover=document.createElement('section');
modePopover.className='popover mode-popover';modePopover.hidden=true;modePopover.setAttribute('role','menu');setAttr(modePopover, 'aria-label', () => t("main.view_mode"));
const modes=[['edit','main.edit','edit'],['reading','main.read','read'],['source','main.source','code']];
for(const [mode,label,glyph] of modes){
 const button=document.createElement('button');button.type='button';button.dataset.mode=mode;button.setAttribute('role','menuitemradio');button.innerHTML=icon(glyph)+`<span>${h(label)}</span>`;
 button.onclick=()=>setMode(mode);modePopover.append(button);
}
document.body.append(modePopover);
function updateModeControl(){
 const mode=state.reading?'reading':state.source?'source':'edit';
 const [,label,glyph]=modes.find(m=>m[0]===mode),button=document.querySelector('#readingToggle');
 button.innerHTML=icon(glyph)+`<span>${h(label)}</span>`;setAttr(button, 'aria-label', () => t("main.view_mode_ui0182", {"label": t(label)}));button.removeAttribute('aria-pressed');button.setAttribute('aria-haspopup','menu');button.setAttribute('aria-expanded',String(!modePopover.hidden));setAttr(button, 'data-tooltip', () => shortcutText(t("main.choose_edit_source_or_reading_mode_r")));
 for(const item of modePopover.children)item.setAttribute('aria-checked',String(item.dataset.mode===mode));
}
function readingBlocks() {
  return [...reader.querySelectorAll('[data-source-from][data-source-to]')].map(element => ({
    element,
    from: Number(element.dataset.sourceFrom),
    to: Number(element.dataset.sourceTo),
    rect: element.getBoundingClientRect(),
  })).filter(block => block.rect.height > 0);
}
function visibleReadingPosition() {
  const pane = readingPane.getBoundingClientRect();
  const y = pane.top + Math.min(40, pane.height / 4);
  const blocks = readingBlocks();
  const crossing = blocks.filter(block => block.rect.top <= y && block.rect.bottom >= y);
  const block = crossing.sort((a, b) => (a.to - a.from) - (b.to - b.from))[0]
    ?? blocks.find(candidate => candidate.rect.top > y)
    ?? blocks.at(-1);
  if (!block) return 0;
  const fraction = Math.max(0, Math.min(1, (y - block.rect.top) / block.rect.height));
  return Math.round(block.from + fraction * (block.to - block.from));
}
function revealReadingPosition(position) {
  const blocks = readingBlocks();
  const distance = block => position < block.from ? block.from - position : position > block.to ? position - block.to : 0;
  const block = blocks.sort((a, b) => distance(a) - distance(b) || (a.to - a.from) - (b.to - b.from))[0];
  if (!block) return;
  const fraction = Math.max(0, Math.min(1, (position - block.from) / Math.max(1, block.to - block.from)));
  const pane = readingPane.getBoundingClientRect();
  readingPane.scrollTop += block.rect.top + fraction * block.rect.height - pane.top - Math.min(40, pane.height / 4);
}
function cycleMode(){
 if(shell.classList.contains('welcome-state'))return;
 setMode(state.reading?'source':state.source?'edit':'reading');
}
function setMode(mode){
 const current=state.reading?'reading':state.source?'source':'edit';
 if(mode===current){closePopovers();updateModeControl();return;}
 const position=state.reading?visibleReadingPosition():editor.visiblePosition();
 if(state.reading!==(mode==='reading'))toggleReading();
 state.source=mode==='source';editor.setSource(state.source);closePopovers();updateModeControl();renderNotes();
 if(!state.reading)editor.focus();
 if(state.reading)revealReadingPosition(position);else editor.revealPosition(position);
}
document.querySelector('#readingToggle').addEventListener('click',()=>{
 if(shell.classList.contains('welcome-state'))return;
 const opening=modePopover.hidden;closePopovers();modePopover.hidden=!opening;updateModeControl();
 if(opening){const box=document.querySelector('#readingToggle').getBoundingClientRect();positionMenu(modePopover,box);modePopover.querySelector('[aria-checked="true"]').focus();}
});
modePopover.addEventListener('keydown',e=>{
 const items=[...modePopover.children],i=items.indexOf(document.activeElement);
 if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();items[(i+(e.key==='ArrowDown'?1:2))%3].focus();}
 if(e.key==='Escape'){e.preventDefault();closePopovers();document.querySelector('#readingToggle').focus();}
});
updateModeControl();
function openDocumentProperties(){
  if(shell.classList.contains('welcome-state'))return;
  if(!frontmatter(state.content)) {
    if(state.reading)toggleReading();
    editor.createProperties();
    return;
  }
  if(state.reading){
    readingPane.scrollTop=0;
    reader.querySelector('.print-properties')?.scrollIntoView({block:'start'});
    readingPane.focus();
  } else editor.revealProperties();
}
function openDocumentSearch() {
  if(state.reading)toggleReading();
  editor.openSearch();
}
window.addEventListener('keydown',event=>{
  const mac=/mac|iphone|ipad|ipod/i.test(navigator.userAgentData?.platform||navigator.platform);
  const modifier=mac?event.metaKey&&!event.ctrlKey:event.ctrlKey&&!event.metaKey;
  if(event.isComposing||!modifier||event.altKey||event.shiftKey)return;
  const key=event.code||`Key${event.key.toUpperCase()}`;
  if(key!=='KeyE'&&key!=='KeyR')return;
  event.preventDefault();event.stopImmediatePropagation();
  if(event.repeat)return;
  if(key==='KeyE')void exportPdf();else cycleMode();
},true);

function snapshotKey() {
  return `leaf-snapshots:${state.fileName}`;
}

function saveSnapshot(content) {
  if (!content || content === state.content) return;
  try {
    const snapshots = JSON.parse(localStorage.getItem(snapshotKey()) || '[]');
    snapshots.unshift({ content, timestamp: Date.now() });
    localStorage.setItem(snapshotKey(), JSON.stringify(snapshots.slice(0, 8)));
  } catch {
    // Storage quota errors must never block the actual file save.
  }
}

function latestSnapshot() {
  try {
    return JSON.parse(localStorage.getItem(snapshotKey()) || '[]')[0] || null;
  } catch {
    return null;
  }
}

async function rememberFile(handle) {
  if (!handle || !('indexedDB' in window)) return;
  try {
    const db = await openDatabase();
    const tx = db.transaction('recent', 'readwrite');
    tx.objectStore('recent').put({ name: handle.name, handle, openedAt: Date.now() });
    await transactionDone(tx);
    await renderRecentFiles();
  } catch {
    // Some browsers cannot persist file handles; opening still works normally.
  }
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('leaf', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('recent', { keyPath: 'name' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

async function readRecentFiles() {
  if (desktop) {
    try { return await invoke('recent_list'); } catch { return []; }
  }
  if (!('indexedDB' in window)) return [];
  const db = await openDatabase();
  const tx = db.transaction('recent', 'readonly');
  const request = tx.objectStore('recent').getAll();
  const files = await new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return files.sort((a, b) => b.openedAt - a.openedAt).slice(0, 8);
}

let recentOpenError = '';
async function renderRecentFiles() {
  const list = document.querySelector('#recentList');
  list.replaceChildren();
  let files = [];
  try { files = await readRecentFiles(); } catch { /* ignored */ }
  if (!files.length) {
    list.innerHTML = `<span class="empty-hint">${h("main.no_recent_files_ui0184")}</span>`;
    return;
  }
  for (const item of files) {
    const button = document.createElement('button');
    const name = document.createElement('span');
    name.className = 'recent-file-name';
    name.textContent = item.name;
    button.append(name);
    if (typeof item.path === 'string' && item.path) {
      const separator = Math.max(item.path.lastIndexOf('/'), item.path.lastIndexOf('\\'));
      if (separator >= 0) {
        const directory = document.createElement('span');
        directory.className = 'recent-file-directory';
        const root = separator === 0 || separator === 2 && item.path[1] === ':';
        directory.textContent = item.path.slice(0, separator + (root ? 1 : 0));
        directory.title = directory.textContent;
        button.append(directory);
      }
      button.title = item.path;
    }
    button.addEventListener('click', async () => {
      if(desktop){
        try {
          await invoke('recent_open',{path:item.path});
          recentPopover.hidden=true;
          statusNotices.clear(recentOpenError);
          recentOpenError = '';
        }
        catch (reason) {
          recentOpenError = t("main.could_not_open_recent_file_it_may", {"reason": reason});
          setStatus(recentOpenError, 'error');
        }
        return;
      }
      const permission = await item.handle.queryPermission({ mode: 'readwrite' });
      if (permission !== 'granted' && await item.handle.requestPermission({ mode: 'readwrite' }) !== 'granted') return;
      await loadHandle(item.handle);
      recentPopover.hidden = true;
    });
    list.append(button);
  }
  if (desktop) {
    const clear = document.createElement('button');
    setText(clear, () => t("main.clear_unavailable_entries"));
    clear.addEventListener('click', async () => {
      try {
        await invoke('recent_clear_missing');
        await renderRecentFiles();
        statusNotices.clear(recentOpenError);
        recentOpenError = '';
      }
      catch (error) { setStatus(translatedMessage("main.could_not_clear_unavailable_recent_entries", {"error": error}), 'error'); }
    });
    list.append(clear);
  }
}

async function setDocument(content, name, handle = null, file = null) {
  setMovedMissingImages();
  statusNotices.reset();
  collapsedOutline.clear();
  state.outline = [];
  outlineList.replaceChildren();
  clearTimeout(state.saveTimer);
  state.fileHandle = handle;
  state.fileName = name;
  state.content = content;
  state.savedContent = content;
  state.diskContent = content;
  state.conflict = false;
  state.lastModified = file?.lastModified || 0;
  shell.classList.remove('welcome-state', 'document-loading');
  welcomeScreen.hidden = true;
  editor.setValue(content);
  updateHistoryControls();
  if(state.reading)renderReading();
  updateDocumentChrome();
  renderOutline(content);
  renderNotes();
  const hasSaveLocation = desktop ? desktopHasPath() : !!handle;
  if (hasSaveLocation) showSaveNotice(translatedMessage("main.autosave_enabled"));
  else setStatus(translatedMessage("main.press_s_to_choose_where_to_save"), 'manual');
  if(state.reading)readingPane.focus(); else editor.focus();
  if (handle) await rememberFile(handle);
}

async function loadHandle(handle) {
  const file = await handle.getFile();
  await setDocument(await file.text(), file.name, handle, file);
}

async function openFile() {
  if (desktop) return desktopOpen().catch(error => setStatus(translatedMessage("main.could_not_open_file", {"error": error}), 'error'));
  if ('showOpenFilePicker' in window) {
    try {
      const [handle] = await window.showOpenFilePicker({
        types: [{ description: 'Markdown', accept: { 'text/markdown': ['.md', '.markdown', '.mdown'] } }],
        multiple: false,
      });
      await loadHandle(handle);
    } catch (error) {
      if (error.name !== 'AbortError') setStatus(translatedMessage("main.could_not_open_file", {"error": error.message}), 'error');
    }
    return;
  }
  const input = Object.assign(document.createElement('input'), {
    type: 'file', accept: '.md,.markdown,.mdown,text/markdown,text/plain',
  });
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (file) await setDocument(await file.text(), file.name, null, file);
  });
  input.click();
}

async function hasExternalConflict() {
  if (!state.fileHandle || !state.lastModified) return false;
  const file = await state.fileHandle.getFile();
  if (file.lastModified === state.lastModified) return false;
  const diskNow = await file.text();
  if (diskNow === state.diskContent || diskNow === state.content) {
    state.lastModified = file.lastModified;
    return false;
  }
  state.conflict = true;
  return true;
}

async function saveToHandle(isAutoSave = false, force = false) {
  if (!state.fileHandle || state.saving) return false;
  state.saving = true;
  try {
    if (!force && await hasExternalConflict()) {
      if (isAutoSave) {
        setStatus(translatedMessage("main.file_changed_externally_autosave_paused_save_as"), 'error');
        return false;
      }
      if (!window.confirm(t("main.another_app_has_modified_this_file_saving"))) {
        setStatus(translatedMessage("main.external_changes_not_overwritten"), 'error');
        return false;
      }
    }
    setStatus(translatedMessage("main.saving"), 'pending');
    saveSnapshot(state.diskContent);
    const writable = await state.fileHandle.createWritable();
    await writable.write(state.content);
    await writable.close();
    const file = await state.fileHandle.getFile();
    state.diskContent = state.content;
    state.savedContent = state.content;
    state.lastModified = file.lastModified;
    state.conflict = false;
    updateDocumentChrome();
    setStatus(translatedMessage(isAutoSave ? "main.autosaved" : "main.saved"), 'saved');
    return true;
  } catch (error) {
    setStatus(translatedMessage("main.your_changes_have_not_been_saved_try", {"error": error.message}), 'error');
    return false;
  } finally {
    state.saving = false;
  }
}

async function saveFile() {
  clearTimeout(state.saveTimer);
  if (desktop) return desktopSave();
  if (state.fileHandle) {
    await saveToHandle(false);
    return;
  }
  if ('showSaveFilePicker' in window) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: state.fileName,
        types: [{ description: 'Markdown', accept: { 'text/markdown': ['.md'] } }],
      });
      state.fileHandle = handle;
      state.fileName = handle.name;
      state.lastModified = 0;
      await saveToHandle(false, true);
      await rememberFile(handle);
    } catch (error) {
      if (error.name !== 'AbortError') setStatus(translatedMessage("main.your_changes_have_not_been_saved_try", {"error": error.message}), 'error');
    }
    return;
  }
  const url = URL.createObjectURL(new Blob([state.content], { type: 'text/markdown' }));
  const link = Object.assign(document.createElement('a'), { href: url, download: state.fileName });
  link.click();
  URL.revokeObjectURL(url);
  state.savedContent = state.content;
  updateDocumentChrome();
  setStatus(translatedMessage("main.document_copy_downloaded"), 'saved');
}

async function checkExternalChanges() {
  if (!state.fileHandle || state.saving) return;
  try {
    const file = await state.fileHandle.getFile();
    if (!state.lastModified || file.lastModified === state.lastModified) return;
    const content = await file.text();
    if (content === state.diskContent) {
      state.lastModified = file.lastModified;
      return;
    }
    if (state.content === state.savedContent) {
      await setDocument(content, file.name, state.fileHandle, file);
      setStatus(translatedMessage("main.external_changes_loaded"), 'saved');
    } else {
      state.conflict = true;
      setStatus(translatedMessage("main.file_changed_externally_autosave_paused_save_as"), 'error');
    }
  } catch {
    // File permission can disappear when the browser restarts; manual save will surface it.
  }
}

function closePopovers(except = null) {
  for (const popover of [appearancePopover, recentPopover, headingPopover, calloutPopover, modePopover, documentPopover, exportPopover, displayPopover, languagePopover]) {
    if (popover !== except) popover.hidden = true;
    if (popover===modePopover && popover.hidden) document.querySelector('#readingToggle').setAttribute('aria-expanded','false');
  }
  for (const control of document.querySelectorAll('.quick-language-button')) control.setAttribute('aria-expanded', String(!languagePopover.hidden && languagePopover.dataset.trigger === control.id));
  document.querySelector('#appearanceButton').setAttribute('aria-expanded', String(except === appearancePopover && !appearancePopover.hidden));
  document.querySelector('#headingButton').setAttribute('aria-expanded', String(except === headingPopover && !headingPopover.hidden));
  document.querySelector('#calloutButton').setAttribute('aria-expanded', String(except === calloutPopover && !calloutPopover.hidden));
  document.querySelector('#documentMenuButton').setAttribute('aria-expanded', String(!documentPopover.hidden));
  document.querySelector('#exportMenuButton').setAttribute('aria-expanded', String(!exportPopover.hidden));
  displayButton.setAttribute('aria-expanded', String(!displayPopover.hidden));
}

function fuzzyMatch(text, query) {
  let index = 0;
  const source = text.toLowerCase();
  for (const char of query.toLowerCase()) {
    index = source.indexOf(char, index);
    if (index < 0) return false;
    index += 1;
  }
  return true;
}

async function exportBundle() {
  closePopovers();
  try {
    const path=await desktopExportBundle();
    if(path)setStatus(translatedMessage("main.document_and_attachments_exported", {"path": path}),'saved');
  } catch(error) { setStatus(translatedMessage("main.export_failed", {"error": error}),'error'); }
}
async function exportPdf() {
  if (!welcomeScreen.hidden) return;
  const snapshot = { source: editor.getValue(), name: state.fileName, numbered: state.showHeadingNumbers };
  try {
    if (desktop) await invoke('open_export', { snapshot });
    else {
      const key = `leaf-export-${crypto.randomUUID()}`;
      sessionStorage.setItem(key, JSON.stringify(snapshot));
      const preview = window.open(`?export=${key}`, '_blank');
      sessionStorage.removeItem(key);
      if (!preview) throw new Error(t("main.allow_the_export_preview_window_to_open"));
    }
  } catch (error) { setStatus(translatedMessage("main.export_failed", {"error": error}), 'error'); }
}

const commands = [
  { id: 'main.appearance_typography_ui0202', get name() { return t('main.appearance_typography_ui0202'); }, action: () => openSettings('appearance') },
  { id: 'main.display_options', get name() { return t('main.display_options'); }, action: () => document.querySelector('#displayButton').click() },
  { id: 'main.saving_recovery_ui0204', get name() { return t('main.saving_recovery_ui0204'); }, action: () => openSettings('recovery') },
  { id: 'main.copy_as_rich_text', get name() { return t('main.copy_as_rich_text'); }, shortcut: '⇧⌘C', action: () => writing.copyRich() },
  { id: 'main.paste_as_plain_text', get name() { return t('main.paste_as_plain_text'); }, shortcut: '⌘T', action: () => writing.pastePlain() },
  { id: 'main.insert_image', get name() { return t('main.insert_image'); }, action: () => writing.attachments(null, true) },
  { id: 'main.insert_attachment', get name() { return t('main.insert_attachment'); }, action: () => writing.attachments(null, false) },
  { id: 'main.undo_ui0209', get name() { return t('main.undo_ui0209'); }, shortcut: '⌘Z', action: () => editor.undo() },
  { id: 'main.redo_ui0210', get name() { return t('main.redo_ui0210'); }, shortcut: '⇧⌘Z', action: () => editor.redo() },
  { id: 'main.export_pdf_ui0211', get name() { return t('main.export_pdf_ui0211'); }, shortcut: '⌘E', action: exportPdf },
  { id: 'main.open_file_ui0212', get name() { return t('main.open_file_ui0212'); }, shortcut: '⌘O', action: openFile },
  { id: 'main.show_or_hide_editing_marks', get name() { return t('main.show_or_hide_editing_marks'); }, shortcut: '⌘⇧\\', action: toggleBlankLineMarkers },
  { id: 'main.clean_up_blank_lines', get name() { return t('main.clean_up_blank_lines'); }, shortcut: '⌘⌥\\', action: tidyBlankLines },
  { id: 'main.save_file', get name() { return t('main.save_file'); }, shortcut: '⌘S', action: saveFile },
  { id: 'main.cycle_view_mode', get name() { return t('main.cycle_view_mode'); }, shortcut: '⌘R', action: cycleMode },
  { id: 'main.document_properties_ui0217', get name() { return t('main.document_properties_ui0217'); }, action: openDocumentProperties },
  { id: 'main.find_in_document', get name() { return t('main.find_in_document'); }, shortcut: '⌘F', action: openDocumentSearch },
  { id: 'main.renumber_footnotes_in_reference_order', get name() { return t('main.renumber_footnotes_in_reference_order'); }, action: () => editor.renumberFootnotes() },
  { id: 'main.show_or_hide_outline', get name() { return t('main.show_or_hide_outline'); }, action: () => setOutlineDrawer(!outlineDrawer.classList.contains('visible')) },
  { id: 'main.show_or_hide_footnotes', get name() { return t('main.show_or_hide_footnotes'); }, action: toggleNotesDrawer },
  { id: 'main.show_or_hide_source_line_numbers', get name() { return t('main.show_or_hide_source_line_numbers'); }, action: () => setLineNumbers(!state.showLineNumbers) },
  { id: 'main.toggle_focus_mode', get name() { return t('main.toggle_focus_mode'); }, action: toggleFocusMode },
  { id: 'main.toggle_light_dark_theme', get name() { return t('main.toggle_light_dark_theme'); }, action: cycleTheme },
  { id: 'main.set_to_heading_1', get name() { return t('main.set_to_heading_1'); }, shortcut: '⌥1', action: () => editor.format('heading1') },
  { id: 'main.bold_ui0226', get name() { return t('main.bold_ui0226'); }, shortcut: '⌘B', action: () => editor.format('bold') },
  { id: 'main.italic_ui0227', get name() { return t('main.italic_ui0227'); }, shortcut: '⌘I', action: () => editor.format('italic') },
  { id: 'main.highlight', get name() { return t('main.highlight'); }, shortcut: '⌘=', action: () => editor.format('highlight') },
  { id: 'main.inline_code', get name() { return t('main.inline_code'); }, shortcut: '⌘⌥C', action: () => editor.format('code') },
  { id: 'main.blockquote_ui0228', get name() { return t('main.blockquote_ui0228'); }, action: () => editor.format('quote') },
  { id: 'main.insert_footnote_ui0229', get name() { return t('main.insert_footnote_ui0229'); }, shortcut: '⇧⌘F', action: () => editor.format('footnote') },
  { id: 'main.insert_callout_ui0230', get name() { return t('main.insert_callout_ui0230'); }, aliases: ['Callout'], action: () => {if(state.reading)toggleReading();editor.format('callout-note');} },
  { id: 'main.bulleted_list_ui0232', get name() { return t('main.bulleted_list_ui0232'); }, shortcut: '⇧⌘8', action: () => editor.format('bullet') },
  { id: 'main.insert_table_ui0233', get name() { return t('main.insert_table_ui0233'); }, action: () => editor.format('table') },
  ...(desktop ? [
    { id: 'main.versions_drafts_ui0234', get name() { return t('main.versions_drafts_ui0234'); }, action: () => showRecovery({ invoke, restore: desktopRestore }) },
    { id: 'main.recover_unsaved_drafts', get name() { return t('main.recover_unsaved_drafts'); }, action: () => showRecovery({ invoke, drafts: true }) },
  ] : [{
    id: 'main.restore_version_before_last_save_ui0236', get name() { return t('main.restore_version_before_last_save_ui0236'); },
    action() {
      const snapshot = latestSnapshot();
      if (!snapshot) return setStatus(translatedMessage('main.no_recoverable_versions'), 'info');
      editor.restoreValue(snapshot.content);
      state.content = snapshot.content;
      updateDocumentChrome();
      scheduleSave();
      // scheduleSave supplies the pending or save-location state.
    },
  }]),
];

const commandGroups = [
  ['main.settings_ui0238', ['main.appearance_typography_ui0202', 'main.saving_recovery_ui0204']],
  ['main.file', ['main.open_file_ui0212', 'main.save_file', 'main.export_pdf_ui0211', 'main.document_properties_ui0217']],
  ['main.edit_ui0240', ['main.undo_ui0209', 'main.redo_ui0210', 'main.copy_as_rich_text', 'main.paste_as_plain_text', 'main.find_in_document', 'main.clean_up_blank_lines', 'main.renumber_footnotes_in_reference_order']],
  ['main.insert_format', ['main.insert_image', 'main.insert_attachment', 'main.set_to_heading_1', 'main.bold_ui0226', 'main.italic_ui0227', 'main.highlight', 'main.inline_code', 'main.blockquote_ui0228', 'main.insert_footnote_ui0229', 'main.insert_callout_ui0230', 'main.bulleted_list_ui0232', 'main.insert_table_ui0233']],
  ['main.view', ['main.display_options', 'main.cycle_view_mode', 'main.show_or_hide_editing_marks', 'main.show_or_hide_outline', 'main.show_or_hide_footnotes', 'main.show_or_hide_source_line_numbers', 'main.toggle_focus_mode', 'main.toggle_light_dark_theme']],
  ['main.recovery', ['main.versions_drafts_ui0234', 'main.recover_unsaved_drafts', 'main.restore_version_before_last_save_ui0236']],
];
function selectPaletteItem(button) {
  for (const item of paletteList.querySelectorAll('button')) {
    const selected = item === button;
    item.classList.toggle('selected', selected);
    item.setAttribute('aria-selected', String(selected));
  }
  if (button) paletteInput.setAttribute('aria-activedescendant', button.id);
  else paletteInput.removeAttribute('aria-activedescendant');
}
function renderPalette(query = '') {
  paletteList.replaceChildren();
  const normalized = query.trim();
  let count = 0;
  for (const [groupKey, names] of commandGroups) {
    const group = t(groupKey);
    const matches = commands.filter(command => names.includes(command.id) && fuzzyMatch(`${aliases(command.id).join(' ')} ${aliases(groupKey).join(' ')} ${(command.aliases || []).join(' ')}`, normalized));
    if (!matches.length) continue;
    let parent = paletteList;
    if (!normalized) {
      parent = document.createElement('div');
      parent.setAttribute('role', 'group');
      parent.setAttribute('aria-label', group);
      const label = document.createElement('div');
      label.className = 'palette-group-title';
      label.setAttribute('aria-hidden', 'true');
      label.textContent = group;
      parent.append(label);
      paletteList.append(parent);
    }
    for (const command of matches) {
      const button = document.createElement('button');
      button.type = 'button'; button.tabIndex = -1;
      button.id = `palette-command-${count++}`;
      button.setAttribute('role', 'option');
      button.innerHTML = `<span>${command.name}</span><kbd>${shortcutText(command.shortcut || '')}</kbd>`;
      renderShortcutText(button.querySelector('kbd'), shortcutText(command.shortcut || ''));
      button.addEventListener('pointermove', event => {
        if (event.pointerType !== 'touch') selectPaletteItem(button);
      });
      button.addEventListener('click', () => runCommand(command));
      parent.append(button);
    }
  }
  document.querySelector('#paletteEmpty').hidden = count !== 0;
  selectPaletteItem(paletteList.querySelector('button'));
  paletteList.scrollTop = 0;
}

function openPalette() {
  closePopovers();
  palette.hidden = false;
  paletteInput.setAttribute('aria-expanded', 'true');
  paletteInput.value = '';
  renderPalette();
  requestAnimationFrame(() => paletteInput.focus());
}

function closePalette() {
  palette.hidden = true;
  paletteInput.setAttribute('aria-expanded', 'false');
  paletteInput.removeAttribute('aria-activedescendant');
  if (state.reading) readingPane.focus(); else editor.focus();
}

function runCommand(command) {
  closePalette();
  command.action();
}

function setLineNumbers(show) {
  state.showLineNumbers = show;
  localStorage.setItem('leaf-line-numbers', String(show));
  document.querySelector('#lineNumberToggle').checked = show;
  editor.setLineNumbers(show);
}

function cycleTheme() {
  state.theme = currentTheme() === 'dark' ? 'light' : 'dark';
  localStorage.setItem('leaf-theme', state.theme);
  updateAppearance();
}

function toggleFocusMode() {
  closePopovers();
  state.focusMode = !state.focusMode;
  shell.classList.toggle('focus-mode', state.focusMode);
  // Visually hidden chrome must also leave keyboard and accessibility navigation.
  for (const region of shell.querySelectorAll('.topbar, .format-toolbar, .statusbar')) region.inert = state.focusMode;
  if (state.reading) readingPane.focus(); else editor.focus();
}

document.querySelector('#openButton')?.addEventListener('click', openFile);
document.querySelector('#exportButton').addEventListener('click', exportPdf);
document.querySelector('#exportBundleButton').addEventListener('click', exportBundle);
document.querySelector('#searchButton').addEventListener('click', openDocumentSearch);
outlineButton.addEventListener('click', () => setOutlineDrawer(true));
document.querySelector('#commandsButton').addEventListener('click', openPalette);
document.querySelector('#focusButton').addEventListener('click', toggleFocusMode);

// The toolbar sits outside the editor, so a click moves focus to the button and
// the menu-style route would find nothing to act on. A toolbar undo always means
// the document: run the editor history, then hand the caret back so the next
// keystroke, and the next Cmd-Z, land in the editor again.
for (const [button, action] of [[undoButton, 'undo'], [redoButton, 'redo']]) {
  button.addEventListener('click', () => {
    editor[action]();
    if (!state.reading) editor.focus();
    updateHistoryControls();
  });
}
document.querySelector('[data-close="outline"]').addEventListener('click', () => { setOutlineDrawer(false); outlineButton.focus(); });
document.querySelector('#notesButton').addEventListener('click', toggleNotesDrawer);
document.querySelector('[data-close="notes"]').addEventListener('click', () => { setNotesDrawer(false); notesButton.focus(); });
// The reading view keeps its own jump down to the printed list; lighting up the
// matching row as well is what a reader expects the panel to do, and it costs no
// navigation of its own.
readingPane.addEventListener('click', event => {
  const ref = event.target.closest('.footnote-ref');
  const card = ref && notesList.querySelector(`.note-card[data-number="${ref.textContent.trim()}"]`);
  if (card) markActiveNote(card);
});

const appearanceScroll = appearancePopover.querySelector('.appearance-scroll');
function updateAppearanceScrollHint() {
  appearancePopover.querySelector('.appearance-scroll-hint').hidden = appearanceScroll.scrollHeight - appearanceScroll.clientHeight - appearanceScroll.scrollTop < 2;
}
appearanceScroll.addEventListener('scroll', updateAppearanceScrollHint, {passive: true});
new ResizeObserver(updateAppearanceScrollHint).observe(appearanceScroll);
appearancePopover.addEventListener('keydown', event => {
  if (event.isComposing || event.keyCode === 229) return;
  // Native selects own Escape while their option list is open. Their ordinary
  // change/blur ends this guard; a subsequent Escape closes the whole panel.
  if (event.key === 'Escape' && !event.defaultPrevented) {
    if (event.target instanceof HTMLSelectElement && appearanceSelectOpen) { appearanceSelectOpen = false; return; }
    event.preventDefault(); event.stopPropagation(); closePopovers();
    settingsReturnFocus?.focus();
  }
});
// WebKit may leave mouse-operated ranges unfocused. Keep the last slider
// focused so arrow keys work immediately after clicking or dragging it.
for (const slider of appearancePopover.querySelectorAll('input[type="range"]')) {
  slider.addEventListener('pointerdown', () => slider.focus({preventScroll: true}));
  slider.addEventListener('mousedown', () => slider.focus({preventScroll: true}));
  slider.addEventListener('pointerup', () => slider.focus({preventScroll: true}));
  slider.addEventListener('click', () => slider.focus({preventScroll: true}));
  slider.addEventListener('keydown', event => {
    if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'ArrowRight') slider.stepUp(); else slider.stepDown();
    slider.dispatchEvent(new Event('input', {bubbles: true}));
    slider.dispatchEvent(new Event('change', {bubbles: true}));
  });
}
let appearanceSelectOpen = false;
for (const select of appearancePopover.querySelectorAll('select')) {
  select.addEventListener('pointerdown', () => { appearanceSelectOpen = true; });
  select.addEventListener('keydown', event => {
    if (event.key === ' ' || event.key === 'F4' || (event.altKey && event.key === 'ArrowDown')) appearanceSelectOpen = true;
  });
  for (const name of ['change', 'blur']) select.addEventListener(name, () => { appearanceSelectOpen = false; });
}
let settingsReturnFocus;
function selectSettingsTab(tab) {
  // The display switches moved out to the toolbar's 显示 control, so the editing
  // tab is gone; a stored 'editing' falls back to the first tab.
  if (!['appearance', 'recovery'].includes(tab)) tab = 'appearance';
  localStorage.setItem('leaf-settings-tab', tab);
  for (const button of appearancePopover.querySelectorAll('[data-settings-tab]')) {
    const active = button.dataset.settingsTab === tab;
    button.setAttribute('aria-selected', String(active)); button.tabIndex = active ? 0 : -1;
  }
  for (const panel of appearancePopover.querySelectorAll('[data-settings-panel]')) panel.hidden = panel.dataset.settingsPanel !== tab;
  appearanceScroll.scrollTop = 0;
  requestAnimationFrame(updateAppearanceScrollHint);
}
function openSettings(tab) {
  settingsReturnFocus = welcomeScreen.hidden ? document.querySelector('#appearanceButton') : document.querySelector('#welcomeSettings');
  closePopovers(); appearancePopover.hidden = false;
  document.querySelector('#appearanceButton').setAttribute('aria-expanded', 'true');
  selectSettingsTab(tab || localStorage.getItem('leaf-settings-tab') || 'appearance');
  appearanceSelectOpen = false;
  appearancePopover.querySelector('[aria-selected="true"]').focus();
}
function closeSettings() { closePopovers(); settingsReturnFocus?.focus(); }
for (const id of ['appearanceButton', 'welcomeSettings']) document.getElementById(id).onclick = () => appearancePopover.hidden ? openSettings() : closeSettings();
document.querySelector('#settingsClose').onclick = closeSettings;
for (const button of appearancePopover.querySelectorAll('[data-settings-tab]')) {
  button.onclick = () => selectSettingsTab(button.dataset.settingsTab);
  button.onkeydown = event => {
    const tabs = [...appearancePopover.querySelectorAll('[data-settings-tab]')], i = tabs.indexOf(button);
    const next = {ArrowRight:(i+1)%tabs.length, ArrowLeft:(i-1+tabs.length)%tabs.length, Home:0, End:tabs.length-1}[event.key];
    if (next !== undefined) { event.preventDefault(); tabs[next].click(); tabs[next].focus(); }
  };
}
// Markers do not exist in reading mode, so this offers the way to see them.
// Switching mode closes the switchboard along with the rest of the popovers.
document.querySelector('#markerEditMode').onclick = () => setMode('edit');
function openRecoveryRecords(current = false) {
  closePopovers();
  if (desktop) return showRecovery({invoke, restore:desktopRestore, drafts:!current});
  commands.find(c => c.name === t("main.restore_version_before_last_save_ui0244"))?.action();
}
document.querySelector('#settingsRecovery').onclick = () => openRecoveryRecords();
document.querySelector('#documentHistory').onclick = () => openRecoveryRecords(true);
if (desktop) {
  document.querySelector('#documentReveal').onclick = async () => {
    try { await invoke('reveal_document'); }
    catch (error) { setStatus(translatedMessage("main.could_not_show_the_file_in_the", {"error": error}), 'error'); }
  };
  document.querySelector('#documentRename').onclick = renameCurrentDocument;
}
document.querySelector('#saveButton').onclick = saveFile;
// Whether the property rows are on screen is a display choice like the rest, so
// it lives in the 显示 switchboard with them rather than on a toolbar button of
// its own. The switchboard reads the live state when it opens: the region's own
// header control folds the same rows, and a tracked copy drifts out of step.
function syncDisplayPopover() {
  const propertiesToggle = displayPopover.querySelector('#documentPropertiesToggle');
  // Source mode draws the properties as YAML text and reading mode has no
  // editor rows at all, so there is nothing either could fold.
  propertiesToggle.disabled = state.source || state.reading;
  propertiesToggle.checked = editor.propertiesExpanded();
  setText(displayPopover.querySelector('#markerModeHint'), () => state.reading ? t("main.editing_marks_are_hidden_in_reading_mode") : state.source ? t("main.source_mode_shows_only_line_break_marks") : '');
  displayPopover.querySelector('#markerEditMode').hidden = !state.reading;
}
displayButton.addEventListener('mousedown', event => event.preventDefault());
displayButton.addEventListener('click', () => {
  if (shell.classList.contains('welcome-state')) return;
  const opening = displayPopover.hidden;
  closePopovers();
  if (!opening) { if (displayPopover.contains(document.activeElement)) displayButton.focus(); return; }
  displayPopover.hidden = false;
  displayButton.setAttribute('aria-expanded', 'true');
  syncDisplayPopover();
  positionMenu(displayPopover, displayButton.getBoundingClientRect());
  // Move focus to the first switch, the way the settings panel focuses its
  // active tab: Tab then walks the rows, and Escape -- which the popover
  // handles on its own keydown -- has somewhere to fire from.
  displayPopover.querySelector('input:not(:disabled)')?.focus({preventScroll: true});
});
// A switchboard stays open while its switches are flipped, so it does not use
// the menu loop, which closes on any button press.
displayPopover.addEventListener('keydown', event => {
  if (event.key === 'Escape') { event.preventDefault(); closePopovers(); displayButton.focus(); }
});
// These non-modal panels allow native Tab order within the panel. Once focus
// leaves via Tab, dismiss it without covering the next keyboard target. A
// mouse click can blur native macOS checkboxes before their click fires; never
// close the panel in that interval. Outside clicks are handled separately.
for (const [panel, trigger] of [[appearancePopover, document.querySelector('#appearanceButton')], [displayPopover, displayButton]]) {
  panel.addEventListener('keydown', event => {
    if (event.key !== 'Tab') return;
    requestAnimationFrame(() => {
    if (panel.hidden || panel.contains(document.activeElement)) return;
    panel.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    });
  });
}
displayPopover.querySelector('#documentPropertiesToggle').addEventListener('change', event => {
  // A document with no properties has no rows to unfold, and creating the
  // region is what showing them means there.
  if (event.target.checked && editor.setPropertiesVisible(true) === null) return openDocumentProperties();
  if (!event.target.checked) editor.setPropertiesVisible(false);
});
document.querySelector('#markerEditMode').onclick = () => setMode('edit');

for (const [id, popup] of [['documentMenuButton', documentPopover], ['exportMenuButton', exportPopover]]) {
  const trigger = document.getElementById(id);
  trigger.addEventListener('mousedown', event => event.preventDefault());
  trigger.addEventListener('click', () => {
    const opening = popup.hidden;
    closePopovers();
    if (!opening) return;
    if (popup === documentPopover && desktop) {
      const unavailable = !desktopHasPath();
      for (const id of ['documentReveal', 'documentRename']) {
        const item = document.getElementById(id);
        item.disabled = unavailable;
        setAttr(item, 'title', () => unavailable ? t("main.save_the_document_first") : '');
      }
    }
    popup.hidden = false;
    const rect = trigger.getBoundingClientRect();
    positionMenu(popup,rect);
    trigger.setAttribute('aria-expanded', 'true');
    popup.querySelector('button:not(:disabled)')?.focus();
  });
  popup.addEventListener('mousedown', event => { if (event.target.closest('button')) event.preventDefault(); });
  popup.addEventListener('click', event => {
    if (!event.target.closest('button')) return;
    closePopovers();
    if (popup.contains(document.activeElement)) trigger.focus();
  });
  popup.addEventListener('keydown', event => {
    const items = [...popup.querySelectorAll('button:not(:disabled)')];
    const index = items.indexOf(document.activeElement);
    const target = {ArrowDown: (index + 1) % items.length, ArrowUp: (index - 1 + items.length) % items.length, Home: 0, End: items.length - 1}[event.key];
    if (target !== undefined) { event.preventDefault(); items[target]?.focus(); }
    if (event.key === 'Escape') { event.preventDefault(); closePopovers(); trigger.focus(); }
    if (event.key === 'Tab') { closePopovers(); trigger.focus(); }
  });
}
calloutPopover.addEventListener('keydown', event => {
  if (event.key === 'Escape') { closePopovers(); document.querySelector('#calloutButton').focus(); }
});
headingPopover.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    event.preventDefault(); closePopovers(); document.querySelector('#headingButton').focus();
  }
});
window.addEventListener('resize', () => closePopovers());

document.querySelector('#headingButton').addEventListener('click', () => {
  const willOpen = headingPopover.hidden;
  closePopovers(headingPopover);
  headingPopover.hidden = !willOpen;
  document.querySelector('#headingButton').setAttribute('aria-expanded', String(willOpen));
  if (willOpen) (headingPopover.querySelector('[aria-pressed="true"]') || headingPopover.querySelector('button'))?.focus();
});

async function toggleRecentFiles(event) {
  const willOpen = recentPopover.hidden;
  closePopovers(recentPopover);
  recentPopover.hidden = !willOpen;
  if (willOpen) {
    recentPopover.dataset.returnFocus = event.currentTarget.id;
    await renderRecentFiles();
    if (!recentPopover.hidden) recentPopover.querySelector('button:not(:disabled)')?.focus();
  }
}

recentPopover.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    event.preventDefault(); closePopovers(); document.getElementById(recentPopover.dataset.returnFocus)?.focus();
  }
});

document.querySelector('#recentButton').addEventListener('click', toggleRecentFiles);
document.querySelector('#recoveryNotice').addEventListener('click', () => showRecovery({ invoke, restore: desktopRestore, drafts: false }));
document.querySelector('#welcomeOpenButton').addEventListener('click', openFile);
document.querySelector('#welcomeRecentButton').addEventListener('click', toggleRecentFiles);
document.querySelector('#welcomeNewButton').addEventListener('click', () => {
  if (desktop) {
    void desktopNew().catch(error => setStatus(translatedMessage("main.could_not_create_the_document", {"error": error}), 'error'));
  } else {
    void setDocument('', t("main.untitled_md"));
  }
});

document.querySelectorAll('[data-format]').forEach((button) => {
  button.addEventListener('click', () => {
    const note=document.activeElement.closest?.('.note-card')?._noteEditor;
    if(note)note.format(button.dataset.format);else editor.format(button.dataset.format);
    closePopovers();
    headingPopover.hidden = true;
    document.querySelector('#headingButton').setAttribute('aria-expanded', 'false');
  });
});

document.querySelector('#calloutButton').addEventListener('click',event=>{
  event.stopPropagation();if(state.reading)return;
  const rect=document.querySelector('#calloutButton').getBoundingClientRect();
  const opening=calloutPopover.hidden;closePopovers();calloutPopover.hidden=!opening;
  if(opening){positionMenu(calloutPopover,rect);calloutPopover.querySelector('button')?.focus();}
  event.currentTarget.setAttribute('aria-expanded',String(opening));
});

document.querySelector('#themeSelect').addEventListener('change', (event) => {
  state.theme = event.target.value;
  localStorage.setItem('leaf-theme', state.theme);
  updateAppearance();
});
document.querySelector('#fontFamilySelect').addEventListener('change', (event) => {
  state.fontFamily = event.target.value;
  localStorage.setItem('leaf-reading-v2-font', state.fontFamily);
  updateAppearance();
});
document.querySelector('#fontSizeInput').addEventListener('input', (event) => {
  state.fontSize = Number(event.target.value);
  localStorage.setItem('leaf-reading-v2-size', state.fontSize);
  updateAppearance();
});
document.querySelector('#contentWidthInput').addEventListener('input', (event) => {
  state.contentWidth = Number(event.target.value);
  localStorage.setItem('leaf-reading-v2-width', state.contentWidth);
  updateAppearance();
});
let recoveryDays=30;
document.addEventListener('leaf-retention-days',event=>{
 recoveryDays=Number(event.detail);const select=document.querySelector('#recoveryRetentionSelect');if(select){select.value=String(recoveryDays);select.disabled=false;}
});
document.querySelector('#recoveryRetentionSelect')?.addEventListener('change',async event=>{
 const select=event.target;select.disabled=true;
 try {recoveryDays=await invoke('recovery_retention',{days:Number(select.value)});await invoke('recovery_expire');setStatus(translatedMessage("main.recovery_records_are_kept_for_days", {"days": recoveryDays}),'saved');}
 catch(error){setStatus(translatedMessage("main.could_not_update_the_recovery_retention_period", {"error": error}),'error');}
 finally{select.value=String(recoveryDays);select.disabled=false;}
});
document.querySelector('#fileNameTitleToggle').addEventListener('change',event=>{
 state.showFileNameTitle=event.target.checked;localStorage.setItem('leaf-file-name-title',String(state.showFileNameTitle));editor.setFileNameTitle(state.showFileNameTitle);if(state.reading)renderReading();
});
document.querySelector('#lineNumberToggle').addEventListener('change', (event) => setLineNumbers(event.target.checked));
// 标题多级编号 is one switch in the 显示 popover, alongside the other display
// switches. It used to have a second entry point in the format toolbar, which
// read as a separate feature that happened to do the same thing.
const headingNumberSetting = document.querySelector('#headingNumberSetting');
headingNumberSetting.checked = state.showHeadingNumbers;
headingNumberSetting.addEventListener('change', (event) => {
  state.showHeadingNumbers = event.target.checked;
  localStorage.setItem('leaf-heading-numbers', String(state.showHeadingNumbers));
  editor.setHeadingNumbers(state.showHeadingNumbers);
  if(state.reading)renderReading();
});

paletteInput.addEventListener('input', event => { if (!event.isComposing) renderPalette(paletteInput.value); });
paletteInput.addEventListener('compositionend', () => renderPalette(paletteInput.value));
paletteInput.addEventListener('keydown', (event) => {
  if (event.isComposing || event.keyCode === 229) return;
  if (event.key === 'Tab') { event.preventDefault(); event.stopPropagation(); return; }
  const buttons = [...paletteList.querySelectorAll('button')];
  let index = buttons.findIndex((button) => button.classList.contains('selected'));
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    index = event.key === 'ArrowDown' ? Math.min(index + 1, buttons.length - 1) : Math.max(index - 1, 0);
    selectPaletteItem(buttons[index]);
    buttons[index]?.scrollIntoView({ block: 'nearest' });
  } else if (event.key === 'Enter') {
    event.preventDefault();
    buttons[index]?.click();
  } else if (event.key === 'Escape') {
    event.preventDefault();
    closePalette();
  }
});

palette.addEventListener('keydown', event => {
  if (event.isComposing) return;
  if (event.key === 'Tab') { event.preventDefault(); paletteInput.focus(); }
  if (event.key === 'Escape' && event.target !== paletteInput) { event.preventDefault(); closePalette(); }
});

palette.addEventListener('mousedown', (event) => {
  if (event.target === palette) closePalette();
});

document.addEventListener('mousedown', (event) => {
    if (!event.target.closest('.quick-language-button') && !event.target.closest('.popover') && !event.target.closest('#readingToggle') && !event.target.closest('#appearanceButton') && !event.target.closest('#welcomeSettings') && !event.target.closest('#recentButton') && !event.target.closest('#welcomeRecentButton') && !event.target.closest('#headingButton') && !event.target.closest('#documentMenuButton') && !event.target.closest('#exportMenuButton') && !event.target.closest('#displayButton')) closePopovers();
});

let tooltipTimer = null;
let tooltipTarget = null;

function hideTooltip() {
  clearTimeout(tooltipTimer);
  tooltipTarget = null;
  tooltip.hidden = true;
}

function showTooltip(target) {
  if (!target?.isConnected || !target.dataset.tooltip) return;
  tooltipTarget = target;
  tooltip.dataset.kind = target.dataset.tooltipKind || 'default';
  tooltip.dataset.placement = target.dataset.tooltipPlacement || 'default';
  tooltip.style.maxWidth = '';
  const imageRect = target.dataset.tooltipPlacement === 'image-top-right'
    ? target.querySelector('.leaf-image')?.getBoundingClientRect() : null;
  if (imageRect) {
    // Leave room for the reveal button on small images.
    if (imageRect.width <= 38) { hideTooltip(); return; }
    tooltip.style.maxWidth = `${Math.min(window.innerWidth - 16, imageRect.width - 34)}px`;
  }
  renderTooltipText(tooltip, target.dataset.tooltip);
  tooltip.hidden = false;
  const targetRect = target.getBoundingClientRect();
  const tooltipRect = tooltip.getBoundingClientRect();
  const left = Math.min(
    window.innerWidth - tooltipRect.width - 8,
    Math.max(8, imageRect ? imageRect.right - tooltipRect.width - 4 : targetRect.left + targetRect.width / 2 - tooltipRect.width / 2),
  );
  let top = imageRect ? Math.max(8, imageRect.top + 4) : targetRect.bottom + 8;
  if (!imageRect && top + tooltipRect.height > window.innerHeight - 8) top = targetRect.top - tooltipRect.height - 8;
  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${top}px`;
}

function queueTooltip(target) {
  clearTimeout(tooltipTimer);
  tooltipTimer = setTimeout(() => showTooltip(target), 300);
}

document.addEventListener('pointerover', (event) => {
  const target = event.target.closest('[data-tooltip]');
  if (target && target !== tooltipTarget) queueTooltip(target);
});
document.addEventListener('pointerout', (event) => {
  const target = event.target.closest('[data-tooltip]');
  if (target && !target.contains(event.relatedTarget)) hideTooltip();
});
document.addEventListener('focusin', (event) => {
  const target = event.target.closest('[data-tooltip]');
  if (target) queueTooltip(target);
});
document.addEventListener('focusout', hideTooltip);
document.addEventListener('click', hideTooltip);
window.addEventListener('scroll', hideTooltip, true);

window.addEventListener('keydown', (event) => {
  if (!event.isComposing && (event.metaKey || event.ctrlKey) && event.code === 'Backslash' && event.shiftKey !== event.altKey) {
    event.preventDefault(); event.stopPropagation();
    if (event.shiftKey) toggleBlankLineMarkers(); else tidyBlankLines();
  }
}, true);
window.addEventListener('keydown', (event) => {
  if (event.defaultPrevented) return;
  if (event.metaKey || event.ctrlKey) {
    const key = event.key.toLowerCase();
    if (key === 'o') {
      event.preventDefault();
      openFile();
    } else if (key === 's') {
      event.preventDefault();
      if (desktop && event.shiftKey) desktopSave(true);
      else saveFile();
    } else if (key === 'f') {
      event.preventDefault();
      openDocumentSearch();
    } else if (key === 'p') {
      event.preventDefault();
      openPalette();
    }
  }
  if (event.key === 'Escape' && state.focusMode) toggleFocusMode();
});

function toggleBlankLineMarkers() {
  state.showBlankMarkers=!state.showBlankMarkers;
  localStorage.setItem('leaf-blank-markers',String(state.showBlankMarkers));
  editor.setBlankMarkers(state.showBlankMarkers);
  updateBlankMarkerButton();
}
function updateBlankMarkerButton() {
  const button=document.querySelector('#blankMarkerToggle');
  button.checked = state.showBlankMarkers;
}
function tidyBlankLines() {
  const count=editor.tidyBlankLines();
  if (count) editor.focus();
  setStatus(translatedMessage(count ? "main.blank_lines_cleaned_up_z_to_undo" : "main.no_changes_needed"),'info');
}
document.querySelector('#blankMarkerToggle').addEventListener('change',toggleBlankLineMarkers);
document.addEventListener('keydown', event => {
  if ((event.metaKey || event.ctrlKey) && (event.code === 'Comma' || event.key === ',') && !event.shiftKey && event.altKey && !event.isComposing) { event.preventDefault(); event.stopImmediatePropagation(); openSettings(); }
}, true);
document.querySelector('#tidyBlankLines').addEventListener('click',tidyBlankLines);
updateBlankMarkerButton();

window.addEventListener('beforeunload', (event) => {
  if (!desktop && state.content !== state.savedContent) event.preventDefault();
});

for (const eventName of ['dragenter', 'dragover']) {
  window.addEventListener(eventName, (event) => {
    event.preventDefault();
    if(desktop)return; // Tauri supplies native paths and drag coordinates below.
    dropOverlay.classList.add('visible');
  });
}
window.addEventListener('dragleave', (event) => {
  if (!event.relatedTarget) dropOverlay.classList.remove('visible');
});
window.addEventListener('drop', async (event) => {
  event.preventDefault();
  if (desktop) return;
  dropOverlay.classList.remove('visible');
  const item = event.dataTransfer.items?.[0];
  const file = item?.getAsFile() || event.dataTransfer.files?.[0];
  if (!file) return;
  const handle = item?.getAsFileSystemHandle ? await item.getAsFileSystemHandle() : null;
  await setDocument(await file.text(), file.name, handle?.kind === 'file' ? handle : null, file);
});

matchMedia('(prefers-color-scheme: dark)').addEventListener('change', updateAppearance);
setInterval(checkExternalChanges, 3000);

// A placeholder that cannot reach its file reports here: the status line is the
// one place a persistent message belongs, and it keeps the reason visible.
document.addEventListener('leaf-image-reveal-failed', event => {
  setStatus(translatedMessage("main.could_not_show_the_file_in_the", {"error": event.detail}), 'error');
});

updateAppearance();
updateDocumentChrome();
updateHistoryControls();
renderOutline(welcome);
renderRecentFiles();

// macOS routes Cmd-Z through the application menu, so the shortcut never
// reaches the editor's own history binding. The menu event comes back here:
// the editor answers for its own history, while plain inputs (document
// properties, callouts, the search field) keep the native undo manager.
function runHistory(action) {
  const active = document.activeElement;
  if (active?.closest('.cm-editor')) { editor[action](); return; }
  try { document.execCommand(action); } catch { /* No native history for this target. */ }
}

if (desktop) {
  // Browser file handles cannot be shared with the desktop filesystem layer.
  document.querySelector('#recentButton').hidden = true;
  setupWelcomeRecovery({ invoke, welcome: welcomeScreen });
  shell.style.pointerEvents = 'none';
  editor.setReading(true);
  initDesktop({
    content: () => state.content,
    loadedImages: () => loadedLocalImagePaths(),
    retryMissingImages: () => retryMissingImages(),
    dirty: () => state.content !== state.savedContent,
    status: setStatus,
    recoveryAvailable: statusNotices.recoveryAvailable,
    load: (content, name, path) => { state.resourcePath = path; return setDocument(content, name); },
    recovery: () => showRecovery({ invoke, restore: desktopRestore, drafts: !welcomeScreen.hidden }),
    restore: content => { clearTimeout(state.saveTimer); editor.restoreValue(content); if (state.reading) renderReading(); },
    find: openDocumentSearch,
    exportPdf,
    cycleMode,
    rename: renameCurrentDocument,
    async renameNative(name){
      try {
        const extension=state.fileName.match(/\.(md|markdown|mdown)$/i)?.[0]||'.md';
        await desktopRename(name.trim()+extension);
        if(state.reading)renderReading();
        await invoke('finish_title_rename',{error:null});
      }catch(error){setStatus(String(error),'error');await invoke('finish_title_rename',{error:String(error)});}
    },
    settings: () => openSettings(),
    copyRich: () => writing.copyRich(),
    pastePlain: () => writing.pastePlain(),
    undo: () => runHistory('undo'),
    redo: () => runHistory('redo'),
    attach: (files, point) => writing.attachments(files, true, point),
    drag(active, point, files=[]) {
      const opening=files.some(path=>/\.(md|markdown|mdown)$/i.test(path))||!welcomeScreen.hidden;
      dropOverlay.classList.toggle('visible',active&&opening);
      // Native Tauri drag events do not pass through contentDOM's dragover.
      editor.setDropPoint(active&&!opening&&!state.reading ? point : null);
    },
    saved(content, name, path) { const changed = state.resourcePath !== path; state.resourcePath = path; state.savedContent = content; state.fileName = name; updateDocumentChrome(); if (changed) { setMovedMissingImages(); refreshImages(); } },
    followed(content, name, path, movedImages) { state.resourcePath = path; state.savedContent = content; state.fileName = name; updateDocumentChrome(); setMovedMissingImages(movedImages); refreshImages(); },
  }).catch(error => setStatus(translatedMessage("main.desktop_app_initialization_failed", {"error": error}), 'error')).finally(async () => {
    shell.style.pointerEvents = '';
    await desktopRevealDocument().catch(error => console.error('Document window reveal failed', error));
    editor.setReading(state.reading);
    if (welcomeScreen.hidden && !state.reading) editor.focus();
  });
}

const languageSelects = [...document.querySelectorAll('.quick-language-button')];
let languageReturnFocus;
function syncLanguageControls() {
  languageSelects.forEach(control => { control.value = languagePreference(); });
  for (const item of languagePopover.querySelectorAll('[data-language]')) item.setAttribute('aria-checked', String(item.dataset.language === languagePreference()));
}
async function chooseLanguage(value) {
  languageSelects.forEach(control => { control.disabled = true; });
  try { await setLanguagePreference(value); }
  catch { setStatus(translatedMessage('UI0261'), 'error'); }
  finally { syncLanguageControls(); languageSelects.forEach(control => { control.disabled = false; }); }
}
for (const control of languageSelects) {
  control.value = languagePreference();
  control.addEventListener('click', () => {
    const opening = languagePopover.hidden || languagePopover.dataset.trigger !== control.id;
    closePopovers();
    if (!opening) return;
    hideTooltip();
    languageReturnFocus = control;
    languagePopover.dataset.trigger = control.id;
    languagePopover.hidden = false;
    syncLanguageControls();
    control.setAttribute('aria-expanded', 'true');
    positionMenu(languagePopover, control.getBoundingClientRect());
    languagePopover.querySelector('[aria-checked="true"]').focus({preventScroll: true});
  });
}
for (const item of languagePopover.querySelectorAll('[data-language]')) {
  item.addEventListener('click', async () => {
    closePopovers();
    await chooseLanguage(item.dataset.language);
    languageReturnFocus?.focus({preventScroll: true});
  });
}
languagePopover.addEventListener('keydown', event => {
  const items = [...languagePopover.querySelectorAll('[data-language]')];
  const index = items.indexOf(document.activeElement);
  const next = event.key === 'ArrowDown' ? (index + 1) % items.length
    : event.key === 'ArrowUp' ? (index + items.length - 1) % items.length
    : event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : undefined;
  if (next !== undefined) { event.preventDefault(); items[next].focus(); }
  if (event.key === 'Escape' || event.key === 'Tab') {
    event.preventDefault(); closePopovers(); languageReturnFocus?.focus({preventScroll: true});
  }
});
syncLanguageControls();
onLanguageChange(() => {
  syncLanguageControls();
  updateDocumentChrome(); updateModeControl(); updateHeadingControl(editor.headingLevel());
  if (!palette.hidden) renderPalette(paletteInput.value);
  for (const el of document.querySelectorAll('[data-callout-label]')) el.textContent = calloutLabels[el.dataset.calloutLabel];
  statusNotices.refresh();
  refreshTranslations();
});
