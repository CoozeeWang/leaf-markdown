import {rewriteResourcePaths} from './resource-paths.js';
// Native I/O is injected so delayed writes, conflicts and recovery can be
// exercised without a WebView or a user's files.
export function createDocumentSession(io) {
  let path = null, disk = null, ready = false, revision = 0, paused = false;
  let queue = Promise.resolve();
  const serialize = action => {
    const result = queue.then(action);
    queue = result.catch(() => {});
    return result;
  };
  const status = (text, kind = 'error', options) => io.status(text, kind, options);
  return {
    get path() { return path; },
    get paused() { return paused; },
    get ready() { return ready; },
    edited() { revision++; },
    async initialize(source, content) {
      path = source; disk = content;
      await io.load(content, source);
      ready = true;
    },
    idle: () => queue,
    run: action => serialize(action),
    checkpoint() {
      return serialize(async () => {
        if (ready && io.content() !== disk) await io.checkpoint(io.content());
      });
    },
    save({ as = false, manual = true } = {}) {
      return serialize(async () => {
        if (!ready || (paused && !manual)) return false;
        try {
          let target = path, expected = disk;
          if (!target || as) {
            target = await io.select(path);
            if (!target) return false;
            expected = await io.readTarget(target);
          }
          let content = io.content();
          await io.checkpoint(content);
          status('正在保存…', 'pending');
          const result = await io.write(target, content, expected);
          const cleanupWarning = result && typeof result === 'object' ? result.warning : result;
          if (result && typeof result === 'object') {
            content = result.content;
            const latest = rewriteResourcePaths(io.content(), result.mappings);
            if (latest !== io.content()) io.restore(latest);
          }
          path = target; disk = content; paused = false;
          io.saved(content, target);
          status(cleanupWarning || (io.content() === content ? '已保存' : '等待自动保存…'), cleanupWarning ? 'error' : io.content() === content ? 'saved' : 'pending', { announce: manual });
          return true;
        } catch (error) { status(`修改尚未保存。请重试或另存为。详情：${error}`); return false; }
      });
    },
    rename(name) {
      return serialize(async () => {
        if(!ready || !path) throw new Error('请先保存文档，再修改文件名');
        await io.checkpoint(io.content());
        const result=await io.rename(path,name,disk,io.content());
        const target=typeof result==='string'?result:result.path;
        if (typeof result==='object') {
          disk=result.content;
          const latest=rewriteResourcePaths(io.content(),result.mappings);
          if(latest!==io.content())io.restore(latest);
        }
        const previous=path;path=target;
        io.renamed(disk,target,previous);
        status(io.content()===disk?'已重命名':'已重命名 · 等待保存',io.content()===disk?'saved':'pending');
        return target;
      });
    },
    poll() {
      return serialize(async () => {
        if (!ready || !path || paused) return;
        const at = revision;
        try {
          const current = await io.read(path);
          if (current === disk) return;
          if (revision !== at || io.content() !== disk) {
            status('文件已被其他程序修改。请另存为以保留当前编辑内容。'); return;
          }
          await io.load(current, path);
          disk = current;
          status('已载入外部修改', 'saved');
        } catch (error) { status(`无法读取文件：${error}`); }
      });
    },
    restore(content) {
      return serialize(async () => {
        if (!ready) throw new Error('请先打开或新建文档');
        // Protect the current buffer before replacing it; keep the disk
        // baseline intact. Autosave must not turn a preview choice into a write.
        await io.checkpoint(io.content(), true);
        paused = true;
        await io.restore(content);
        revision++;
        await io.checkpoint(content);
        status('已恢复到编辑区 · 自动保存暂停，请检查后保存', 'manual');
      });
    },
  };
}
