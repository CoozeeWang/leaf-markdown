# Leaf 1.0.4 — release preparation draft

[简体中文](RELEASE-NOTES.zh-CN.md) · **English**

This version is not published. [1.0.3](https://github.com/CoozeeWang/leaf-markdown/releases/tag/v1.0.3) remains the public release; this draft does not imply that 1.0.4 downloads exist.

## Changes

- Keep a single lock icon throughout AI editing tasks. PR #112.
- Empty callout bodies use UI-only hints. Title Enter focuses the body; Enter on its trailing empty ordinary paragraph exits the callout. Preserve existing literal content. PR #115.
- Callout-body rich-text paste uses the same safe conversion as ordinary text, preserving validated named deep links, selection replacement and single undo.

- Preserve validated named Ripple production/development source links in rich-text paste, consistently in Edit and Source views and after saving. PRs #120 and #121.
- Fix external text drops being consumed on macOS. Insert rich text at the drop position with one undo, preserving file drops and internal text moves. PR #121.
- Hide parsed escape markers around literal brackets such as timestamps in live preview. Markdown source and code remain unchanged. PR #121.
- Reduce repeated parsing of long and nested content, restore editing focus, and improve callout text-selection feedback. PR #119.
- Document rich text, application links and Windows update data preservation in all three user guides.

Leaf converts HTML to Markdown; it does not reproduce every source application's layout. Application links are limited to the verified Ripple production/development v2 contracts. Paste, drop and save never launch another application. Command-click on Mac or Ctrl-click on Windows in Edit view, or click in Reading view, to request opening a link. The matching application and protocol registration must be present.

## Installation and updates

Planned filenames: `Leaf-1.0.4-windows-x64-setup.exe` and `Leaf-1.0.4-macOS-arm64.dmg`. Final download links, checksums and build provenance must be added before publication.

Save your work and quit Leaf normally before replacing it. On Mac, use the existing Applications location. On Windows, install at the existing location and leave **Delete the application data** unchecked if an uninstall step appears. Application identity and data locations remain unchanged. Leaf checks for updates and opens official downloads in the browser; it does not install updates or restart itself.

See the [installation guide](INSTALL.md) for system requirements and security prompts. Mac builds use ad-hoc signing without Developer ID/notarization; Windows installers lack Authenticode signing. Checksums and detached Minisign signatures do not provide OS publisher signing. Keep system protection enabled.

## Verification and publication boundary

- Previous Mac/Windows candidates from `e92db721` exclude PRs #112/#115 and the callout paste follow-up. They are superseded and retained only as historical evidence.
- Final application source: `49841a3c1aba0e3ab59ddb1368b96918506afd37`. Source/native CI and local Chromium/WebKit regressions passed. PRs #112/#115 are merged; the callout paste follow-up is included in this preparation branch.
- Mac 1.0.4 / `49841a3c` was rebuilt, signature-verified, installed with application/state backups and explicitly accepted by the user. Windows standard packaging and automated verification [passed](https://github.com/CoozeeWang/leaf-markdown/actions/runs/40893319389). Both installers passed checksum and detached-signature verification with the existing release public key. Windows user installation remains deferred.
- No 1.0.4 tag, Release or public release assets have been created.

[User guide](INSTALL.md) · [AI / MCP connections](AI_CONNECTIONS.md) · [Support Leaf](SUPPORT.md)
