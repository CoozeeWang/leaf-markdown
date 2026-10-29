# Leaf 1.0.4 — release preparation draft

[简体中文](RELEASE-NOTES.zh-CN.md) · **English**

This version is not published. [1.0.3](https://github.com/CoozeeWang/leaf-markdown/releases/tag/v1.0.3) remains the public release; this draft does not imply that 1.0.4 downloads exist.

## Changes

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

- The fixes are merged in main through PRs #120 and #121. The user accepted Mac daily fix build `0d516f12`, whose product version is 1.0.3; this does not represent acceptance of a published 1.0.4 package.
- The Windows x64 candidate was built from `e92db721ca87dbc22442b5e55d215d1c03363576`. The [full Windows workflow](https://github.com/CoozeeWang/leaf-markdown/actions/runs/40879620840) passed source, browser, native, MCP, actual installer integration and PDF checks. Download/archive checksums match; installer file/product version is 1.0.4.0. Actions artifacts expire on 2026-11-05 at 13:29 UTC and are not Release assets.
- Windows user installation and actual cross-application drag/link opening remain pending. Automated checks do not establish all language/OS combinations. The Mac arm64 1.0.4 DMG is built from the same `e92db721` application source. Disk-image verification, mounted bundle comparison and strict ad-hoc signature checks passed; GUI/helper build identities match. The daily installation was not replaced.
- Both installer Minisign signatures have been independently verified using the unchanged 1.0.3 release public key. The existing signing configuration was recovered from the original creation record; no new signing identity or password change was needed.
- Before publication, verify the final source, both platform artifacts, SHA-256, signatures using the existing release key, and final asset names. No 1.0.4 tag, Release or public release assets have been created.

[User guide](INSTALL.md) · [AI / MCP connections](AI_CONNECTIONS.md) · [Support Leaf](SUPPORT.md)
