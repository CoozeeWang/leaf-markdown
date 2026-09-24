import { chromium, launchOptions, artifactPath } from './browser-runtime.mjs';
import assert from 'node:assert/strict';
const browser = await chromium.launch(launchOptions);
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://127.0.0.1:41732');
  await page.click('#welcomeNewButton');
  await page.evaluate(async () => {
    const { createLeafEditor } = await import('/src/editor.js');
    document.querySelector('#editor').replaceChildren();
    window.readingEditor = createLeafEditor({ parent: document.querySelector('#editor'), doc:
      '# 阅读路线\n\n- **先理解方向**：读第 1—3 节，理解为什么从真实工作出发，以及技术进步如何改变机会。\n- **带着问题查阅**：先看机制总览，再逐条阅读解释。\n- **判断是否值得投入**：比较真实案例、进入条件与最小验证安排。\n\n# 1. 这轮研究究竟要支持什么决定\n\n## 1.1 创业命题与研究结论分开\n\n我们的**创业方向假设**是：帮助有真实组织卡点的企业，把已经取得的能力转化为业务成果。优先考虑组织诊断、工作台管理机制调整、采用和能力建设，尽量借助成熟工具。\n\n*这是一段补充说明。强调色应帮助读者识别它的作用，而不抢走正文的注意力。*\n\n本报告要减少三种代价：\n\n- 围绕即将被产品覆盖的功能投入；\n- 在没有专业能力时承诺复杂组织交付；\n- 把长期陪伴误当成可经营的服务。\n\n> 当前判断：值得继续验证，但还不足以据此承诺结果。\n\n[阅读参考资料](https://example.com)\n\n| 阶段 | 重点 |\n| --- | --- |\n| 观察 | **真实需求**与约束 |\n| 验证 | *保留不确定性* |\n' });
    readingEditor.view.dispatch({ selection: { anchor: readingEditor.getValue().length } });
  });
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await page.waitForTimeout(200); // Let the controls' theme transition settle.
    const styles = await page.evaluate(() => {
      const content = document.querySelector('#editor .cm-content');
      const strong = document.querySelector('#editor .tok-strong');
      return { font: getComputedStyle(content).fontSize, weight: getComputedStyle(strong).fontWeight,
        left: content.getBoundingClientRect().left, width: content.getBoundingClientRect().width,
        family: getComputedStyle(content).fontFamily };
    });
    assert.equal(styles.font, '17px'); assert.equal(styles.weight, '600');
    assert.ok(styles.family.includes('PingFang')); assert.ok(styles.left > 60 && styles.width <= 780);
    await page.screenshot({ path: artifactPath(`leaf-reading-${theme}.png`) });
  }
  assert.deepEqual(errors, []);
  console.log('Reading typography checks passed');
} finally { await browser.close(); }
