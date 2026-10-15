# 开发与验证 / Development and verification

需要 Node.js 22、Rust stable，以及平台原生工具链：macOS Xcode Command Line Tools；Windows Visual Studio C++ Build Tools（Desktop development with C++）及 WebView2。

Use Node.js 22, stable Rust, and native platform prerequisites. Install the Xcode Command Line Tools on macOS; install Visual Studio C++ Build Tools and WebView2 on Windows.

```sh
npm ci
npx playwright install chromium webkit
npm run check
npm run test:browser
```

正文字体回归为 `body-fonts.test.js`、`body-fonts-browser.mjs`：检查东亚／西文独立选择、实际字体家族去重、名称字形及列表键盘操作、旧偏好迁移、本机字体真实加载、缺失回退、粗斜体字形、跨窗口保存同步、三语及窄窗布局，并核对正文与撤销记录不变。Chromium 额外检查实际用于字形的字体；WebKit 独立运行行为检查。相关设置与阅读回归仍需运行。候选字体依本机安装情况而异，测试不下载字体。

并行开发时，字体、阅读和设置专项可通过 `LEAF_TEST_BASE_URL=http://127.0.0.1:41741` 使用预先启动的独立 Vite 服务，直接运行对应测试文件；默认浏览器总入口仍使用 41732。其他专项是否支持自定义地址，应先核对对应脚本。

macOS 原生字体检查使用独立 WKWebView：在 `src-tauri` 运行 `cargo run --locked --example native-table-keys -- ../tests/native-body-fonts.html http://127.0.0.1:41732/tests/native-body-fonts.html`。它检查本机 Palatino、Georgia、宋体、真实斜体、视图边界、偏好与撤销；不启动或更新日用 Leaf，不代替 macOS／Windows 安装版人工验收。

`npm run test:browser:all` 运行全部浏览器回归，包含公开合成的长表格样例。`npm run test:browser -- footnote-regressions-browser.mjs` 运行指定用例。入口自行管理 Vite，截图存放在忽略提交的 `test-results/`。可设置 `LEAF_BROWSER_CHANNEL=chrome` 使用已安装 Chrome，默认使用锁定的 Chromium。不能将浏览器平台模拟算作原生 Windows 验收。

The runner owns its Vite server on port 41732 and fails if that port is occupied. It runs pinned Chromium by default. Screenshots are written to ignored `test-results/`. Browser platform emulation does not replace native Windows testing.

行内格式生成由 `inline-format.test.js` 检查真实 Markdown 解析、标点外侧补空格、首尾空白、CRLF、段落、结构保护、脚注及反引号。`inline-format-browser.mjs` 检查格式按钮、Mac／Windows 快捷键路径、实际字形样式、取消格式及一次撤销／重做；`LEAF_INLINE_ENGINE=webkit` 可检查 WebKit。平台模拟不等于 Windows 安装版实测。

macOS 原生格式检查使用开发服务器，在 `src-tauri` 运行 `cargo run --locked --example native-table-keys -- ../tests/native-inline-format.html http://127.0.0.1:41732/tests/native-inline-format.html`。夹具检查实际 WKWebView 中的共享格式入口、字形、CRLF、脚注、行内代码和撤销；不代替安装版操作、原生快捷键或 Windows 实测。

选区合成回归同时运行 Chromium 与 WebKit；两者都需要安装。它覆盖重复色块、编辑器原生选区透明范围和结构化输入框的选区，不代替 macOS WKWebView 真机验收。

Rust 测试在 `src-tauri` 中运行：

```sh
cargo test --locked --all-targets
```

MCP adapter 的协议回归包含旧版 `initialize` 和新版 `server/discover` 两条实际传输链路，检查从旧版内部 broker 转发的工具／资源响应在新版宿主中带有 `resultType: "complete"`，在旧版宿主中保留原格式，并保留数据、元信息和错误语义。`node scripts/test-mcp-adapter.mjs stdio-and-origin` 另用隔离原生应用与标准 TypeScript SDK 检查新版工具发现、读取、错误响应和旧版连接／撤权；运行前须构建匹配的 `native-smoke` GUI 与 helper。该检查不代表真实 Claude 或 Windows 安装版验收。

高亮与行内代码快捷键由 `inline-format-shortcuts-browser.mjs` 检查，覆盖两端按键、三语命令、实际渲染及撤销／重做。已有 Vite 测试服务运行时，macOS 可执行 `cargo run --locked --example native-table-keys -- ../tests/native-inline-format-shortcuts.html http://127.0.0.1:41732/tests/native-inline-format-shortcuts.html`，以 AppKit 按键验证实际 WKWebView；不代替安装版及真实中文输入法验收。

