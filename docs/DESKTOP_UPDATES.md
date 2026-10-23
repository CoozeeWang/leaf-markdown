# Desktop updates

Leaf uses one independent Software Update window. Open it from **Leaf → Check for Updates…** on macOS or **Help → Check for Updates…** on Windows. The welcome screen and document windows share this window. Settings does not repeat the manual check action.

## User flow

Checking is manual. When a compatible version is available, **Update and Restart…** opens one confirmation naming that version. Cancel has initial keyboard focus. Confirmation authorizes download, verification, saving every open document, installation and one restart. Downloading does not lock editing; the participating document set is captured immediately before preparation. Untitled documents request a save location. Cancellation, failure or a missing participant cancels preparation and leaves documents open.

Closing the update window keeps its download and state, and revokes permission to install. Reopening a ready download requires a new confirmation. Escape first cancels an open confirmation; a subsequent Escape closes the update window. Opening the window explicitly sets keyboard focus.

## Document preparation and installation

Native code owns the transaction ID, participant set, write barrier and installation authority. Preparation freezes new document creation and new writing tasks, drains existing saves, resource writes and MCP work, then requests bound Frozen, Saved and Sealed replies from each document. Replies from the wrong window, session, revision or transaction cannot authorize installation. Preparation rechecks native document identity, saved file identity and bytes, pending operations and package integrity. The helper must finish readiness before a fresh short lived commit permit is issued. Only one successful permit consumption and the matching application exit authorize the helper to install.

The existing per-document close command is not the preparation protocol. An abort releases the preparation barrier without destroying document windows. A save that completed before a later cancellation remains saved.

On macOS the complete app, MCP adapter and update helper are validated before executing the helper. The helper receives a native-owned plan, independently verifies it, waits for the exact GUI process to exit and uses one same-volume atomic exchange. It validates the replacement before one exact-version restart. Failed post-install validation exchanges the original app back. Failed recovery keeps the original bundle at the reported recovery location. The updater does not terminate unrelated AI clients. Running a retained recovery bundle cannot make that backup an installation target.

On Windows an external current-user supervisor runs the authenticated NSIS installer after the GUI exits. Before the first installer mutation it saves and hashes the complete installation directory and Leaf-owned registration values. Shared Markdown extension keys are backed up and restored by individual installer-owned values, preserving unrelated registrations and UserChoice. The helper checks every payload file for replacement locks, may stop only an adapter at the exact installed path, and blocks on other occupied files. Installer exit alone is insufficient: the completion marker, full new inventory, executable identities and registered version must agree. A partial failure restores and verifies the full old payload and registration snapshot; failed restoration keeps the backup and reports recovery failure. The helper permits one restart of the verified target and reconciles the durable result against actual disk contents on launch.

Windows 1.0.0 has checking, downloading, authentication and document preparation, but no installation executor. It cannot obtain the missing executor simply by publishing a new update package. A complete newer installer must first be installed manually as the Windows update baseline, followed by a strictly higher version for an actual online-upgrade test. Windows installer integration, file occupancy, recovery, GUI restart and online acceptance remain separate evidence; a Mac pass does not establish Windows readiness.

## Trust and data preservation

The native source is the fixed official Leaf repository. Checks enumerate complete published Release pages, including published Betas, and compare product semantic versions strictly. Missing compatible manifests are distinct from being current; incomplete pagination is a failure. Internal builds of the same product version require manual installation.

Each accepted release must bind its tag, manifest version, archive, authenticated complete inventory, platform, architecture and binary version identities. Signatures authenticate both version and contents. Extraction bounds cover compressed and expanded size, entry count, path length and depth, traversal and symbolic links. A new label cannot authenticate an old signed package. Repository, trust key and installation target cannot be supplied as arbitrary frontend arguments.

Only application resources are replaced. Application identity, user-data and WebView locations, language, theme, body fonts, layout, save preferences, recent files, named and untitled drafts, recovery records and connection configuration remain outside the replacement. Synthetic credential usability is checked independently of configuration presence. Production trust identity and an actual higher official signed release remain separate prerequisites; fixture keys do not enable production installation.

## Verification environments and evidence

Use the established complete environment or the manual CI workflows for full frontend checks, Rust, native probes and packaging. Local lightweight previews and pure runner/oracle tests do not establish native or installed behavior.

The manual full-platform workflow runs the frontend matrix, locked Rust tests, actual native admission and multi-document preparation, official-source HTTPS, signed-package boundaries, native window roles, and the Mac independent-helper matrix. The Mac helper matrix uses fresh TEST-ONLY signatures and disposable temporary roots. It exercises actual codesign verification, process occupancy, GUI-exit waiting, atomic filesystem exchanges, failed swap-back and one restart. Its synthetic app executables prove the installation mechanism; they do not prove actual Leaf GUI or settings continuity.

The preservation oracle in `tests/desktop-updates-preservation.mjs` compares immutable, run-bound semantic snapshots for successful restart and rollback. All required categories must be captured from actual application storage in an installed fixture. A copied sentinel file alone is insufficient. Credential evidence contains only opaque identity and challenge success. Raw settings, private paths, documents and credentials must not enter public fixtures or reports.

The package workflow's `windows-updater` scope runs only the relevant Windows transaction and installed NSIS/recovery suite in `tests/windows-desktop-updates.ps1`. Its disposable runner reuses the already-built 1.0.0 baseline, checks six actual partial-mutation fault positions, restore failure, payload locks, an exact-path adapter and an unrelated same-name process. Restart checks launch the real executable's identity entry point once; they do not establish a visible GUI restart or real official online upgrade. Fault-injection commands exist only in a native-smoke helper and separately compiled NSIS fixture; release installers do not accept them. The production archive includes the complete expected installed payload plus `.leaf-update-installer.exe`, all bound by its authenticated inventory.

Record six evidence levels independently:

| Level | Required evidence |
| --- | --- |
| Source | Exact commit and successful relevant checks |
| Synthetic UI | Three languages, both themes, long notes, small window, errors, disabled controls, focus and Escape |
| Native fixture | Actual document protection, helper/filesystem behavior and fault outcomes |
| Installed package | Actual Leaf executable, visible native window/menu, restart and settings continuity |
| User confirmation | Explicit observations from the acceptance operator |
| Official online upgrade | Separately verified higher official signed artifact and real upgrade |

A package build is not an installed pass. DOM rendering does not prove a native window is visible. Open the actual native menu and verify the window from its real installation location. Keep failures and pending platform rows explicit. Mac daily installation is allowed only after its applicable gates and specific user authorization. Windows and human acceptance can remain pending without becoming passes. Package workflows create internal artifacts; implementation, successful checks and installation do not authorize a Release or production key provisioning.
