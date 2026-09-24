// Bounded content weights keep identifier columns compact without allowing a
// single long paragraph to starve all the other columns.
export function tableColumnWidths(block) {
  const weights = Array.from({ length: block.columns }, (_, col) => {
    const lengths = block.rows.map(row => [...(row.cells[col]?.value ?? '')]
      .reduce((n, char) => n + (char.charCodeAt(0) > 255 ? 2 : 1), 0));
    const max = Math.max(0, ...lengths);
    const average = lengths.reduce((a, b) => a + b, 0) / Math.max(1, lengths.length);
    return 4 + Math.sqrt(Math.min(180, max * .65 + average * .35));
  });
  const total = weights.reduce((a, b) => a + b, 0);
  return weights.map(w => 100 * w / total);
}

export function applyTableWidths(table, block) {
  table.style.setProperty('--table-min-width', block.columns >= 4 ? `${block.columns * 7}em` : '0px');
  let group = table.querySelector('colgroup');
  if (!group) { group = document.createElement('colgroup'); table.prepend(group); }
  group.replaceChildren(...tableColumnWidths(block).map(width => {
    const col = document.createElement('col'); col.style.width = `${width}%`; return col;
  }));
}
