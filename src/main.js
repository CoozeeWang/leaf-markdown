import { t, h, aliases, currentLanguage, languagePreference, setLanguagePreference, onLanguageChange, refreshTranslations, setText, setAttr, message as translatedMessage } from './i18n.js';
import { calloutBadge } from './callout-icons.js';
import { inlineRename } from './inline-rename.js';
import { setupStatusNotices } from './status-notices.js';
import { positionMenu } from './menu-position.js';
import {installMenuInteraction} from './menu-interaction.js';
installMenuInteraction();
import { setupWriting } from './writing-tools.js';
import { loadedLocalImagePaths, refreshImages, retryMissingImages, setMovedMissingImages } from './resources.js';
import { showRecovery, setupWelcomeRecovery } from './recovery-dialog.js';
import { createLeafEditor, createLeafNoteEditor, mcpDigest } from './editor.js';
import {listAiComments,readAiComment,locateAiComment} from './ai-comment-operations.js';
import { setupSidebarResize } from './outline-resize.js';
import './style.css';
import { renderPrintDocument } from './print-document.js';
import { frontmatter } from './markdown-model.js';
import './reading.css';
import { desktop, desktopRevealDocument, desktopExportBundle, desktopRename, desktopOpen, desktopNew, desktopSave, desktopAiApplied, desktopFileState, desktopHasPath, initDesktop, desktopTitle, desktopEdited, desktopRestore, desktopRecoveryPaused, desktopRun, chooseAttachments } from './desktop.js';
import { invoke } from '@tauri-apps/api/core';
import { listen as listenNative } from '@tauri-apps/api/event';
import { open as pickNativeFile } from '@tauri-apps/plugin-dialog';
import { shortcutText, renderShortcutText, renderTooltipText } from './platform-shortcuts.js';
import { labels as calloutLabels } from './callout.js';
import { indexFootnotes, notePanelRows } from './footnotes.js';
import {setupCommentPanel} from './comment-panel.js';
import {stripComments} from './comments.js';
import {commentShortcuts} from './comment-view.js';
import {setupCommentContext} from './comment-context.js';
import { uiIcon, uiIconPaths } from './ui-icons.js';
import {readingFolding} from './outline-folding.js';
import { BODY_ZOOM_LEVELS, stepBodyZoom, bodyZoomShortcut } from './body-zoom.js';
import { setupBodyFontSettings } from './body-font-settings.js';

// Read only the live authorized buffer, then recheck after asynchronous hashing.
async function handleMcpCommentQuery(args) {
  const valid=()=>mcpBinding?.document_id===args.document_id&&mcpBinding?.session_id===args.session_id&&mcpBinding?.authorization_epoch===args.authorization_epoch;
  if(!valid())throw new Error('not_authorized');
  const snapshot=editor.mcpSnapshot();
  if(snapshot.revision!==args.revision)throw new Error('stale_revision');
  const source_fingerprint=await mcpDigest(snapshot.content);
  const current=editor.mcpSnapshot();
  if(!valid()||current.revision!==snapshot.revision||current.content!==snapshot.content)throw new Error('stale_revision');
  const context={...args,source_fingerprint};
  const query={list_comments:listAiComments,read_comment:readAiComment,locate_comment:locateAiComment}[args.query];
  if(!query)throw new Error('unknown_comment_query');
  return query(snapshot.content,context,args.id);
}

async function planAndApplyMcpCommentBatch(args) {
  if(mcpBinding?.document_id!==args.document_id||mcpBinding?.session_id!==args.session_id||mcpBinding?.authorization_epoch!==args.authorization_epoch)throw new Error('not_authorized');
  return editor.applyMcpBatch(args);
}

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
  bodyZoom: 100,
};

