import {test} from 'node:test';
import assert from 'node:assert/strict';
import {indexFootnotes, planFootnoteInsertion, footnoteDefinitionText, footnoteBodyText, appendDefinition} from '../src/footnotes.js';

function apply(text, changes) {
  let out = '', at = 0;
  for (const change of changes) { out += text.slice(at, change.from) + change.insert; at = change.to; }
  return out + text.slice(at);
}

const rangeOf = (text, needle) => {
  const from = text.indexOf(needle);
  assert.ok(from >= 0, `找不到 ${needle}`);
  return [from, from + needle.length];
};

// A plan is a change set, so it has to behave like one, and the labels it writes
// have to agree with the numbers the reader is going to see. Both are checked
// here so the specific cases below and the random sweep share one definition of
// "correct".
function settle(text, from, to = from) {
  const plan = planFootnoteInsertion(text, from, to);
  assert.ok(plan.changes.length > 0, 'a plan always edits something');
  for (let i = 1; i < plan.changes.length; i++) {
    assert.ok(plan.changes[i - 1].to <= plan.changes[i].from, `改动必须升序且不重叠：${JSON.stringify(plan.changes)}`);
  }
  const next = apply(text, plan.changes);
  assert.ok(plan.caret >= 0 && plan.caret <= next.length, `光标 ${plan.caret} 越界`);
  if (!plan.renumberBlocked) {
    let displayed = 0;
    for (const note of indexFootnotes(next).notes) {
      if (!note.def || note.number === null) continue;
      displayed++;
      if (/^[0-9]+$/.test(note.id)) {
        assert.equal(note.id, String(displayed), `标签要与页面上的号一致：${JSON.stringify(next)}`);
      }
    }
  }
  return {plan, next};
}

test('空文档里插一条，光标停在标记后面', () => {
  const {plan, next} = settle('', 0);
  assert.equal(next, '[^1]\n\n[^1]:');
  assert.equal(plan.caret, '[^1]'.length);
  assert.equal(plan.body, '');
});

test('没选中文字时，标记落在光标处、定义落在文末', () => {
  const {plan, next} = settle('第一句。\n', 4);
  assert.equal(next, '第一句。[^1]\n\n[^1]:');
  assert.equal(plan.caret, '第一句。[^1]'.length);
});

test('插到已有的注释前面，后面的标号整体往后挪，定义也排到最前', () => {
  const text = '甲[^1] 乙[^2]\n\n[^1]: A\n[^2]: B\n';
  const {plan, next} = settle(text, 1);
  assert.equal(next, '甲[^1][^2] 乙[^3]\n\n[^1]:\n[^2]: A\n[^3]: B\n');
  assert.equal(plan.label, '1');
  assert.equal(plan.renumbered, true);
  // 定义落在光标后面，所以光标不动
  assert.equal(plan.caret, '甲[^1]'.length);
});

// The report that started this: a note inserted between two others is numbered
// between them, and its definition has to be written between theirs as well --
// the number says "second", so the file must not say "last".
test('插在两条注释中间时，定义也落在两条定义中间', () => {
  const text = '甲[^scale]，乙乙[^capital]。\n\n[^scale]: 一\n[^capital]: 二\n[^stray]: 没人引用的那条\n';
  const {plan, next} = settle(text, '甲[^scale]，'.length);
  assert.equal(next, '甲[^scale]，[^2]乙乙[^capital]。\n\n[^scale]: 一\n[^2]:\n[^capital]: 二\n[^stray]: 没人引用的那条\n');
  assert.equal(plan.label, '2');
  // 标签是作者写的字，不参与重排
  assert.equal(plan.renumbered, false);
  assert.equal(plan.caret, '甲[^scale]，[^2]'.length);
});

// A file that keeps its definitions above the text: the new block belongs back up
// there, and the caret has to stay with the sentence it was typed into rather than
// drift by the length of the block that landed in front of it.
test('定义写在正文上面时，新定义也回到上面，光标留在原句', () => {
  const text = '[^1]: A\n[^2]: B\n\n甲[^1] 乙[^2]\n';
  const {plan, next} = settle(text, text.indexOf('乙'));
  assert.equal(next, '[^1]: A\n[^2]:\n[^3]: B\n\n甲[^1] [^2]乙[^3]\n');
  assert.equal(plan.caret, next.indexOf('[^2]乙') + '[^2]'.length);
  assert.equal(plan.renumbered, true);
});

