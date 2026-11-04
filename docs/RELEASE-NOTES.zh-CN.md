# Leaf 1.0.5

**简体中文** · [繁體中文](RELEASE-NOTES.zh-TW.md) · [English](RELEASE-NOTES.md)

本补丁修复工具栏换行遮挡提示，以及部分文案未随界面语言切换的问题。详见[变更记录](../CHANGELOG.md)和 [Issue #125](https://github.com/CoozeeWang/leaf-markdown/issues/125)。

## 主要变化

- 文档标题和格式工具栏换行时，状态提示与关闭按钮保持可见、可操作。
- 草稿恢复与历史版本窗口的标题、说明和主按钮随界面语言切换，保留当前记录选择、预览和编辑状态。
- AI 高级设置的代理输入提示随语言切换，保留输入值与配置。

## 下载与升级

从 [GitHub Release](https://github.com/CoozeeWang/leaf-markdown/releases/tag/v1.0.5) 下载：

- `Leaf-1.0.5-macOS-arm64.dmg`：Apple Silicon Mac。
- `Leaf-1.0.5-windows-x64-setup.exe`：Windows x64。

发布页同时提供 SHA256 校验值、Minisign 分离签名和构建来源。先保存文稿并正常退出 Leaf，再覆盖安装；Windows 如出现卸载选项，不勾选“删除应用数据”。不要卸载后清空设置或 MCP 配置。更新仍通过浏览器下载并手动安装，不自动退出或重启应用。

Mac 使用 ad-hoc 签名，未做 Developer ID 签名或公证；Windows 没有 Authenticode 签名。下载签名不等于系统发布者签名。系统要求与首次打开提示见[安装指南](INSTALL.zh-CN.md)。

## 验证范围

维护者于2026年11月4日确认本批修复在 Mac 和 Windows 验收通过；该次确认未逐项记录 Windows 构建标识和语言组合。本地446项单元测试与9套定向浏览器回归通过，主要布局和动态翻译检查覆盖 Chromium／WebKit。最终安装包检查与构建来源见发布页；本批修复验收不代表所有系统版本均已验证。

[使用说明](INSTALL.zh-CN.md) · [AI / MCP 连接](AI_CONNECTIONS.zh-CN.md) · [支持 Leaf](SUPPORT.md)
