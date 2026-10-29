import { safeAppLink } from './app-links.js';
import { safeLinkTarget } from './resources.js';
// Invoked only by explicit link gestures. Keeping this separate makes routing
// testable without launching applications or granting resource access.
export async function openResourceLink(raw, { desktop, invoke, openWeb }) {
  const target = safeLinkTarget(raw);
  if (!target || target.startsWith('#')) throw new Error('writing_tools.this_link_is_not_supported');
  const web = /^https?:|^mailto:/i.test(target);
  if (desktop) return invoke('open_link', { target: web || safeAppLink(target) ? target : decodeURIComponent(target) });
  if (web) return openWeb(target, '_blank', 'noopener,noreferrer');
  throw new Error('writing_tools.open_relative_file_links_in_the_desktop');
}
