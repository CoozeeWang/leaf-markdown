// UI copy uses macOS modifier glyphs as canonical tokens; never transform
// document content. The actual editor bindings use CodeMirror's Mod modifier.
export function shortcutText(text, platform = globalThis.navigator?.userAgentData?.platform || globalThis.navigator?.platform || '') {
  if (/mac|iphone|ipad|ipod/i.test(platform)) return text.replace(/[⌘⌃⌥⇧]+/g, keys => [...'⌃⌥⇧⌘'].filter(key=>keys.includes(key)).join(''));
  return text.replace(/[⌘⌃⌥⇧]+/g, keys => {
    const parts=[];
    if(/[⌘⌃]/.test(keys))parts.push('Ctrl');
    if(keys.includes('⌥'))parts.push('Alt');
    if(keys.includes('⇧'))parts.push('Shift');
    return parts.join('+')+'+';
  });
}

const modifierPaths = {
  '⇧': 'M4 10 12 2l8 8h-5v11H9V10Z',
  '⌥': 'M3 5h5l8 14h5M14 5h7',
  '⌃': 'm5 14 7-7 7 7',
  '⌘': 'M8 8H5a3 3 0 1 1 3-3v14a3 3 0 1 1-3-3h14a3 3 0 1 1-3 3V5a3 3 0 1 1 3 3H8',
};
const modifierNames = {'⇧':'Shift','⌥':'Option','⌃':'Control','⌘':'Command'};

// Draw modifiers with consistent geometry instead of relying on font fallback.
// Input is UI copy only; use text nodes for all ordinary text.
export function renderShortcutText(container, text) {
  container.replaceChildren();
  let from = 0;
  for (const match of text.matchAll(/([⌃⌥⇧⌘]+)([A-Za-z0-9\\.,])/g)) {
    container.append(document.createTextNode(text.slice(from, match.index)));
    const group = document.createElement('span'); group.className = 'shortcut-keys';
    const keys = [...'⌃⌥⇧⌘'].filter(key=>match[1].includes(key));
    group.setAttribute('role','img');
    group.setAttribute('aria-label',[...keys.map(key=>modifierNames[key]),match[2]].join('+'));
    for (const key of keys) {
      const svg = document.createElementNS('http://www.w3.org/2000/svg','svg');
      svg.dataset.modifier = modifierNames[key];
      for (const [name,value] of Object.entries({viewBox:'0 0 24 24',width:'14',height:'14',fill:'none',stroke:'currentColor','stroke-width':'1.8','stroke-linecap':'round','stroke-linejoin':'round','aria-hidden':'true'})) svg.setAttribute(name,value);
      const path=document.createElementNS('http://www.w3.org/2000/svg','path'); path.setAttribute('d',modifierPaths[key]);svg.append(path);group.append(svg);
    }
    const key=document.createElement('span');key.textContent=match[2];key.setAttribute('aria-hidden','true');group.append(key);
    container.append(group);from=match.index+match[0].length;
  }
  container.append(document.createTextNode(text.slice(from)));
}
