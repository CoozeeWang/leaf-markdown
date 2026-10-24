# Leaf 1.0.3

**简体中文** · [English](RELEASE-NOTES.md)

一款可实时预览的 Markdown 编辑器，兼顾专注写作与文稿审阅。支持 MCP 插件，连接 AI 软件辅助编辑与审阅。

## 本版主要功能

- **实时预览**：编辑时即时呈现排版效果，支持编辑、源码和阅读三种视图。
- **脚注边栏**：在正文旁查看和编辑脚注，方便对照说明与出处。
- **文稿批注**：为选中文字或正文位置添加批注，在边栏集中查看和编辑。
- **MCP 接入**：通过 MCP 连接 ChatGPT、Claude（桌面版）和 WorkBuddy，辅助读取、修改与审阅文稿。

此外，Leaf 还提供大纲导航、文档属性、表格编辑、图片管理、PDF 导出和草稿恢复。完整介绍与界面截图请见 [README](../README.zh-CN.md)。

## 下载与安装

请在本次发布页面下方的 **Assets（附件）** 中选择适合你电脑的安装包：

| 电脑 | 安装包 | 安装方式 |
| :--- | :--- | :--- |
| Windows x64 | [Leaf-1.0.3-windows-x64-setup.exe](https://github.com/CoozeeWang/leaf-markdown/releases/download/v1.0.3/Leaf-1.0.3-windows-x64-setup.exe) | 下载后双击，按提示安装。 |
| Mac（M 系列芯片） | [Leaf-1.0.3-macOS-arm64.dmg](https://github.com/CoozeeWang/leaf-markdown/releases/download/v1.0.3/Leaf-1.0.3-macOS-arm64.dmg) | 打开 DMG，将 Leaf 拖入“应用程序”文件夹。 |

Mac 仅提供 Apple Silicon 安装包，编译最低目标为 macOS 11.0；Windows 提供面向 Windows 10 / 11 的 x64 安装包，需要 WebView2 Runtime。编译目标与依赖支持范围不等同于全部系统版本均已实测，详见[系统与运行环境](INSTALL.zh-CN.md#系统与运行环境)。

首次使用请参阅[安装与使用说明](INSTALL.zh-CN.md)。打开 Leaf 后，新建文档即可开始写作，也可以打开或拖入已有的 Markdown 文件。

如需连接 AI，请参阅 [AI 辅助编辑与 MCP 连接](AI_CONNECTIONS.zh-CN.md)。

## 首次安装提示

本版 Mac 仅有临时签名（ad-hoc），没有 Developer ID 发行签名或 Apple 公证；Windows 没有 Authenticode 数字签名。首次安装或打开时，系统可能显示安全提示。请从 [Leaf 官方发布页](https://github.com/CoozeeWang/leaf-markdown/releases)下载安装包，并核对文件。以下操作仅适用于官方来源且文件核对一致的未识别开发者或 SmartScreen 未知信誉提示。

发布页中的 SHA256 与 Minisign 分离签名用于核对文件完整性与来源，不等同于系统认可的发行签名。

如果来源不明、文件损坏、发现恶意软件、验签失败或受到组织策略阻止，请停止安装，保留提示截图并通过 [GitHub Issues](https://github.com/CoozeeWang/leaf-markdown/issues) 联系我们核实。不要移除隔离或关闭系统防护。

### Mac

将 Leaf 放入“应用程序”文件夹后，先尝试打开一次。如果系统提示无法验证开发者或 Apple 无法检查此 App：

1. 打开“系统设置” → “隐私与安全性”。
2. 向下找到关于 Leaf 被阻止打开的提示，点击“仍要打开”（如有此选项）。
3. 按系统提示确认，再次打开 Leaf。

具体操作可参阅 [Apple 的说明](https://support.apple.com/zh-cn/102445)。

### Windows

如果打开安装包时出现“Windows 已保护你的电脑”，确认文件来自 Leaf 官方发布页后，点击“更多信息”，再选择“仍要运行”（如有此选项），继续安装。安装过程中，发布者可能显示为“未知发布者”。参阅 [Microsoft 说明](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation)。

## 更新已有版本

Leaf 1.0.3 可在应用内检查更新并查看发布说明，然后通过浏览器前往官方下载页面。请保存文稿并正常退出 Leaf，再手动安装新版：Mac 在“应用程序”原位置替换 Leaf，Windows 按安装器提示覆盖原安装。本版不会在应用内下载安装或自动退出重启。

在同一系统用户下，保留原安装位置、不卸载也不清空数据目录，正常覆盖安装会保留持久设置与应用数据。此说明不包含更换用户、迁移数据或移动隧道程序目录的情况。临时连接需要重新建立；外部 AI 软件（包括 ChatGPT）的 MCP 授权可能需要重新确认。

使用 1.0.1 或 1.0.2 时，请先从发布页手动安装一次 1.0.3。

## 使用前须知

**已知限制**：本版不提供 Intel Mac 安装包；更新需通过浏览器下载并手动安装。外部 AI 软件的授权可能需要重新确认。

遇到问题或有改进建议，欢迎通过 [GitHub Issues](https://github.com/CoozeeWang/leaf-markdown/issues) 告诉我们。反馈时请附上系统、Leaf 版本和复现步骤，便于查找原因。
