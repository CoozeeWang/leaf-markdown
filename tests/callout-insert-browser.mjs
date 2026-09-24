import { chromium, launchOptions, artifactPath } from './browser-runtime.mjs';
import assert from 'node:assert/strict';
const browser=await chromium.launch(launchOptions);
try{
 const page=await browser.newPage();await page.goto('http://127.0.0.1:41732');await page.click('#welcomeNewButton');
 await page.click('#calloutButton');
 assert.equal(await page.locator('.callout-types button svg.leaf-callout-badge').count(),13);
 await page.screenshot({path:artifactPath('callout-badge-menu.png')});
 await page.locator('[data-format=callout-note]').click();
 const source=()=>page.evaluate(async()=>{const {EditorView}=await import('/node_modules/@codemirror/view/dist/index.js');window.v=EditorView.findFromDOM(document.querySelector('.cm-content'));return v.state.doc.toString();});
 assert.ok((await source()).startsWith('> [!note]\n> 内容'));
 const title=page.getByRole('textbox',{name:'提示块标题',exact:true});
 assert.equal(await title.inputValue(),'');
 await page.getByRole('combobox',{name:'提示块类型',exact:true}).focus();
 await page.getByRole('combobox',{name:'提示块类型',exact:true}).selectOption('todo');
 assert.ok((await source()).startsWith('> [!todo]\n'));
 assert.equal(await page.locator('.leaf-callout-title > .leaf-callout-preview').innerText(),'待办');
 const alignment=await page.locator('.leaf-callout-title').evaluate(el=>{
  const icon=el.querySelector('svg').getBoundingClientRect(), text=el.querySelector('.leaf-callout-preview').getBoundingClientRect();
  return Math.abs(icon.y+icon.height/2-text.y-text.height/2);
 });
 assert.ok(alignment<1,`Badge/title centers differ by ${alignment}px`);
 await page.screenshot({path:artifactPath('callout-badge-editor.png')});

 await page.locator('.leaf-callout-title > .leaf-callout-preview').click();
 await title.fill('自定义标题');assert.ok((await source()).includes('[!todo] 自定义标题'));
 await title.fill(''); assert.ok(!(await source()).includes('待办'));
 await title.fill('自定义标题');
 await page.getByRole('combobox',{name:'提示块类型',exact:true}).selectOption('warning');
 assert.ok((await source()).includes('[!warning] 自定义标题'));
 await page.locator('.leaf-callout-body > .leaf-callout-preview').click();
 const body=page.getByRole('textbox',{name:'提示块内容',exact:true});
 await body.fill('**重点**\n第二行');
 await body.press('End'); await body.press('Enter'); await body.press('a');
 assert.ok((await source()).includes('> a'));
 for(let i=0;i<3;i++) {await body.press('Backspace');assert.equal(await body.evaluate(el=>document.activeElement===el),true);}
 await page.locator('#calloutButton').focus();
 assert.ok(await page.locator('.leaf-callout-body strong').isVisible());
 assert.equal(await page.getByRole('button',{name:'返回实时渲染',exact:true}).count(),0);
 assert.equal(await page.locator('.leaf-callout-widget .leaf-block-top').count(),0);
 assert.equal(await page.locator('#calloutButton').evaluate(el=>el.parentElement.className),'format-toolbar');
 await page.evaluate(()=>v.dispatch({selection:{anchor:0,head:v.state.doc.length}}));
 assert.equal(await page.locator('.leaf-callout-widget').count(),1);
 assert.equal(await page.getByRole('button',{name:'返回实时渲染',exact:true}).count(),0);
 await page.getByRole('combobox',{name:'提示块类型',exact:true}).selectOption('__source');
 assert.equal(await page.getByRole('button',{name:'返回实时渲染',exact:true}).count(),1);
 await page.getByRole('button',{name:'返回实时渲染',exact:true}).click();
 await page.evaluate(()=>{const doc='前段\n\n**重点**\n第二行\n\n后段';v.dispatch({changes:{from:0,to:v.state.doc.length,insert:doc},selection:{anchor:4,head:14}});});
 const before=await source();await page.click('#calloutButton');await page.locator('[data-format=callout-warning]').click();
 assert.ok((await source()).includes('> [!warning]\n> **重点**\n> 第二行'));
 await page.keyboard.press('ControlOrMeta+z');assert.equal(await source(),before);
 console.log('PASS callout toolbar types, editable title, rendering, selected text and undo');
}finally{await browser.close()}