const iconPaths = {
  ...uiIconPaths,
  language: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 4 6 4 9s-1 6-4 9c-3-3-4-6-4-9s1-6 4-9Z"/>',
  attach: '<path d="m9 12 6-6a3 3 0 0 1 4 4l-9 9a5 5 0 0 1-7-7l9-9"/>',
  link: '<path d="m10 13 4-4m-6 6-2 2a3 3 0 0 1-4-4l5-5a3 3 0 0 1 4 0m2 8a3 3 0 0 0 4 0l5-5a3 3 0 0 0-4-4l-2 2"/>',
  paste: '<path d="M9 4H5v17h14V4h-4"/><rect x="9" y="2" width="6" height="4" rx="1"/><path d="M8 11h8M8 15h6"/>',
  copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V6a4 4 0 0 1 8 0v4M12 14v3"/>',
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
      <button id="commentInsert" aria-label="${t('comments.add')}" data-i18n-aria-label="comments.add">${icon('comment')}</button>
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

    <div class="document-notices" style="grid-row:3;min-width:0">
    <div id="aiTaskNotice" class="status-notice" data-kind="error" role="status" aria-live="polite" hidden></div>
    <div id="statusNotice" class="status-notice" hidden>
      <span id="saveStatus" class="save-status" hidden></span>
      <button id="recoveryNotice" class="recovery-notice" hidden>${h("main.recovery_available_view")}</button>
      <span id="statusActions" class="status-actions" hidden></span>
      <button id="dismissStatus" class="dismiss-status" aria-label="${t("main.dismiss_notice")}" data-i18n-aria-label="main.dismiss_notice" data-tooltip="${t("main.dismiss_notice")}" data-i18n-data-tooltip="main.dismiss_notice">${icon('close', 14)}</button>
    </div>
    <span id="statusAnnouncement" class="status-announcement" role="status" aria-live="polite" aria-atomic="true"></span>
    </div>

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
      <section id="readingPane" class="reading-pane" aria-label="${t("main.reading_mode")}" data-i18n-aria-label="main.reading_mode" tabindex="0" hidden><div class="reading-zoom-frame"><div class="reading-zoom-canvas"><article class="reading-document"></article></div></div></section>
      <button id="outlineButton" class="sidebar-rail sidebar-rail-left" aria-label="${t("main.expand_outline")}" data-i18n-aria-label="main.expand_outline" aria-controls="outlineDrawer" aria-expanded="false" data-tooltip="${t("main.expand_outline")}" data-i18n-data-tooltip="main.expand_outline">${icon('outline')}</button>
      <aside id="outlineDrawer" class="outline-drawer" aria-label="${t("main.document_outline")}" data-i18n-aria-label="main.document_outline">
        <div class="outline-resizer" role="separator" aria-label="${t("main.resize_outline")}" data-i18n-aria-label="main.resize_outline" aria-orientation="vertical" tabindex="0" title="${t("main.drag_to_resize_double_click_to_reset")}" data-i18n-title="main.drag_to_resize_double_click_to_reset"></div>
        <div class="drawer-header"><strong>${h("main.outline")}</strong><button data-close="outline" class="icon-control" aria-label="${t("main.collapse_outline")}" data-i18n-aria-label="main.collapse_outline" data-tooltip="${t("main.collapse_outline")}" data-i18n-data-tooltip="main.collapse_outline" aria-controls="outlineDrawer" aria-expanded="true">${icon('outline')}</button></div>
        <div id="outlineList" class="outline-list"></div>
      </aside>
      <aside id="notesDrawer" class="notes-drawer" aria-label="${t("comments.sidebar")}" data-i18n-aria-label="comments.sidebar">
        <div class="notes-resizer" role="separator" aria-label="${t("comments.resize")}" data-i18n-aria-label="comments.resize" aria-orientation="vertical" tabindex="0" title="${t("main.drag_to_resize_double_click_to_reset")}" data-i18n-title="main.drag_to_resize_double_click_to_reset"></div>
        <div class="drawer-header"><div class="annotation-tabs" role="tablist" aria-label="${t('comments.sidebar')}" data-i18n-aria-label="comments.sidebar"><button id="commentsTab" role="tab" aria-controls="commentsList" aria-selected="true"><span>${h('comments.title')}</span><span id="commentsCount" class="drawer-count"></span></button><button id="notesTab" role="tab" aria-controls="notesList" aria-selected="false"><span>${h('main.footnotes')}</span><span id="notesCount" class="drawer-count"></span></button></div><button data-close="notes" class="icon-control" aria-label="${t('comments.collapse')}" data-i18n-aria-label="comments.collapse" data-tooltip="${t('comments.collapse')}" data-i18n-data-tooltip="comments.collapse" aria-controls="notesDrawer" aria-expanded="true">${icon('notes')}</button></div>
        <div id="commentsList" class="comments-list" role="tabpanel" aria-labelledby="commentsTab"></div>
        <div id="notesList" class="notes-list" role="tabpanel" aria-labelledby="notesTab" hidden></div>
      </aside>
      <div id="annotationRail" class="sidebar-rail sidebar-rail-right annotation-rail" role="group" aria-label="${t('comments.sidebar')}" data-i18n-aria-label="comments.sidebar">
        <button id="commentsButton" class="icon-control" aria-label="${t('comments.expand')}" data-i18n-aria-label="comments.expand" aria-controls="notesDrawer" aria-expanded="false" data-tooltip="${t('comments.expand')}" data-i18n-data-tooltip="comments.expand">${icon('comment')}</button>
        <button id="notesButton" class="icon-control" aria-label="${t('main.expand_footnotes')}" data-i18n-aria-label="main.expand_footnotes" aria-controls="notesDrawer" aria-expanded="false" aria-pressed="false" data-tooltip="${t('main.expand_footnotes')}" data-i18n-data-tooltip="main.expand_footnotes">${icon('notes')}</button>
      </div>
    </section>

    <footer class="statusbar">
      <span class="cursor-and-save"><span id="cursorStatus">${h("main.line_1_column_1")}</span><span id="saveIndicator" role="status"></span></span>
      <span id="stats"></span>
      <div class="body-zoom" role="group" aria-label="${t('main.body_zoom')}" data-i18n-aria-label="main.body_zoom">
        <button id="zoomOut" type="button" aria-label="${t('main.zoom_out')}" data-i18n-aria-label="main.zoom_out">−</button>
        <button id="zoomLevel" type="button" aria-haspopup="menu" aria-controls="zoomPopover" aria-expanded="false">100%</button>
        <button id="zoomIn" type="button" aria-label="${t('main.zoom_in')}" data-i18n-aria-label="main.zoom_in">+</button>
      </div>
      <button id="focusButton" class="status-button icon-control" aria-label="${t("main.focus_mode")}" data-i18n-aria-label="main.focus_mode" data-tooltip="${t("main.focus_mode_press_esc_to_exit")}" data-i18n-data-tooltip="main.focus_mode_press_esc_to_exit">${icon('focus', 15)}</button>
    </footer>

    <div id="dropOverlay" class="drop-overlay">${h("main.drop_to_open_a_markdown_file")}</div>

    <section id="zoomPopover" class="popover action-popover zoom-popover" role="menu" aria-label="${t('main.body_zoom')}" data-i18n-aria-label="main.body_zoom" hidden>
      ${BODY_ZOOM_LEVELS.map(level => `<button type="button" role="menuitemradio" data-zoom="${level}" aria-checked="${level === 100}">${level}%</button>`).join('')}
      <div class="zoom-menu-divider" role="separator"></div>
      <button type="button" role="menuitem" data-zoom="100">${h('main.zoom_reset')}<kbd>⇧⌘0</kbd></button>
    </section>

    <section id="appearancePopover" class="popover appearance-popover" role="dialog" aria-label="${t("main.settings_ui0078")}" data-i18n-aria-label="main.settings_ui0078" tabindex="-1" hidden>
      <div class="settings-heading"><h2>${h("main.settings_ui0078")}</h2><button id="settingsClose" aria-label="${t("main.close_settings")}" data-i18n-aria-label="main.close_settings">${icon('close')}</button></div>
      <div class="settings-tabs" role="tablist" aria-label="${t("main.settings_categories")}" data-i18n-aria-label="main.settings_categories">
        <button id="settingsTab-appearance" role="tab" data-settings-tab="appearance" aria-controls="settingsPanel-appearance">${h("main.appearance_typography")}</button>
        <button id="settingsTab-recovery" role="tab" data-settings-tab="recovery" aria-controls="settingsPanel-recovery">${h("main.saving_recovery")}</button>
        <button id="settingsTab-ai" role="tab" data-settings-tab="ai" aria-controls="settingsPanel-ai">${h('ai.settings')}</button>
      </div>
      <div class="appearance-scroll" tabindex="-1">
      <section id="settingsPanel-appearance" role="tabpanel" aria-labelledby="settingsTab-appearance" data-settings-panel="appearance">
      <fieldset class="appearance-group" aria-label="${t("main.theme")}" data-i18n-aria-label="main.theme">
      <label class="setting-row"><span>${h("main.theme")}</span>
        <span class="ui-select"><select id="themeSelect"><option value="system" data-i18n="main.system_default">${t("main.system_default")}</option><option value="light" data-i18n="main.light">${t("main.light")}</option><option value="dark" data-i18n="main.dark">${t("main.dark")}</option></select>${icon('chevron', 16)}</span>
      </label>
      </fieldset>
      <fieldset class="appearance-group" aria-label="${t("main.body_typography")}" data-i18n-aria-label="main.body_typography">
      <div class="setting-row body-font-row"><span>${h('fonts.chinese')}</span>
        <span class="ui-select"><select id="chineseFontSelect" aria-label="${t('fonts.chinese')}" data-i18n-aria-label="fonts.chinese" aria-describedby="bodyFontStatus"></select>${icon('chevron', 16)}</span>
      </div>
      <div class="setting-row body-font-row"><span>${h('fonts.english')}</span>
        <span class="ui-select"><select id="englishFontSelect" aria-label="${t('fonts.english')}" data-i18n-aria-label="fonts.english" aria-describedby="bodyFontStatus"></select>${icon('chevron', 16)}</span>
      </div>
      <p id="bodyFontStatus" class="setting-hint body-font-status" role="status"></p>
      <label class="setting-slider"><span>${h("main.body_font_size")}</span><span class="slider-control"><input id="fontSizeInput" type="range" min="14" max="24" step="1" /><output id="fontSizeValue"></output></span></label>
      <label class="setting-slider"><span>${h("main.maximum_body_width")}</span><span class="slider-control"><input id="contentWidthInput" type="range" min="600" max="1100" step="20" /><output id="contentWidthValue"></output></span></label>
      </fieldset>
      </section>
      <section id="settingsPanel-recovery" role="tabpanel" aria-labelledby="settingsTab-recovery" data-settings-panel="recovery" hidden>
      ${desktop ? `<fieldset class="appearance-group" aria-label="${t("main.recovery_records")}" data-i18n-aria-label="main.recovery_records"><label class="setting-row"><span>${h("main.version_draft_retention")}</span><span class="ui-select"><select id="recoveryRetentionSelect" aria-label="${t("main.version_draft_retention")}" data-i18n-aria-label="main.version_draft_retention" disabled><option value="7" data-i18n="main.7_days">${t("main.7_days")}</option><option value="30" selected data-i18n="main.30_days">${t("main.30_days")}</option><option value="90" data-i18n="main.90_days">${t("main.90_days")}</option></select>${icon('chevron',16)}</span></label></fieldset>` : ''}
      <div class="settings-recovery-action"><button id="settingsRecovery" class="settings-action">${h(desktop ? "main.view_recoverable_drafts" : "main.restore_version_before_last_save")}</button></div>
      ${desktop ? '' : `<p class="setting-hint">${h("main.restoring_replaces_the_current_editor_content_and")}</p>`}
      </section>
      <section id="settingsPanel-ai" role="tabpanel" aria-labelledby="settingsTab-ai" data-settings-panel="ai" hidden>
        <h3 class="mcp-heading">${h('ai.heading')}</h3>
        <label class="setting-check ai-master"><input id="mcpEnabled" type="checkbox" disabled>${h('ai.master')}</label>
        <p class="setting-hint">${h('ai.access_boundary')}</p>
        <fieldset id="aiConnectionControls" class="ai-connection-controls" disabled>
        <label class="setting-row ai-client-row"><span>${h('ai.client')}</span><span class="ui-select"><select id="aiClient"><option value="chatgpt">ChatGPT</option><option value="claude-desktop">Claude Desktop</option><option value="workbuddy">WorkBuddy</option></select>${icon('chevron',16)}</span></label>
        <div class="ai-actions ai-config-actions"><button id="aiEditSetup" class="ai-button" hidden>${h('ai.edit_setup')}</button><button id="aiClear" class="ai-button ai-danger" disabled></button></div>
        <p id="aiConnectionError" class="setting-hint ai-error" role="alert"></p>
        <div id="aiLocalSetup" hidden><h4 id="aiClaudeManualTitle" class="ai-local-title" hidden></h4><ol class="setting-hint ai-local-steps"><li id="aiLocalStep1"></li><li id="aiLocalStep2"></li><li id="aiLocalStep3"></li></ol><div class="ai-actions ai-config-actions"><button id="aiLocalConfigure" class="ai-button ai-primary"></button></div><p id="aiLocalResult" class="setting-hint" role="status"></p></div>
        <div id="aiChatGPTSetup" class="ai-guided-card">
          <h4>${h('ai.guided_title')}</h4><p id="aiSavedStatus" class="setting-hint" role="status"></p>
          <ol class="ai-guided-steps">
            <li><label for="aiTunnelId">${h('ai.tunnel_id')}</label><p class="setting-hint">${h('ai.setup_at')} <a href="https://platform.openai.com/settings/organization/tunnels" data-ai-link>${h('ai.tunnel_link')}</a> ${h('ai.tunnel_help')}</p><input id="aiTunnelId" autocomplete="off" spellcheck="false" data-i18n-placeholder="ai.tunnel_placeholder" placeholder="${t('ai.tunnel_placeholder')}" disabled></li>
            <li><label for="aiTunnelProgram">${h('ai.program')}</label><div class="ai-input-row"><input id="aiTunnelProgram" readonly data-i18n-placeholder="ai.program_placeholder" placeholder="${t('ai.program_placeholder')}"><button id="aiPickProgram" class="ai-button" disabled>${h('ai.choose_program')}</button></div><div class="ai-device-row"><span id="aiDevice" class="setting-hint"></span><button id="aiRefreshDownload" class="ai-text-button">${h('ai.recheck')}</button></div><p id="aiDownloadStatus" class="setting-hint" role="status"></p><a id="aiDownload" href="https://github.com/openai/tunnel-client/releases/latest" data-ai-link>${h('ai.downloads')}</a><p id="aiProgramHelp" class="setting-hint"></p><details id="aiMacHelp" open><summary>${h('ai.mac_title')}</summary><p class="setting-hint">${h('ai.mac_help')}</p></details></li>
            <li><label for="aiTunnelProxy">${h('ai.proxy_label')}</label><input id="aiTunnelProxy" autocomplete="off" spellcheck="false" placeholder="${t('ai.proxy_placeholder')}" disabled><p class="setting-hint">${h('ai.proxy_help')}</p><label for="aiRuntimeKey">${h('ai.runtime_key')}</label><input id="aiRuntimeKey" type="password" autocomplete="off" spellcheck="false" disabled><p class="setting-hint">${h('ai.setup_at')} <a href="https://platform.openai.com/settings/organization/api-keys" data-ai-link>${h('ai.key_link')}</a> ${h('ai.key_help')}</p><p id="aiKeepKey" class="setting-hint" hidden>${h('ai.keep_key')}</p><div class="ai-actions"><button id="aiSaveSetup" class="ai-button ai-primary" disabled>${h('ai.save_setup')}</button><button id="aiCancelSetup" class="ai-button" hidden>${h('ai.cancel')}</button></div></li>
            <li><span class="ai-step-title">${h('ai.add_title')}</span><p class="setting-hint">${h('ai.add_help')}</p><p id="aiRuntimeStatus" class="setting-hint" role="status"></p><div class="ai-actions ai-add-actions"><button id="aiAddChatGPT" class="ai-button ai-primary" disabled>${h('ai.add_button')}</button><button id="aiCopyTunnel" class="ai-button" disabled>${h('ai.copy_tunnel')}</button></div><button id="aiRetryTunnel" class="ai-text-button ai-retry" hidden>${h('ai.retry_connection')}</button><details><summary>${h('ai.existing_title')}</summary><p class="setting-hint">${h('ai.existing_help')}</p></details></li>
          </ol>
          <details id="aiDiagnostics"><summary>${h('ai.diagnostics_title')}</summary><p class="setting-hint">${h('ai.diagnostics_help')}</p><pre id="aiDiagnosticsText" class="setting-hint" style="white-space:pre-wrap;overflow-wrap:anywhere"></pre><button id="aiCopyDiagnostics" class="ai-text-button">${h('ai.copy_diagnostics')}</button></details>
        </div>
        <details id="aiSetupHelp" class="ai-setup-help"><summary>${h('ai.help_title')}</summary><p class="setting-hint">${h('ai.help_hint')}</p><p class="setting-hint ai-setup-prompt">${h('ai.help_prompt')}</p><button id="aiCopyPrompt" class="ai-button">${h('ai.copy_prompt')}</button></details>
        <p id="aiActionStatus" class="setting-hint" role="status"></p>
        </fieldset>
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
setupBodyFontSettings({ root: shell });
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
const zoomPopover = document.querySelector('#zoomPopover');
const zoomLevelButton = document.querySelector('#zoomLevel');
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
  taskContainer: document.querySelector('#aiTaskNotice'),
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
  setText(statsElement, () => {const content=stripComments(state.content);return `${t('main.characters', { count: content.length })} · ${t('main.words', { count: content.split(/\s+/).filter(Boolean).length })}`;});
  desktopTitle(document.title);
  editor.setFileName(state.fileName);
}

