import { Direction, RectangleMarker, layer } from '@codemirror/view';

// CodeMirror derives the continuation edges from the first rendered .cm-line.
// In live preview that may be an indented list/quote, unrelated to the selection.
// Retain its bidi-aware endpoint geometry, correcting only open continuation edges.
export const leafSelection = layer({
  above: false,
  class: 'leaf-selectionLayer',
  markers(view) {
    const content = view.contentDOM.getBoundingClientRect();
    const scroll = view.scrollDOM.getBoundingClientRect();
    const baseLeft = (view.textDirection === Direction.LTR ? scroll.left : scroll.right - view.scrollDOM.clientWidth * view.scaleX) - view.scrollDOM.scrollLeft * view.scaleX;
    const baseTop = scroll.top - view.scrollDOM.scrollTop * view.scaleY;
    const first = view.contentDOM.querySelector('.cm-line');
    const style = first && getComputedStyle(first);
    const borrowedLeft = content.left + (style ? parseInt(style.paddingLeft) + Math.min(0, parseInt(style.textIndent)) : 0) - baseLeft;
    const borrowedRight = content.right - (style ? parseInt(style.paddingRight) : 0) - baseLeft;
    const padding = parseFloat(getComputedStyle(view.dom).getPropertyValue('--leaf-selection-inset'));
    const left = content.left + padding * view.scaleX - baseLeft;
    const right = content.right - padding * view.scaleX - baseLeft;
    const markers = [];
    for (const range of view.state.selection.ranges) {
      if (range.empty) continue;
      const start = view.coordsAtPos(range.from, 1);
      const end = view.coordsAtPos(range.to, -1);
      for (const marker of RectangleMarker.forRange(view, 'cm-selectionBackground', range)) {
        const top = marker.top + baseTop, bottom = top + marker.height;
        let x = marker.left, edge = x + marker.width;
        // The first/last visual row contains real selection endpoints; never
        // expand those into unselected characters, even if coordinates coincide.
        const afterStart = !start || top >= start.bottom - .5;
        const beforeEnd = !end || bottom <= end.top + .5;
        if (Math.abs(x - borrowedLeft) < .5 && (view.textDirection === Direction.LTR ? afterStart : beforeEnd)) x = left;
        if (Math.abs(edge - borrowedRight) < .5 && (view.textDirection === Direction.LTR ? beforeEnd : afterStart)) edge = right;
        markers.push(new RectangleMarker(marker.className, x, marker.top, Math.max(0, edge - x), marker.height));
      }
    }
    return markers;
  },
  update: update => update.docChanged || update.selectionSet || update.viewportChanged || update.geometryChanged,
});
