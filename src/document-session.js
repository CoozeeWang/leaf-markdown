import { errorCode, copyKeys, message as translatedMessage } from './i18n.js';
import {rewriteResourcePaths} from './resource-paths.js';
// Native I/O is injected so delayed writes, conflicts and recovery can be
// exercised without a WebView or a user's files.
export function createDocumentSession(io) {
  let path = null, disk = null, ready = false, revision = 0, paused = false;
  let pollFailure = null;
  const unavailable = error => ['NA0024','NA0025','NA0038'].some(id => errorCode(error)?.code === copyKeys[id]) || /\b(?:ENOENT|os error 2)\b|no such file or directory|the system cannot find the file specified|无法确认当前文件的位置|原文件在原位置找不到/i.test(String(error));
  let queue = Promise.resolve();
  const serialize = action => {
    const result = queue.then(action);
    queue = result.catch(() => {});
    return result;
  };
  const status = (text, kind = 'error', options) => io.status(io.localizedMessages ? text : String(text), kind, options);
  const follow = observation => {
    if (observation.path === path) return;
    const previous = path;
    path = observation.path;
    pollFailure = null;
    io.followed?.(disk, path, previous, observation.movedImages ?? []);
  };
  return {
    get path() { return path; },
    get paused() { return paused; },
    get ready() { return ready; },
    edited() { revision++; },
    async initialize(source, content) {
      path = source; disk = content;
      pollFailure = null;
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
        let locationCheckFailed = false;
        try {
          if (path && !as && io.observe) {
            try { follow(await io.observe()); }
            catch (error) { locationCheckFailed = true; throw error; }
          }
          let target = path, expected = disk;
          if (!target || as) {
            target = await io.select(path);
            if (!target) return false;
            expected = await io.readTarget(target);
          }
          let content = io.content();
          await io.checkpoint(content);
          status(translatedMessage("document_session.saving"), 'pending');
          const result = await io.write(target, content, expected);
          const cleanupWarning = result && typeof result === 'object' ? result.warning : result;
          if (result && typeof result === 'object') {
            content = result.content;
            const latest = rewriteResourcePaths(io.content(), result.mappings);
            if (latest !== io.content()) io.restore(latest);
          }
          path = target; disk = content; paused = false; pollFailure = null;
          io.saved(content, target);
          status(cleanupWarning || (io.content() === content ? translatedMessage("document_session.saved") : translatedMessage("document_session.waiting_to_autosave")), cleanupWarning ? 'error' : io.content() === content ? 'saved' : 'pending', { announce: manual });
          return true;
        } catch (error) {
          status(locationCheckFailed || unavailable(error)
            ? translatedMessage("document_session.the_original_file_is_unavailable_your_changes")
            : translatedMessage("document_session.your_changes_have_not_been_saved_try", {"error": error}),
          'error', locationCheckFailed || unavailable(error) ? { actions: io.unavailableActions?.() } : undefined);
          return false;
        }
      });
    },
    relocate() {
      return serialize(async () => {
        if (!ready || !path || !io.selectExisting || !io.relocate) return false;
        try {
          await io.checkpoint(io.content());
          const selected = await io.selectExisting();
          if (!selected) return false;
          const observation = await io.relocate(selected, disk);
          follow(observation);
          pollFailure = null;
          status(io.content() === disk ? translatedMessage("document_session.original_file_located") : translatedMessage("document_session.original_file_located_changes_not_saved"), 'saved');
          return true;
        } catch (error) {
          status(translatedMessage("document_session.could_not_locate_the_original_file_your", {"error": error}), 'error', { actions: io.unavailableActions?.() });
          return false;
        }
      });
    },
    rename(name) {
      return serialize(async () => {
        if(!ready || !path) throw new Error(translatedMessage("document_session.save_the_document_before_renaming_it"));
        if (io.observe) follow(await io.observe());
        await io.checkpoint(io.content());
        const result=await io.rename(path,name,disk,io.content());
        const target=typeof result==='string'?result:result.path;
        if (typeof result==='object') {
          disk=result.content;
          const latest=rewriteResourcePaths(io.content(),result.mappings);
          if(latest!==io.content())io.restore(latest);
        }
        const previous=path;path=target;pollFailure=null;
        io.renamed(disk,target,previous);
        status(io.content()===disk?translatedMessage("document_session.renamed"):translatedMessage("document_session.renamed_waiting_to_save"),io.content()===disk?'saved':'pending');
        return target;
      });
    },
    poll() {
      return serialize(async () => {
        if (!ready || !path || paused) return;
        const at = revision;
        try {
          const observation = io.observe ? await io.observe() : { path, content: await io.read(path) };
          follow(observation);
          const current = observation.content;
          const recovered = pollFailure !== null;
          pollFailure = null;
          if (current === disk) {
            if (recovered) status(translatedMessage("document_session.reading_the_original_file_resumed"), 'saved', { announce: false });
            return;
          }
          if (revision !== at || io.content() !== disk) {
            status(translatedMessage("document_session.another_app_has_changed_this_file_use")); return;
          }
          await io.load(current, path);
          disk = current;
          status(translatedMessage("document_session.external_changes_loaded"), 'saved');
        } catch (error) {
          const detail = String(error);
          if (detail === pollFailure) return;
          pollFailure = detail;
          const missing = error?.code === 'ENOENT' || unavailable(detail);
          status(missing
            ? translatedMessage("document_session.the_original_file_was_not_found_at")
            : translatedMessage("document_session.could_not_read_the_file_your_edits", {"detail": detail}),
          'error', { actions: io.unavailableActions?.() });
        }
      });
    },
    restore(content) {
      return serialize(async () => {
        if (!ready) throw new Error(translatedMessage("document_session.open_or_create_a_document_first"));
        // Protect the current buffer before replacing it; keep the disk
        // baseline intact. Autosave must not turn a preview choice into a write.
        await io.checkpoint(io.content(), true);
        paused = true;
        await io.restore(content);
        revision++;
        await io.checkpoint(content);
        status(translatedMessage("document_session.restored_to_the_editor_autosave_paused_review"), 'manual');
      });
    },
  };
}
