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

Cargo 使用标准 crates.io。需要网络镜像时，在个人 Cargo 配置中设置，不修改项目的公共配置。macOS 原生 WebKit 示例只在 macOS 执行；其他平台编译时显示不支持提示。

Cargo uses crates.io. Configure network mirrors in your own Cargo configuration. Native WebKit fixtures only execute on macOS.

## 开发与打包 / Development and packaging

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
