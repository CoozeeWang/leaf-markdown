// The pinned Wry 0.55 backend forwards AppKit/GTK logical coordinates unchanged
// (despite Tauri's PhysicalPosition type). Only WebView2 supplies physical
// client pixels. Keep that native boundary out of editor/insertion code and
// recheck these contracts when upgrading the desktop runtime.
export function nativeDropPoint(point, platform=globalThis.navigator?.userAgentData?.platform || globalThis.navigator?.platform || '', pixelRatio=globalThis.devicePixelRatio || 1) {
  if(!point)return null;
  const scale=/^win/i.test(platform) ? pixelRatio : 1;
  return {x:point.x/scale,y:point.y/scale};
}
