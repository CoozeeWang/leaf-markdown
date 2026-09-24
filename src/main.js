import { calloutBadge } from './callout-icons.js';
import { inlineRename } from './inline-rename.js';
import { positionMenu } from './menu-position.js';
import {installMenuInteraction} from './menu-interaction.js';
installMenuInteraction();
import { setupWriting } from './writing-tools.js';
import { refreshImages } from './resources.js';
import { showRecovery, setupWelcomeRecovery } from './recovery-dialog.js';
import { createLeafEditor } from './editor.js';
import { setupSidebarResize } from './outline-resize.js';
import './style.css';
import { renderPrintDocument } from './print-document.js';
import { frontmatter } from './markdown-model.js';
import './reading.css';
import { desktop, desktopExportBundle, desktopRename, desktopOpen, desktopNew, desktopSave, desktopHasPath, initDesktop, desktopTitle, desktopEdited, desktopRestore, desktopRecoveryPaused, desktopRun, chooseAttachments } from './desktop.js';
import { invoke } from '@tauri-apps/api/core';
import { shortcutText, renderShortcutText } from './platform-shortcuts.js';
import { labels as calloutLabels } from './callout.js';
import { indexFootnotes, notePanelRows } from './footnotes.js';
import { uiIcon, uiIconPaths } from './ui-icons.js';
import {readingFolding} from './outline-folding.js';

const welcome = '# Leaf\n\n轻量 Markdown 编辑器。\n';

