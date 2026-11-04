import {message} from './i18n.js';

export function documentRevealLabelKey(platform = globalThis.navigator?.userAgentData?.platform || globalThis.navigator?.platform || '') {
  if (/mac|iphone|ipad|ipod/i.test(platform)) return 'resources.show_in_finder';
  if (/win/i.test(platform)) return 'native.show_in_explorer';
  return 'main.show_in_file_manager';
}

// Both native File and the filename menu use this window-scoped IPC. No path
// comes from the renderer, and opening a folder never saves or edits the buffer.
export function createDocumentReveal({invoke,status}) {
  return async () => {
    try { await invoke('reveal_document'); }
    catch (error) { status(message('main.could_not_show_the_file_in_the',{error}),'error'); }
  };
}
