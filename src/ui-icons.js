// Series-wide UI glyphs. Product-specific editor symbols remain in main.js.
export const uiIconPaths = {
  outline: '<path d="M4 5h16M4 12h3m4 0h9M4 19h3m4 0h9"/>',
  notes: '<path d="M4 11h8M4 15h13M4 19h13"/><path d="M17 5.4 19 4.1V10"/>',
  open: '<path d="M3 7V6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v1"/><path d="M3.5 9h17l-2.4 8.5a2 2 0 0 1-1.9 1.5H5.8a2 2 0 0 1-1.9-1.5Z"/>',
  history: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
  // Save keeps the disk: a tray with an arrow pointed either way makes both
  // controls read as the same action, and export is the one that needs the
  // tray. Export sends the file out of the tray.
  save: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z"/><path d="M17 21v-8H7v8"/><path d="M7 3v5h8"/>',
  export: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 8l5-5 5 5M12 3v12"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  trash: '<path d="M3 6h18M9 6V4h6v2M5 6l1 14h12l1-14M10 10v6M14 10v6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  up: '<path d="M12 19V5m-6 6 6-6 6 6"/>',
  down: '<path d="M12 5v14m-6-6 6 6 6-6"/>',
  selectAll: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 4H6a2 2 0 0 0-2 2v10M11 14l2 2 4-4"/>',
  // U-turn arrows: the head sits on the flat leg, the tail curls back around a
  // semicircle, so both share one baseline inside the 24 box.
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10a5 5 0 0 1 0 10h-3"/>',
  redo: '<path d="m15 14 5-5-5-5"/><path d="M20 9H10a5 5 0 0 0 0 10h3"/>',
  // Text lines with a raised numeral, the shape a footnote makes on a page.
  footnote: '<path d="M4 11h8M4 15h13M4 19h13"/><path d="M17 5.4 19 4.1V10"/>',
  // One eye for the group of switches that decide what the document shows:
  // the glyph names the category, and every entry behind it is on or off.
  eye: '<path d="M2.6 12S6.2 5.6 12 5.6 21.4 12 21.4 12 17.8 18.4 12 18.4 2.6 12 2.6 12Z"/><circle cx="12" cy="12" r="3.1"/>',
};
export function uiIcon(name, size = 18) {
  return `<svg class="ui-icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${uiIconPaths[name]}</svg>`;
}