test('选中一句话，句子搬进注释，光标留在原位', () => {
  const text = '他说了一句废话。\n';
  const [from, to] = rangeOf(text, '废话');
  const {plan, next} = settle(text, from, to);
  assert.equal(next, '他说了一句[^1]。\n\n[^1]: 废话');
  assert.equal(plan.body, '废话');
  // 光标紧跟在标记后面，好接着往下写
  assert.equal(next.slice(plan.caret - 4, plan.caret), '[^1]');
});

test('选中多行时，续行带上四个空格的缩进', () => {
  const text = '开头。\n第一行\n第二行\n结尾。\n';
  const [from, to] = rangeOf(text, '第一行\n第二行');
  const {plan, next} = settle(text, from, to);
  assert.equal(next, '开头。\n[^1]\n结尾。\n\n[^1]: 第一行\n    第二行');
  assert.equal(plan.body, '第一行\n第二行');
  assert.equal(next.slice(plan.caret - 4, plan.caret), '[^1]');
});

test('选中的结尾空行不会变成注释里的空首行', () => {
  const text = '开头。\n要注释的一句\n后面。\n';
  const [from, to] = rangeOf(text, '要注释的一句\n');
  const {plan, next} = settle(text, from, to);
  assert.equal(plan.body, '要注释的一句');
  assert.equal(next, '开头。\n[^1]\n后面。\n\n[^1]: 要注释的一句');
});

test('文字标签是作者的，不被改动', () => {
  const text = '正文[^note]。\n\n[^note]: 只有一条\n';
  const {plan, next} = settle(text, 2);
  assert.equal(next, '正文[^1][^note]。\n\n[^1]:\n[^note]: 只有一条\n');
  assert.equal(plan.renumbered, false);
});

test('光标停在标记里时，插到它后面而不是劈开它', () => {
  const text = '正文[^1] 后面\n\n[^1]: A\n';
  const {plan, next} = settle(text, '正文[^'.length);
  assert.equal(next, '正文[^1][^2] 后面\n\n[^1]: A\n\n[^2]:');
  assert.equal(plan.label, '2');
});

test('光标停在定义标记里时，定义不会被劈坏', () => {
  const text = '正文[^1]\n\n[^1]: A\n';
  const {next} = settle(text, '正文[^1]\n\n[^'.length);
  // 新标记落在定义体内，但 [^1]: 这一行仍然是完整的定义
  assert.ok(next.startsWith('正文[^1]\n\n[^1]:'), `定义标记要保持完整：${JSON.stringify(next)}`);
  assert.equal(indexFootnotes(next).notes.find(note => note.id === '1').state, 'complete');
});

test('遇上没定义的纯数字引用时放弃重排，不把两条注释并成一条', () => {
  const text = '引用[^note] 和 [^1]\n\n[^note]: 定义\n';
  const {plan, next} = settle(text, rangeOf(text, '[^note]')[0]);
  assert.equal(plan.renumberBlocked, true);
  assert.equal(plan.renumbered, false);
  assert.equal(indexFootnotes(next).notes.filter(note => note.id === '1').length, 1, '不允许两条注释同名');
  assert.equal(indexFootnotes(next).notes.find(note => note.id === 'note').def.body, '定义', '原有定义不受影响');
});

test('一次插入只产生一组改动，可以一次撤销', () => {
  const text = '甲[^1] 乙[^2]\n\n[^1]: A\n[^2]: B\n';
  // 插在中间会同时改 4 处（2 个引用 + 2 个定义 + 新标记 + 新定义），但仍是单次事务
  const plan = planFootnoteInsertion(text, 1);
  assert.ok(plan.changes.length >= 5, `应当一次给出全部改动，实际 ${plan.changes.length}`);
  assert.equal(apply(text, [...plan.changes].reverse().sort((a, b) => a.from - b.from)).includes('[^3]: B'), true);
});