const state = {
  fileHandle: null,
  fileName: '未命名.md',
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

document.querySelector('#app').innerHTML = shortcutText(`
  <main class="shell welcome-state${desktop && new URLSearchParams(location.search).has('document') ? ' document-loading' : ''}">
    <header class="topbar">
      <div class="brand">
        <img class="brand-mark" src="/leaf-icon.png" alt="" aria-hidden="true" />
        <span class="brand-copy"><strong>Leaf</strong><small>Markdown Editor</small></span>
      </div>
      <div class="document-controls">
        <div class="document-primary">
        <button id="openButton" class="primary icon-control" aria-label="打开文件" data-tooltip="打开文件  ⌘O">${icon('open')}</button>
        <button id="recentButton" class="icon-control" aria-label="最近打开" data-tooltip="最近打开">${icon('history')}</button>
        <button id="documentMenuButton" class="filename" aria-label="文档操作" aria-haspopup="menu" aria-expanded="false"><span id="fileName"></span>${icon('chevron', 13)}</button>
        </div>
        <span id="dirty" class="dirty" aria-label="未保存"></span>
        <span id="saveStatus" class="save-status"></span>
        <span id="statusAnnouncement" class="status-announcement" role="status" aria-live="polite" aria-atomic="true"></span>
        <button id="recoveryNotice" class="recovery-notice" hidden>发现恢复记录 · 查看</button>
      </div>
      <div class="topbar-actions">
      <button id="readingToggle" class="icon-control" aria-label="切换到阅读模式" aria-pressed="false" data-tooltip="切换到阅读模式  ⌘R">${icon('edit')}</button>
      <button id="searchButton" class="icon-control" aria-label="查找" data-tooltip="文内查找  ⌘F">${icon('search')}</button>
      <button id="commandsButton" class="icon-control" aria-label="命令面板" data-tooltip="命令面板  ⌘P">${icon('commands')}</button>
      <button id="saveButton" class="icon-control" aria-label="保存" data-tooltip="保存  ⌘S">${icon('save')}</button>
      <button id="exportMenuButton" class="icon-control" aria-label="导出" aria-haspopup="menu" aria-expanded="false" data-tooltip="导出  ⌘E">${icon('export')}</button>
      <button id="appearanceButton" class="icon-control" aria-label="设置" aria-haspopup="dialog" aria-expanded="false" data-tooltip="设置  ⌥⌘,">${icon('appearance', 16)}</button>
      </div>
    </header>

    <nav class="format-toolbar" aria-label="格式工具栏">
      <button id="undoButton" aria-label="撤销" data-tooltip="撤销  ⌘Z">${icon('undo')}</button>
      <button id="redoButton" aria-label="重做" data-tooltip="重做  ⇧⌘Z">${icon('redo')}</button>
      <span class="toolbar-divider"></span>
      <button id="headingButton" class="heading-control" aria-label="标题级别" aria-haspopup="menu" aria-expanded="false" data-tooltip="标题级别  ⌥1–6 · 正文 ⌥0"><span>H</span>${icon('chevron', 13)}</button>
      <span class="toolbar-divider"></span>
      <button data-format="bold" aria-label="粗体" data-tooltip="粗体  ⌘B"><span class="format-glyph bold">B</span></button>
      <button data-format="italic" aria-label="斜体" data-tooltip="斜体  ⌘I"><span class="format-glyph italic">I</span></button>
      <button data-format="strike" aria-label="删除线" data-tooltip="删除线  ⌘⇧X"><span class="format-glyph strike">S</span></button>
      <button data-format="sup" aria-label="上标" data-tooltip="上标  ⌘."><span class="format-glyph">x<sup>2</sup></span></button>
      <button data-format="sub" aria-label="下标" data-tooltip="下标  ⌘,"><span class="format-glyph">x<sub>2</sub></span></button>
      <button data-format="footnote" aria-label="插入脚注" data-tooltip="插入脚注  ⇧⌘F">${icon('footnote')}</button>
      <span class="toolbar-divider"></span>
      <button data-format="quote" aria-label="引用" data-tooltip="引用">${icon('quote')}</button>
      <button data-format="bullet" aria-label="无序列表" data-tooltip="无序列表  ⌘⇧8">${icon('list')}</button>
      <button data-format="ordered" aria-label="有序列表" data-tooltip="有序列表  ⌘⇧7">${icon('ordered')}</button>
      <span class="toolbar-divider"></span>
      <button data-format="code" aria-label="行内代码" data-tooltip="行内代码">${icon('code')}</button>
      <button data-format="codeblock" aria-label="代码块" data-tooltip="代码块">${icon('codeblock')}</button>
      <button data-format="table" aria-label="插入表格" data-tooltip="插入表格">${icon('table')}</button>
      <span class="toolbar-narrow-break" aria-hidden="true"></span><button id="calloutButton" aria-label="插入提示块" data-tooltip="插入提示块" aria-haspopup="dialog" aria-expanded="false">${icon('callout')}</button>
      <span class="toolbar-spacer"></span>
      <button id="tidyBlankLines" aria-label="整理段落空行" data-tooltip="整理段落空行  ⌥⌘\\">${icon('tidy')}</button>
      <button id="displayButton" aria-label="显示" aria-haspopup="dialog" aria-expanded="false" data-tooltip="显示">${icon('eye')}</button>
    </nav>
    <div id="fileFeedback" class="file-feedback" role="status" aria-live="polite"></div>

    <section class="document-area">
      <div id="editor" class="editor-host"></div>
      <section id="welcomeScreen" class="welcome-screen" aria-label="欢迎使用 Leaf">
        <button id="welcomeSettings" class="welcome-settings icon-control" aria-label="设置" data-tooltip="设置">${icon('appearance', 16)}</button>
        <div class="welcome-card">
          <img class="welcome-mark" src="/leaf-icon.png" alt="" aria-hidden="true" />
          <h1 class="welcome-title"><span class="welcome-name">Leaf</span><span class="welcome-description">轻量 Markdown 编辑器</span></h1>
          <div class="welcome-actions">
            <button id="welcomeNewButton" class="welcome-primary">${icon('newfile', 17)}<span>新建文档</span></button>
            <button id="welcomeOpenButton" class="welcome-primary">${icon('open', 17)}<span>打开文件</span></button>
            <button id="welcomeRecentButton" class="welcome-icon" aria-label="最近打开" data-tooltip="最近打开">${icon('history', 17)}</button>
          </div>
        </div>
        <p class="welcome-drop-hint">拖入 Markdown 文件即可打开</p>
      </section>
      <section id="readingPane" class="reading-pane" aria-label="阅读模式" tabindex="0" hidden><article class="reading-document"></article></section>
      <button id="outlineButton" class="sidebar-rail sidebar-rail-left" aria-label="展开大纲" aria-controls="outlineDrawer" aria-expanded="false" data-tooltip="展开大纲">${icon('outline')}</button>
      <aside id="outlineDrawer" class="outline-drawer" aria-label="文档大纲">
        <div class="outline-resizer" role="separator" aria-label="调整大纲宽度" aria-orientation="vertical" tabindex="0" title="拖动调整宽度 · 双击恢复默认 · 方向键微调"></div>
        <div class="drawer-header"><strong>大纲</strong><button data-close="outline" class="icon-control" aria-label="收起大纲" data-tooltip="收起大纲" aria-controls="outlineDrawer" aria-expanded="true">${icon('outline')}</button></div>
        <div id="outlineList" class="outline-list"></div>
      </aside>
      <aside id="notesDrawer" class="notes-drawer" aria-label="注释">
        <div class="notes-resizer" role="separator" aria-label="调整注释宽度" aria-orientation="vertical" tabindex="0" title="拖动调整宽度 · 双击恢复默认 · 方向键微调"></div>
        <div class="drawer-header"><strong>注释<span id="notesCount" class="drawer-count"></span></strong><button data-close="notes" class="icon-control" aria-label="收起注释" data-tooltip="收起注释" aria-controls="notesDrawer" aria-expanded="true">${icon('notes')}</button></div>
        <div id="notesList" class="notes-list"></div>
      </aside>
      <button id="notesButton" class="sidebar-rail sidebar-rail-right" aria-label="展开注释" aria-controls="notesDrawer" aria-expanded="false" aria-pressed="false" data-tooltip="展开注释">${icon('notes')}</button>
    </section>

    <footer class="statusbar">
      <span id="cursorStatus">第 1 行，第 1 列</span>
      <span id="saveNotice" class="save-notice" role="status" aria-live="polite"></span>
      <span id="stats"></span>
      <button id="focusButton" class="status-button icon-control" aria-label="专注模式" data-tooltip="专注模式  Esc 退出">${icon('focus', 15)}</button>
    </footer>

    <div id="dropOverlay" class="drop-overlay">松开以打开 Markdown 文件</div>

    <section id="appearancePopover" class="popover appearance-popover" role="dialog" aria-label="设置" tabindex="-1" hidden>
      <div class="settings-heading"><h2>设置</h2><button id="settingsClose" aria-label="关闭设置">${icon('close')}</button></div>
      <div class="settings-tabs" role="tablist" aria-label="设置分类">
        <button id="settingsTab-appearance" role="tab" data-settings-tab="appearance" aria-controls="settingsPanel-appearance">外观与排版</button>
        <button id="settingsTab-recovery" role="tab" data-settings-tab="recovery" aria-controls="settingsPanel-recovery">保存与恢复</button>
      </div>
      <div class="appearance-scroll" tabindex="-1">
      <section id="settingsPanel-appearance" role="tabpanel" aria-labelledby="settingsTab-appearance" data-settings-panel="appearance">
      <fieldset class="appearance-group" aria-label="主题">
      <label class="setting-row"><span>主题</span>
        <span class="ui-select"><select id="themeSelect"><option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option></select>${icon('chevron', 16)}</span>
      </label>
      </fieldset>
      <fieldset class="appearance-group" aria-label="正文排版">
      <label class="setting-row"><span>正文字体</span>
        <span class="ui-select"><select id="fontFamilySelect"><option value="serif">宋体</option><option value="sans">系统黑体</option><option value="mono">等宽</option></select>${icon('chevron', 16)}</span>
      </label>
      <label class="setting-slider"><span>正文字号</span><span class="slider-control"><input id="fontSizeInput" type="range" min="14" max="24" step="1" /><output id="fontSizeValue"></output></span></label>
      <label class="setting-slider"><span>正文最大宽度</span><span class="slider-control"><input id="contentWidthInput" type="range" min="600" max="1100" step="20" /><output id="contentWidthValue"></output></span></label>
      </fieldset>
      </section>
      <section id="settingsPanel-recovery" role="tabpanel" aria-labelledby="settingsTab-recovery" data-settings-panel="recovery" hidden>
      ${desktop ? `<fieldset class="appearance-group" aria-label="恢复记录"><label class="setting-row"><span>历史版本与草稿保留时间</span><span class="ui-select"><select id="recoveryRetentionSelect" aria-label="历史版本与草稿保留时间" disabled><option value="7">7 天</option><option value="30" selected>30 天</option><option value="90">90 天</option></select>${icon('chevron',16)}</span></label></fieldset>` : ''}
      <div class="settings-recovery-action"><button id="settingsRecovery" class="settings-action">${desktop ? '查看可恢复草稿' : '恢复最近一次保存前版本'}</button></div>
      ${desktop ? '' : '<p class="setting-hint">恢复将替换当前内容，可撤销。检查后请保存。</p>'}
      </section>
      </div>
      <div class="appearance-scroll-hint" hidden aria-hidden="true">向下滚动查看更多</div>
      <p class="settings-about"><strong id="settingsVersion">Leaf</strong><span id="settingsBuild" hidden></span></p>
    </section>

    <section id="documentPopover" class="popover action-popover" role="menu" aria-label="历史版本" hidden>
      <button id="documentHistory" role="menuitem">${desktop ? '历史版本' : '恢复最近一次保存前版本'}</button>
    </section>

    <section id="exportPopover" class="popover action-popover" role="menu" aria-label="导出" hidden>
      <button id="exportButton" role="menuitem">导出 PDF<kbd>⌘E</kbd></button>
      <button id="exportBundleButton" role="menuitem" ${desktop ? '' : 'hidden'}>导出文档与附件…</button>
    </section>

    <section id="displayPopover" class="popover action-popover display-popover" role="dialog" aria-label="显示" hidden>
      <div class="popover-title">显示</div>
      <label class="setting-check"><input id="documentPropertiesToggle" type="checkbox" /><span>文档属性</span></label>
      <label class="setting-check"><input id="fileNameTitleToggle" type="checkbox" /><span>正文上方的文件名</span></label>
      <label class="setting-check"><input id="lineNumberToggle" type="checkbox" /><span>源码行号</span></label>
      <label class="setting-check"><input id="blankMarkerToggle" type="checkbox" /><span class="setting-label">编辑标记<small class="setting-inline-hint">¶ 段落结束　↵ 换行</small></span></label>
      <label class="setting-check"><input id="headingNumberSetting" type="checkbox" /><span class="setting-label">标题多级编号<small class="setting-inline-hint">仅影响显示，不修改原文</small></span></label>
      <p id="markerModeHint" class="setting-hint"></p>
      <button id="markerEditMode" class="settings-action" hidden>切换到编辑模式查看</button>
    </section>

    <section id="recentPopover" class="popover recent-popover" hidden>
      <div class="popover-title">最近打开</div>
      <div id="recentList" class="recent-list"><span class="empty-hint">暂无最近打开的文件</span></div>
    </section>

    <section id="headingPopover" class="popover heading-popover" hidden>
      <div class="heading-grid">
        <button data-format="heading0" aria-label="正文" data-tooltip="恢复正文  ⌥0">¶</button>
        <button data-format="heading1" aria-label="一级标题" data-tooltip="一级标题  ⌥1">H1</button>
        <button data-format="heading2" aria-label="二级标题" data-tooltip="二级标题  ⌥2">H2</button>
        <button data-format="heading3" aria-label="三级标题" data-tooltip="三级标题  ⌥3">H3</button>
        <button data-format="heading4" aria-label="四级标题" data-tooltip="四级标题  ⌥4">H4</button>
        <button data-format="heading5" aria-label="五级标题" data-tooltip="五级标题  ⌥5">H5</button>
        <button data-format="heading6" aria-label="六级标题" data-tooltip="六级标题  ⌥6">H6</button>
      </div>
    </section>

    <div id="palette" class="modal-backdrop" hidden>
      <section class="command-palette" role="dialog" aria-modal="true" aria-label="命令面板">
        <input id="paletteInput" type="search" placeholder="搜索命令…" aria-label="搜索命令" role="combobox" aria-autocomplete="list" aria-controls="paletteList" aria-expanded="false" autocomplete="off" />
        <div id="paletteList" class="palette-list" role="listbox" aria-label="命令结果"></div>
        <div id="paletteEmpty" class="palette-empty" role="status" hidden>没有匹配的命令，试试其他关键词。</div>
        <div class="palette-help">↑ ↓ 选择　Enter 执行　Esc 关闭</div>
      </section>
    </div>
    <div id="tooltip" class="ui-tooltip" role="tooltip" hidden></div>
    <section id="calloutPopover" class="popover callout-popover" role="dialog" aria-label="提示块类型" hidden>
      <div class="popover-title">插入提示块</div>
      <div class="callout-types">${Object.entries(calloutLabels).map(([key,label])=>`<button data-format="callout-${key}">${calloutBadge(key)}<span>${label}</span></button>`).join('')}</div>
    </section>
  </main>
`);

const shell = document.querySelector('.shell');
const fileNameElement = document.querySelector('#fileName');
const dirtyElement = document.querySelector('#dirty');
const statsElement = document.querySelector('#stats');
const cursorStatus = document.querySelector('#cursorStatus');
const saveStatus = document.querySelector('#saveStatus');
const saveNotice = document.querySelector('#saveNotice');
const outlineDrawer = document.querySelector('#outlineDrawer');

const outlineList = document.querySelector('#outlineList');

// The version line in 设置 comes from the constants vite.config.js injects at
// build time. Any context that never went through vite -- a unit test importing
// this module directly, or a build outside a git checkout -- leaves them
// undefined, which the typeof guards absorb.
const leafVersion = typeof __LEAF_VERSION__ === 'string' ? __LEAF_VERSION__ : '';
const leafBuild = typeof __LEAF_BUILD__ === 'string' ? __LEAF_BUILD__ : '';
document.querySelector('#settingsVersion').textContent = `Leaf ${leafVersion}`.trim();
const settingsBuild = document.querySelector('#settingsBuild');
settingsBuild.textContent = leafBuild ? `构建 ${leafBuild}` : '';
settingsBuild.hidden = !leafBuild;
const appearancePopover = document.querySelector('#appearancePopover');
const recentPopover = document.querySelector('#recentPopover');
const headingPopover = document.querySelector('#headingPopover');
const calloutPopover = document.querySelector('#calloutPopover');
const documentPopover = document.querySelector('#documentPopover');
const exportPopover = document.querySelector('#exportPopover');
const displayPopover = document.querySelector('#displayPopover');
const displayButton = document.querySelector('#displayButton');
const palette = document.querySelector('#palette');
const paletteInput = document.querySelector('#paletteInput');
const paletteList = document.querySelector('#paletteList');
const dropOverlay = document.querySelector('#dropOverlay');
const tooltip = document.querySelector('#tooltip');
const welcomeScreen = document.querySelector('#welcomeScreen');

let statusTimer, announcementTimer, saveNoticeTimer;
// Opening a document reports its save mode in the statusbar instead of the
// topbar, where a notice under the filename crowded the format toolbar.
function showSaveNotice(text) {
  clearTimeout(saveNoticeTimer);
  // The welcome hint ("打开文件后自动保存") never auto-clears; opening a
  // document must not leave it stranded under the filename.
  saveStatus.textContent = ''; delete saveStatus.dataset.kind;
  saveNotice.textContent = shortcutText(text);
  saveNotice.dataset.kind = 'saved';
  saveNoticeTimer = setTimeout(() => { saveNotice.textContent = ''; delete saveNotice.dataset.kind; }, 4000);
}
function setStatus(text, kind = '', { announce = true } = {}) {
  clearTimeout(statusTimer);
  clearTimeout(announcementTimer);
  const announcement = document.querySelector('#statusAnnouncement');
  announcement.textContent = '';
  // Announce deliberate actions, without narrating background autosaves.
  if (announce && (kind === 'saved' || kind === 'info') && !/^(已自动保存|已开启自动保存|已载入外部修改)/.test(text)) {
    announcementTimer = setTimeout(() => { announcement.textContent = shortcutText(text); }, 50);
  }
  saveStatus.textContent = shortcutText(text);
  saveStatus.dataset.kind = kind;
  if (kind === 'saved' || kind === 'info') {
    statusTimer = setTimeout(() => { saveStatus.textContent = ''; delete saveStatus.dataset.kind; }, 4000);
  }
  const feedback = document.querySelector('#fileFeedback');
  if (kind === 'error' || (kind === 'manual' && /自动保存暂停|检查后|选择保存位置/.test(text) && feedback.dataset.kind !== 'error')) {
    feedback.textContent = shortcutText(text); feedback.dataset.kind = kind;
  } else if (kind === 'saved' && /^(已保存|已自动保存|已下载保存副本|已载入外部修改|已开启自动保存)/.test(text)) {
    feedback.textContent = ''; delete feedback.dataset.kind;
  }
}

function renameCurrentDocument(){
  if(shell.classList.contains('welcome-state')||document.querySelector('.inline-rename'))return;
  const extension=state.fileName.match(/\.(md|markdown|mdown)$/i)?.[0]||'.md';
  const stem=state.fileName.endsWith(extension)?state.fileName.slice(0,-extension.length):state.fileName;
  const anchor=state.reading?reader.querySelector('.leaf-file-name-title'):document.querySelector('.leaf-default-title h1');
  inlineRename({anchor,value:stem,apply:async name=>{
    if(!desktop)throw new Error('请在桌面版中修改磁盘文件名');
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
    ? 'Leaf — Markdown Editor'
    : `${changed ? '• ' : ''}${state.fileName} — Leaf`;
  statsElement.textContent = `${state.content.length} 字符 · ${state.content.split(/\s+/).filter(Boolean).length} 词`;
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
      button.title = `${button.textContent}\n${state.reading ? '单击跳转' : '单击跳转 · 双击修改标题'}`;
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
    outlineList.innerHTML = '<span class="empty-hint">此文档没有标题</span>';
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
        toggle.setAttribute('aria-label', `${open ? '收起' : '展开'}大纲子项：${item.text}`);
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
    button.title='单击跳转 · 双击修改标题';
    button.addEventListener('click', () => {
      if(state.reading) reader.querySelector(`[data-source-line="${item.line}"]`)?.scrollIntoView({block:'start'});
      else editor.goToLine(item.line);
    });
    button.addEventListener('dblclick', () => {
      if(state.reading)return;
      const original=editor.view.state.doc.line(item.line).text;
      const input=document.createElement('input');
      input.className='outline-rename';input.value=item.text;
      input.setAttribute('aria-label','修改标题');
      button.replaceWith(input);input.focus();input.select();
      let finished=false;
      const finish=save=>{
        if(finished)return;finished=true;
        if(save && input.value.trim()!==item.text && !editor.renameHeading(item.line,original,input.value))
          setStatus('标题为空或原文已变化，未修改','info');
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
  const signature = JSON.stringify([state.reading, rows]);
  if (signature === state.notesSignature) return;
  // A drawer that is closed has no width to lay a textarea out in, so a height
  // measured now would be fixed to the wrong width; the redraw waits for the next
  // open, where the signature is dropped and this runs again from scratch.
  // Rebuilding under the caret is worse: it would take the words out from under
  // the fingers -- and out of an unfinished pinyin run.
  if (!notesDrawer.classList.contains('visible')) return;
  if (notesList.contains(document.activeElement)) {
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
      number.setAttribute('aria-label', `跳转到注释 ${row.number ?? row.label}`);
      const body = card.querySelector('.note-body');
      body.setAttribute('aria-label', `注释 ${row.number ?? row.label} 的内容`);
      if (body !== document.activeElement && body.value !== row.body) { body.value = row.body; fitNoteBody(body); }
      if (row.state === 'complete') card.querySelector('.note-card-head')?.remove();
    }
    notesCount.textContent = rows.filter(row => row.number !== null).length || '';
    return;
  }
  state.notesSignature = signature;

  // Which notes there are, as opposed to what they say. Writing a note in the
  // editor, or in the box under a fresh marker, arrives one keystroke at a time,
  // and rebuilding a row per keystroke would cost a textarea per note in the
  // document each time. Same notes, different words: patch the words.
  const skeleton = JSON.stringify([state.reading, rows.map(row => [row.label, row.number, row.state])]);
  if (skeleton === state.notesSkeleton) {
    for (const row of rows) {
      const body = notesList.querySelector(`.note-card[data-label="${CSS.escape(row.label)}"] .note-body`);
      if (body && body.value !== row.body) { body.value = row.body; fitNoteBody(body); }
    }
    return;
  }
  state.notesSkeleton = skeleton;

  const numbered = rows.filter(row => row.number !== null).length;
  notesCount.textContent = numbered ? `${numbered}` : '';
  notesList.replaceChildren();
  if (!rows.length) {
    notesList.innerHTML = '<span class="empty-hint">此文档没有注释</span>';
    return;
  }
  const measure = [];
  for (const row of rows) notesList.append(noteCard(row, measure));
  for (const fit of measure) fit();
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
  number.title = '跳转到正文中的角标';
  number.setAttribute('aria-label', `跳转到注释 ${row.number ?? row.label}`);
  number.addEventListener('click', () => gotoNote(row));
  if (row.state === 'unreferenced') head.append(statusNote('正文里已没有它的角标'));
  if (row.state === 'undefined') {
    const hint = statusNote('缺少脚注定义');
    hint.title = `找不到 [^${row.label}]: 对应的定义，请检查定义行末尾的冒号。此引用暂不参与显示编号。`;
    head.append(hint);
  }

  const body = document.createElement('textarea');
  body.className = 'note-body';
  body.rows = 1;
  body.spellcheck = false;
  body.value = row.body;
  body.placeholder = '输入注释内容';
  body.setAttribute('aria-label', `注释 ${row.number ?? row.label} 的内容`);
  // The reading view shows the notes the way they will print, and an edit made
  // there would be dropped on the floor, so the panel stops offering one.
  body.readOnly = state.reading;
  measure.push(() => fitNoteBody(body));
  body.addEventListener('input', () => { editor.setFootnoteBody(row.label, body.value); fitNoteBody(body); });
  body.addEventListener('keydown', event => {
    if (event.isComposing) return;
    if (event.key === 'Escape' || (event.key === 'Enter' && !event.shiftKey)) {
      event.preventDefault();
      if (!state.reading) editor.focus();
    }
  });

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
    remove.setAttribute('aria-label', '删除脚注');
    remove.title = '删除这条脚注及其全部引用（可撤销）';
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
  const body = card.querySelector('.note-body');
  if (!body || body.readOnly) return;
  body.focus();
  body.setSelectionRange(body.value.length, body.value.length);
}

function markActiveNote(card) {
  for (const other of notesList.querySelectorAll('.note-card.active')) other.classList.remove('active');
  card.classList.add('active');
}

// A keystroke in a note leaves the caret in the panel, so the redraw waits for
// the blur rather than stealing the words mid-word.
notesList.addEventListener('focusout', () => requestAnimationFrame(renderNotes));

function scheduleSave() {
  clearTimeout(state.saveTimer);
  if (desktop) {
    desktopEdited();
    if (desktopRecoveryPaused()) { setStatus('恢复后自动保存暂停 · 检查后请手动保存', 'manual'); return; }
    if (desktopHasPath()) {
      setStatus('等待自动保存…', 'pending');
      state.saveTimer = setTimeout(() => desktopSave(false, false), 800);
    } else setStatus('⌘S 选择保存位置', 'manual');
    return;
  }
  if (!state.fileHandle) {
    setStatus('⌘S 选择保存位置', 'manual');
    return;
  }
  if (state.conflict) {
    setStatus('外部文件已修改 · 自动保存暂停，请另存为以保留当前内容', 'error');
    return;
  }
  setStatus('等待自动保存…', 'pending');
  state.saveTimer = setTimeout(() => saveToHandle(true), 800);
}

const undoButton = document.querySelector('#undoButton');
const redoButton = document.querySelector('#redoButton');

function updateHeadingControl(level) {
  const button = document.querySelector('#headingButton');
  const label = level === null ? '混合级别' : level === 0 ? '正文' : `${level} 级标题`;
  button.querySelector('span').textContent = level === null ? 'H' : level === 0 ? '¶' : `H${level}`;
  button.setAttribute('aria-label', `标题级别：${label}`);
  button.dataset.tooltip = shortcutText(`标题级别：${label}  ⌥1–6 · 正文 ⌥0`);
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
    cursorStatus.textContent = `第 ${position.line} 行，第 ${position.column} 列`;
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
  renderPrintDocument(reader,state.content,{name:state.fileName,numbered:state.showHeadingNumbers,properties:true,expandCallouts:false,fallbackTitle:false,fileNameTitle:state.showFileNameTitle});
  const title=reader.querySelector('.leaf-file-name-title');if(title){title.tabIndex=0;title.title='双击修改文件名';title.setAttribute('aria-label',`${state.fileName}，双击或按回车修改文件名`);}
  for (const table of reader.querySelectorAll('table')) {
    const wrap = document.createElement('div'); wrap.className = 'reading-table-scroll';
    wrap.tabIndex = 0; wrap.setAttribute('role', 'region'); wrap.setAttribute('aria-label', '表格，可横向滚动');
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
modePopover.className='popover mode-popover';modePopover.hidden=true;modePopover.setAttribute('role','menu');modePopover.setAttribute('aria-label','视图模式');
const modes=[['edit','编辑','edit'],['reading','阅读','read'],['source','源码','code']];
for(const [mode,label,glyph] of modes){
 const button=document.createElement('button');button.type='button';button.dataset.mode=mode;button.setAttribute('role','menuitemradio');button.innerHTML=icon(glyph)+`<span>${label}</span>`;
 button.onclick=()=>setMode(mode);modePopover.append(button);
}
document.body.append(modePopover);
function updateModeControl(){
 const mode=state.reading?'reading':state.source?'source':'edit';
 const [,label,glyph]=modes.find(m=>m[0]===mode),button=document.querySelector('#readingToggle');
 button.innerHTML=icon(glyph)+`<span>${label}</span>`;button.setAttribute('aria-label',`视图模式：${label}`);button.removeAttribute('aria-pressed');button.setAttribute('aria-haspopup','menu');button.setAttribute('aria-expanded',String(!modePopover.hidden));button.dataset.tooltip=shortcutText('选择编辑、源码或阅读模式  ⌘R');
 for(const item of modePopover.children)item.setAttribute('aria-checked',String(item.dataset.mode===mode));
}
function cycleMode(){
 if(shell.classList.contains('welcome-state'))return;
 setMode(state.reading?'source':state.source?'edit':'reading');
}
function setMode(mode){
 if(state.reading!==(mode==='reading'))toggleReading();
 state.source=mode==='source';editor.setSource(state.source);closePopovers();updateModeControl();
 if(!state.reading)editor.focus();
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
    try { return JSON.parse(localStorage.getItem('leaf-desktop-recent')||'[]').slice(0,8); } catch { return []; }
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

async function renderRecentFiles() {
  const list = document.querySelector('#recentList');
  list.replaceChildren();
  let files = [];
  try { files = await readRecentFiles(); } catch { /* ignored */ }
  if (!files.length) {
    list.innerHTML = '<span class="empty-hint">暂无最近打开的文件</span>';
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
        try { await invoke('open_document',{path:item.path});recentPopover.hidden=true; }
        catch { list.replaceChildren(Object.assign(document.createElement('span'),{className:'empty-hint',textContent:'无法打开：文件可能已移动或删除。'})); }
        return;
      }
      const permission = await item.handle.queryPermission({ mode: 'readwrite' });
      if (permission !== 'granted' && await item.handle.requestPermission({ mode: 'readwrite' }) !== 'granted') return;
      await loadHandle(item.handle);
      recentPopover.hidden = true;
    });
    list.append(button);
  }
}

async function setDocument(content, name, handle = null, file = null) {
  const feedback = document.querySelector('#fileFeedback');
  feedback.textContent = ''; delete feedback.dataset.kind;
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
  if (hasSaveLocation) showSaveNotice('已开启自动保存');
  else setStatus('⌘S 选择保存位置', 'manual');
  if(state.reading)readingPane.focus(); else editor.focus();
  if (handle) await rememberFile(handle);
}

async function loadHandle(handle) {
  const file = await handle.getFile();
  await setDocument(await file.text(), file.name, handle, file);
}

async function openFile() {
  if (desktop) return desktopOpen().catch(error => setStatus(`打开失败：${error}`, 'error'));
  if ('showOpenFilePicker' in window) {
    try {
      const [handle] = await window.showOpenFilePicker({
        types: [{ description: 'Markdown', accept: { 'text/markdown': ['.md', '.markdown', '.mdown'] } }],
        multiple: false,
      });
      await loadHandle(handle);
    } catch (error) {
      if (error.name !== 'AbortError') setStatus(`打开失败：${error.message}`, 'error');
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
        setStatus('外部文件已修改 · 自动保存暂停，请另存为以保留当前内容', 'error');
        return false;
      }
      if (!window.confirm('此文件已被其他程序修改。继续保存会覆盖外部版本，是否继续？')) {
        setStatus('未覆盖外部修改', 'error');
        return false;
      }
    }
    setStatus('正在保存…', 'pending');
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
    setStatus(isAutoSave ? '已自动保存' : '已保存', 'saved');
    return true;
  } catch (error) {
    setStatus(`修改尚未保存。请重试或另存为。详情：${error.message}`, 'error');
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
      if (error.name !== 'AbortError') setStatus(`修改尚未保存。请重试或另存为。详情：${error.message}`, 'error');
    }
    return;
  }
  const url = URL.createObjectURL(new Blob([state.content], { type: 'text/markdown' }));
  const link = Object.assign(document.createElement('a'), { href: url, download: state.fileName });
  link.click();
  URL.revokeObjectURL(url);
  state.savedContent = state.content;
  updateDocumentChrome();
  setStatus('已下载保存副本', 'saved');
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
      setStatus('已载入外部修改', 'saved');
    } else {
      state.conflict = true;
      setStatus('外部文件已修改 · 自动保存暂停，请另存为以保留当前内容', 'error');
    }
  } catch {
    // File permission can disappear when the browser restarts; manual save will surface it.
  }
}

function closePopovers(except = null) {
  for (const popover of [appearancePopover, recentPopover, headingPopover, calloutPopover, modePopover, documentPopover, exportPopover, displayPopover]) {
    if (popover !== except) popover.hidden = true;
    if (popover===modePopover && popover.hidden) document.querySelector('#readingToggle').setAttribute('aria-expanded','false');
  }
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
    if(path)setStatus(`已导出文档与附件：${path}`,'saved');
  } catch(error) { setStatus(`导出失败：${error}`,'error'); }
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
      if (!preview) throw new Error('请允许打开导出预览窗口');
    }
  } catch (error) { setStatus(`导出失败：${error}`, 'error'); }
}

