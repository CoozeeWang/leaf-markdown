# Leaf 1.0.3

[简体中文](RELEASE-NOTES.zh-CN.md) · **English**

Leaf 1.0.3 checks for a new version, shows its notes, and opens the official platform installer in your browser. It no longer downloads or installs updates, prepares documents, quits, or restarts the application.

This release preserves unsaved-document protection, fixes a cancelled close blocking later close/quit attempts, follows Stylebook typography, and adds a conventional drag-to-Applications Mac DMG. The Windows installer removes only the retired helper in the registered installation folder while preserving persistent data.

Save your work and quit Leaf normally before installing. On Apple Silicon Macs, drag Leaf from the DMG into Applications and choose Replace. On Windows x64, run the installer at the existing location. Users on 1.0.1 or 1.0.2 should install this baseline manually once. Persistent settings and MCP/tunnel configuration retain their existing locations; temporary sessions reconnect, and external authorization may still need confirmation.

SHA-256 checksums, detached Minisign signatures and the existing public key are included. These do not provide Apple notarization or Windows Authenticode signing. User installation and external MCP authorization acceptance remain pending.


Provenance: both production applications were built from `22c540e4915ad61354c9747551da5728ceeabce4` (displayed build `22c540e4`). Packaging and isolated test fixes are included through `4893d0520bd43eaaf94e703da7199e040d423d96`, merged in [PR #106](https://github.com/CoozeeWang/leaf-markdown/pull/106). Release source: `9c4588adc3a55efd467279bf71d4574c51161e34`. The reused GUI and MCP executable hashes were verified, including after Windows installation.

Validation: [Windows manual install, configuration preservation, adapter replacement and close protection](https://github.com/CoozeeWang/leaf-markdown/actions/runs/40084739161); [native MCP protocol and lifecycle](https://github.com/CoozeeWang/leaf-markdown/actions/runs/40084190674). User daily installations have not been replaced by this release task.

Main verification: [source tests and frontend build](https://github.com/CoozeeWang/leaf-markdown/actions/runs/40085232516); [native renderer, protocol and lifecycle gates](https://github.com/CoozeeWang/leaf-markdown/actions/runs/40085232551).

## Documentation

- [Installation and usage guide](INSTALL.md), including [first-launch security prompts](INSTALL.md#first-launch-security-prompts)
- [AI-assisted editing and MCP connections](AI_CONNECTIONS.md)
- [Support Leaf](SUPPORT.md)
