import test from 'node:test';
import assert from 'node:assert/strict';
import { BODY_FONT_STORAGE, readBodyFonts, loadBodyFonts, resolveBodyFonts, bodyFontChoices, LATIN_RANGE, CHINESE_RANGE } from '../src/body-fonts.js';
const storage = entries => ({ getItem: key => entries[key] ?? null });

test('displayed families exclude unavailable fonts and duplicate migrated presets', () => {
  const catalog = { en: { serif: { available: true, family: 'Georgia' }, georgia: { available: true, family: 'Georgia' },
    sans: { available: true, family: 'Arial' }, mono: { available: true, family: null },
    palatino: { available: false, family: null } } };
  assert.deepEqual(bodyFontChoices('en', catalog).map(({id,family})=>({id,family})),
    [{id:'georgia',family:'Georgia'},{id:'sans',family:'Arial'}]);
  assert.deepEqual(bodyFontChoices('zh', null), []);
});

test('legacy presets migrate both scripts without writing the old setting', () => {
  for (const preset of ['sans','serif','mono']) {
    const entries = { 'leaf-reading-v2-font': preset };
    assert.deepEqual(readBodyFonts(storage(entries)), { zh: preset, en: preset });
    assert.deepEqual(entries, { 'leaf-reading-v2-font': preset });
  }
  assert.deepEqual(readBodyFonts(storage({ 'leaf-reading-v2-font': 'invalid' })), { zh: 'sans', en: 'sans' });
});
test('Latin letters and combining accents share a range, while Chinese punctuation stays separate', () => {
  const contains=(range,point)=>range.split(',').some(part=>{const [from,to]=part.replace('U+','').split('-').map(value=>parseInt(value,16));return point>=from&&point<=(to??from);});
  for(const point of [0x41,0xe9,0x301,0x1ab0,0x1dc0,0xfe20]) {
    assert.equal(contains(LATIN_RANGE,point),true);assert.equal(contains(CHINESE_RANGE,point),false);
  }
  for(const point of [0x201c,0x3002,0x4e2d,0xff0c]) {
    assert.equal(contains(CHINESE_RANGE,point),true);assert.equal(contains(LATIN_RANGE,point),false);
  }
});
test('independent saved choices survive; corrupt or unknown values use the legacy preset', () => {
  const entries = { 'leaf-reading-v2-font': 'serif', [BODY_FONT_STORAGE]: '{broken' };
  assert.deepEqual(readBodyFonts(storage(entries)), { en: 'serif', zh: 'serif' });
  entries[BODY_FONT_STORAGE] = JSON.stringify({ zh: 'songti', en: 'palatino' });
  assert.deepEqual(readBodyFonts(storage(entries)), { zh: 'songti', en: 'palatino' });
  entries[BODY_FONT_STORAGE] = JSON.stringify({ zh: 'unknown', en: 'georgia' });
  assert.deepEqual(readBodyFonts(storage(entries)), { zh: 'serif', en: 'georgia' });
});
test('missing fonts produce explicit fallback while keeping the requested preference', () => {
  const prefs = { en: 'nyt-imperial', zh: 'songti' };
  const catalog = { en: {sans:{available:true,alias:'English system'}}, zh: {songti:{available:true,alias:'Chinese songti'}} };
  const value = resolveBodyFonts(prefs,catalog);
  assert.deepEqual(value.active,{en:'sans',zh:'songti'});
  assert.deepEqual(value.missing,[{script:'en',id:'nyt-imperial'}]);
  assert.deepEqual(prefs,{en:'nyt-imperial',zh:'songti'});
  assert.equal(value.stack,'"English system", "Chinese songti", var(--ui-font)');
  assert.deepEqual(resolveBodyFonts({en:'mono',zh:'serif'},null).missing,[]);
});
test('local lookup rejects nonexistent faces; no URL source and no FontFaceSet.check false positive', async () => {
  const loaded=[],added=[];
  class LocalFace {
    constructor(alias,source,descriptors) { Object.assign(this,{family:alias,source,descriptors}); }
    async load() {
      loaded.push(this);
      assert.ok(this.source.startsWith('local(')); assert.ok(!this.source.includes('url('));
      if (!this.source.includes('local("Georgia")') && !this.source.includes('local("Songti SC")')) throw new Error('Missing');
      return this;
    }
  }
  const catalog=await loadBodyFonts({FontFaceType:LocalFace,fontSet:{add:face=>added.push(face),check:()=>assert.fail('check cannot detect installed fonts')}});
  assert.equal(catalog.en.georgia.available,true);
  assert.equal(catalog.zh.songti.available,true);
  assert.equal(catalog.en['nyt-imperial'].available,false);
  assert.equal(catalog.zh.yahei.available,false);
  assert.equal(catalog.en.sans.available,true,'Generic presets remain usable');
  assert.equal(added.find(face=>face.family==='Leaf Body en georgia').descriptors.unicodeRange,LATIN_RANGE);
  assert.equal(added.find(face=>face.family==='Leaf Body zh songti').descriptors.unicodeRange,CHINESE_RANGE);
  assert.ok(loaded.some(face=>face.descriptors.style==='italic' && face.descriptors.weight==='700'));
});
test('an unknown local CJK serif preset retains browser serif fallback independently of the loaded Latin face', () => {
  const value=resolveBodyFonts({en:'georgia',zh:'serif'},{en:{georgia:{available:true,alias:'English Georgia'}},zh:{serif:{available:true,alias:null}}});
  assert.equal(value.stack,'"English Georgia", serif');
  assert.deepEqual(value.missing,[]);
});
test('blocked font access and stalled loads keep generic presets usable', async () => {
  const missing=await loadBodyFonts({FontFaceType:null,fontSet:null});
  assert.equal(missing.en.georgia.available,false);
  assert.equal(missing.zh.serif.available,true);
  class StalledFace { load(){return new Promise(()=>{});} }
  const stalled=await loadBodyFonts({FontFaceType:StalledFace,fontSet:{add:()=>assert.fail('No stalled face may be installed')},timeout:2});
  assert.equal(stalled.en.palatino.available,false);
});
