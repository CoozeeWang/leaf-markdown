import { chromium, launchOptions, artifactPath } from './browser-runtime.mjs';
import assert from 'node:assert/strict';
const browser = await chromium.launch(launchOptions);
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 1150 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('http://127.0.0.1:41732');
  await page.click('#welcomeNewButton');
  await page.evaluate(async () => {
    const { createLeafEditor } = await import('/src/editor.js');
    document.querySelector('#editor').replaceChildren();
    window.paletteEditor = createLeafEditor({ parent: document.querySelector('#editor'), doc:
      '# 一级标题 · 松林\n\n## 二级标题 · 青溪\n\n### 三级标题 · 远山\n\n#### 四级标题 · 暮岚\n\n##### 五级标题 · 树皮\n\n###### 六级标题 · 苔石\n\n正文保持安静，让**重要判断**、*补充说明*、`inline code` 与 ==值得记住的结论== 各自清楚。\n\n| 格式 | 阅读效果 |\n| --- | --- |\n| 粗体 / 斜体 | **明确的重点** 与 *温和的旁注* |\n| 代码 / 高亮 | `example` 与 ==标记的内容== |\n\n结束。' });
    paletteEditor.view.dispatch({ selection: { anchor: paletteEditor.getValue().length } });
  });
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await page.waitForTimeout(200);
    const result = await page.evaluate(() => {
      const color = selector => getComputedStyle(document.querySelector(selector)).color;
      const lum = hex => {
        const v = hex.match(/[a-f\d]{2}/gi).map(s => parseInt(s, 16) / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
        return .2126 * v[0] + .7152 * v[1] + .0722 * v[2];
      };
      const css = getComputedStyle(document.documentElement), value = name => css.getPropertyValue(name).trim();
      const contrast = (a, b) => { const x = lum(value(a)), y = lum(value(b)); return (Math.max(x,y)+.05)/(Math.min(x,y)+.05); };
      return {
        headings: Array.from({ length: 6 }, (_, i) => color(`.cm-leaf-heading-${i+1}`)),
        formats: ['.tok-strong', '.tok-emphasis', '.cm-leaf-inline-code', '.leaf-highlight'].map(color),
        ratios: ['--heading-primary', '--heading-secondary', '--heading-3', '--heading-4', '--heading-5', '--heading-6', '--strong', '--emphasis', '--link'].map(c => contrast(c, '--canvas')).concat(contrast('--code-text', '--code'), contrast('--highlight-text', '--highlight-bg')),
      };
    });
    assert.equal(new Set(result.headings).size, 6);
    assert.equal(new Set(result.formats).size, 4);
    assert.ok(result.ratios.every(r => r >= 4.5), JSON.stringify(result.ratios));
    assert.equal(await page.locator('.leaf-cell-preview mark').textContent(), '标记的内容');
    await page.screenshot({ path: artifactPath(`leaf-palette-${theme}.png`) });
    console.log(`${theme}: minimum contrast ${Math.min(...result.ratios).toFixed(2)}:1`);
  }
  assert.deepEqual(errors, []);
} finally { await browser.close(); }
