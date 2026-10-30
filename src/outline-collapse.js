import {StateField,StateEffect} from '@codemirror/state';
import {invertedEffects} from '@codemirror/commands';
export const setOutlineCollapsed=StateEffect.define({map:(value,changes)=>new Set([...value].map(p=>changes.mapPos(p,1)))});
export const outlineCollapsed=StateField.define({
  create:()=>new Set(),
  update(value,tr){
    let next=tr.docChanged?new Set([...value].map(p=>tr.changes.mapPos(p,1))):value;
    for(const e of tr.effects)if(e.is(setOutlineCollapsed))next=new Set(e.value);
    return next;
  }
});
export const outlineCollapseHistory=invertedEffects.of(tr=>tr.effects.some(e=>e.is(setOutlineCollapsed))
  ?[setOutlineCollapsed.of(tr.startState.field(outlineCollapsed))]:[]);
