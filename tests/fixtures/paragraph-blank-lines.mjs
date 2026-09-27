// Synthetic source shared by browser and native WKWebView acceptance checks.
export const source = '\n \t\n第一段\n第二段\n\n\n# 标题\n\n\n- 父项\n\n  - 子项一\n\n  - 子项二\n\n- 下一项\n\n\n1. 有序一\n\n3. 有序二\n\n\n- [ ] 任务一\n\n- [x] 任务二\n\n\n- 多段第一段\n\n\n  多段第二段\n\n- 后续项\n\n\n```text\n代码第一行\n\n\n代码第二行\n```\n\n\n末段\n\n \t\n';
export const expected = '第一段\n\n第二段\n\n# 标题\n\n- 父项\n  - 子项一\n  - 子项二\n- 下一项\n\n1. 有序一\n2. 有序二\n\n- [ ] 任务一\n- [x] 任务二\n- 多段第一段\n\n  多段第二段\n- 后续项\n\n```text\n代码第一行\n\n\n代码第二行\n```\n\n末段\n';
