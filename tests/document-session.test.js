import test from 'node:test';
import assert from 'node:assert/strict';
import { createDocumentSession } from '../src/document-session.js';

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function setup(overrides = {}) {
  const state = { content: 'disk', saved: 'disk', writes: [], checkpoints: [], statuses: [], disk: 'disk' };
  const io = {
    content: () => state.content,
    load: async content => { state.content = content; state.saved = content; },
    status: text => state.statuses.push(text),
    checkpoint: async (content, preserve) => state.checkpoints.push({ content, preserve }),
    read: async () => state.disk, readTarget: async () => null, select: async () => '/new.md',
    write: async (path, content, expected) => {
      if (path === '/file.md' && expected !== state.disk) throw new Error('external conflict');
      state.writes.push({ path, content, expected }); state.disk = content;
    },
    saved: (content) => { state.saved = content; },
    restore: async content => { state.content = content; },
    ...overrides,
  };
  const session = createDocumentSession(io);
  await session.initialize('/file.md', 'disk');
  return { session, state, io };
}
test('typing during a slow save stays dirty and the queued save writes the latest content', async () => {
  const started = deferred(), finish = deferred();
  const { session, state, io } = await setup();
  const original = io.write;
  io.write = async (...args) => { started.resolve(); await finish.promise; return original(...args); };
  state.content = 'first'; session.edited();
  const saving = session.save(); await started.promise;
  state.content = 'second'; session.edited();
  finish.resolve(); assert.equal(await saving, true);
  assert.equal(state.saved, 'first'); assert.equal(state.content, 'second');
  assert.equal(await session.save(), true);
  assert.equal(state.saved, 'second'); assert.equal(state.disk, 'second');
});
test('an external read in flight cannot overwrite input made before it returns', async () => {
  const started = deferred(), finish = deferred();
  const { session, state } = await setup({ read: async () => { started.resolve(); return finish.promise; } });
  const poll = session.poll(); await started.promise;
  state.content = 'my typing'; session.edited(); finish.resolve('external'); await poll;
  assert.equal(state.content, 'my typing'); assert.match(state.statuses.at(-1), /其他程序修改/);
});
test('failed writes and cancelled save-as retain both buffer and original path', async () => {
  const { session, state, io } = await setup({ select: async () => null });
  state.content = 'mine';
  assert.equal(await session.save({ as: true }), false);
  assert.equal(session.path, '/file.md'); assert.equal(state.writes.length, 0);
  state.disk = 'external';
  assert.equal(await session.save(), false);
  assert.equal(state.content, 'mine'); assert.equal(state.saved, 'disk'); assert.equal(state.disk, 'external');
  io.write = async () => { throw new Error('read only'); };
  assert.equal(await session.save(), false); assert.equal(state.content, 'mine');
});
test('restoration checkpoints the previous buffer and blocks queued autosave until explicit save', async () => {
  const { session, state } = await setup();
  state.content = 'current edits'; session.edited();
  const restoring = session.restore('old version');
  const autosave = session.save({ manual: false });
  await restoring; assert.equal(await autosave, false);
  assert.deepEqual(state.checkpoints[0], { content: 'current edits', preserve: true });
  assert.equal(state.content, 'old version'); assert.equal(state.disk, 'disk');
  state.disk = 'external change'; await session.poll();
  assert.equal(state.content, 'old version');
  assert.equal(await session.save(), false); assert.equal(session.paused, true);
  state.disk = 'disk'; assert.equal(await session.save(), true); assert.equal(session.paused, false);
});
test('a checkpoint failure prevents replacing the editor during recovery', async () => {
  const { session, state } = await setup({ checkpoint: async () => { throw new Error('storage full'); } });
  await assert.rejects(session.restore('old'), /storage full/);
  assert.equal(state.content, 'disk'); assert.equal(state.writes.length, 0);
});
test('saving an uninitialized welcome window never opens a chooser or writes', async () => {
  const session = createDocumentSession({ select: () => { throw new Error('must not run'); } });
  assert.equal(await session.save(), false);
});
test('cleanup warning preserves the saved baseline and remains visible',async()=>{
 const {session,state,io}=await setup();const write=io.write;
 io.write=async(...args)=>{await write(...args);return '文档已保存，图片清理未完成';};
 state.content='new';session.edited();assert.equal(await session.save(),true);
 assert.equal(state.saved,'new');assert.equal(state.statuses.at(-1),'文档已保存，图片清理未完成');
 io.write=write;state.content='next';session.edited();assert.equal(await session.save(),true);
 assert.equal(state.writes.at(-1).expected,'new');
});

test('rename keeps dirty content and routes queued saves to the new path', async()=>{
 const {session,state,io}=await setup();let renamed;
 io.rename=async(path,name,expected)=>{assert.equal(path,'/file.md');assert.equal(expected,'disk');return '/renamed.md';};
 io.renamed=(disk,path,previous)=>{renamed={disk,path,previous};};
 state.content='unsaved';session.edited();
 await session.rename('renamed.md');
 assert.deepEqual(renamed,{disk:'disk',path:'/renamed.md',previous:'/file.md'});
 assert.equal(state.content,'unsaved');await session.save();assert.equal(state.writes[0].path,'/renamed.md');
 io.rename=async()=>{throw new Error('exists');};
 await assert.rejects(session.rename('exists.md'),/exists/);assert.equal(session.path,'/renamed.md');
});

test('save-as updates attachment links without losing text typed during native copying',async()=>{
 const {session,state,io}=await setup();const started=deferred(),finish=deferred();
 state.content='![图](file.assets/a.png)';
 io.write=async()=>{started.resolve();await finish.promise;return {content:'![图](new.assets/a.png)',mappings:[['file.assets/a.png','new.assets/a.png']],warning:null};};
 const saving=session.save({as:true});await started.promise;
 state.content+='\n输入仍在继续';session.edited();finish.resolve();assert.equal(await saving,true);
 assert.equal(state.saved,'![图](new.assets/a.png)');
 assert.equal(state.content,'![图](new.assets/a.png)\n输入仍在继续');
 assert.equal(session.path,'/new.md');
});
