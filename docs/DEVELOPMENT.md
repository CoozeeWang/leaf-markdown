# 开发与验证 / Development and verification

需要 Node.js 22、Rust stable，以及平台原生工具链：macOS Xcode Command Line Tools；Windows Visual Studio C++ Build Tools（Desktop development with C++）及 WebView2。

Use Node.js 22, stable Rust, and native platform prerequisites. Install the Xcode Command Line Tools on macOS; install Visual Studio C++ Build Tools and WebView2 on Windows.

```sh
npm ci
npx playwright install chromium webkit
npm run check
npm run test:browser
```

`npm run test:browser:all` 运行全部浏览器回归，包含公开合成的长表格样例。`npm run test:browser -- footnote-regressions-browser.mjs` 运行指定用例。入口自行管理 Vite，截图存放在忽略提交的 `test-results/`。可设置 `LEAF_BROWSER_CHANNEL=chrome` 使用已安装 Chrome，默认使用锁定的 Chromium。不能将浏览器平台模拟算作原生 Windows 验收。

The runner owns its Vite server on port 41732 and fails if that port is occupied. It runs pinned Chromium by default. Screenshots are written to ignored `test-results/`. Browser platform emulation does not replace native Windows testing.

选区合成回归同时运行 Chromium 与 WebKit；两者都需要安装。它覆盖重复色块、编辑器原生选区透明范围和结构化输入框的选区，不代替 macOS WKWebView 真机验收。

Rust 测试在 `src-tauri` 中运行：

```sh
cargo test --locked --all-targets
```

Issue #36 的文件跟随回归包含 `src-tauri/src/document_location.rs` 中的原生文件身份测试，以及 `tests/document-session.test.js` 中的串行轮询、未保存编辑和保存去向测试。Rust 测试在本机一次性目录中改名、移动和替换文件；前端测试使用模拟文件接口。两者通过后，仍需分别在 macOS、Windows 原生应用中用一次性 Markdown 文件检查文件名、最近打开和保存位置。浏览器测试与 macOS 结果不能代替 Windows 实测；构建通过也不能代替已安装应用的人工验收。

空行整理的规则见[空行整理说明](BLANK-LINES.md)。相关回归为 `blank-lines.test.js`、`blank-lines-browser.mjs` 和 `paragraph-blank-lines-browser.mjs`：覆盖补减空行、首尾清理、嵌套列表和受保护内容，并检查按钮、快捷键、一次撤销／重做、重复整理、预览及保存后重新打开的一致性。保存检查使用模拟文件接口，不代替桌面版真实文件验收。

macOS 原生空行整理检查使用同一开发服务器，在 `src-tauri` 中运行 `cargo run --locked --example native-table-keys -- ../tests/native-blank-lines.html http://127.0.0.1:41732/tests/native-blank-lines.html`。它在实际 WKWebView 中检查整理、预览／源码切换、保存回调、撤销／重做和 CRLF 保留；不代替安装版真实文件保存与重新打开的验收。

Cargo 使用标准 crates.io。需要网络镜像时，在个人 Cargo 配置中设置，不修改项目的公共配置。macOS 原生 WebKit 示例只在 macOS 执行；其他平台编译时显示不支持提示。

Cargo uses crates.io. Configure network mirrors in your own Cargo configuration. Native WebKit fixtures only execute on macOS.

状态提示回归为 `recovery-notice-browser.mjs`、`file-feedback-browser.mjs` 和 `status-notices-browser.mjs`，覆盖工具栏下方的单一提示、4 秒寿命、关闭、恢复入口、长错误换行、窄窗／深色以及保存保护。macOS 原生检查使用同一开发服务器：在 `src-tauri` 中运行 `cargo run --locked --example native-table-keys -- ../tests/native-status-notices.html http://127.0.0.1:41732/tests/native-status-notices.html`。它验证实际 WKWebView 的显示和交互，但使用模拟文件接口，不代替安装版真实文件保存与恢复验收。

macOS 图片插入隔离检查：先在仓库根目录启动 `npm run dev -- --host 127.0.0.1 --port 41732 --strictPort`，再在 `src-tauri` 执行：

```sh
cargo run --locked --example native-table-keys -- ../tests/native-image-insertion.html http://127.0.0.1:41732/tests/native-image-insertion.html --foreground
```

`--foreground` 会短暂激活测试窗口，以真实焦点验证延迟图片加载后的光标可见性和 AppKit 退格。图片导入和资源字节是合成的；这不代替 Finder 拖放、原生文件选择器或 Windows 真机验收。省略此参数时保留原有后台键盘检查行为。