脚注浮框的文档历史回归为 `footnote-history-browser.mjs`，覆盖 Mac／Windows 快捷键、原生菜单事件入口、撤销后继续输入、编号恢复与浮框同步。macOS 可用同一原生入口运行 `../tests/native-footnote-history.html` 与 `http://127.0.0.1:41732/tests/native-footnote-history.html --foreground`，检查 AppKit 撤销／重做与模拟菜单转发；不代替真实原生菜单、中文输入法或 Windows 实机验收。

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

两平台均原子创建空白 Markdown，默认文件名按 Leaf 当前有效语言生成：`未命名.md`、`未命名.md` 或 `Untitled.md`；重名加空格与递增数字，随后打开 Leaf。可用现有标题改名；失败显示原生错误提示，已创建但打开失败的文件保留并告知位置。Rust 测试覆盖并发、重名、无效目录和 Finder 专用粘贴板输入；Mac 原生粘贴板测试需要可访问系统粘贴板服务的会话。安装包检查还覆盖服务声明、Windows 实际安装／冷启动／已有实例创建和卸载，不代替 Finder／Explorer 菜单的安装版人工操作。


图片定位图标与悬浮说明的交互回归使用 `image-reveal-browser.mjs`；通过 `LEAF_IMAGE_PLATFORM=MacIntel`／`Win32` 核对平台文案，`LEAF_IMAGE_REVEAL_ENGINE=webkit` 核对 WebKit。原生最近文件菜单标签由 Rust 回归验证，同名文档只补最短可区分目录。Finder 启用“显示图标预览”时可用内容缩略图代替应用图标；诊断应分别核对默认应用、系统返回的文件图标与 Finder 预览状态，不替用户关闭显示偏好。

图片说明与定位按钮的统一提示由 `image-tooltips-browser.mjs` 在完整应用中验证，覆盖浅色／深色、窄窗、键盘与单一提示；默认 Chromium，设置 `LEAF_IMAGE_TOOLTIP_ENGINE=webkit` 可单独检查 WebKit。浏览器引擎进程异常退出应记为环境阻塞，不能当作应用已通过或已失败。

## 三语资源与维护 / Localization

应用使用 i18next 的普通 JavaScript 接口，资源位于 `src/locales/`：`zh-Hans.json`、`zh-Hant-TW.json`、`en.json`。`copy-keys.json` 将固定文案编号映射到语义键；新增文案分配新编号，不复用旧编号。个人审阅稿和基线快照放在公开仓库外，产品只保留语言资源、编号映射和正式检查。

`src/i18n.js` 在导入界面之前初始化；桌面配置 `language-v1.json` 保存到各自应用的数据目录，Leaf Dev 与日用 Leaf 隔离。Rust 复用同一份 JSON，菜单只改标签，错误传递稳定码与参数。浏览器偏好使用本地存储，桌面通过命令与事件同步；启动、新窗口与重新获得焦点重新读取语言。不要用译文判断命令、状态或操作身份。

界面文字使用显式绑定，动态句使用命名参数；`h` 用于经过转义的 HTML，`setText` 和 `setAttr` 用于文字与属性。不要扫描或替换用户内容。英文数量资源提供 `_one`、`_other`；机器语法、Markdown、路径、用户输入和系统诊断保持原文。添加或修改三语资源时，对照现行审阅基线，记录新增、变更、删除及变量/场景变化；未变条目沿用已审阅结果。

`npm run check` 检查资源、插值、系统匹配、数量、稳定错误以及已有源码回归。`npm run test:browser -- i18n-browser.mjs` 检查切换、历史/选区、组合输入、持久保存失败、跨窗口同步与导出选项；相关编辑、附件、恢复用例仍需运行。浏览器检查不代替原生菜单、系统文件窗口或安装版验收。

Finder 服务文字由 macOS 选择语言，不随 Leaf 内语言切换。`src-tauri/locales/` 的 `en`、`zh-Hans`、`zh-Hant` 三种 `ServicesMenu.strings` 从共享语言资源生成；繁中采用台湾用语，英文为包默认语言。修改共享服务文案后运行 `node scripts/sync-macos-locales.mjs`；Mac 构建前检查资源漂移，实际包检查核对三语资源和服务声明。系统服务列表可能缓存旧名称；覆盖安装后如未更新，先退出并重新打开 Finder，必要时注销再登录，不修改系统语言来测试，也不清空全局服务设置。

Windows 安装器与右键入口仍待完成三语打包集成和平台验收；资源中已有这些文案不表示安装器已启用三语。系统对话框和系统注入菜单由操作系统决定语言。

Mac 服务的原始 `NSMenuItem.default` 用作稳定标识，不随翻译改变；实际显示文本由三种 `ServicesMenu.strings` 提供，英文仍为包回退语言。先安装 Leaf 主菜单，再初始化 AppKit Services menu 和已就绪的提供者。实际安装版可显式运行 `node tests/finder-service-native.mjs '使用 Leaf 新建 Markdown 文档' '未命名.md'`（按系统菜单名称与当前 Leaf 语言调整参数）。检查使用临时合成文件夹／文件，确认服务接受请求后确实创建新文件并保留已有样本；生成的文档窗口留供观察。此 API 检查不代替 Finder 点击、冷启动或用户验收。

