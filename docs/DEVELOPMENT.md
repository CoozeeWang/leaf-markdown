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

## 开发与打包 / Development and packaging

`list-images-browser.mjs` 在 Chromium 和 WebKit 中检查列表图片取消缩进、重新缩进、相邻列表项、撤销／重做、预览／阅读／导出一致性及模拟保存重开。macOS 可用上述开发服务器和 `native-table-keys` 示例运行 `../tests/native-list-images.html` 与 `http://127.0.0.1:41732/tests/native-list-images.html`；它在实际 WKWebView 中通过 AppKit 发送 Shift+Tab 并检查布局和快捷键处理，图片字节为合成输入，不代替安装版真实文件验收。

```sh
npm run dev
npm run desktop:dev
```

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
