# Leaf 1.0.4

**简体中文** · [繁體中文](RELEASE-NOTES.zh-TW.md) · [English](RELEASE-NOTES.md)

本版改进日常编辑、大纲整理和文字选择，并修复提示块、富文本拖放及 Windows 重复安装的问题。完整变化见[变更记录](../CHANGELOG.md)。

## 主要变化

- 拖动大纲标题可调整整章顺序和层级，保留子章节、正文和折叠状态，并可一次撤销。
- 修复提示块光标高度及重复闪烁；标题 Enter 进入正文，尾部空普通段落 Enter 退出提示块。新建提示块的占位提示不写入文稿。
- 修复连续 AI 编辑任务导致提示栏累积锁图标的问题。
- 富文本粘贴保留有效的 Ripple 来源链接；Mac 外部文字拖放按落点插入，并可一次撤销。提示块内粘贴使用相同转换。
- 减少长文及嵌套内容的重复解析，改善编辑焦点和文字选择；普通预览隐藏合法转义标记，源码和代码内容不变。
- 统一轻量悬浮提示；文档名菜单居中。Mac 菜单使用“在 Finder 中显示”，Windows 保留文件资源管理器文案。
- 三击整行的高亮不再延伸到下一行的缩进空白；整行选择仍包含换行符，正常跨行选字不变。
- Windows 重复安装时保留原有文件关联的恢复信息。

Leaf 将富文本转换为 Markdown，不保证重现来源软件的完整排版。应用来源链接限于支持的 Ripple 协议；粘贴、拖放和保存不会启动其他应用。编辑视图中按住 Mac ⌘／Windows Ctrl 单击，或在阅读视图单击，才请求打开链接。

## 下载与升级

从 [GitHub Release](https://github.com/CoozeeWang/leaf-markdown/releases/tag/v1.0.4) 下载：

- `Leaf-1.0.4-macOS-arm64.dmg`：Apple Silicon Mac。
- `Leaf-1.0.4-windows-x64-setup.exe`：Windows x64。

发布页同时提供 SHA256 校验值、Minisign 分离签名和构建来源。先保存文稿并正常退出 Leaf，再覆盖安装；Windows 如出现卸载选项，不勾选“删除应用数据”。不要卸载后清空设置或 MCP 配置。更新仍通过浏览器下载并手动安装，不自动退出或重启应用。

Mac 使用 ad-hoc 签名，未做 Developer ID 签名或公证；Windows 没有 Authenticode 签名。下载签名不等于系统发布者签名。系统要求与首次打开提示见[安装指南](INSTALL.zh-CN.md)。

## 验证范围

本轮编辑修复已通过本地单元测试与 Chromium／WebKit 回归。Mac 日用版已安装；Windows 自动检查、最终包来源及校验结果以发布页所列构建记录为准。Windows 用户实机验收仍待进行，自动检查不代表已完成该项；相关 Issue 保留验收状态。

[使用说明](INSTALL.zh-CN.md) · [AI / MCP 连接](AI_CONNECTIONS.zh-CN.md) · [支持 Leaf](SUPPORT.md)
