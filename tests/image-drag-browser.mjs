import assert from 'node:assert/strict';
import {webkit} from 'playwright';
import {chromium,launchOptions} from './browser-runtime.mjs';
import {desktopImageFixture} from './fixtures/desktop-image.mjs';
const raw='![Picture](assets/my%20photo.svg "Original title")';
const source=`---\ntitle: Image move\n---\n\nIntro\n\n${raw}\n\nTarget paragraph\n\nEnd paragraph\n`;
for(const [engine,options] of [[chromium,launchOptions],[webkit,{headless:true}]]) {
  const browser=await engine.launch(options);
  try {
    for(const platform of ['macOS','Windows']) {
      const page=await browser.newPage({viewport:{width:1100,height:800}}),errors=[];
      page.setDefaultTimeout(10000);
      page.on('pageerror',error=>errors.push(error.stack));
      await desktopImageFixture(page,source,{platform});
      const image=page.locator('.cm-editor img[alt="Picture"]');
      await image.waitFor();
      await page.waitForFunction(()=>document.querySelector('img[alt="Picture"]')?.dataset.loaded==='yes');
      const text=()=>page.evaluate(()=>v.state.doc.toString());
      const point=async needle=>page.evaluate(needle=>{const r=v.coordsAtPos(v.state.doc.toString().indexOf(needle));return {x:r.left,y:(r.top+r.bottom)/2};},needle);
      const begin=async()=>{
        const b=await image.boundingBox();
        await page.keyboard.down(platform==='macOS'?'Meta':'Control');
        await page.mouse.move(b.x+b.width/2,b.y+b.height/2);await page.mouse.down();
      };
      const finish=async()=>{await page.mouse.up();await page.keyboard.up(platform==='macOS'?'Meta':'Control');};
      // Plain click/drag may expose source, but never moves the image.
      let box=await image.boundingBox();
      await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();
      await page.mouse.move(600,600,{steps:5});await page.mouse.up();
      assert.equal(await text(),source,'ordinary drag never moves an image');
      await page.evaluate(()=>v.dispatch({selection:{anchor:v.state.doc.toString().indexOf('Intro')}}));
      await image.waitFor();
      const target=await point('End paragraph');
      await begin();await finish();
      assert.equal(await text(),source,'modifier click without movement is a no-op');
      await begin();await page.mouse.move(target.x,target.y,{steps:8});
      await page.keyboard.up(platform==='macOS'?'Meta':'Control');await page.mouse.up();
      assert.equal(await text(),source,'releasing the modifier cancels movement');
      const properties=await page.locator('.leaf-yaml').boundingBox();
      await begin();await page.mouse.move(properties.x+properties.width/2,properties.y+10,{steps:8});await finish();
      assert.equal(await text(),source,'property block is not a move target');
      await begin();await page.mouse.move(target.x,target.y,{steps:8});
      await page.locator('.leaf-file-drop-cursor').waitFor();
      assert.equal(await text(),source,'hover does not edit');
      await page.keyboard.press('Escape');await finish();
      assert.equal(await text(),source,'Escape cancels');
      assert.equal(await page.locator('.leaf-file-drop-cursor').count(),0);
      await begin();await page.mouse.move(1,1,{steps:8});await finish();
      assert.equal(await text(),source,'outside drop cancels');
      await begin();await page.mouse.move(target.x,target.y,{steps:8});
      await page.locator('.leaf-file-drop-cursor').waitFor();await finish();
      const moved=await text();
      assert.ok(moved.indexOf(raw)>moved.indexOf('Target paragraph'),'moves to the shown position');
      assert.ok(moved.startsWith('---\ntitle: Image move\n---\n'));
      assert.equal(moved.split(raw).length,2,'exact original resource reference occurs once');
      assert.equal(await page.locator('.leaf-file-drop-cursor').count(),0);
      await page.locator('#undoButton').click();
      assert.equal(await text(),source,'one undo restores all source');
      await page.locator('#redoButton').click();
      assert.equal(await text(),moved,'one redo repeats the move');
      // The real app save action goes through the fixture's synthetic file API.
      await page.locator('#saveButton').click();
      await page.waitForFunction(()=>writes.length>0);
      assert.equal(await page.evaluate(()=>disk),moved,'save writes the moved source');
      await page.close();
      const reopened=await browser.newPage({viewport:{width:1100,height:800}});
      reopened.setDefaultTimeout(10000);
      await desktopImageFixture(reopened,moved,{platform});
      await reopened.locator('.cm-editor img[alt="Picture"]').waitFor();
      assert.equal(await reopened.evaluate(()=>v.state.doc.toString()),moved);
      for(const body of [
        `Before ${raw} after`,
        `[${raw}](https://example.test)`,
        `- First\n  ${raw}\n- Second`,
        `| Image | Text |\n| --- | --- |\n| ${raw} | Value |`,
        `> [!NOTE] Note\n> ${raw}`,
      ]) {
        const fixture=`Intro\n\n${body}\n\nEnd paragraph\n`;
        await reopened.evaluate(doc=>{v.dispatch({changes:{from:0,to:v.state.doc.length,insert:doc},selection:{anchor:0}});},fixture);
        const img=reopened.locator('.cm-editor img[alt="Picture"]');
        await img.waitFor();
        await reopened.waitForFunction(()=>document.querySelector('.cm-editor img[alt="Picture"]')?.dataset.loaded==='yes');
        await reopened.waitForTimeout(150);
        const b=await img.boundingBox();
        const p=await reopened.evaluate(()=>{const r=v.coordsAtPos(v.state.doc.toString().indexOf('End paragraph'));return {x:r.left,y:(r.top+r.bottom)/2};});
        await reopened.keyboard.down(platform==='macOS'?'Meta':'Control');
        await reopened.mouse.move(b.x+b.width/2,b.y+b.height/2);await reopened.mouse.down();
        await reopened.mouse.move(p.x,p.y,{steps:8});
        await reopened.locator('.leaf-file-drop-cursor').waitFor();
        await reopened.mouse.up();await reopened.keyboard.up(platform==='macOS'?'Meta':'Control');
        const result=await reopened.evaluate(()=>v.state.doc.toString());
        assert.notEqual(result,fixture,`moves from structured or inline content: ${body}`);
        assert.equal(result.split(raw).length,2);
        await reopened.locator('#undoButton').click();
        assert.equal(await reopened.evaluate(()=>v.state.doc.toString()),fixture);
      }
      const longDoc=`Intro\n\n${raw}\n\n`+Array.from({length:45},(_,i)=>`Paragraph ${i}`).join('\n\n');
      await reopened.evaluate(doc=>{v.dispatch({changes:{from:0,to:v.state.doc.length,insert:doc},selection:{anchor:0},scrollIntoView:true});},longDoc);
      await reopened.waitForTimeout(200);
      const b=await reopened.locator('.cm-editor img[alt="Picture"]').boundingBox();
      const edge=await reopened.evaluate(()=>{const r=v.scrollDOM.getBoundingClientRect();return {x:r.left+r.width/2,y:r.bottom-10};});
      await reopened.keyboard.down(platform==='macOS'?'Meta':'Control');
      await reopened.mouse.move(b.x+b.width/2,b.y+b.height/2);await reopened.mouse.down();
      await reopened.mouse.move(edge.x,edge.y,{steps:8});
      await reopened.waitForFunction(()=>v.scrollDOM.scrollTop>100);
      // A concurrent edit cancels the captured move rather than deleting stale offsets.
      await reopened.evaluate(()=>v.dispatch({changes:{from:v.state.doc.length,insert:'\nNew text'}}));
      await reopened.waitForFunction(()=>!document.querySelector('.leaf-file-drop-cursor'));
      await reopened.mouse.up();await reopened.keyboard.up(platform==='macOS'?'Meta':'Control');
      assert.equal(await reopened.evaluate(()=>v.state.doc.toString()),longDoc+'\nNew text');
      await reopened.close();
      assert.deepEqual(errors,[]);
      console.log(`PASS ${engine.name()}/${platform}: modified pointer drag, marker, cancel, exact source, undo/redo, reopen`);
    }
  }finally{await browser.close();}
}
