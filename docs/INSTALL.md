[简体中文](INSTALL.zh-CN.md) · [繁體中文](INSTALL.zh-TW.md) · **English**

# Installation and usage guide

Leaf is a Markdown editor with live preview, designed for focused writing and thoughtful review. This guide takes you from installation to everyday writing, formatting, and review.

## Install and open Leaf

Visit the [Leaf download page](https://github.com/CoozeeWang/leaf-markdown/releases) and choose the package for your computer. Before downloading, read the release notes for system requirements and known issues.

| Computer | Package | How to install |
| --- | --- | --- |
| Windows x64 | [Leaf-1.0.3-windows-x64-setup.exe](https://github.com/CoozeeWang/leaf-markdown/releases/download/v1.0.3/Leaf-1.0.3-windows-x64-setup.exe) | Double-click the installer and follow the instructions. |
| Mac (Apple silicon) | [Leaf-1.0.3-macOS-arm64.dmg](https://github.com/CoozeeWang/leaf-markdown/releases/download/v1.0.3/Leaf-1.0.3-macOS-arm64.dmg) | Open the DMG, drag Leaf into Applications, then open it from Applications. |

The Mac package above is for Apple silicon, not Intel Macs. On Windows, the installer may need an internet connection to set up WebView2 if it is not already installed.

Before installing a new version, save your documents and quit the old version of Leaf. A normal update does not require uninstalling Leaf or clearing its settings.

**Windows updates:** Keep **Delete the application data** unchecked if an uninstall step appears. Selecting it during a normal uninstall deletes Leaf’s settings and MCP connection configuration. Replacing old program files is different and can proceed normally.

### System and runtime requirements

- **Mac**: An Apple silicon build only. The minimum deployment target is macOS 11.0; this does not mean every macOS version from 11 onward has been tested. Leaf uses the system WebKit, so rendering may differ on older systems.
- **Windows**: An x64 build targeting Windows 10 / 11, requiring Microsoft Edge WebView2 Runtime. The installer may need internet access to install it if missing. Official runtime support does not establish that Leaf has been tested on every supported OS version.

This release does not yet have physical-device acceptance records covering all these OS versions.

### First-launch security prompts

The Mac build uses an ad-hoc signature, without Developer ID signing or Apple notarization. The Windows installer is not Authenticode-signed. Confirm that your package comes from the [official Leaf release](https://github.com/CoozeeWang/leaf-markdown/releases/tag/v1.0.3) and verify the file before proceeding.

- **Mac**: Try opening Leaf once. If Apple cannot verify the app or its developer, go to **System Settings → Privacy & Security → Open Anyway**, if available, and confirm. See [Apple’s instructions](https://support.apple.com/en-us/102445).
- **Windows**: If SmartScreen displays **Windows protected your PC**, choose **More info → Run anyway**, if available. Labels may vary by Windows version. See [Microsoft’s explanation](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation).

These steps apply only to unidentified-developer or unknown-reputation warnings after you have verified the source. Stop and contact us through [Issues](https://github.com/CoozeeWang/leaf-markdown/issues) if you see malware, damage, verification failures, or an organizational restriction. Keep system protection enabled. Browser download warnings, User Account Control, and Smart App Control are separate prompts.

The release’s SHA256 checksums and detached Minisign signatures help verify file integrity and origin. They are not OS-recognized publisher signatures and do not guarantee a warning-free installation.

## Open and save documents

After opening Leaf, create a new document or open or drag in an existing Markdown file.

- **Save** writes your changes to the file. When saving a new document for the first time, choose a filename and location.
- **Save as** saves the current content to another file, useful for making a copy or keeping a separate draft.
- **Autosave** writes changes automatically when a document has a save location. Watch the save status: waiting for autosave does not mean saving has finished.

If Leaf reports that the original file is missing or has been changed by another app, preserve your current edits first. Follow the prompt to locate the file again or save a separate copy.

**Autosave and draft recovery serve different purposes.** Autosave updates the document file; draft recovery keeps editing content you can retrieve after an interruption. Back up important documents regularly.

## Document properties

Properties hold information outside the document body, such as author, date, and tags. View and edit them together at the top of the document without adding them to the text.

### Add and edit properties

In Edit view, place the cursor on an empty first line at the very beginning of the document and type three hyphens, `---`. Leaf creates the properties area automatically. You can also search for “Document Properties” in the command palette.

Click **Add Property**, enter a name and initial value, and choose a suitable type, such as text, date, number, or checkbox.

Edit an existing property's name or value directly. Click its type icon to change the type. To remove a property, clear both its name and value.

In Edit view, use **Display → Document Properties** to expand or collapse the area. Collapsing it only changes what is visible; it does not delete properties.

### Save and read properties

Properties are stored as YAML at the beginning of the Markdown file and travel with the document. You normally do not need to write this markup yourself. Source view shows the original YAML; use it to edit complex properties that cannot be edited directly in the properties area.

If you prefer to type them yourself, switch to Source view and enclose the properties between two lines of `---` at the very beginning of the document:

```yaml
---
date: 2026-10-24
tags: [writing, draft]
---
```

**Select All in the body of Edit view does not select properties.** Pressing `⌘A` (Mac) or `Ctrl+A` (Windows) selects only the body, so you can copy or replace the text while keeping properties. To copy or delete everything including properties, switch to Source view and select all there.

Properties do not appear as headings in the outline. Read view displays them at the top of the document. When exporting PDF, the **Document Properties** option controls whether to include them; it is unchecked by default.

## Edit and read

### Choose a view for your work

| View | Use it to |
| --- | --- |
| Edit | Write while seeing headings, bold text, lists, and other formatting. |
| Source | View and change Markdown markup, check links and blank lines, or work with complex formatting. |
| Read | Read the formatted document with fewer editing controls in the way. |

All three views use the same document. There is no need to copy content between them. To change the body, footnotes, or comments, switch to Edit or Source view.

### Common formatting

Type Markdown directly, or use the formatting toolbar and keyboard shortcuts to add bold, italics, highlights, strikethrough, and links, or insert headings, lists, blockquotes, tables, code blocks, and callouts.

In tables, edit cells directly and use the table controls to add or remove rows and columns. Switch to Source view whenever you need to check the underlying markup.

### Shortcuts when you need them

Hover over a control to see its keyboard shortcut. You can gradually get comfortable with the keyboard without memorizing a hundred shortcuts, keeping your attention on writing.

### Focus mode

Turn on **Focus Mode** for a quieter writing space. Press `Esc` to leave it.

### Rich-text copy, paste and drop (1.0.4)

This section describes the upcoming 1.0.4. Download links above still point to released 1.0.3 and will change only when the new release is published.

Use Copy as rich text (`⌘⇧C` on Mac, `Ctrl+Shift+C` on Windows) to supply formatted content and a readable plain-text fallback; the receiving application chooses a format. Ordinary copy is a separate action. Leaf converts incoming HTML to Markdown in both Edit and Source views, rather than preserving the original webpage layout. A plain-text-only source cannot supply a missing link target.

Drop external rich text at a position in the body and undo the insertion in one step. Internal text moves, image imports and opening dropped Markdown files retain their existing behavior. Live preview hides valid escape markers away from the caret. Source view retains escapes such as `\[` to preserve literal brackets; the underlying file is unchanged.

Valid Ripple v2 source links retain their named labels for production `ripple-transcript` and development `ripple-segment-dev`. Use Command-click on Mac or Ctrl-click on Windows in Edit view, or click in Reading view. Saving, pasting and dropping never launch another application. The matching Ripple application must be installed and its protocol registered. Other editors choose whether to retain or open these links. Existing web, email, anchor and relative-file links retain their behavior; arbitrary application schemes are not supported.

The Mac daily fix build has user acceptance. Windows build checks and automated tests are separate from user installation acceptance; actual Windows cross-application drag and return links remain unverified by the user.

## Navigate and review

### Outline navigation

The outline shows the document's heading hierarchy. Click a heading to jump to that section. If a section is missing, check that its title uses heading formatting.

### Footnote sidebar

Place the cursor where you want a reference, use **Insert Footnote** or its shortcut, and enter the note. A marker in the body points to the footnote; the sidebar lets you review and edit notes beside the text. All footnotes are also available at the end of the document.

In the sidebar, double-click a footnote or press Enter to edit it. Use the return-to-text control to locate its reference marker. Deleting a footnote also removes all its references from the body; you can undo this action.

Footnotes are saved in Markdown footnote format. If Leaf reports a missing footnote definition, switch to Source view and check that the reference has a matching definition.

### Document comments

Select text within one paragraph and use **Add Comment** to leave feedback. You can also place the cursor between characters to add a comment at that position.

Open the comment sidebar to review feedback and locate the related text. Double-click a comment or press Enter to edit it. Deleting a comment leaves the document text intact.

Leaf also supports Obsidian hidden comments, written as `%%comment text%%`. Their source text remains visible in Edit view, is hidden from the body in Read view, and is listed in the comment sidebar.

Footnotes and comments share the right sidebar. Switch between them using their tabs.

## Display and layout

### Theme, font, and reading width

Under **Settings → Appearance**, choose a light, dark, or system theme and adjust the body font, font size, and maximum body width.

These settings help you find a comfortable layout for reading and writing. They do not add font, size, or width information to the Markdown body.

### Source line numbers

Enable **Source Line Numbers** under **Display** in the formatting toolbar to show Markdown source line numbers beside the body. These help you locate text and describe issues.

Line numbers are not paragraph numbers. Text that wraps onto several visual lines still belongs to one source line. Blank lines may not display a number in Edit view, so the numbers may have gaps.

Line numbers are visual guides only. They are not added to or saved in the document text.

### Heading numbering

Enable **Multilevel Heading Numbering** under **Display** to show numbers such as “1”, “1.1”, and “1.2” based on the heading hierarchy.

**These numbers are a visual aid. They are not added to heading text or written to the Markdown file.** Turn the option off to display headings without them.

If you want numbers in the actual heading text, enter them yourself. This feature is also separate from numbered lists in the body.

### Clean Up Blank Lines

Blank lines in Markdown separate paragraphs and other blocks. **Clean Up Blank Lines** adds missing separators, removes excess blank lines, and clears blank lines at the beginning and end of the document.

In Edit or Source view, click **Clean Up Blank Lines** in the toolbar, or search for it in the command palette.

**This operation changes the Markdown content throughout the document.** A single undo reverses all changes made by this operation. It is different from formatting marks under Display, which only control the visibility of marks such as line breaks and do not change the text.

| Location | Result |
| --- | --- |
| Between ordinary paragraphs | Keep one blank line, adding it if missing or removing extras. |
| Between a paragraph and a heading, list, table, or other separate block | Keep one blank line. |
| Between adjacent list items, or a parent item and a nested list | Remove extra blank lines while keeping hierarchy and indentation. |
| Between paragraphs within a list item | Keep the blank lines needed to preserve the structure. |
| Beginning and end of the document | Remove excess blank lines. |

Before:

```markdown
First paragraph
Second paragraph


- First item

- Second item
```

After:

```markdown
First paragraph

Second paragraph

- First item
- Second item
```

In ordinary body text, two consecutive lines are treated as separate paragraphs, with a blank line added between them. Continuation lines inside list items are not split this way. If you intentionally wrap lines within a paragraph, consider whether you want to run this operation.

Blank lines inside properties, code blocks, HTML blocks, blockquotes, callouts, and footnote definitions are preserved. Inline formatting spanning multiple lines is also protected. The operation does not change list text or indentation, but affected ordered lists follow automatic numbering rules to keep their numbers consecutive.

For a closer check, inspect the result in Source view before saving.

## Images and PDF

### Image management

Images inserted into a document are saved in a companion folder beside it. For example:

```text
Travel notes.md
Travel notes.assets/
```

**When moving, backing up, or sharing a document, include both the `.md` file and its `.assets` folder, keeping their relative locations unchanged.** Someone receiving only the Markdown file may not be able to see its local images.

If the document already references other local images, keep those files and their relative paths as well.

### Export PDF

Use **Export PDF**, check the preview, and follow the prompts to save. If the system print dialog opens, choose to save as PDF.

The preview shows document styling, not actual pagination. After exporting, open the PDF to check headings, images, tables, and page breaks.

Footnotes appear as endnotes. **PDFs do not include document comments, hidden comments, or comment markers.** Keep the original Markdown file if you need to retain review feedback.

## Draft recovery and app updates

### Recover unsaved changes

When Leaf reports recoverable content, click the prompt to view it. You can also go to **Settings → Saving & Recovery** and choose **View Recoverable Drafts**.

Restoring a draft replaces the current editing content and can be undone. Check the restored document, then save it manually. Autosave pauses after recovery to avoid overwriting the file before you have reviewed it.

Saving & Recovery also lets you set how long recovery records are kept and restore the version before the most recent save. These records expire and are not a substitute for long-term backups.

### Check for updates

Leaf 1.0.3 checks for updates and shows release notes within the app, then opens the official download page in your browser. Save your documents and quit Leaf normally before installing the update manually: replace Leaf in Applications on Mac, or run the Windows installer over the existing installation. This version does not download or install updates within the app, or quit and restart automatically.

An in-place update preserves persistent settings and app data when you use the same OS user account and installation location, without uninstalling Leaf or clearing its data folders. This does not cover changing users, migrating data, or moving the tunnel client directory. Temporary connections must be re-established, and external AI apps, including ChatGPT, may ask you to authorize MCP access again.

**Windows updates:** Keep **Delete the application data** unchecked if an uninstall step appears. Selecting it during a normal uninstall deletes Leaf’s settings and MCP connection configuration. Replacing old program files is different and can proceed normally.

If you use 1.0.1 or 1.0.2, install 1.0.3 manually from the release page first.

## AI-assisted editing

Leaf currently supports **ChatGPT, Claude Desktop, and WorkBuddy** for AI-assisted editing and review through MCP. Set up the MCP connection for your chosen app before use.

To let AI read and edit documents, enable MCP under **Settings → AI-Assisted Editing**. See [AI-assisted editing and MCP connections](AI_CONNECTIONS.md) for setup instructions.

Once connected, AI can access open documents, including unsaved content. Relevant text is sent to the AI service you use. Decide whether to enable it based on the document and your needs.

## Get help

Use [GitHub Issues](https://github.com/CoozeeWang/leaf-markdown/issues) to report problems or suggest improvements. Include your operating system, Leaf version, the steps you took, and what you expected versus what happened.

Version and build information are available in Settings. Screenshots and sample documents can help diagnose a problem, but remove private content and keys first.
