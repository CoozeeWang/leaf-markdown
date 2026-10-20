import {message} from './i18n.js';

// Both native File and the filename menu use this window-scoped IPC. No path
// comes from the renderer, and opening a folder never saves or edits the buffer.
export function createDocumentReveal({invoke,status}) {
  return async () => {
    try { await invoke('reveal_document'); }
    catch (error) { status(message('main.could_not_show_the_file_in_the',{error}),'error'); }
  };
}