拖放标记的自动换行定位检查可用同一入口运行 `../tests/native-image-drop.html` 与 `http://127.0.0.1:41732/tests/native-image-drop.html`，无需 `--foreground`。它在实际 macOS WKWebView 中核对标记所在的视觉行、原光标不移动及取消恢复，但输入坐标是测试构造的，不代表 Finder 真拖放已验收。浏览器拖放回归同时覆盖 Chromium 与 WebKit。

图片移动回归为 `image-move.test.js` 和 `image-drag-browser.mjs`，覆盖 Cmd／Ctrl 鼠标拖动、取消、属性保护、结构化图片、边缘滚动、一次撤销及模拟文件保存重开。macOS 可用同一开发服务器和 `native-table-keys` 示例运行 `../tests/native-image-drag.html` 与 `http://127.0.0.1:41732/tests/native-image-drag.html`；该夹具使用合成鼠标事件检查实际 WKWebView、CRLF 与撤销／重做，不代替安装版人工拖动验收。

## 开发与打包 / Development and packaging

`list-images-browser.mjs` 在 Chromium 和 WebKit 中检查列表图片取消缩进、重新缩进、相邻列表项、撤销／重做、预览／阅读／导出一致性及模拟保存重开。macOS 可用上述开发服务器和 `native-table-keys` 示例运行 `../tests/native-list-images.html` 与 `http://127.0.0.1:41732/tests/native-list-images.html`；它在实际 WKWebView 中通过 AppKit 发送 Shift+Tab 并检查布局和快捷键处理，图片字节为合成输入，不代替安装版真实文件验收。

```sh
npm run dev
npm run desktop:dev
```

`desktop:dev` 打开独立的 **Leaf Dev** 原生窗口。macOS 开发入口需要 Node.js 22.15 或更高版本；启动时生成忽略提交的 `.cache/Leaf Dev.app` 开发壳，重新编译后替换其中的可执行文件，由 Tauri 直接管理应用进程，避免残留旧窗口。界面由本机 Vite 服务提供，样式自动更新，脚本修改可能刷新整页；Rust 修改会重新编译并重启应用。手动重启时先保存验收文档，结束开发进程，再运行同一入口。刷新和重启不保证保留光标、撤销记录或尚未保存的编辑。

开发入口使用 `studio.leaf.editor.dev`，最近文件、恢复草稿、历史版本、保留设置和移除图片备份与安装版分开。macOS 主窗口、文档窗口和 PDF 导出窗口共用独立的持久网页存储，主题等设置可跨重启保留；此入口要求 macOS 14 或更高版本，旧系统会拒绝启动，安装版最低系统配置不变。Windows 网页存储随独立应用标识分开，但仍需 Windows 实测。

开发版不制作安装包、不注册默认文件关联，也不安装 Finder 服务提供者。界面显示「Leaf Dev」和「开发模式 · 使用文档副本」。应用数据隔离不会保护主动打开的原始 Markdown 文件或附件：验收必须使用一次性目录中的合成文档或副本。不要在开发版与安装版中同时编辑同一个原文件。此入口不接受额外参数，避免配置覆盖绕过隔离。

日常启动和重启可由负责开发的 Agent 管理。安装、升级、卸载、正式数据迁移、文件管理器双击与图标、默认程序关联、Finder 服务、Windows 右键菜单、系统入口冷启动／已有实例接收文件，以及打包资源、离线启动、签名／权限和跨机器兼容性仍通过实际安装包检查。涉及文件保存、恢复、打印或 PDF 导出的修改，在开发窗口检查后也需对交付安装包复核；开发模式和 macOS 结果不替代安装版或 Windows 验收。

在 macOS 构建 DMG：

```sh
npm run desktop:build -- --config src-tauri/tauri.macos.conf.json
```

在 Windows 构建当前用户安装程序：

```sh
npm run desktop:build -- --config src-tauri/tauri.windows.conf.json
```

GitHub `Checks` 工作流在推送时运行 Linux 上的前端单元测试与构建。`Full platform tests (manual)` 可按需在 macOS／Windows 跑浏览器和原生检查。`Internal test packages` 手动工作流生成 Apple Silicon、Intel 或 Windows x64 安装包，附 SHA-256，Actions artifacts 保留 7 天；不会创建 Release，也不会改变仓库可见性。需要仓库访问权限才能下载私有仓库的产物。

The manually dispatched package workflow uploads installers and SHA-256 checksums as Actions artifacts for 7 days. It does not create a Release or change repository visibility. Private repository artifacts require repository access.