const commands = [
  { name: '外观与排版', action: () => openSettings('appearance') },
  { name: '显示选项', action: () => document.querySelector('#displayButton').click() },
  { name: '保存与恢复', action: () => openSettings('recovery') },
  { name: '复制为富文本', shortcut: '⇧⌘C', action: () => writing.copyRich() },
  { name: '粘贴为纯文本', shortcut: '⌘T', action: () => writing.pastePlain() },
  { name: '插入图片', action: () => writing.attachments(null, true) },
  { name: '插入附件', action: () => writing.attachments(null, false) },
  { name: '撤销', shortcut: '⌘Z', action: () => editor.undo() },
  { name: '重做', shortcut: '⇧⌘Z', action: () => editor.redo() },
  { name: '导出 PDF', shortcut: '⌘E', action: exportPdf },
  { name: '打开文件', shortcut: '⌘O', action: openFile },
  { name: '显示或隐藏编辑标记', shortcut: '⌘⇧\\', action: toggleBlankLineMarkers },
  { name: '整理段落空行', shortcut: '⌘⌥\\', action: tidyBlankLines },
  { name: '保存文件', shortcut: '⌘S', action: saveFile },
  { name: '切换视图模式', shortcut: '⌘R', action: cycleMode },
  { name: '文档属性', action: openDocumentProperties },
  { name: '在文档中查找', shortcut: '⌘F', action: openDocumentSearch },
  { name: '按引用顺序重新编号脚注', action: () => editor.renumberFootnotes() },
  { name: '显示或隐藏大纲', action: () => setOutlineDrawer(!outlineDrawer.classList.contains('visible')) },
  { name: '显示或隐藏注释', action: toggleNotesDrawer },
  { name: '显示或隐藏源码行号', action: () => setLineNumbers(!state.showLineNumbers) },
  { name: '切换专注模式', action: toggleFocusMode },
  { name: '切换深浅主题', action: cycleTheme },
  { name: '设为一级标题', shortcut: '⌥1', action: () => editor.format('heading1') },
  { name: '粗体', shortcut: '⌘B', action: () => editor.format('bold') },
  { name: '斜体', shortcut: '⌘I', action: () => editor.format('italic') },
  { name: '引用', action: () => editor.format('quote') },
  { name: '插入脚注', shortcut: '⇧⌘F', action: () => editor.format('footnote') },
  { name: '插入提示块', aliases: ['Callout'], action: () => {if(state.reading)toggleReading();editor.format('callout-note');} },
  { name: '无序列表', shortcut: '⇧⌘8', action: () => editor.format('bullet') },
  { name: '插入表格', action: () => editor.format('table') },
  ...(desktop ? [
    { name: '历史版本与草稿', action: () => showRecovery({ invoke, restore: desktopRestore }) },
    { name: '恢复未保存草稿', action: () => showRecovery({ invoke, drafts: true }) },
  ] : [{
    name: '恢复最近一次保存前版本',
    action() {
      const snapshot = latestSnapshot();
      if (!snapshot) return setStatus('没有可恢复的版本', 'info');
      editor.restoreValue(snapshot.content);
      state.content = snapshot.content;
      updateDocumentChrome();
      scheduleSave();
      // scheduleSave supplies the pending or save-location state.
    },
  }]),
];

