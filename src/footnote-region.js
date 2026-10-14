import { EditorState, StateField, StateEffect, Transaction, ChangeSet } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, ViewPlugin } from '@codemirror/view';
import { undo, redo, isolateHistory } from '@codemirror/commands';
import { footnoteIndex } from './footnote-state.js';
import { displayNotes, indexFootnotes } from './footnotes.js';
import { sourceMode, setSourceMode } from './view-mode.js';
import { t, setText, setAttr } from './i18n.js';
import { collectFootnoteDefinitions, footnoteHiddenRanges, continueBodyPosition } from './footnote-region-model.js';

export const footnoteRegionEnabled = StateField.define({create:()=>true, update:value=>value});
const collectNotes = StateEffect.define();

export function continueFootnoteBody(view) {
  const at = continueBodyPosition(view.state.doc, view.state.field(footnoteIndex).definitions);
  view.dispatch({changes:{from:at,insert:'\n\n'},selection:{anchor:at?at+2:0},
    annotations:isolateHistory.of('full'),userEvent:'input.footnote-body',scrollIntoView:true});
  view.focus();
}

export function prepareBodyBeforeNotes(view) {
  if(view.state.field(sourceMode)||!view.state.selection.main.empty||view.state.selection.main.head!==0||view.state.field(footnoteIndex).definitions[0]?.lineFrom!==0)return false;
  view.dispatch({changes:{from:0,insert:'\n\n'},selection:{anchor:0},userEvent:'input.type',annotations:isolateHistory.of('before')});
  return true;
}

class FootnoteRegion extends WidgetType {
  constructor(rows, createEditor, applyBody) { super(); this.rows=rows; this.createEditor=createEditor; this.applyBody=applyBody; }
  eq(other) { return JSON.stringify(this.rows)===JSON.stringify(other.rows); }
  toDOM(view) {
    const root=document.createElement('section');root.className='leaf-footnote-region';
    root.setAttribute('contenteditable','false');setAttr(root,'aria-label',()=>t('print_document.footnotes'));
    const head=document.createElement('div');head.className='leaf-footnote-region-head';
    const title=document.createElement('span');setText(title,()=>t('print_document.footnotes'));
    const button=document.createElement('button');button.type='button';button.className='leaf-continue-body';
    setText(button,()=>t('editor.continue_body'));
    button.addEventListener('click',()=>continueFootnoteBody(view));
    head.append(title,button);root.append(head);root._notes=new Map();
    this.patch(root,view);return root;
  }
  updateDOM(root,view) { this.patch(root,view);return true; }
  patch(root,view) {
    const keep=new Set();
    for (const row of this.rows) {
      const key=JSON.stringify([row.label,row.ordinal??0]);
      keep.add(key);
      let card=root._notes.get(key);
      if (!card) {
        card=document.createElement('div');card.className='leaf-endnote';card.dataset.label=row.label;
        const number=document.createElement('span');number.className='leaf-endnote-number';
        const body=document.createElement('div');body.className='leaf-footnote-body';
        card.append(number,body);root._notes.set(key,card);root.append(card);
        card._editor=this.createEditor({parent:body,doc:row.body,multiline:true,
          label:t('main.content_of_footnote',{note:row.number??row.label}),
          onFocus:()=>view.dispatch({annotations:isolateHistory.of('full')}),
          onChange:(value,composing)=>{
            card._updating=true;
            try { this.applyBody(view,card._row.label,value,composing,card._row.ordinal??0,true); }
            finally { card._updating=false; }
          },
          onUndo:()=>undo(view),onRedo:()=>redo(view),onLeave:()=>view.focus(),
          onCompositionEnd:()=>queueMicrotask(()=>{
            if(view.dom.isConnected) view.dispatch({effects:collectNotes.of(null),userEvent:'input.type.compose'});
          })});
        card._noteEditor=card._editor;
      }
      card._row=row;
      card.firstChild.textContent=String(row.number??`[${row.label}]`);
      // Reuse active input DOM, including during Chinese composition. Never
      // replace a note editor because another part of the document changed.
      if (!card._updating && !card._editor.view.compositionStarted) card._editor.sync(row.body);
      const expected=root.children[this.rows.indexOf(row)+1];
      if(expected!==card)root.insertBefore(card,expected??null);
    }
    for(const [label,card] of root._notes) if(!keep.has(label)) {
      card._editor.destroy();card.remove();root._notes.delete(label);
    }
  }
  destroy(root) { for(const card of root._notes.values()) card._editor.destroy(); }
  ignoreEvent() { return true; }
}

// A collapsed main-document caret cannot edit an invisible definition. Full
// document selections and explicit note edits still use normal document history.
export const footnoteBoundaryGuard = EditorState.transactionFilter.of(tr=>{
  if(tr.startState.field(sourceMode) || !tr.startState.selection.main.empty || !tr.isUserEvent('delete'))return tr;
  const defs=tr.startState.field(footnoteIndex).definitions;
  let blocked=false;
  tr.changes.iterChangedRanges((from,to)=>{
    if(defs.some(def=>from<def.to && to>def.lineFrom || to===def.lineFrom && tr.startState.doc.lineAt(from).text.trim()))blocked=true;
  });
  return blocked?[]:tr;
});

