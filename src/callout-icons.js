// Phosphor Icons Fill (MIT); original SVGs and license are kept in assets/callouts.
import note from './assets/callouts/note.svg?raw';
import abstract from './assets/callouts/text-align-left.svg?raw';
import info from './assets/callouts/info.svg?raw';
import todo from './assets/callouts/list-checks.svg?raw';
import tip from './assets/callouts/lightbulb.svg?raw';
import success from './assets/callouts/check-circle.svg?raw';
import question from './assets/callouts/question.svg?raw';
import warning from './assets/callouts/warning.svg?raw';
import failure from './assets/callouts/x-circle.svg?raw';
import danger from './assets/callouts/warning-octagon.svg?raw';
import bug from './assets/callouts/bug.svg?raw';
import example from './assets/callouts/flask.svg?raw';
import quote from './assets/callouts/quotes.svg?raw';
const badges = { note, abstract, info, todo, tip, success, question, warning, failure, danger, bug, example, quote };
export function calloutBadge(type) {
  return (badges[type] || badges.note).replace('<svg ', '<svg class="leaf-callout-badge" aria-hidden="true" width="20" height="20" ');
}