const commandGroups = [
  ['设置', ['外观与排版', '保存与恢复']],
  ['文件', ['打开文件', '保存文件', '导出 PDF', '文档属性']],
  ['编辑', ['撤销', '重做', '复制为富文本', '粘贴为纯文本', '在文档中查找', '整理段落空行', '按引用顺序重新编号脚注']],
  ['插入与格式', ['插入图片', '插入附件', '设为一级标题', '粗体', '斜体', '引用', '插入脚注', '插入提示块', '无序列表', '插入表格']],
  ['视图', ['显示选项', '切换视图模式', '显示或隐藏编辑标记', '显示或隐藏大纲', '显示或隐藏注释', '显示或隐藏源码行号', '切换专注模式', '切换深浅主题']],
  ['恢复', ['历史版本与草稿', '恢复未保存草稿', '恢复最近一次保存前版本']],
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
  for (const [group, names] of commandGroups) {
    const matches = commands.filter(command => names.includes(command.name) && fuzzyMatch(`${command.name} ${group} ${(command.aliases || []).join(' ')}`, normalized));
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
  state.focusMode = !state.focusMode;
  shell.classList.toggle('focus-mode', state.focusMode);
  if (!state.focusMode) editor.focus();
}

document.querySelector('#openButton').addEventListener('click', openFile);
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
    const next = {ArrowRight:(i+1)%2, ArrowLeft:(i+2)%2, Home:0, End:1}[event.key];
    if (next !== undefined) { event.preventDefault(); tabs[next].click(); tabs[next].focus(); }
  };
}
// Markers do not exist in reading mode, so this offers the way to see them.
// Switching mode closes the switchboard along with the rest of the popovers.
document.querySelector('#markerEditMode').onclick = () => setMode('edit');
function openRecoveryRecords(current = false) {
  closePopovers();
  if (desktop) return showRecovery({invoke, restore:desktopRestore, drafts:!current});
  commands.find(c => c.name === '恢复最近一次保存前版本')?.action();
}
document.querySelector('#settingsRecovery').onclick = () => openRecoveryRecords();
document.querySelector('#documentHistory').onclick = () => openRecoveryRecords(true);
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
  displayPopover.querySelector('#markerModeHint').textContent = state.reading ? '阅读模式不显示编辑标记。' : state.source ? '源码模式仅显示换行标记 ↵。' : '';
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
  if (event.key === 'Tab') { closePopovers(); displayButton.focus(); }
});
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
    void desktopNew().catch(error => setStatus(`新建失败：${error}`, 'error'));
  } else {
    void setDocument('', '未命名.md');
  }
});

