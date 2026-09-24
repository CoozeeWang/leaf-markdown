import { chromium, launchOptions, artifactPath } from './browser-runtime.mjs';
import assert from 'node:assert/strict';
const browser=await chromium.launch(launchOptions);
try {
 const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:41732');await page.click('#welcomeNewButton');await page.click('#commandsButton');await page.fill('#paletteInput','文档属性');await page.getByRole('option',{name:'文档属性',exact:true}).click();
 const add=async(key,type,value)=>{
  if(!await page.locator('.leaf-property-add').count())await page.getByRole('button',{name:'添加文档属性',exact:true}).click();
  await page.getByRole('textbox',{name:'新属性名',exact:true}).fill(key);
  await page.getByLabel('新属性类型',{exact:true}).selectOption(type);
  if(value!==undefined)await page.getByLabel('新属性值',{exact:true}).fill(value);
  await page.locator('.brand').click();
 };
 const source=()=>page.evaluate(async()=>{const {EditorView}=await import('/node_modules/@codemirror/view/dist/index.js');return EditorView.findFromDOM(document.querySelector('.cm-content')).state.doc.toString()});
 await add('日期','date');
 const now=new Date(),today=`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
 assert.equal(await page.getByLabel('日期',{exact:true}).inputValue(),today);
 await add('完成','checkbox');await page.getByLabel('完成',{exact:true}).check();assert.ok((await source()).includes('"完成": true'));
 await add('主题','list');await page.getByRole('textbox',{name:'主题',exact:true}).fill('设计');await page.getByRole('textbox',{name:'主题',exact:true}).press('Enter');
 assert.ok((await source()).includes('["设计"]'));
 await page.getByRole('textbox',{name:'主题',exact:true}).fill('开发');await page.getByRole('textbox',{name:'主题',exact:true}).press('Enter');
 await page.getByRole('button',{name:'删除 设计',exact:true}).click();assert.ok((await source()).includes('["开发"]'));
 await add('状态','enum','草稿');await page.getByRole('button',{name:'设置枚举选项',exact:true}).click();
 await page.getByLabel('状态 候选项',{exact:true}).fill('草稿；审阅；完成');await page.getByRole('button',{name:'保存选项',exact:true}).click();
 await page.getByLabel('状态',{exact:true}).selectOption('审阅');assert.ok((await source()).includes('"状态": "审阅"'));
 await page.getByLabel('状态 类型',{exact:true}).selectOption('number');assert.ok((await source()).includes('"状态": "审阅"'));assert.ok(await page.getByRole('status').filter({hasText:'不是数字'}).count());
 await add('数量','number','12');assert.ok((await source()).includes('"数量": 12'));
 await page.getByLabel('数量 类型',{exact:true}).selectOption('text');assert.ok((await source()).includes('"数量": "12"'));
 await page.screenshot({path:artifactPath('leaf-typed-properties.png')});
 await page.getByRole('button',{name:'添加文档属性',exact:true}).click();
 await page.getByLabel('新属性名',{exact:true}).fill('createdAt');
 await page.getByLabel('新属性类型',{exact:true}).selectOption('date');
 const inside=await page.getByLabel('新属性类型',{exact:true}).evaluate(select=>{
   const group=select.closest('.leaf-property-name-control'),box=group.getBoundingClientRect(),arrow=select.getBoundingClientRect();
   return group.querySelector('input')!==null&&arrow.left>=box.left&&arrow.right<=group.querySelector('input').getBoundingClientRect().left+1&&select.parentElement.dataset.type==='date'&&select.parentElement.querySelector('svg')!==null;
 });
 assert.ok(inside,'type selector must be inside property name field');
 await page.screenshot({path:artifactPath('leaf-property-integrated.png')});
 assert.deepEqual(errors,[]);console.log('PASS date default, list chips, enum options, checkbox, number, safe conversion');
}finally{await browser.close()}