export function footnoteRegion(createEditor, applyBody) {
  const build = state => {
    if(state.field(sourceMode)) return Decoration.none;
    const index=state.field(footnoteIndex);
    if(!index.definitions.length) return Decoration.none;
    const rows=displayNotes(index).list.filter(note=>index.notes.find(n=>n.id===note.label)?.def).map(note=>({label:note.label,number:note.number,body:note.body}));
    // Preserve unreferenced and duplicate definitions as separate editable rows;
    // duplicates keep their own body rather than overwriting the first one.
    for(const note of index.notes) if(note.def && !rows.some(row=>row.label===note.id))
      rows.push({label:note.id,number:null,body:note.def.body});
    const occurrences=new Map();
    for(const def of index.definitions) {
      const ordinal=occurrences.get(def.id)??0;occurrences.set(def.id,ordinal+1);
      if(ordinal) rows.push({label:def.id,number:null,body:def.body,ordinal});
    }
    const defs=index.definitions;
    const ranges=footnoteHiddenRanges(state.doc,defs).map(range=>Decoration.replace({block:true}).range(range.from,range.to));
    ranges.push(Decoration.widget({widget:new FootnoteRegion(rows,createEditor,applyBody),block:true,side:1}).range(state.doc.length));
    return Decoration.set(ranges,true);
  };
  const decorations=StateField.define({create:build,update:(value,tr)=>tr.docChanged||tr.effects.length?build(tr.state):value,
    provide:field=>[EditorView.decorations.from(field),EditorView.atomicRanges.of(view=>view.state.field(field))]});
  return [footnoteRegionEnabled,decorations,
    ViewPlugin.fromClass(class {
      constructor(view){this.view=view;this.revision=0;}
      update(update){
        const token=++this.revision,range=update.state.selection.main;
        if(this.highlighted&&(update.selectionSet||update.docChanged||update.state.field(sourceMode))) {
          const previous=this.highlighted;this.highlighted=null;
          queueMicrotask(()=>{if(previous.view.dom.isConnected)previous.highlightMatch(null);});
        }
        if(!update.selectionSet||update.docChanged||range.empty||update.state.field(sourceMode))return;
        const definitions=update.state.field(footnoteIndex).definitions;
        const def=definitions.find(def=>range.from>=def.bodyFrom&&range.to<=def.to);
        if(!def)return;
        const ordinal=definitions.filter(d=>d.id===def.id).indexOf(def);
        const offset=pos=>update.state.doc.sliceString(def.bodyFrom,pos).split('\n').map((line,i)=>i?line.replace(/^(?: {4}|\t)/,''):line).join('\n').length;
        const anchor=offset(range.anchor),head=offset(range.head);
        queueMicrotask(()=>{
          const view=this.view;if(!view.dom.isConnected||token!==this.revision)return;
          view.dispatch({effects:EditorView.scrollIntoView(view.state.doc.length,{y:'end'})});
          requestAnimationFrame(()=>{
            if(!view.dom.isConnected||view.state.field(sourceMode)||view.state.selection.main.anchor!==range.anchor||view.state.selection.main.head!==range.head)return;
            const card=[...view.dom.querySelectorAll('.leaf-endnote')].find(card=>card._row.label===def.id&&(card._row.ordinal??0)===ordinal);
            if(card){const child=card._editor;child.highlightMatch(Math.min(anchor,child.view.state.doc.length),Math.min(head,child.view.state.doc.length));this.highlighted=child;}
          });
        });
      }
    }),
    EditorState.transactionFilter.of(tr=>{
      const source=tr.effects.findLast(e=>e.is(setSourceMode))?.value??tr.startState.field(sourceMode);
      if(source||!tr.newSelection.main.empty)return tr;
      const defs=indexFootnotes(tr.newDoc.toString()).definitions;
      const at=tr.newSelection.main.head;
      if(!defs.some(def=>at>=def.lineFrom&&at<=def.to))return tr;
      const def=defs.find(def=>at>=def.lineFrom&&at<=def.to);
      const line=tr.newDoc.lineAt(def.lineFrom);
      const anchor=line.number>1?tr.newDoc.line(line.number-1).to:0;
      return [tr,{selection:{anchor},sequential:true}];
    }),
    // Layout follows actual edits, never loading, source mode, history or an IME
    // that still owns its text. The move and edit share one undo transaction.
    EditorState.transactionFilter.of(tr=>{
      if(tr.startState.field(sourceMode) || tr.isUserEvent('input.type.compose')&&!tr.effects.some(e=>e.is(collectNotes)) ||
        (!tr.docChanged&&!tr.effects.some(e=>e.is(collectNotes))) ||
        (!tr.isUserEvent('input')&&!tr.isUserEvent('delete')&&!tr.isUserEvent('move'))) return tr;
      const changes=collectFootnoteDefinitions(tr.newDoc.toString());
      return changes.length?[tr,{changes,selection:tr.newSelection.map(ChangeSet.of(changes,tr.newDoc.length),-1),sequential:true}]:tr;
    }),
    EditorView.domEventHandlers({compositionend(_event,view){queueMicrotask(()=>{
      if(view.dom.isConnected&&!view.compositionStarted) view.dispatch({effects:collectNotes.of(null),annotations:Transaction.userEvent.of('input.type.compose')});
    });return false;}}),
  ];
}
