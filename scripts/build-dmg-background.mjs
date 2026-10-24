// Regenerate the committed installer artwork after editing its SVG source.
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import sharp from 'sharp';
const source=await readFile(new URL('../src-tauri/dmg-background.svg',import.meta.url),'utf8');
const browser=await chromium.launch({headless:true});
try {
 const page=await browser.newPage({viewport:{width:660,height:480},deviceScaleFactor:2});
 await page.setContent('<style>html,body{margin:0;width:660px;height:480px;overflow:hidden}</style>'+source);
 await page.evaluate(()=>document.fonts.ready);
 await sharp(await page.screenshot()).withMetadata({density:144}).png().toFile(fileURLToPath(new URL('../src-tauri/dmg-background.png',import.meta.url)));
} finally {await browser.close();}
