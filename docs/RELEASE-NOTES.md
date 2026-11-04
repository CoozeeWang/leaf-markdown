# Leaf 1.0.5

[简体中文](RELEASE-NOTES.zh-CN.md) · [繁體中文](RELEASE-NOTES.zh-TW.md) · **English**

This patch fixes wrapped-toolbar notices and text that did not follow interface language changes. See the [changelog](../CHANGELOG.md) and [Issue #125](https://github.com/CoozeeWang/leaf-markdown/issues/125).

## Highlights

- Status notices and their close buttons remain accessible when the document title and formatting toolbar wrap.
- Draft recovery and version-history titles, descriptions and primary buttons follow language changes while preserving the selected record, preview and editing state.
- The proxy input hint in advanced AI settings follows language changes without resetting its value or configuration.

## Downloads and updates

Download from the [GitHub Release](https://github.com/CoozeeWang/leaf-markdown/releases/tag/v1.0.5):

- `Leaf-1.0.5-macOS-arm64.dmg`: Apple Silicon Mac.
- `Leaf-1.0.5-windows-x64-setup.exe`: Windows x64.

The release page includes SHA256 checksums, detached Minisign signatures and build provenance. Save your work and quit Leaf normally before replacing it. On Windows, leave **Delete the application data** unchecked if an uninstall option appears. Preserve settings and MCP configuration. Updates still use browser downloads and manual installation; Leaf does not automatically quit or restart.

Mac builds use ad-hoc signing without Developer ID signing or notarization. Windows installers lack Authenticode signing. Download signatures do not provide OS publisher signing. See the [installation guide](INSTALL.md) for system requirements and first-launch prompts.

## Verification scope

The maintainer confirmed Mac and Windows acceptance for this fix batch on November 4, 2026. The exact Windows build and individual language combinations were not recorded in that confirmation. Local validation passed 446 unit tests and nine targeted browser suites, with the key layout and translation suites checked in Chromium and WebKit. Final package checks and build provenance are listed on the release page; acceptance of the fixes does not establish compatibility with every OS version.

[User guide](INSTALL.md) · [AI / MCP connections](AI_CONNECTIONS.md) · [Support Leaf](SUPPORT.md)