function currentTheme() {
  if (state.theme !== 'system') return state.theme;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function updateAppearance() {
  document.documentElement.dataset.theme = currentTheme();
  shell.style.setProperty('--editor-font-size', `${state.fontSize}px`);
  shell.style.setProperty('--content-width', `${state.contentWidth}px`);
  document.querySelector('#themeSelect').value = state.theme;
  document.querySelector('#fontSizeInput').value = state.fontSize;
  document.querySelector('#fontSizeValue').textContent = `${state.fontSize}px`;
  document.querySelector('#contentWidthInput').value = state.contentWidth;
  document.querySelector('#contentWidthValue').textContent = `${state.contentWidth}px`;
  document.querySelector('#fileNameTitleToggle').checked = state.showFileNameTitle;
  document.querySelector('#lineNumberToggle').checked = state.showLineNumbers;
}

function updateZoomControls() {
  zoomLevelButton.textContent = `${state.bodyZoom}%`;
  setAttr(zoomLevelButton, 'aria-label', () => t('main.zoom_level', { percent: state.bodyZoom }));
  for (const [id, key, shortcut] of [['zoomIn', 'main.zoom_in', '⇧⌘='], ['zoomOut', 'main.zoom_out', '⇧⌘−']]) {
    setAttr(document.getElementById(id), 'data-tooltip', () => `${t(key)}  ${shortcutText(shortcut)}`);
  }
  document.querySelector('#zoomOut').disabled = state.bodyZoom === BODY_ZOOM_LEVELS[0];
  document.querySelector('#zoomIn').disabled = state.bodyZoom === BODY_ZOOM_LEVELS.at(-1);
  for (const button of zoomPopover.querySelectorAll('[role="menuitemradio"]')) button.setAttribute('aria-checked', String(Number(button.dataset.zoom) === state.bodyZoom));
}

let zoomRevision = 0;
function setBodyZoom(percent) {
  if (!BODY_ZOOM_LEVELS.includes(percent) || percent === state.bodyZoom || editor.view.composing) return;
  const view = editor.view;
  const snapshot = view.state;
  const revision = ++zoomRevision;
  const readingPosition = state.reading ? visibleReadingPosition() : null;
  const pane = state.reading ? null : view.scrollDOM.getBoundingClientRect();
  const caret = pane ? view.coordsAtPos(snapshot.selection.main.head) : null;
  const anchor = pane ? (view.hasFocus && caret && caret.top >= pane.top && caret.bottom <= pane.bottom
    ? snapshot.selection.main.head : editor.visiblePosition()) : null;
  const offset = pane ? (view.coordsAtPos(anchor)?.top ?? pane.top) - pane.top : 0;
  state.bodyZoom = percent;
  shell.style.setProperty('--body-zoom', String(percent / 100));
  updateZoomControls();
  if (readingPosition !== null) { syncReadingZoom(); revealReadingPosition(readingPosition); scheduleOutlineCurrent(); return; }
  // Measure at the new scale before correcting the scroll position. A display
  // change must not dispatch a document transaction or disturb its selection.
  // First let CodeMirror finish rebuilding its height map/viewport. Anchoring
  // in that same measurement is too early for a virtualized long document.
  view.requestMeasure({ key: setBodyZoom, read: () => null, write: () => requestAnimationFrame(() => {
    if (revision !== zoomRevision || state.reading || view.state.doc !== snapshot.doc || !view.state.selection.eq(snapshot.selection)) return;
    view.requestMeasure({ key: setBodyZoom, read: () => view.coordsAtPos(anchor), write: coords => {
      if (coords && revision === zoomRevision && !state.reading && view.state.doc === snapshot.doc && view.state.selection.eq(snapshot.selection)) {
        view.scrollDOM.scrollTop += (coords.top - view.scrollDOM.getBoundingClientRect().top - offset) / view.scaleY;
      }
      scheduleOutlineCurrent();
    }});
  })});
}

function runBodyZoom(action) {
  setBodyZoom(action === 'reset' ? 100 : stepBodyZoom(state.bodyZoom, action === 'in' ? 1 : -1));
}

updateZoomControls();
for (const [id, action] of [['zoomIn', 'in'], ['zoomOut', 'out']]) {
  const button = document.getElementById(id);
  button.addEventListener('mousedown', event => event.preventDefault());
  button.addEventListener('click', () => runBodyZoom(action));
}
zoomLevelButton.addEventListener('click', () => {
  const opening = zoomPopover.hidden;
  closePopovers();
  zoomPopover.hidden = !opening;
  zoomLevelButton.setAttribute('aria-expanded', String(opening));
  if (opening) {
    positionMenu(zoomPopover, zoomLevelButton.getBoundingClientRect());
    zoomPopover.querySelector('[aria-checked="true"]')?.focus({preventScroll: true});
  }
});
zoomPopover.addEventListener('click', event => {
  const button = event.target.closest('button[data-zoom]');
  if (!button) return;
  setBodyZoom(Number(button.dataset.zoom));
  closePopovers();
  zoomLevelButton.focus({preventScroll: true});
});
zoomPopover.addEventListener('keydown', event => {
  if (event.key === 'Escape' || event.key === 'Tab') {
    event.preventDefault(); event.stopPropagation(); closePopovers(); zoomLevelButton.focus({preventScroll: true});
  }
});
window.addEventListener('keydown', event => {
  if (event.defaultPrevented || shell.classList.contains('welcome-state') || !appearancePopover.hidden || !palette.hidden) return;
  const action = bodyZoomShortcut(event);
  if (!action) return;
  event.preventDefault(); event.stopImmediatePropagation();
  runBodyZoom(action);
}, true);

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
      if(state.reading||!editor.mutationAllowed())return;
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
const commentsButton = document.querySelector('#commentsButton');
const annotationRail = document.querySelector('#annotationRail');
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
function renderNotes() { renderFootnotes(); commentPanel?.render(); }
function renderFootnotes() {
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
  body.style.height = 'auto';
  body.closest('.note-card')?._noteEditor?.view.requestMeasure();
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
      mutationAllowed:()=>editor.mutationAllowed(),
      label:t('main.content_of_footnote',{note:row.number??row.label}),
      onChange: value => {
        card._noteUpdating=true;
        try { editor.setFootnoteBody(card._noteRow.label,value); }
        finally { card._noteUpdating=false; }
      },
      onUndo:()=>editor.undo(),onRedo:()=>editor.redo(),onLeave:()=>editor.focus()});
  }
  if(card._noteEditor) setAttr(card._noteEditor.view.contentDOM,'aria-label',()=>t('main.content_of_footnote',{note:card._noteRow.number??card._noteRow.label}));
  body.addEventListener('focusin', () => {
    if (card._noteRow.state === 'undefined' && !state.source && !state.reading) {
      editor.setFootnoteBody(card._noteRow.label, '');
    }
  });
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
  annotationRail.hidden = open;
  commentsButton.setAttribute('aria-expanded', String(open));
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
  if(!notesDrawer.classList.contains('visible'))commentPanel?.selectTab('notes');
  setNotesDrawer(!notesDrawer.classList.contains('visible'));
}