document.querySelectorAll('[data-format]').forEach((button) => {
  button.addEventListener('click', () => {
    editor.format(button.dataset.format);
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
 try {recoveryDays=await invoke('recovery_retention',{days:Number(select.value)});await invoke('recovery_expire');setStatus(`恢复记录保留 ${recoveryDays} 天`,'saved');}
 catch(error){setStatus(`恢复设置或清理失败：${error}`,'error');}
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
    if (!event.target.closest('.popover') && !event.target.closest('#readingToggle') && !event.target.closest('#appearanceButton') && !event.target.closest('#welcomeSettings') && !event.target.closest('#recentButton') && !event.target.closest('#welcomeRecentButton') && !event.target.closest('#headingButton') && !event.target.closest('#documentMenuButton') && !event.target.closest('#exportMenuButton') && !event.target.closest('#displayButton')) closePopovers();
});

let tooltipTimer = null;
let tooltipTarget = null;

function hideTooltip() {
  clearTimeout(tooltipTimer);
  tooltipTarget = null;
  tooltip.hidden = true;
}

function showTooltip(target) {
  if (!target?.dataset.tooltip) return;
  tooltipTarget = target;
  renderShortcutText(tooltip, target.dataset.tooltip);
  tooltip.hidden = false;
  const targetRect = target.getBoundingClientRect();
  const tooltipRect = tooltip.getBoundingClientRect();
  const left = Math.min(
    window.innerWidth - tooltipRect.width - 8,
    Math.max(8, targetRect.left + targetRect.width / 2 - tooltipRect.width / 2),
  );
  let top = targetRect.bottom + 8;
  if (top + tooltipRect.height > window.innerHeight - 8) top = targetRect.top - tooltipRect.height - 8;
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
  setStatus(count ? '已整理段落空行 · ⌘Z 撤销' : '无需整理','info');
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
  setStatus(`无法在文件管理器中显示：${event.detail}`, 'error');
});

updateAppearance();
updateDocumentChrome();
updateHistoryControls();
renderOutline(welcome);
renderRecentFiles();
setStatus('打开文件后自动保存', 'manual');

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
    dirty: () => state.content !== state.savedContent,
    status: setStatus,
    recoveryAvailable: available => { document.querySelector('#recoveryNotice').hidden = !available; },
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
    drag(active) { dropOverlay.classList.toggle('visible',active); },
    saved(content, name, path) { const changed = state.resourcePath !== path; state.resourcePath = path; state.savedContent = content; state.fileName = name; updateDocumentChrome(); if (changed) refreshImages(); },
  }).catch(error => setStatus(`桌面初始化失败：${error}`, 'error')).finally(() => {
    shell.style.pointerEvents = '';
    editor.setReading(state.reading);
    if (welcomeScreen.hidden && !state.reading) editor.focus();
  });
}
