// Native WebKit textarea carets can include the previous line's leading.
// Keep the real control (selection, IME and accessibility) and measure only a
// visual caret from an inert mirror. Neither text nor line spacing is changed.
export function textareaCaret(input) {
  const doc = input.ownerDocument, win = doc.defaultView;
  const mirror = doc.createElement('div'), caret = doc.createElement('span');
  mirror.className = 'leaf-callout-caret-mirror';
  caret.className = 'leaf-callout-caret';
  for (const node of [mirror, caret]) { node.setAttribute('aria-hidden', 'true'); node.inert = true; }
  caret.hidden = true;
  input.parentElement.append(mirror, caret);
  let frame = 0, composing = false, active = false, windowActive = true, lastPosition = '';
  const properties = ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontStretch',
    'fontVariant', 'fontKerning', 'fontFeatureSettings', 'fontVariationSettings',
    'lineHeight', 'letterSpacing', 'wordSpacing', 'textIndent', 'textAlign',
    'textTransform', 'direction', 'tabSize', 'wordBreak', 'overflowWrap'];
  const hide = () => { caret.hidden = true; input.classList.remove('leaf-measured-caret'); };
  const update = () => {
    frame = 0;
    if (!active || !windowActive || !input.isConnected || doc.activeElement !== input || composing ||
        input.selectionStart !== input.selectionEnd || input.disabled || input.readOnly) { hide(); return; }
    const style = win.getComputedStyle(input), box = input.getBoundingClientRect();
    if (!box.width || !box.height) { hide(); return; }
    for (const property of properties) mirror.style[property] = style[property];
    mirror.style.width = `${input.clientWidth}px`;
    mirror.style.padding = style.padding;
    // A trailing sentinel supplies a measurable final empty line, without
    // inserting nodes at the caret or breaking shaping/ligatures before it.
    mirror.textContent = input.value + '\u200b';
    const range = doc.createRange();
    range.setStart(mirror.firstChild, input.selectionStart); range.collapse(true);
    let rect = range.getClientRects()[0];
    // Chromium can return no collapsed range on an empty mixed-script line.
    // Only in that case use an inline zero-width marker at the same offset.
    if (!rect?.height) {
      const marker = doc.createElement('span'); marker.textContent = '\u200b';
      mirror.replaceChildren(doc.createTextNode(input.value.slice(0, input.selectionStart)), marker,
        doc.createTextNode(input.value.slice(input.selectionStart) + '\u200b'));
      rect = marker.getBoundingClientRect();
    }
    const origin = mirror.getBoundingClientRect();
    if (!rect || !rect.height) { hide(); return; }
    // Leaf's body zoom scales the editor; Range rectangles are screen pixels,
    // while the positioned caret must use the control's unscaled CSS pixels.
    const scale = origin.width / input.clientWidth;
    if (!Number.isFinite(scale) || scale <= 0) { hide(); return; }
    const height = rect.height / scale;
    const left = input.offsetLeft + input.clientLeft + (rect.left - origin.left) / scale - input.scrollLeft;
    const top = input.offsetTop + input.clientTop + (rect.top - origin.top) / scale - input.scrollTop;
    if (left < input.offsetLeft || left > input.offsetLeft + input.clientWidth ||
        top + height < input.offsetTop || top > input.offsetTop + input.clientHeight) { hide(); return; }
    caret.style.left = `${left}px`; caret.style.top = `${top}px`; caret.style.height = `${height}px`;
    caret.hidden = false; input.classList.add('leaf-measured-caret');
    const position = `${left}:${top}:${height}:${input.selectionStart}:${input.value}`;
    if (position !== lastPosition) { for (const animation of caret.getAnimations()) animation.currentTime = 0; lastPosition = position; }
  };
  const schedule = () => { if (active && !frame) frame = win.requestAnimationFrame(update); };
  const observer = new win.ResizeObserver(schedule);
  const windowBlur = () => { windowActive = false; hide(); };
  const windowFocus = () => { windowActive = true; schedule(); };
  const focus = () => {
    active = true; windowActive = true; observer.observe(input);
    win.addEventListener('blur', windowBlur); win.addEventListener('focus', windowFocus);
    doc.addEventListener('selectionchange', schedule);
    doc.fonts?.addEventListener('loadingdone', schedule);
    schedule();
  };
  const blur = () => {
    active = false; composing = false; observer.disconnect();
    win.removeEventListener('blur', windowBlur); win.removeEventListener('focus', windowFocus);
    doc.removeEventListener('selectionchange', schedule);
    doc.fonts?.removeEventListener('loadingdone', schedule);
    if (frame) win.cancelAnimationFrame(frame); frame = 0;
    mirror.textContent = ''; hide();
  };
  const startComposition = () => { composing = true; hide(); };
  const endComposition = () => {
    composing = false;
    // Do not leave the native caret visible until the next animation frame.
    // Its independent blink can otherwise flash once after composition ends.
    if (frame) win.cancelAnimationFrame(frame);
    update();
  };
  const events = {focus, blur, input:schedule, select:schedule, selectionchange:schedule,
    keyup:schedule, pointerup:schedule, scroll:schedule,
    compositionstart:startComposition, compositionupdate:startComposition, compositionend:endComposition};
  for (const [name, listener] of Object.entries(events)) input.addEventListener(name, listener);
  return {update:schedule, destroy() {
    blur(); for (const [name, listener] of Object.entries(events)) input.removeEventListener(name, listener);
    mirror.remove(); caret.remove();
  }};
}