## Windows 安装器三语

NSIS 配置启用 English、SimpChinese、TradChinese 和语言选择器，直接复用 Tauri 官方语言包；不维护标准安装器文案的副本。英文为不支持系统的回退，官方安装器会记住此前安装语言。Leaf 右键菜单文案从正式语言资源生成：`node scripts/sync-windows-locales.mjs`；漂移检查随 `npm test` 执行。

文件夹及文件夹空白处的右键入口按安装器选择语言写入。应用内换语言不刷新 Windows 右键文字，重新运行安装器选择新语言后更新；安装语言不覆盖应用内偏好。标准 Windows/NSIS 系统文字由官方资源控制，Leaf 定稿只控制自己的入口。当前用户安装、文件关联和 UserChoice 保护沿用。

`Internal test packages` 的 Windows 作业在一次性 runner 中运行 `tests/windows-i18n-installer.ps1`，检查实际 EXE 的三语注册、重装更新、应用语言偏好保护及新文件名，然后运行文件图标/关联/卸载检查。脚本拒绝运行于用户电脑；静默安装使用 MUI2 保存的安装语言驱动，不能代替语言选择器界面实机验收。D 仍需在 Windows 检查选择器、系统匹配/回退、应用三语布局与真实右键操作。

已安装 NSIS 的开发机可运行 `node tests/windows-i18n-nsis.mjs` 编译无操作的合成夹具，检查钩子和三语资源语法。生成 EXE 位于忽略提交的 `test-results`，不执行钩子、不安装 Leaf；不算正式 Windows 包。macOS 编译子进程使用 `en_US.UTF-8`，避免不支持的 locale 造成中文编码错误。

脚注侧栏三模式由 `footnote-sidebar-modes-browser.mjs` 检查；文末定义格式由 `footnote-definition-format-browser.mjs` 在 Chromium/WebKit 检查实际格式、解析器边界、多行内容、源码/光标标记与撤销，位置映射另由 `footnote-inline.test.js` 覆盖 CRLF 和缩进。长文浮框输入由 `footnote-input-performance-browser.mjs` 使用约十九万字符合成样本检查即时写回、侧栏同步和组合输入。macOS 原生夹具为 `native-footnote-sidebar.html`，使用现有 `native-table-keys` 入口验证实际 WKWebView 的文末/侧栏渲染与共享撤销。性能数字来自本机合成样本，不代替用户原文、真实输入法或安装版验收。

批注使用既有 CriticMarkup 范围／位置格式与 Obsidian `%%…%%`。`comments.test.js` 检查位置、CRLF、代码／转义／属性保护、非法选区和删除保留正文；`comments-browser.mjs` 检查隐藏式批注的编辑原文、直接输入、短暂定位、阅读隐藏与段落定位、侧栏标签、上标气泡、文字格式、共享历史、三模式、三语、两平台快捷键、PDF 提示和打印隐藏。支持 `LEAF_TEST_BASE_URL`，默认 Chromium，`LEAF_COMMENT_ENGINE=webkit` 切换 WebKit。macOS 在 `src-tauri` 运行 `cargo run --locked --example native-table-keys -- ../tests/native-comments.html http://127.0.0.1:41732/tests/native-comments.html`，验证真实 WKWebView、保存格式、历史和 AppKit Option+Command+A；合成组合输入及平台模拟不等于实际输入法或 Windows 验收。Obsidian 互通另外使用独立测试库与已记录版本的 CriticMarkup 插件，不能只凭解析器测试宣称原生互通。Leaf 不读取外部编辑器的私有批注数据库。

普通正文 Enter 与脚注完成由 `paragraph-enter.test.js`、`footnote-completion.test.js` 及双引擎 `paragraph-input-browser.mjs` 检查，覆盖空格不延续、结构缩进、先成对括号后填标识、组合输入结束后补空定义和一次撤销。macOS 使用 `native-table-keys` 运行 `../tests/native-paragraph-input.html` 与 `http://127.0.0.1:41732/tests/native-paragraph-input.html`；Enter 来自 AppKit，组合输入为合成事件，仍需实际中文输入法与英文标点人工验收。

