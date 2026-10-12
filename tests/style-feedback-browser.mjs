import assert from 'node:assert/strict';
import {webkit} from 'playwright';
import {chromium,launchOptions,artifactPath} from './browser-runtime.mjs';
for(const engine of ['chrome','webkit']) {
 const browser=await(engine==='webkit'?webkit.launch({headless:true}):chromium.launch(launchOptions));
 try {
  const page=await browser.newPage({viewport:{width:1100,height:800}});
  await page.goto('http://127.0.0.1:41732');await page.click('#welcomeNewButton');
  for(const language of ['zh-Hans','zh-Hant-TW','en']) {
   await page.click('#editorLanguageSelect');await page.click(`[data-language="${language}"]`);
   await page.waitForFunction(language=>document.documentElement.lang===language,language);
   await page.click('#appearanceButton');
   assert.equal(await page.locator('#languageSelect').count(),0);
   await page.screenshot({path:artifactPath(`style-feedback-settings-${engine}-${language}.png`)});
   await page.click('#settingsClose');
   await page.locator('#tidyBlankLines').hover();await page.locator('#tooltip').waitFor();
   assert.match(await page.locator('#tooltip').textContent(),/\(.*\)/);
   if(language==='en')assert.match(await page.locator('#tooltip').textContent(),/^Clean Up Blank Lines/);
   await page.screenshot({path:artifactPath(`style-feedback-tooltip-${engine}-${language}.png`)});
   await page.mouse.move(0,0);
  }
  console.log(`PASS ${engine}: settings language entry removed and translated tooltips bracket shortcuts`);
 }finally{await browser.close();}
}
