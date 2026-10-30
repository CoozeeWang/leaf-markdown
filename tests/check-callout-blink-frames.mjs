// Native WKWebView screenshots, never system-screen captures.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import sharp from 'sharp';
const directory=process.argv[2];assert.ok(directory,'supply native snapshot directory');
const states=JSON.parse(await readFile(join(directory,'states.json'),'utf8'));
assert.equal(states.length,100);
const phases=Array.from({length:4},()=>({on:0,off:0}));
for(let index=0;index<states.length;index++) {
 const state=states[index];
 assert.equal(state.focus,true);assert.equal(state.windowFocus,true,'background native capture cannot validate focus cascade');
 assert.equal(state.nativeColor,'rgba(0, 0, 0, 0)','native caret was not suppressed');assert.equal(state.hidden,false);
 const {data,info}=await sharp(join(directory,String(index).padStart(3,'0')+'.png')).raw().toBuffer({resolveWithObject:true});
 const scale=info.width/1100,x=Math.round(state.caret.left*scale);
 const top=Math.max(0,Math.floor((state.caret.top-12)*scale)),bottom=Math.min(info.height,Math.ceil((state.caret.bottom+12)*scale));
 let red=[];
 for(let col=Math.max(0,x-Math.ceil(2*scale));col<Math.min(info.width,x+Math.ceil(3*scale));col++) {
  let darkRun=0;for(let y=top;y<bottom;y++) {
   const p=(y*info.width+col)*info.channels,r=data[p],g=data[p+1],b=data[p+2];
   if(r>220&&g<55&&b<55)red.push(y);
   darkRun=r<100&&g<100&&b<100?darkRun+1:0;
   assert.ok(darkRun<=27*scale,`native dark caret reappeared in frame ${index}`);
  }
 }
 if(red.length){phases[Math.floor(index/25)].on++;assert.ok(Math.max(...red)-Math.min(...red)+1<=27*scale,`tall visual caret in frame ${index}`);}else phases[Math.floor(index/25)].off++;
}
for(const phase of phases)assert.ok(phase.on>=3&&phase.off>=3,`insufficient blink cycles ${JSON.stringify(phase)}`);
console.log(JSON.stringify({pass:true,frames:states.length,phases,native:'foreground WKWebView',realChineseIME:false}));