正文缩放由 `body-zoom-browser.mjs` 检查八档比例、编辑坐标与真实鼠标输入、高亮快捷键区分、撤销、视图切换、长文位置、三语、菜单和独立导出预览。默认 Chromium，`LEAF_ZOOM_ENGINE=webkit` 可检查 WebKit；平台模拟不等于 Windows 实机。macOS 使用已有 `native-table-keys` 入口运行 `../tests/native-body-zoom.html` 与 `http://127.0.0.1:41732/tests/native-body-zoom.html`，加 `--foreground` 检查实际 WKWebView 的比例、坐标及 AppKit Shift 快捷键；后台窗口的帧测量可能暂停。正式安装版的真实输入法、保存重开、图片拖放、实际 PDF 和两平台验收仍分开记录。

脚注编辑区由 `footnote-region-browser.mjs` 覆盖：中间定义的文末显示、打开不改原文、85% 字号、绘制光标、单击只读／双击与键盘编辑／离开恢复预览、键盘焦点外框与提示文字基线对齐、多段脚注、剪贴板粘贴、组合输入、正文续写、一次撤销／重做、搜索映射、CRLF、删除边界和全文删除；Chromium 使用 Mac/Windows 快捷键模拟，WebKit 使用 Mac 路径。`native-footnote-region.html` 配合 `native-table-keys` 检查实际 macOS WKWebView 的 AppKit Enter、文末区域、正文末尾自然续写与历史。原生夹具仍为合成文档，不能代替实际中文输入法、安装版保存和 Windows 实机验收。
Windows「保存为 PDF」直接使用 WebView2 `PrintToPdf`，避免 Microsoft Print to PDF 的 Unicode 标题截断。输出先写入同目录临时文件，成功且签名正确后才替换目标；取消保存不写文件。`pdf_output` 的 Rust 测试覆盖 Unicode 文件名及失败保护。原生 smoke 使用带中文、重音和 emoji 的标题，通过 `tests/pdf-title-check.py` 检查实际 PDF 元数据、A4 分页及尾段，并测试再次覆盖。仅 `native-smoke` 构建支持用 `LEAF_NATIVE_SMOKE_PDF_DIR` 指定一次性输出目录以绕过保存窗口；正式构建始终显示系统保存窗口。该自动路径不代替 Windows 安装版保存窗口、取消和覆盖确认的人工验收。

源码测试串行调度测试文件，因为多个 AI 契约用例会调用同一 Rust 工作目录；并行启动会在 Windows 冷构建时争用 Cargo 锁，导致等待锁被误判为三分钟超时。原生断言和各用例超时仍保留，未跳过失败项。

Windows 安装包流程现在先构建启用 `native-smoke` 的本机测试应用，运行 `windows-native-smoke.mjs --pdf-only`：打开实际 Leaf 导出窗口，经 `print_export` 命令生成单行与多页 Unicode 标题 PDF，并重复覆盖后校验内容／元数据。保留临时路径的清理保护，但在交给外部渲染器前关闭 Leaf 的文件句柄；Windows 单元测试同时比较旧句柄阻塞与新路径允许独占写入。该检查不代替用户保存窗口与真实安装版验收。

## MCP configuration and restart regressions

The master MCP preference is stored separately from process credentials. First use is off; explicit on/off survives restarts. Startup creates fresh client capabilities and descriptors, restores configured clients independently, and reports connection errors without clearing consent. Closed document identities and edit tasks never survive a restart.

After building a matching `native-smoke` GUI/helper, `node scripts/test-mcp-startup.mjs` runs three isolated application lifetimes (first use, restored on, restored off). `node scripts/test-mcp-adapter.mjs stdio-and-origin --reuse-build` also checks generated Claude MCPB and WorkBuddy configuration through the real adapter with a standard MCP SDK. These checks need no model quota and do not replace installed-host/model acceptance.

Windows `Internal test packages` additionally runs `tests/windows-mcp-config.ps1` in its disposable runner. It verifies the official tunnel-client 0.0.16 archive digest and runs the production profile preparation path (init, final YAML, doctor) with spaces, apostrophes and Unicode paths and a synthetic placeholder key. No real tunnel is started by that CLI test. `--mcp-command` uses the vendor’s shell-style lexer; Windows paths use forward slashes in this string. CreateProcess argument quoting remains separate. Init/doctor failures return distinct stable stage codes; raw stderr and keys are not exposed.

Configuration/profile and recovery-record replacement uses the same completed temporary file throughout bounded Windows lock retries (at most one second for access-denied/sharing/lock errors). It never deletes the destination first, and aborts if the destination changes while waiting. Other platforms retain a single attempt. Windows tests hold actual file handles to verify released locks, persistent locks and concurrent destination changes; failures preserve the prior file and return an error.

Windows private directories grant the current user inheritable file/container access; private files keep a file-only grant. Startup repairs the earlier directory grant before reading saved profiles or ledger data. Protecting the shared application directory must preserve existing profile files and nested MCP paths. A Windows regression checks that sequence, repairs a simulated legacy grant, reloads the profiles and traverses/removes the synthetic tree. Native drivers wait for child shutdown and retry temporary cleanup locks without hiding an earlier assertion failure.
