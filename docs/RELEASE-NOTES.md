# Leaf 1.0.4

[简体中文](RELEASE-NOTES.zh-CN.md) · [繁體中文](RELEASE-NOTES.zh-TW.md) · **English**

This release improves everyday editing, outline organization and text selection, and fixes callout editing, rich-text drops and Windows reinstalls. See the [changelog](../CHANGELOG.md) for the full list.

## Highlights

- Drag outline headings to reorder sections and change their hierarchy, preserving child sections, content and fold state, with a single undo.
- Correct callout caret height and duplicate blinking. Enter in a title focuses the body; Enter in the trailing empty ordinary paragraph exits the callout. Placeholder hints are no longer written into new callouts.
- Keep a single lock icon across successive AI editing tasks.
- Preserve validated Ripple source links in rich-text paste. External text drops on Mac insert at the drop position with a single undo; callout paste uses the same conversion.
- Reduce repeated parsing of long and nested documents, improve editing focus and selection, and hide valid escape markers in live preview without changing Markdown source or code.
- Use consistent lightweight tooltips and center the document-name menu. Mac uses “Show in Finder”; Windows keeps “Show in File Explorer”.
- Stop triple-click selection backgrounds from extending into the next line's indentation. Whole-line selection still includes the newline; ordinary cross-line selections remain unchanged.
- Preserve the original file-association restoration information across Windows reinstalls.

Leaf converts rich text to Markdown; it does not reproduce every source application's layout. Application source links are limited to supported Ripple protocols. Paste, drop and save never launch another application. Command-click on Mac or Ctrl-click on Windows in Edit view, or click in Reading view, to request opening a link.

## Downloads and updates

Download from the [GitHub Release](https://github.com/CoozeeWang/leaf-markdown/releases/tag/v1.0.4):

- `Leaf-1.0.4-macOS-arm64.dmg`: Apple Silicon Mac.
- `Leaf-1.0.4-windows-x64-setup.exe`: Windows x64.

The release page includes SHA256 checksums, detached Minisign signatures and build provenance. Save your work and quit Leaf normally before replacing it. On Windows, leave **Delete the application data** unchecked if an uninstall option appears. Preserve settings and MCP configuration. Updates still use browser downloads and manual installation; Leaf does not automatically quit or restart.

Mac builds use ad-hoc signing without Developer ID signing or notarization. Windows installers lack Authenticode signing. Download signatures do not provide OS publisher signing. See the [installation guide](INSTALL.md) for system requirements and first-launch prompts.

## Verification scope

The editing fixes passed local unit tests and Chromium/WebKit regressions. The Mac daily build has been installed. Refer to the release page for Windows automated checks, final package provenance and integrity results. Windows user installation acceptance remains pending; automated checks do not establish that acceptance, and the related issues retain this status.

[User guide](INSTALL.md) · [AI / MCP connections](AI_CONNECTIONS.md) · [Support Leaf](SUPPORT.md)