function revealNote(label) {
  commentPanel?.selectTab('notes');
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

let commentPanel=null;
let mutationGeneration=0,mcpBinding=null,mcpAuthorizationActive=false,nativeTestMode=null,nativeTestDelay=null,nativeTestPending=null,nativeTestRecovery=null,nativeTestRetirement=null,aiPresentationTask=null;
const editor = createLeafEditor({
  parent: document.querySelector('#editor'),
  doc: welcome,
  showLineNumbers: state.showLineNumbers,
  showBlankMarkers: state.showBlankMarkers,
  showFileNameTitle: state.showFileNameTitle,
  showHeadingNumbers: state.showHeadingNumbers,
  onAiTaskChange(task){
    mutationGeneration++;
    const previousTask=aiPresentationTask;
    aiPresentationTask=task;
    const client=({'chatgpt':'ChatGPT','claude-desktop':'Claude Desktop','workbuddy':'WorkBuddy'})[task?.client] ?? task?.client ?? 'AI';
    const notice=document.querySelector('#aiTaskNotice');
    const taskCopy=()=>t('ai.task_copy',{client});
    statusNotices.setTask(task?{text:taskCopy,stopLabel:()=>t('ai.end_editing'),stop:async()=>{
      const button=notice.querySelector('button');
      if(button.disabled)return;
      button.disabled=true;notice.setAttribute('aria-busy','true');notice.dataset.state='stopping';
      setAttr(notice,'aria-label',()=>t('ai.task_stopping'));
      try {await invoke('mcp_stop_edit',{taskId:task.task_id});}
      catch {
        if(aiPresentationTask?.task_id===task.task_id){
          button.disabled=false;notice.setAttribute('aria-busy','false');notice.dataset.state='running';
          setAttr(notice,'aria-label',()=>t('ai.stop_failed'));
          setText(document.querySelector('#statusAnnouncement'),()=>t('ai.stop_failed'));
        }
      }
    }}:null);
    notice.setAttribute('aria-busy','false');notice.dataset.state=task?'running':'ended';
    setAttr(notice,'aria-label',()=>t(task?'ai.task_running':'ai.task_ended'));
    if(!task&&previousTask){
      const receipt=desktopFileState()?.aiEditResult;
      const pending=receipt?.bufferResult.changed&&receipt?.diskResult.state!=='saved';
      notice.dataset.state=pending?'applied-pending-save':'ended';
      setText(document.querySelector('#statusAnnouncement'),()=>t(pending?'ai.task_pending_save':'ai.task_ended'));
    }
    if(task){
      const text=notice.querySelector('span');text.className='ai-task-copy';
      if(!notice.querySelector('.ai-task-lock')){const lock=document.createElement('span');lock.className='ai-task-lock';lock.setAttribute('aria-hidden','true');lock.innerHTML=icon('lock',16);notice.prepend(lock);}
      notice.querySelector('button').disabled=false;
    }
    updateHistoryControls();

  },
  onHumanMutation() {
    if(!mcpBinding||!mcpAuthorizationActive)return;
    const retired={...mcpBinding};
    mcpAuthorizationActive=false;
    mcpBinding={...mcpBinding,authorization_epoch:mcpBinding.authorization_epoch+1,client:null,scope:null};
    mutationGeneration++;

    // Broker gates independently check the live renderer across this IPC gap.
    if(desktop)invoke('mcp_retire_authorization',{sessionId:retired.session_id,authorizationEpoch:retired.authorization_epoch}).catch(()=>{});
  },
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
  onCommentActivate: id=>commentPanel?.reveal(id),
  onSave: () => saveFile(),
  onExport: exportPdf,
  onSaveAs: () => desktop ? desktopSave(true) : saveFile(),
  onOpen: () => openFile(),
  onCommandPalette: () => openPalette(),
});
editor.captureMutation=()=>({generation:mutationGeneration,document_id:mcpBinding?.document_id,session_id:mcpBinding?.session_id,authorization_epoch:mcpBinding?.authorization_epoch,native_generation:mcpBinding?.mutation_generation,...editor.mcpSnapshot()});
editor.assertMutationCurrent=token=>{
  const now=editor.captureMutation();
  if(!editor.mutationAllowed()||!token||['generation','document_id','session_id','authorization_epoch','native_generation','revision','content'].some(key=>token[key]!==now[key]))throw new Error('stale_mutation_context');
};
function showDocumentRecovery(options={}) {
  const context=editor.captureMutation();
  const restore=content=>desktopRestore(content,context);
  const pending=showRecovery({...options,restore});
  const observer=new MutationObserver(()=>{
    const dialog=document.querySelector('.recovery-dialog');
    if(!dialog){observer.disconnect();return;}
    let current=true;try{editor.assertMutationCurrent(context);}catch{current=false;}
    const apply=dialog.querySelector('[data-apply]');if(!current&&apply&&!apply.disabled){apply.disabled=true;apply.setAttribute('aria-description','AI editing');}
  });
  observer.observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['disabled','aria-readonly']});
  return pending;
}
let readingCommentFlashTimer;
commentPanel=setupCommentPanel({editor,getMode:()=>state.reading?'reading':state.source?'source':'edit',open:()=>setNotesDrawer(true),status:setStatus,locate:note=>{
  if(!state.reading){editor.goToComment(note.id);return;}
  editor.activateComment(note.id);
  clearTimeout(readingCommentFlashTimer);
  reader.querySelectorAll('.leaf-comment-range.active,.leaf-comment-located').forEach(el=>el.classList.remove('active','leaf-comment-located'));
  let target=reader.querySelector(`[data-comment-id="${note.id}"]`);
  if(!target){const at=note.from+(/\r\n/.test(state.content)?editor.view.state.doc.sliceString(0,note.from).split('\n').length-1:0);const blocks=readingBlocks();target=blocks.findLast(b=>b.from<=at)?.element??blocks[0]?.element;}
  if(!target){setStatus(translatedMessage('comments.no_reading_anchor'),'info');return;}
  target.classList.add(target.matches('.leaf-comment-range')?'active':'leaf-comment-located');target.scrollIntoView({block:'center'});
  if(note.kind==='hidden')readingCommentFlashTimer=setTimeout(()=>target.classList.remove('leaf-comment-located'),1800);
}});
commentPanel.render();
setupCommentContext({editor,add:()=>commentPanel.add(),desktop,invoke,editable:()=>!state.reading&&!shell.classList.contains('welcome-state')});

updateHeadingControl(editor.headingLevel());

