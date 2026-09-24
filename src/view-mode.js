import { StateEffect, StateField } from '@codemirror/state';
export const setSourceMode = StateEffect.define();
export const sourceMode = StateField.define({ create: () => false, update(value, tr) { for (const e of tr.effects) if (e.is(setSourceMode)) value = e.value; return value; } });
