// Structural edits keep existing cell Markdown and the table's newline style.
export function tableOperation(block, axis, index, remove = false) {
  const rows = block.rows.map(row => Array.from({length:block.columns}, (_,c)=>row.cells[c]?.raw ?? ''));
  const align = [...block.align];
  if (axis === 'row') {
    if (index < 1 || index > rows.length || (remove && index >= rows.length)) return null;
    rows.splice(index, remove ? 1 : 0, ...(!remove ? [Array(block.columns).fill('')] : []));
  } else {
    if (index < 0 || index > block.columns || (remove && (block.columns === 1 || index >= block.columns))) return null;
    rows.forEach(row=>row.splice(index, remove ? 1 : 0, ...(!remove ? [''] : [])));
    align.splice(index, remove ? 1 : 0, ...(!remove ? ['left'] : []));
  }
  const lines = rows.map(row=>`| ${row.join(' | ')} |`);
  lines.splice(1,0,`| ${align.map(a=>a==='right'?'---:':a==='center'?':---:':'---').join(' | ')} |`);
  return lines.join(block.raw.includes('\r\n')?'\r\n':'\n');
}

export function tableShortcut(event) {
  const mac = /mac|iphone|ipad/i.test(globalThis.navigator?.platform || '');
  if (!(mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey) || !event.altKey || event.shiftKey || event.isComposing) return null;
  return {ArrowLeft:['col',0],ArrowRight:['col',1],ArrowUp:['row',0],ArrowDown:['row',1]}[event.key] || null;
}
