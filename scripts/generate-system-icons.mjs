import sharp from 'sharp';
import {readFileSync,writeFileSync,mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';

// Keep the approved in-app master intact. System icons have platform-specific
// visible bounds: macOS matches 840px peers; Windows uses 960px at 1024.
const master=readFileSync(new URL('../public/leaf-icon.png',import.meta.url));
const {data,info}=await sharp(master).ensureAlpha().raw().toBuffer({resolveWithObject:true});
let left=info.width,top=info.height,right=0,bottom=0;
for(let y=0;y<info.height;y++)for(let x=0;x<info.width;x++)if(data[(y*info.width+x)*4+3]>16){left=Math.min(left,x);top=Math.min(top,y);right=Math.max(right,x+1);bottom=Math.max(bottom,y+1);}
const crop={left,top,width:right-left,height:bottom-top};
async function systemRaster(bodySide){
 const body=await sharp(master).extract(crop).resize({width:bodySide,height:bodySide,fit:'inside'}).png().toBuffer();
 const meta=await sharp(body).metadata();
 return sharp({create:{width:1024,height:1024,channels:4,background:'#00000000'}}).composite([{input:body,left:Math.floor((1024-meta.width)/2),top:Math.floor((1024-meta.height)/2)}]).png().toBuffer();
}
const windows=await systemRaster(960),sizes=[16,24,32,48,64,128,256];
const pngs=await Promise.all(sizes.map(size=>sharp(windows).resize(size,size).png().toBuffer()));
const header=Buffer.alloc(6+sizes.length*16);header.writeUInt16LE(1,2);header.writeUInt16LE(sizes.length,4);
let offset=header.length;
sizes.forEach((size,i)=>{const at=6+i*16;header[at]=header[at+1]=size===256?0:size;header.writeUInt16LE(1,at+4);header.writeUInt16LE(32,at+6);header.writeUInt32LE(pngs[i].length,at+8);header.writeUInt32LE(offset,at+12);offset+=pngs[i].length;});
writeFileSync(new URL('../src-tauri/icons/icon.ico',import.meta.url),Buffer.concat([header,...pngs]));
if(process.platform==='darwin'){
 const work=mkdtempSync(join(tmpdir(),'leaf-system-icon-'));
 try{
  const set=join(work,'Leaf.iconset');mkdirSync(set);
  const mac=await systemRaster(840);
  for(const size of [16,32,128,256,512])for(const scale of [1,2])writeFileSync(join(set,`icon_${size}x${size}${scale===2?'@2x':''}.png`),await sharp(mac).resize(size*scale,size*scale).png().toBuffer());
  execFileSync('iconutil',['-c','icns',set,'-o',new URL('../src-tauri/icons/icon.icns',import.meta.url).pathname]);
 }finally{rmSync(work,{recursive:true,force:true});}
}
console.log('System icons generated; approved in-app master unchanged.');