macOS 构建入口会为打包子进程设置 `en_US.UTF-8`，避免系统 Perl 在不支持的 `C.UTF-8` 环境中崩溃；不改变系统设置或应用语言。

## 限制 / Limits

目前是未正式签名的内部构建；尚不能保证其他机器安装顺利。最低系统要求以实际完成的验收记录为准，不能仅凭配置中的最低版本宣传支持。

These are internal builds without distribution signing. Installation on another computer is not yet certified. Claim only operating-system versions that have passed the native checklist.

## 文档图标 / Document icons

`src-tauri/icons/document-icon.png` 是 Markdown 文档图标的规范原图；项目锁定的 Tauri 图标工具从它生成 `document-icon.icns` 和 `document-icon.ico`。这三份资源与应用图标分开维护。macOS 的 `src-tauri/Info.plist` 在打包时覆盖文档类型数组，为现有三个扩展名指定随包的 `document-icon.icns`；更改 `bundle.fileAssociations` 时同步该数组。Windows 安装包把 `document-icon.ico` 放在安装目录，安装后只改 Leaf 文档类的 `DefaultIcon`；应用可执行文件与两个文件夹右键菜单继续使用应用图标，不改写系统的 UserChoice 默认程序选择。

macOS 构建后运行 `node tests/document-icons-package.mjs src-tauri/target/release/bundle/macos/Leaf.app`，检查真正打包的文档和应用图标资源、关联声明与 Finder 服务，并用 `codesign --verify --deep --strict` 核对实际 `.app`。`Internal test packages` 自动执行对应平台检查；Windows 的 `tests/document-icons-windows.ps1` 仅允许在一次性 GitHub Actions runner 中静默安装／检查／卸载，验证安装资源、多尺寸图标、三个扩展名注册、两个右键菜单图标、Windows UserChoice 与合成文档不变，并核对卸载清理。源码检查、Mac 打包检查和 Windows CI 安装检查是不同层证据；它们不替代当前已安装应用的检查或用户在系统设置中切换默认应用、双击打开、Finder／Explorer 图标缓存刷新和不同主题尺寸的人工验收。


## 文件管理器新建文档 / File manager creation

macOS 在 Finder 选中单个文件夹或文件，右键「服务 → 使用 Leaf 新建 Markdown 文档」。选中文件夹时在其中创建，选中文件时在其所在目录创建；不读取 Finder 前台窗口，也不需要自动化权限。服务随 App 的 `NSServices` 声明安装，由 `native_services.rs` 注册；首次安装若尚未显示，可在系统设置的键盘快捷键「服务」中检查开关。Finder 空白区域的右键菜单不是此服务的入口。

Windows 安装包通过 `windows-hooks.nsh` 注册当前用户的文件夹／文件夹背景右键菜单；Windows 11 可能需要展开「显示更多选项」。`--new-in` 参数在冷启动和已有实例中走同一路径，卸载时仅移除仍指向本安装位置的 Leaf 菜单。

两平台均原子创建 `未命名.md`，重名依次使用 `未命名 2.md` 等，随后打开 Leaf。可用现有标题改名；失败显示原生错误提示，已创建但打开失败的文件保留并告知位置。Rust 测试覆盖并发、重名、无效目录和 Finder 专用粘贴板输入；Mac 原生粘贴板测试需要可访问系统粘贴板服务的会话。安装包检查还覆盖服务声明、Windows 实际安装／冷启动／已有实例创建和卸载，不代替 Finder／Explorer 菜单的安装版人工操作。


图片定位图标与悬浮说明的交互回归使用 `image-reveal-browser.mjs`；通过 `LEAF_IMAGE_PLATFORM=MacIntel`／`Win32` 核对平台文案，`LEAF_IMAGE_REVEAL_ENGINE=webkit` 核对 WebKit。原生最近文件菜单标签由 Rust 回归验证，同名文档只补最短可区分目录。Finder 启用“显示图标预览”时可用内容缩略图代替应用图标；诊断应分别核对默认应用、系统返回的文件图标与 Finder 预览状态，不替用户关闭显示偏好。

图片说明与定位按钮的统一提示由 `image-tooltips-browser.mjs` 在完整应用中验证，覆盖浅色／深色、窄窗、键盘与单一提示；默认 Chromium，设置 `LEAF_IMAGE_TOOLTIP_ENGINE=webkit` 可单独检查 WebKit。浏览器引擎进程异常退出应记为环境阻塞，不能当作应用已通过或已失败。
