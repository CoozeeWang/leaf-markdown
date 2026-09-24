// Deterministic public test data; never derived from a user's documents.
export const longDocument = [
  '# 长文可靠性验收\n\n',
  ...Array.from({ length: 180 }, (_, i) => `## 章节 ${i + 1}\n\n${'中文写作与技术文档：**强调**、[链接](https://example.com)、行内代码 \\`value\\`。'.replaceAll('\\`', '`').repeat(4)}\n\n- 项目一\n  - 子项目\n- 项目二\n\n> [!note] 提示 ${i + 1}\n> 保留正文和脚注[^note-${i + 1}]。\n\n\`\`\`js\nconst section = ${i + 1};\n\`\`\`\n\n`),
  '## 长表格\n\n| 编号 | 内容 | 状态 |\n| --- | --- | --- |\n',
  ...Array.from({ length: 600 }, (_, i) => `| ${i + 1} | 表格内容 ${i + 1} | 未修改 |\n`),
  '\n## 编辑锚点\n\nSEARCH_TOKEN\n\n',
  ...Array.from({ length: 180 }, (_, i) => `[^note-${i + 1}]: 第 ${i + 1} 条注释，保持文字标签。\n`),
].join('');
