import assert from 'node:assert/strict';
import {chromium,webkit} from 'playwright';
import sharp from 'sharp';
for(const engine of [chromium,webkit]) {
 const browser=await engine.launch({headless:true});
 try {
  const page=await browser.newPage({viewport:{width:1100,height:900}});
  await page.goto('http://127.0.0.1:41732/tests/native-callout-blink.html');
  await page.waitForFunction(()=>document.title==='LeafBlink READY');
  const body=page.locator('.leaf-callout-body textarea');
  let count=0;
  for(let step=0;step<4;step++) {
   await page.evaluate(step=>blinkStep(step),step);
   await page.waitForFunction(()=>JSON.parse(blinkState()).nativeColor==='rgba(0, 0, 0, 0)');
   let on=0,off=0;
   // Observe several independent blink cycles, retaining native caret pixels.
   // Screenshot's default caret hiding would conceal the original regression.
   for(let frame=0;frame<40;frame++) {
    const state=JSON.parse(await page.evaluate(()=>blinkState()));
    assert.equal(state.focus,true);assert.equal(state.windowFocus,true);
    assert.equal(state.nativeColor,'rgba(0, 0, 0, 0)','CodeMirror focus rule restored native caret');
    assert.equal(state.hidden,false);
    const box=await body.locator('..').boundingBox();
    const buffer=await body.locator('..').screenshot({caret:'initial'});
    const {data,info}=await sharp(buffer).raw().toBuffer({resolveWithObject:true});
    let red=[];const x=Math.round(state.caret.left-box.x);
    const top=Math.max(0,Math.floor(state.caret.top-box.y-12));
    const bottom=Math.min(info.height,Math.ceil(state.caret.bottom-box.y+12));
    for(let col=Math.max(0,x-2);col<Math.min(info.width,x+3);col++) {
     let darkRun=0;
     for(let y=top;y<bottom;y++) {
      const p=(y*info.width+col)*info.channels,r=data[p],g=data[p+1],b=data[p+2];
      if(r>220&&g<55&&b<55)red.push(y);
      darkRun=r<100&&g<100&&b<100?darkRun+1:0;
      assert.ok(darkRun<=27,'tall native dark caret appeared during blink');
     }
    }
    if(red.length){on++;assert.ok(Math.max(...red)-Math.min(...red)+1<=27,'visible caret too tall');}else off++;
    count++;await new Promise(resolve=>setTimeout(resolve,100));
   }
   assert.ok(on>=5&&off>=5,`did not observe full blink cycles: on=${on} off=${off}`);
  }
  console.log(`${engine.name()}: ${count} focused frames across idle blank/text, typing and composition-end; native caret hidden and measured blink height stable`);
 }finally{await browser.close();}
}
