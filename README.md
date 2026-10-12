<div align="center">

<img src="public/leaf-icon.png" width="96" alt="Leaf">

<h1>Leaf</h1>

一个轻量的 Markdown 编辑器

</div>

---

**Beta 开发中。** Leaf 用于编辑和阅读本地 Markdown 文档，提供大纲、表格、脚注、提示块、查找、恢复与 PDF 导出等功能。安装包与版本说明见 [GitHub Releases](https://github.com/CoozeeWang/leaf-markdown/releases)。当前 Beta 支持简体中文、繁体中文与 English；试用前请阅读[安装说明](docs/INSTALL.md)。

“整理段落空行”的规则、例外和使用示例见[空行整理说明](docs/BLANK-LINES.md)。

## 从源码运行

需要 Node.js 22 或更高版本。桌面应用还需要 Rust stable 和对应平台的原生工具链；具体要求见[开发指南](docs/DEVELOPMENT.md)。

```sh
npm ci
npm run dev
```

`npm run check` 运行单元测试与前端构建。浏览器测试、Rust 测试、macOS 与 Windows 打包步骤见[开发指南](docs/DEVELOPMENT.md)。浏览器测试和构建通过不代表安装版已经完成验收。

当前界面规则见[Leaf Stylebook](docs/STYLEBOOK.md)；维护与提交方式见[开发与仓库工作方式](docs/WORKFLOW.md)。

## 许可证

Leaf 的原创代码以 [MIT 许可证](LICENSE)发布。随项目提供的第三方提示块图标保留其[原有许可证](src/assets/callouts/LICENSE)。