const writing = setupWriting({ editor, desktop, invoke:async(command,args)=>{
  if(nativeTestMode && command==='import_attachment' && nativeTestDelay){nativeTestDelay.started=true;await nativeTestDelay.promise;}
  return invoke(command,args);
}, icon, status: setStatus,
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
  undoButton.disabled = !editor.mutationAllowed() || depth.undo === 0;
  redoButton.disabled = !editor.mutationAllowed() || depth.redo === 0;
}

const readingPane = document.querySelector('#readingPane');
const reader = readingPane.querySelector('article');
function syncReadingZoom() {
  readingPane.querySelector('.reading-zoom-frame').style.height = `${reader.offsetHeight * state.bodyZoom / 100}px`;
}
reader.addEventListener('dblclick',event=>{if(event.target.closest('.leaf-file-name-title'))renameCurrentDocument();});
reader.addEventListener('keydown',event=>{if(event.target.matches('.leaf-file-name-title')&&['Enter',' '].includes(event.key)){event.preventDefault();renameCurrentDocument();}});
readingPane.addEventListener('scroll', scheduleOutlineCurrent, {passive: true});
readingPane.addEventListener('click', scheduleOutlineCurrent);
new ResizeObserver(scheduleOutlineCurrent).observe(readingPane);
new ResizeObserver(() => { syncReadingZoom(); scheduleOutlineCurrent(); }).observe(reader);
function renderReading() {
  scheduleOutlineCurrent();
  renderPrintDocument(reader,state.content,{name:state.fileName,numbered:state.showHeadingNumbers,properties:true,expandCallouts:false,fallbackTitle:false,fileNameTitle:state.showFileNameTitle,sourcePositions:true,annotations:true,annotationNotes:editor.comments().notes});
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
  syncReadingZoom();
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
  if (!editor.mutationAllowed()) throw new Error('document_locked');
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
  for (const popover of [appearancePopover, recentPopover, headingPopover, calloutPopover, modePopover, documentPopover, exportPopover, displayPopover, languagePopover, zoomPopover]) {
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
  zoomLevelButton.setAttribute('aria-expanded', String(!zoomPopover.hidden));
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
  {id:'comments.add',get name(){return t('comments.add');},get shortcut(){return commentShortcuts();},action:()=>commentPanel.add()},
  { id: 'main.zoom_in', get name() { return t('main.zoom_in'); }, shortcut: '⇧⌘=', action: () => runBodyZoom('in') },
  { id: 'main.zoom_out', get name() { return t('main.zoom_out'); }, shortcut: '⇧⌘−', action: () => runBodyZoom('out') },
  { id: 'main.zoom_reset', get name() { return t('main.zoom_reset'); }, shortcut: '⇧⌘0', action: () => runBodyZoom('reset') },
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
    { id: 'main.versions_drafts_ui0234', get name() { return t('main.versions_drafts_ui0234'); }, action: () => showDocumentRecovery({ invoke }) },
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
  ['main.insert_format', ['main.insert_image', 'main.insert_attachment', 'main.set_to_heading_1', 'main.bold_ui0226', 'main.italic_ui0227', 'main.highlight', 'main.inline_code', 'main.blockquote_ui0228', 'main.insert_footnote_ui0229', 'comments.add', 'main.insert_callout_ui0230', 'main.bulleted_list_ui0232', 'main.insert_table_ui0233']],
  ['main.view', ['main.display_options', 'main.cycle_view_mode', 'main.zoom_in', 'main.zoom_out', 'main.zoom_reset', 'main.show_or_hide_editing_marks', 'main.show_or_hide_outline', 'main.show_or_hide_footnotes', 'main.show_or_hide_source_line_numbers', 'main.toggle_focus_mode', 'main.toggle_light_dark_theme']],
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
commentsButton.addEventListener('click',()=>{commentPanel?.selectTab('comments');setNotesDrawer(true);});
document.querySelector('[data-close="notes"]').addEventListener('click', () => { setNotesDrawer(false); (document.querySelector('#commentsTab').getAttribute('aria-selected')==='true'?commentsButton:notesButton).focus(); });
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
  if (!['appearance', 'recovery', 'ai'].includes(tab)) tab = 'appearance';
  localStorage.setItem('leaf-settings-tab', tab);
  for (const button of appearancePopover.querySelectorAll('[data-settings-tab]')) {
    const active = button.dataset.settingsTab === tab;
    button.setAttribute('aria-selected', String(active)); button.tabIndex = active ? 0 : -1;
  }
  for (const panel of appearancePopover.querySelectorAll('[data-settings-panel]')) panel.hidden = panel.dataset.settingsPanel !== tab;
  appearanceScroll.scrollTop = 0;
  requestAnimationFrame(updateAppearanceScrollHint);
  if (tab === 'ai') {
    void refreshAiConnections();
    if (!aiDownloadStarted) {aiDownloadStarted=true;void refreshAiDownload();}
  }
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
const aiClients = ['chatgpt', 'claude-desktop', 'workbuddy'];
const aiClientNames = {'chatgpt':'ChatGPT','claude-desktop':'Claude Desktop','workbuddy':'WorkBuddy'};
const aiNode = id => document.getElementById(id);
const aiConnection = {profiles:null, tunnel:null, selected:'chatgpt', editing:true, executable:'', busy:false, read:0, platform:null, localInstall:null};
const aiOperation = () => crypto.randomUUID();
aiNode('aiConnectionControls').addEventListener('click',event=>{
  if(aiNode('aiConnectionControls').disabled) {event.preventDefault();event.stopImmediatePropagation();}
},true);
function acceptAiProfile(profile) {
  if (!profile || !aiClients.includes(profile.client) || !Number.isSafeInteger(profile.generation)) return;
  const old = aiConnection.profiles?.clients.find(p => p.client === profile.client);
  if (old && profile.generation < old.generation) return;
  if (aiConnection.profiles) aiConnection.profiles.clients = aiConnection.profiles.clients.map(p => p.client === profile.client ? profile : p);
}
function acceptAiTunnel(value) {
  if (!value?.profile || !value.runtime) return;
  const old = aiConnection.tunnel;
  const known = aiConnection.profiles?.clients.find(p => p.client === 'chatgpt');
  if (known && value.profile.generation < known.generation) return;
  if (old && (value.profile.generation < old.profile.generation || value.runtime.epoch < old.runtime.epoch)) return;
  aiConnection.tunnel = value;
  acceptAiProfile(value.profile);
}
function renderAiConnections() {
  const value = aiConnection, profiles = value.profiles;
  const profile = profiles?.clients.find(p => p.client === value.selected);
  const chatgpt = value.tunnel?.profile, runtime = value.tunnel?.runtime;
  aiNode('mcpEnabled').checked = !!profiles?.enabled;
  aiNode('mcpEnabled').disabled = !desktop || !profiles || value.busy;
  const controls=aiNode('aiConnectionControls');
  controls.disabled=!desktop || !profiles?.enabled || value.busy;
  for(const target of controls.querySelectorAll('a, summary')) {
    if(controls.disabled) {
      target.setAttribute('aria-disabled','true');target.tabIndex=-1;
      if(target.hasAttribute('href')) {target.dataset.aiHref=target.getAttribute('href');target.removeAttribute('href');}
    } else {
      target.removeAttribute('aria-disabled');target.removeAttribute('tabindex');
      if(target.dataset.aiHref) {target.setAttribute('href',target.dataset.aiHref);delete target.dataset.aiHref;}
    }
  }
  aiNode('aiClient').disabled = controls.disabled;
  for (const option of aiNode('aiClient').options) {
    const item = profiles?.clients.find(p => p.client === option.value);
    option.textContent = `${aiClientNames[option.value]} · ${t(item ? item.configured ? 'ai.configured' : 'ai.unconfigured' : 'ai.unknown')}`;
  }
  aiNode('aiClear').textContent = t('ai.clear', {client:aiClientNames[value.selected]});
  aiNode('aiClear').disabled = controls.disabled || !profile?.configured;
  aiNode('aiClear').hidden = !profile?.configured;
  aiNode('aiChatGPTSetup').hidden = value.selected !== 'chatgpt';
  aiNode('aiSetupHelp').hidden = value.selected !== 'chatgpt';
  aiNode('aiLocalSetup').hidden = value.selected === 'chatgpt';
  const windowsClaude=value.selected==='claude-desktop'&&value.platform?.os==='windows';
  aiNode('aiClaudeManualTitle').hidden=!windowsClaude;
  aiNode('aiClaudeManualTitle').textContent=t('ai.claude_manual_title');
  aiNode('aiLocalConfigure').textContent=windowsClaude?t('ai.claude_save_bundle'):t('ai.add_client',{client:value.selected==='claude-desktop'?'Claude':'WorkBuddy'});
  aiNode('aiLocalConfigure').disabled=controls.disabled||!profile;
  for(const [index,key] of ['step1','step2','step3'].entries()) aiNode(`aiLocalStep${index+1}`).textContent=t(`ai.${value.selected==='claude-desktop'?'claude':'workbuddy'}_${key}${windowsClaude&&index<2?'_windows':''}`);
  const installed=value.localInstall;
  aiNode('aiLocalResult').textContent=installed?t(installed.path?'ai.claude_bundle_saved':installed.client==='claude-desktop'?'ai.claude_added':'ai.workbuddy_added',{path:installed.path}):'';
  aiNode('aiSavedStatus').textContent = runtime?.saved_config ? t('ai.saved') : '';
  const cloudErrors={tunnel_network_proxy:'ai.cloud_network_error',tunnel_cloud_auth:'ai.cloud_auth_error',tunnel_cloud_poll_failed:'ai.cloud_poll_error',tunnel_cloud_delivery_failed:'ai.cloud_delivery_error',tunnel_health_unavailable:'ai.cloud_health_error',invalid_tunnel_proxy:'ai.proxy_invalid',tunnel_proxy_auto_config:'ai.proxy_auto_config',tunnel_system_proxy_unavailable:'ai.proxy_system_error'};
  const cloudError=cloudErrors[runtime?.last_error];
  const cloudState=cloudError?'cloud-error':runtime?.cloud_connected?'cloud-connected':runtime?.local_ready?'local-ready':runtime?.process?'starting':'stopped';
  aiNode('aiRuntimeStatus').textContent=[runtime?.local_ready?t('ai.local_ready'):t(runtime?.process?'ai.starting':'ai.stopped'),cloudError?t(cloudError):runtime?.cloud_connected?t('ai.cloud_connected'):runtime?.process?t('ai.cloud_waiting'):''].filter(Boolean).join(' ');
  aiNode('aiRuntimeStatus').dataset.state=cloudState;
  aiNode('aiRuntimeStatus').classList.toggle('ai-error',!!cloudError);
  const diagnostics={...value.tunnel?.diagnostics,tunnel:runtime?{local_ready:runtime.local_ready,cloud_connected:runtime.cloud_connected,cloud_state:runtime.cloud_state,proxy_source:runtime.proxy_source,consecutive_failures:runtime.consecutive_failures,http_status:runtime.http_status,tunnel_instance:runtime.tunnel_instance,last_error:runtime.last_error}:null};
  aiNode('aiDiagnosticsText').textContent=JSON.stringify(diagnostics,null,2);
  aiNode('aiCopyDiagnostics').disabled=controls.disabled||!value.tunnel?.diagnostics;
  if (runtime?.last_error&&!cloudError) showAiError(runtime.last_error);
  for (const id of ['aiTunnelId','aiRuntimeKey','aiTunnelProxy']) {
    aiNode(id).disabled = !desktop || !chatgpt || value.busy;
    aiNode(id).readOnly = !value.editing;
  }
  aiNode('aiPickProgram').disabled = !desktop || !chatgpt || !value.editing || value.busy;
  aiNode('aiPickProgram').hidden = !value.editing;
  aiNode('aiRuntimeKey').placeholder = t(chatgpt?.has_runtime_key ? 'ai.key_saved' : 'ai.key_placeholder');
  aiNode('aiKeepKey').hidden = !chatgpt?.has_runtime_key || !value.editing;
  aiNode('aiSaveSetup').hidden = !value.editing;
  aiNode('aiSaveSetup').disabled = !desktop || !chatgpt || value.busy || !value.executable || !aiNode('aiTunnelId').value.trim() || (!chatgpt?.has_runtime_key && !aiNode('aiRuntimeKey').value.trim());
  aiNode('aiEditSetup').hidden = value.selected !== 'chatgpt' || value.editing;
  aiNode('aiEditSetup').disabled = value.busy;
  aiNode('aiCancelSetup').hidden = !value.editing || !runtime?.saved_config;
  aiNode('aiCancelSetup').disabled = value.busy;
  aiNode('aiRetryTunnel').hidden = !profiles?.enabled || !runtime?.saved_config || !!runtime?.process || value.editing;
  aiNode('aiRetryTunnel').disabled = value.busy;
  aiNode('aiAddChatGPT').disabled = value.busy || !runtime?.cloud_connected || value.editing;
  aiNode('aiCopyTunnel').disabled = value.busy || !chatgpt?.tunnel?.tunnel_id || value.editing;
  const platform=value.platform;
  const chip=['aarch64','arm64'].includes(platform?.arch)?'arm64':['x86_64','amd64'].includes(platform?.arch)?'amd64':null;
  const device=chip&&['macos','windows','linux'].includes(platform?.os)?t(`ai.device_${platform.os}_${chip}`):t('ai.device_unknown');
  aiNode('aiDevice').textContent=t('ai.device',{device});
  aiNode('aiProgramHelp').textContent=t(platform?.os==='windows'?'ai.program_help_windows':platform?'ai.program_help':'ai.program_help_unknown');
  if(value.downloadName)aiNode('aiDownload').textContent=t('ai.download_file',{file:value.downloadName});
  aiNode('aiMacHelp').hidden = platform && platform.os !== 'macos';

  requestAnimationFrame(updateAppearanceScrollHint);
}
function restoreAiFields() {
  const config = aiConnection.tunnel?.profile.tunnel;
  aiNode('aiTunnelId').value = config?.tunnel_id || '';
  aiNode('aiTunnelProxy').value = config?.proxy_url || '';
  aiConnection.executable = config?.executable || '';
  aiNode('aiTunnelProgram').value = aiConnection.executable.split(/[\\/]/).at(-1) || '';
  aiNode('aiRuntimeKey').value = '';
}
function showAiError(error) {
  // Native failures may contain arbitrary OS/user text. Never echo credential
  // input or opaque diagnostics into DOM; the recoverable action is stable.
  const codes = new Set(['invalid_tunnel_proxy','tunnel_proxy_auto_config','tunnel_system_proxy_unavailable','invalid_tunnel_id','invalid_tunnel_executable','invalid_runtime_key','tunnel_unconfigured','tunnel_executable_missing','tunnel_cli_failed','tunnel_cli_rejected','tunnel_cli_init_rejected','tunnel_cli_init_timeout','tunnel_cli_doctor_rejected','tunnel_cli_doctor_timeout','mcp_preference_read','mcp_preference_invalid','mcp_preference_write','tunnel_cli_timeout','tunnel_cli_contract_changed','tunnel_profile_changed','tunnel_profile_reconfigure_required','tunnel_profile_unavailable','tunnel_profile_write','tunnel_spawn_failed','tunnel_start_timeout','tunnel_exited','stale_configuration','credential_unavailable','runtime_key_unavailable','runtime_key_required','runtime_gui_only','invalid_runtime_reference','connection_disabled','helper_not_installed']);
  const code = codes.has(String(error)) ? String(error) : 'connection_failed';
  aiNode('aiConnectionError').dataset.failure = String(error).startsWith('invalid args') ? 'ipc_invalid_args' : /(?:not found|unknown command|Unknown IPC)/.test(String(error)) ? 'ipc_missing' : code;
  aiNode('aiConnectionError').textContent = ['invalid_tunnel_proxy','tunnel_proxy_auto_config','tunnel_system_proxy_unavailable'].includes(String(error))?t({'invalid_tunnel_proxy':'ai.proxy_invalid','tunnel_proxy_auto_config':'ai.proxy_auto_config','tunnel_system_proxy_unavailable':'ai.proxy_system_error'}[String(error)]):['install_write','invalid_export_path'].includes(String(error))?t('ai.claude_save_failed'):t('ai.error', {code});
}
async function refreshAiConnections() {
  if (!desktop) {aiNode('aiConnectionError').textContent = t('ai.desktop_required'); renderAiConnections(); return;}
  if (aiConnection.busy) return;
  const serial = ++aiConnection.read;
  try {
    const [profiles, tunnel] = await Promise.all([invoke('mcp_profiles'), invoke('mcp_tunnel_status')]);
    if (serial !== aiConnection.read || aiConnection.busy) return;
    if (!profiles?.clients || profiles.clients.length !== 3) throw new Error('profiles_unavailable');
    const initial = !aiConnection.profiles;
    if (initial) aiConnection.profiles = profiles;
    else {aiConnection.profiles.enabled = profiles.enabled; for (const profile of profiles.clients) acceptAiProfile(profile);}
    acceptAiTunnel(tunnel);
    const startupError=Object.values(profiles.connection_errors || {})[0];
    if (startupError) showAiError(startupError);
    if (initial) {aiConnection.editing = !tunnel.runtime.saved_config; restoreAiFields();}
    renderAiConnections();
  } catch (error) {if (serial === aiConnection.read) {showAiError(error); renderAiConnections();}}
}
async function runAiAction(action, {masterSwitch=false}={}) {
  if (aiConnection.busy || !desktop || (!masterSwitch&&!aiConnection.profiles?.enabled)) return false;
  aiConnection.busy = true; ++aiConnection.read;
  aiNode('aiConnectionError').textContent = ''; aiNode('aiActionStatus').textContent = t('ai.working'); renderAiConnections();
  try {await action(); aiNode('aiActionStatus').textContent = ''; return true;}
  catch (error) {showAiError(error); aiNode('aiActionStatus').textContent = ''; return false;}
  finally {aiConnection.busy = false; renderAiConnections();}
}
aiNode('aiClient').addEventListener('change', () => {
  aiConnection.selected = aiNode('aiClient').value; aiConnection.localInstall=null;
  aiNode('aiRuntimeKey').value = ''; aiNode('aiConnectionError').textContent = ''; aiNode('aiActionStatus').textContent = ''; renderAiConnections();
});
aiNode('mcpEnabled').addEventListener('change', () => {
  const desired = aiNode('mcpEnabled').checked;
  aiNode('mcpEnabled').checked = !!aiConnection.profiles?.enabled;
  void runAiAction(async () => {
    aiConnection.profiles = await invoke('mcp_set_enabled', {enabled:desired});
    acceptAiTunnel(await invoke('mcp_tunnel_status'));
    if (desired) await enableConfiguredAiConnections();
  },{masterSwitch:true});
});
aiNode('aiPickProgram').onclick = () => {void runAiAction(async () => {
  const path = await pickNativeFile({multiple:false, title:t('ai.choose_program')});
  if (typeof path === 'string') {aiConnection.executable = path; aiNode('aiTunnelProgram').value = path.split(/[\\/]/).at(-1);}
});};
for (const id of ['aiTunnelId','aiRuntimeKey','aiTunnelProxy']) aiNode(id).addEventListener('input', renderAiConnections);
aiNode('aiSaveSetup').onclick = () => {
  const runtimeKey = aiNode('aiRuntimeKey').value;
  aiNode('aiRuntimeKey').value = ''; // Input is ephemeral, including failures.
  void runAiAction(async () => {
    const value = await invoke('mcp_configure_tunnel', {tunnelId:aiNode('aiTunnelId').value.trim(), executable:aiConnection.executable, runtimeKey, proxyUrl:aiNode('aiTunnelProxy').value.trim(), operationId:aiOperation(), generation:aiConnection.tunnel.profile.generation});
    acceptAiTunnel(value); aiConnection.editing = false; restoreAiFields();
    if (aiConnection.profiles?.enabled) await enableConfiguredAiConnections();
  });
};
aiNode('aiEditSetup').onclick = () => {aiConnection.editing = true; renderAiConnections(); aiNode('aiTunnelId').focus();};
aiNode('aiCancelSetup').onclick = () => {aiConnection.editing = false; restoreAiFields(); renderAiConnections(); aiNode('aiEditSetup').focus();};
async function enableConfiguredAiConnections() {
  let failure;
  for (const profile of aiConnection.profiles.clients.filter(p=>p.configured && !p.enabled)) {
    try {
      const result = await invoke('mcp_enable_client', {client:profile.client, operationId:aiOperation(), generation:profile.generation});
      acceptAiProfile(result.profile);
    } catch (error) {failure ??= error;}
  }
  try {if (aiConnection.tunnel?.runtime.saved_config) acceptAiTunnel(await invoke('mcp_start_tunnel'));}
  catch (error) {failure ??= error;}
  failure ??= Object.values(aiConnection.profiles.connection_errors || {})[0];
  if (failure) throw failure;
}
aiNode('aiRetryTunnel').onclick = () => {void runAiAction(enableConfiguredAiConnections);};
aiNode('aiLocalConfigure').onclick = () => {const client=aiConnection.selected;void runAiAction(async()=>{
  aiConnection.localInstall=null;
  aiNode('aiLocalResult').textContent='';
  const result=await invoke('mcp_add_client',{client,language:currentLanguage()});
  if(result.cancelled)return;
  acceptAiProfile(result.profile);
  aiConnection.localInstall={client,path:result.bundle_path};
});};
async function copyAiText(text) {
  try {await navigator.clipboard.writeText(text); aiNode('aiActionStatus').textContent = t('ai.copied');}
  catch {aiNode('aiConnectionError').textContent = t('ai.copy_failed');}
}
aiNode('aiCopyDiagnostics').onclick=()=>{void copyAiText(aiNode('aiDiagnosticsText').textContent);};
aiNode('aiCopyTunnel').onclick = () => {void copyAiText(aiConnection.tunnel.profile.tunnel.tunnel_id);};
aiNode('aiCopyPrompt').onclick = () => {void copyAiText(t('ai.help_prompt'));};
function validAiSetupLink(url) {
  return ['https://platform.openai.com/settings/organization/tunnels','https://platform.openai.com/settings/organization/api-keys','https://github.com/openai/tunnel-client/releases/latest','https://chatgpt.com/plugins'].includes(url) || /^https:\/\/github\.com\/openai\/tunnel-client\/releases\/download\/v[\w.+-]+\/tunnel-client-v[\w.+-]+-(darwin|windows|linux)-(arm64|amd64)\.zip$/.test(url);
}
async function openAiSetupLink(url) {
  if (!validAiSetupLink(url)) return;
  if (!desktop) {window.open(url, '_blank', 'noopener,noreferrer'); return;}
  try {await invoke('open_link', {target:url});} catch {aiNode('aiConnectionError').textContent = t('ai.open_failed', {url});}
}
for (const link of document.querySelectorAll('[data-ai-link]')) link.onclick = event => {event.preventDefault(); void openAiSetupLink(link.href);};
aiNode('aiAddChatGPT').onclick = () => {void openAiSetupLink('https://chatgpt.com/plugins');};
let aiDownloadRead = 0;
async function refreshAiDownload() {
  const serial = ++aiDownloadRead;
  aiConnection.downloadName=null;
  aiNode('aiRefreshDownload').disabled = true; aiNode('aiDownload').href = 'https://github.com/openai/tunnel-client/releases/latest';
  aiNode('aiDownload').textContent = t('ai.downloads'); aiNode('aiDownloadStatus').textContent = t('ai.checking');
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const platform = desktop ? await invoke('mcp_connection_platform') : null;
    aiConnection.platform = platform;
    renderAiConnections();
    const response = await fetch('https://api.github.com/repos/openai/tunnel-client/releases/latest', {credentials:'omit',referrerPolicy:'no-referrer',redirect:'error',cache:'no-store',signal:controller.signal,headers:{Accept:'application/vnd.github+json'}});
    if (!response.ok) throw new Error('release_unavailable');
    const release = await response.json();
    if (serial !== aiDownloadRead) return;
    const os = platform?.os === 'macos' ? 'darwin' : platform?.os;
    const arch = platform?.arch === 'aarch64' ? 'arm64' : platform?.arch === 'x86_64' ? 'amd64' : platform?.arch;
    const name = `tunnel-client-${release.tag_name}-${os}-${arch}.zip`;
    const matches = Array.isArray(release.assets) ? release.assets.filter(a => a.name === name && a.state === 'uploaded' && validAiSetupLink(a.browser_download_url)) : [];
    if (release.draft !== false || release.prerelease !== false || matches.length !== 1) {aiNode('aiDownloadStatus').textContent = t('ai.download_missing'); return;}
    aiConnection.downloadName=name;
    aiNode('aiDownload').href = matches[0].browser_download_url; aiNode('aiDownload').textContent = t('ai.download_file', {file:name}); aiNode('aiDownloadStatus').textContent = '';
  } catch {if (serial === aiDownloadRead) aiNode('aiDownloadStatus').textContent = t('ai.download_failed');}
  finally {clearTimeout(timeout); if (serial === aiDownloadRead) {aiNode('aiRefreshDownload').disabled = false; renderAiConnections();}}
}
aiNode('aiRefreshDownload').onclick = () => {void refreshAiDownload();};
let aiDownloadStarted = false;
if (desktop) void listenNative('leaf-mcp-connections-changed', () => {void refreshAiConnections();});
setInterval(() => {if (!appearancePopover.hidden && !aiNode('settingsPanel-ai').hidden) void refreshAiConnections();}, 4000);
window.addEventListener('focus', () => {if (!appearancePopover.hidden && !aiNode('settingsPanel-ai').hidden) void refreshAiConnections();});
onLanguageChange(renderAiConnections);
aiNode('aiClear').onclick = () => {
  if(aiNode('aiConnectionControls').disabled)return;
  const client = aiConnection.selected, opener = aiNode('aiClear');
  const dialog = document.createElement('dialog'); dialog.className = 'ai-clear-dialog close-document-dialog';
  dialog.setAttribute('aria-labelledby', 'aiClearTitle'); dialog.setAttribute('aria-describedby','aiClearDescription');
  dialog.innerHTML = `<h2 id="aiClearTitle">${h('ai.clear', {client:aiClientNames[client]})}</h2><p id="aiClearDescription">${h('ai.clear_help', {client:aiClientNames[client]})}</p><p>${h('ai.clear_remote')}</p><p id="aiClearError" class="ai-error" role="alert"></p><footer><button class="ai-button" data-ai-cancel>${h('ai.cancel')}</button><button class="ai-button ai-danger" data-ai-confirm>${h('ai.clear', {client:aiClientNames[client]})}</button></footer>`;
  document.body.append(dialog); dialog.showModal(); dialog.querySelector('[data-ai-cancel]').focus();
  dialog.addEventListener('pointerdown', event => event.stopPropagation());
  dialog.addEventListener('mousedown', event => event.stopPropagation());
  dialog.addEventListener('click', event => event.stopPropagation());
  let deleting = false;
  const close = () => {dialog.close(); dialog.remove(); (opener.isConnected && !opener.disabled ? opener : aiNode('aiClient')).focus();};
  dialog.addEventListener('cancel', event => {event.preventDefault(); if (!deleting) close();});
  dialog.querySelector('[data-ai-cancel]').onclick = close;
  dialog.querySelector('[data-ai-confirm]').onclick = async () => {
    if (deleting) return; deleting = true;
    for (const button of dialog.querySelectorAll('button')) button.disabled = true;
    const success = await runAiAction(async () => {
      acceptAiProfile(await invoke('mcp_revoke_client', {client, clear:true, operationId:aiOperation()}));
      if (client === 'chatgpt') {acceptAiTunnel(await invoke('mcp_tunnel_status')); aiConnection.editing = true; restoreAiFields();}

    });
    deleting = false;
    if (success) close(); else {dialog.querySelector('#aiClearError').textContent = t('ai.clear_failed'); for (const button of dialog.querySelectorAll('button')) button.disabled = false; dialog.querySelector('[data-ai-cancel]').focus();}
  };
};
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
  if (desktop) return showDocumentRecovery({invoke, drafts:!current});
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
    if (panel.hidden || panel.contains(document.activeElement) || (panel === appearancePopover && document.querySelector('.ai-clear-dialog[open]'))) return;
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
document.querySelector('#recoveryNotice').addEventListener('click', () => showDocumentRecovery({ invoke, drafts: false }));
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
    const note=document.activeElement.closest?.('.note-card, .leaf-endnote')?._noteEditor;
    if(note && !(button.dataset.format==='footnote' && document.activeElement.closest('.leaf-endnote')))note.format(button.dataset.format);else editor.format(button.dataset.format);
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
    if (!event.target.closest('.quick-language-button') && !event.target.closest('.popover') && !event.target.closest('#readingToggle') && !event.target.closest('#appearanceButton') && !event.target.closest('#welcomeSettings') && !event.target.closest('#recentButton') && !event.target.closest('#welcomeRecentButton') && !event.target.closest('#headingButton') && !event.target.closest('#documentMenuButton') && !event.target.closest('#exportMenuButton') && !event.target.closest('#displayButton') && !event.target.closest('#zoomLevel')) closePopovers();
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

window.addEventListener('leaf-body-fonts-change', () => {
  editor.view.requestMeasure();
  for (const body of notesDrawer.querySelectorAll('.note-body')) fitNoteBody(body);
  for (const table of editor.view.dom.querySelectorAll('.leaf-table')) table._resizeCells?.();
  for (const input of editor.view.dom.querySelectorAll('.leaf-callout-widget textarea:focus, .footnote-box textarea:focus')) {
    input.style.height = 'auto'; input.style.height = `${Math.max(30, input.scrollHeight)}px`;
  }
});
updateAppearance();
updateDocumentChrome();
updateHistoryControls();
renderOutline(welcome);
renderRecentFiles();

// macOS routes Cmd-Z through the application menu, so the shortcut never
// reaches the editor's own history binding. The menu event comes back here:
// the editor and its footnote popup answer for document history. Other plain
// inputs (document properties, callouts, search) keep the native undo manager.
function runHistory(action) {
  if (!editor.mutationAllowed()) return;
  const active = document.activeElement;
  if (active?.closest('.cm-editor') || editor.ownsHistoryTarget(active) || commentPanel?.ownsHistoryTarget(active)) { editor[action](); return; }
  try { document.execCommand(action); } catch { /* No native history for this target. */ }
}

if (desktop) {
  // Browser file handles cannot be shared with the desktop filesystem layer.
  document.querySelector('#recentButton').hidden = true;
  setupWelcomeRecovery({ invoke, welcome: welcomeScreen });
  shell.style.pointerEvents = 'none';
  editor.setReading(true);
  initDesktop({
    mutationAllowed:()=>editor.mutationAllowed(),
    captureMutation:()=>editor.captureMutation(),
    assertMutationCurrent:context=>editor.assertMutationCurrent(context),
    menuCurrent:binding=>binding&&mcpBinding&&['document_id','session_id','authorization_epoch','mutation_generation'].every(key=>binding[key]===mcpBinding[key]),
    content: () => state.content,
    saveContext:()=>mcpBinding ? {...mcpBinding,...editor.mcpSnapshot()} : null,
    loadedImages: () => loadedLocalImagePaths(),
    retryMissingImages: () => retryMissingImages(),
    dirty: () => state.content !== state.savedContent,
    status: setStatus,
    recoveryAvailable: statusNotices.recoveryAvailable,
    load: (content, name, path) => { state.resourcePath = path; return setDocument(content, name); },
    recovery: () => showDocumentRecovery({ invoke, drafts: !welcomeScreen.hidden }),
    restore: (content,context) => { if(context)editor.assertMutationCurrent(context);if(!editor.mutationAllowed())throw new Error('document_locked');clearTimeout(state.saveTimer); editor.restoreValue(content); if (state.reading) renderReading(); },
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
    addComment:()=>commentPanel.add(),
    undo: () => runHistory('undo'),
    redo: () => runHistory('redo'),
    clipboard:command=>{if(editor.mutationAllowed())document.execCommand(command);},
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
    const testMode=await invoke('mcp_test_mode').catch(()=>null);
    nativeTestMode=testMode;
    const hiddenTestMutations=new Set();
    await listenNative('leaf-mcp-editor',async ({payload})=>{
      let reply;
      try {
        const {operation,args}=payload;
        let result;
        // Feature-gated native fixture: deliver a human mutation in the second
        // callback, after authorization ACK, while the broker still owns its queue.
        if(testMode&&operation==='snapshot'&&nativeTestRetirement?.checked) {
          const mutation=nativeTestRetirement;nativeTestRetirement=null;
          if(mutation.action==='undo')editor.undo();else editor.restoreValue(mutation.content);
        }
        if(['authorization','begin'].includes(operation)||['snapshot','reader_snapshot'].includes(operation)&&args.session_id) {
          if(!mcpAuthorizationActive||mcpBinding?.document_id!==args.document_id||mcpBinding?.session_id!==args.session_id||mcpBinding?.authorization_epoch!==args.authorization_epoch)throw new Error('not_authorized');
        }
        if(['binding','begin','finish'].includes(operation)&&mcpBinding?.session_id===args.session_id&&args.authorization_epoch<mcpBinding.authorization_epoch)throw new Error('stale_projection');
        if(operation==='authorization'){result={authorized:true};if(testMode&&nativeTestRetirement)nativeTestRetirement.checked=true;}
        else if(operation==='access_snapshot'){
          if(mcpBinding?.document_id!==args.document_id||mcpBinding?.session_id!==args.session_id)throw new Error('stale_session');
          result={...editor.mcpSnapshot(),name:state.fileName,binding_epoch:mcpBinding.authorization_epoch,access_active:mcpAuthorizationActive};
        }
        else if(operation==='snapshot')result=editor.mcpSnapshot();
        else if(operation==='reader_snapshot')result={...editor.mcpSnapshot(),name:state.fileName,saved:state.savedContent===editor.getValue(),language:currentLanguage(),theme:currentTheme()};
        else if(operation==='comment_query')result=await handleMcpCommentQuery(args);
        else if(operation==='binding'){if(args.revision!==undefined&&args.revision!==editor.mcpSnapshot().revision)throw new Error('stale_revision');mcpBinding=args;mcpAuthorizationActive=args.revision!==undefined;mutationGeneration++;result=editor.mcpSnapshot();}
        else if(operation==='begin'){if(desktopFileState()?.paused)throw new Error('document_conflict_pending');result=editor.beginAiTask(args);mcpBinding=args;}
        else if(operation==='apply') {
          if(testMode && args.test_fault==='before-dispatch')throw new Error('test_before_dispatch');
          const realClock=Date.now;
          if(testMode && args.test_clock!==undefined) Date.now=()=>Number(args.test_clock);
          try {result=args.operations?.some(operation=>operation?.kind==='comment')?await planAndApplyMcpCommentBatch(args):await editor.applyMcpBatch(args);}finally{Date.now=realClock;}
          desktopAiApplied(result);
          if(testMode && ['drop-ack','unknown-receipt'].includes(args.test_fault)) {
            if(args.test_fault==='unknown-receipt')hiddenTestMutations.add(args.mutation_id);
            // Receipt is already committed. Drop only this production IPC ack.
            return;
          }
        }
        else if(operation==='finish'){result=editor.finishAiTask(args);mcpBinding={...mcpBinding,mutation_generation:args.mutation_generation};}
        else if(operation==='query_renderer_mutation')result=hiddenTestMutations.has(args.mutation_id)?null:editor.queryRendererMutation(args.mutation_id);
        else if(operation==='test' && testMode) {
          if(args.clock!==undefined) {
            const nativeClock=Date.now;
            // Only the feature-gated driver can advance the renderer clock.
            Date.now=()=>Number(args.clock);
            queueMicrotask(()=>{Date.now=nativeClock;});
          }
          if(args.action==='reset') await setDocument(args.content,'Synthetic MCP.md');
          else if(args.action==='save') result={saved:await desktopSave(false,false),...desktopFileState()};
          else if(args.action==='session-state') result=desktopFileState();
          else if(args.action==='pause-auto-timer') {clearTimeout(state.saveTimer);result={paused_timer:true};}
          else if(args.action==='undo') editor.undo();
          else if(args.action==='redo') editor.redo();
          else if(args.action==='retire-between-read-callbacks') {
            if(!['undo','human'].includes(args.mutation))throw new Error('invalid_test_retirement');
            nativeTestRetirement={action:args.mutation,content:args.content,checked:false};result={armed:true};
          }
          else if(args.action==='human') editor.restoreValue(args.content);
          else if(args.action==='ai-settings-configure') {
            openSettings('ai'); await refreshAiConnections();
            if (!aiConnection.profiles) throw new Error('native_ui_profiles_missing');
            aiNode('mcpEnabled').click();
            while(aiConnection.busy) await new Promise(resolve=>setTimeout(resolve,10));
            aiConnection.executable=args.executable;
            aiNode('aiTunnelProgram').value='tunnel-client';
            aiNode('aiTunnelId').value=`tunnel_${'a'.repeat(32)}`;
            aiNode('aiRuntimeKey').value='synthetic-tunnel-key-sentinel';
            renderAiConnections(); aiNode('aiSaveSetup').click();
            while(aiConnection.busy) await new Promise(resolve=>setTimeout(resolve,10));
            if (aiNode('aiConnectionError').textContent) throw new Error(`native_ui_configure_failed: ${aiNode('aiConnectionError').dataset.failure}`);
            for(const client of ['claude-desktop','workbuddy']) {
              const old=aiConnection.profiles.clients.find(p=>p.client===client);
              const configured=await invoke('mcp_configure_client',{client,operationId:aiOperation(),generation:old.generation});acceptAiProfile(configured);
              const result=await invoke('mcp_enable_client',{client,operationId:aiOperation(),generation:configured.generation});acceptAiProfile(result.profile);
            }
            aiNode('aiClient').value='chatgpt'; aiNode('aiClient').dispatchEvent(new Event('change'));
            result={key_empty:aiNode('aiRuntimeKey').value==='',master:aiNode('mcpEnabled').checked,state:aiNode('aiRuntimeStatus').dataset.state,configured_badges:[...aiNode('aiClient').options].filter(option=>option.textContent.endsWith(t('ai.configured'))).length};
          }
          else if(args.action==='ai-settings-clear') {
            aiNode('aiClear').click();document.querySelector('[data-ai-confirm]').click();
            while(aiConnection.busy) await new Promise(resolve=>setTimeout(resolve,10));
            result={key_empty:aiNode('aiRuntimeKey').value==='',focus:document.activeElement.id};
          }
          else if(args.action==='close-ai-settings') {closeSettings();result={closed:appearancePopover.hidden};}
          else if(args.action==='selection') editor.view.dispatch({selection:{anchor:args.anchor,head:args.head??args.anchor}});
          else if(args.action==='ai-settings-authorize') {
            const snapshot=editor.mcpSnapshot();
            result=await invoke('mcp_authorize',{sessionId:mcpBinding.session_id,client:args.client,scope:{from:0,to:snapshot.content.length},revision:snapshot.revision});
          }
          else if(args.action==='delay-attachment') {
            let release;const promise=new Promise(resolve=>{release=resolve;});
            nativeTestDelay={promise,release,started:false};
            nativeTestPending=writing.attachments(args.files,false);
            nativeTestRecovery=editor.captureMutation();
          }
          else if(args.action==='delay-status')result={started:nativeTestDelay?.started===true};
          else if(args.action==='release-attachment'){nativeTestDelay.release();await nativeTestPending;nativeTestDelay=null;}
          else if(args.action==='late-recovery')await desktopRestore('forbidden late recovery',nativeTestRecovery);
          else if(args.action==='native-stop'){await invoke('mcp_stop_edit',{taskId:args.task_id});}
          else if(args.action==='entrance') {
            const before=editor.mcpSnapshot();
            if(args.entrance==='body')editor.view.dispatch({changes:{from:0,insert:'forbidden'},userEvent:'input.type'});
            else if(args.entrance==='source'){editor.setSource(true);editor.view.dispatch({changes:{from:0,insert:'forbidden'},userEvent:'input'});editor.setSource(false);}
            else if(args.entrance==='properties')editor.createProperties();
            else if(args.entrance==='footnote')editor.setFootnoteBody('1','forbidden');
            else if(args.entrance==='table')editor.view.dispatch({changes:{from:before.content.indexOf('one'),to:before.content.indexOf('one')+3,insert:'forbidden'},filter:false,userEvent:'input.table'});
            else if(args.entrance==='comment'){const note=editor.comments().notes[0];if(!note)throw new Error('synthetic_comment_absent');editor.setCommentBody(note.id,'forbidden');}
            else if(args.entrance==='writing')writing.editLink();
            else if(args.entrance==='recovery')await desktopRestore('forbidden');
            else if(args.entrance==='attachment')await writing.attachments(args.files,false);
            else throw new Error('unknown_test_entrance');
          }
          result ??= {...editor.mcpSnapshot(),history:editor.historyDepth(),task_api:typeof editor.beginAiTask==='function'};
        } else throw new Error('unknown_bridge_operation');
        reply={result};
      } catch(error) {
        reply={error:String(error.message||'renderer_error')};
        if(payload.operation==='apply' && editor.mcpSnapshot().revision===payload.args.revision)reply.mutation_state='UNAPPLIED';
      }
      await invoke('mcp_renderer_reply',{callId:payload.call_id,reply}).catch(()=>{});
    });
    if(welcomeScreen.hidden) mcpBinding=await invoke('mcp_register');
    if(testMode && testMode!=='passive') {
      const report=await invoke('mcp_test_run',{mode:testMode}).catch(()=>({pass:false,failure:'native driver failure'}));
      await invoke('mcp_test_report',{report});
    }
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
  updateZoomControls();
  updateDocumentChrome(); updateModeControl(); updateHeadingControl(editor.headingLevel());
  if (!palette.hidden) renderPalette(paletteInput.value);
  for (const el of document.querySelectorAll('[data-callout-label]')) el.textContent = calloutLabels[el.dataset.calloutLabel];
  statusNotices.refresh();
  refreshTranslations();
});