test('改动会让某个标记改换含义时，退回原文的标号而不是写坏', () => {
  // 定义体里的 "[^2]: B" 本来因为后面跟着冒号而被当成标记跳过；选区只换掉 ": B"，
  // 前面那个 [^2] 立刻变成真正的引用，全文的引用顺序因此被打乱。这种文档只能放弃重排。
  const text = '[^2]:[^1]: A[^2]:[^note][^2]: B```\n```乙。```\n[^x][^2]\n';
  const {plan, next} = settle(text, 28, 31);
  assert.equal(plan.renumberBlocked, true, '这种文档应该放弃重排');
  assert.equal(plan.renumbered, false);
  assert.equal(indexFootnotes(next).notes.filter(note => note.id === plan.label).length, 1, '新标签只能对应一条注释');
});

test('随机文档里，插入后文件里的号始终等于页面上的号', () => {
  const tokens = ['甲', ' ', '\n', '\n\n', '乙。', '[^1]', '[^2]', '[^10]', '[^x]', '[^note]',
    '[^1]: A', '[^2]: B', '[^10]: C', '[^note]: D', '[^2]:', '    续行', '`[^1]`', '```\n', '```', '| 表[^2] |'];
  let seed = 20260910;
  const random = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  let renumbered = 0, blocked = 0;
  for (let n = 0; n < 600; n++) {
    let text = '';
    for (let i = 0, len = 1 + Math.floor(random() * 12); i < len; i++) text += tokens[Math.floor(random() * tokens.length)];
    const from = Math.floor(random() * (text.length + 1));
    const to = random() < 0.35 ? Math.min(text.length, from + Math.floor(random() * 4)) : from;
    const {plan} = settle(text, from, to);
    if (plan.renumberBlocked) blocked++;
    else if (plan.renumbered) renumbered++;
  }
  assert.ok(renumbered > 0, '随机样本要真的走到重排那条路');
  assert.ok(blocked > 0, '也要走到放弃重排那条路');
});

// The note box writes the body; the insert control writes the whole definition.
// Both have to lay a multi-line note out the same way, or a note typed in the box
// would lose its second line the moment the file is read back.
test('注释正文的排版：首行同行、续行带缩进、空行留空', () => {
  const INDENT = '    ';
  assert.equal(footnoteBodyText('一条注释'), '一条注释');
  assert.equal(footnoteBodyText(`第一行\n第二行`), `第一行\n${INDENT}第二行`);
  assert.equal(footnoteBodyText(`第一段\n\n第二段`), `第一段\n\n${INDENT}第二段`);
  assert.equal(footnoteBodyText('尾随空格  '), '尾随空格');
});

test('整块定义就是「标记 + 正文」，两处写出来的是同一样东西', () => {
  for (const body of ['', '甲', '甲\n乙', '甲\n\n乙']) {
    const laid = footnoteBodyText(body);
    assert.equal(footnoteDefinitionText('7', body), laid ? `[^7]: ${laid}` : '[^7]:');
  }
});

test('文末还没有定义时，新定义追加在最后，与前面隔一个空行', () => {
  assert.equal(apply('甲[^1]。\n', appendDefinition('甲[^1]。\n', '1', '')), '甲[^1]。\n\n[^1]:');
  assert.equal(apply('甲[^1]。\n\n\n', appendDefinition('甲[^1]。\n\n\n', '1', '注释')), '甲[^1]。\n\n[^1]: 注释');
  assert.equal(apply('', appendDefinition('', '1', '注释')), '[^1]: 注释');
});

// The first words in a note whose citation was typed by hand: the box and the
// panel write through here, and they must not lay a note out differently from the
// way the insert control does.
test('给还没有定义的引用补写正文时，定义也排在它该在的地方', () => {
  const text = '甲[^1] 乙[^2]\n\n[^2]: B\n';
  assert.equal(apply(text, appendDefinition(text, '1', 'A')), '甲[^1] 乙[^2]\n\n[^1]: A\n[^2]: B\n');
  // 后面已经没有别的定义，只能落在文末
  const tail = '甲[^1] 乙[^2]\n\n[^1]: A\n';
  assert.equal(apply(tail, appendDefinition(tail, '2', 'B')), '甲[^1] 乙[^2]\n\n[^1]: A\n\n[^2]: B');
});
