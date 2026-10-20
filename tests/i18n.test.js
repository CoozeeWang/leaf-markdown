import {readdirSync,readFileSync} from 'node:fs';
import {parseAst} from 'rollup/parseAst';
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveLanguage, normalizePreference, resources, copyKeys, t, h, aliases, formatError } from '../src/i18n.js';
import { parseCallout } from '../src/callout.js';

test('language matching honors explicit script before region and falls back to English', () => {
  for (const [tag, expected] of [
    ['zh-CN','zh-Hans'], ['zh-SG','zh-Hans'], ['zh_Hans_TW','zh-Hans'], ['zh-Hant-CN','zh-Hant-TW'],
    ['zh-TW','zh-Hant-TW'], ['zh-HK','zh-Hant-TW'], ['zh-MO','zh-Hant-TW'], ['zh','zh-Hans'],
    ['en-GB','en'], ['en-US','en'], ['ja-JP','en'], ['', 'en'], ['unknown','en'],
  ]) assert.equal(resolveLanguage(tag), expected, tag);
  assert.equal(normalizePreference('bad-value'), 'system');
  assert.equal(normalizePreference('zh-Hant-TW'), 'zh-Hant-TW');
});
test('every approved copy ID has all languages and matching interpolation variables', () => {
  assert.equal(Object.keys(copyKeys).length, 835);
  const extract = value => [...value.matchAll(/\{\{([^}]+)\}\}/g)].map(match => match[1]).sort();
  for (const [id, key] of Object.entries(copyKeys)) {
    const translations = Object.values(resources).map(locale => locale[key]);
    assert.ok(translations.every(value => typeof value === 'string' && value.length), id);
    // Native positional placeholders and NSIS macros are preserved as their
    // own grammar. JS named interpolation must align across all three.
    assert.deepEqual(extract(translations[0]), extract(translations[1]), id);
    assert.deepEqual(extract(translations[0]), extract(translations[2]), id);
  }
});
test('English counts use one/other; HTML and text rendering escape at the actual sink', () => {
  for (const [count, word] of [[0,'words'],[1,'word'],[2,'words']]) assert.equal(t('main.words',{lng:'en',count}), `${count} ${word}`);
  for (const [count, word] of [[0,'characters'],[1,'character'],[2,'characters']]) assert.equal(t('main.characters',{lng:'en',count}), `${count} ${word}`);
  const raw = '<img src=x onerror=alert(1)> & "';
  assert.ok(t('UI0176',{fileName:raw}).includes(raw), 'textContent receives unescaped text');
  assert.ok(!h('UI0176',{fileName:raw}).includes('<img'), 'HTML receives escaped user parameters');
  assert.ok(h('UI0176',{fileName:raw}).includes('&lt;img'));
});
test('three-language aliases and default callout titles do not change explicit user titles', () => {
  assert.deepEqual(aliases(copyKeys.UI0209), ['撤销','還原','Undo']);
  assert.equal(parseCallout('> [!note] 用户的标题\n> 原文').title, '用户的标题');
  assert.equal(parseCallout('> [!note]\n> 原文').customTitle, '');
  assert.equal(t('UI0258',{lng:'en'}), '简体中文');
  assert.equal(t('UI0259',{lng:'zh-Hans'}), '繁體中文（台灣）');
});

test('stable native errors translate the explanation and retain system diagnoses', () => {
  const code=copyKeys.NA0005;
  const payload=JSON.stringify({leafError:1,code,params:{}});
  assert.equal(formatError(payload), t(code));
  assert.equal(formatError('Permission denied (os error 13)'), 'Permission denied (os error 13)');
  assert.equal(formatError(JSON.stringify({leafError:1,code:'unknown',params:{}})), JSON.stringify({leafError:1,code:'unknown',params:{}}));
  assert.ok(t('pdf_export.export_failed',{error:payload}).includes(t(code)));
  for(const [count,word] of [[0,'entries'],[1,'entry'],[2,'entries']]) assert.equal(t('NA0071',{lng:'en',count}),`Removed ${count} unavailable ${word}.`);
  assert.equal(t('MO0182',{lng:'en',total:1}),'1 match');
});

test('literal UI translation calls refer to existing resources', () => {
  const visit=node=>{
    if(!node||typeof node!=='object')return;
    if(node.type==='CallExpression'&&['t','h','translatedMessage'].includes(node.callee?.name)&&node.arguments[0]?.type==='Literal') {
      const id=node.arguments[0].value,key=copyKeys[id]||id;
      assert.ok(resources.en[key]||resources.en[key+'_other'],`Unknown translation: ${id}`);
    }
    for(const value of Object.values(node))if(Array.isArray(value))value.forEach(visit);else visit(value);
  };
  for(const name of readdirSync('src').filter(name=>name.endsWith('.js')))visit(parseAst(readFileSync('src/'+name,'utf8')));
  for(const key of Object.keys(resources.en))for(const language of ['zh-Hans','zh-Hant-TW'])assert.ok(resources[language][key],`${language} missing ${key}`);
});

test('native errors wrapped in Error remain readable',()=>{
 const code='main.a_file_with_this_name_already_exists_na0039';
 assert.equal(formatError(new Error(JSON.stringify({leafError:1,code,params:{}}))),t(code));
});
