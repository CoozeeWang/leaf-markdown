import { sourceMode } from './view-mode.js';
import {Decoration,ViewPlugin,WidgetType,keymap} from '@codemirror/view';
import {syntaxTree,codeFolding,foldedRanges,foldEffect,unfoldEffect,foldService,foldKeymap} from '@codemirror/language';
import {analyzeMarkdown} from './markdown-model.js';

const structures=new WeakMap();
function structure(state) {
 const tree=syntaxTree(state),cached=structures.get(state.doc);if(cached?.tree===tree)return cached.value;
 const doc=state.doc, headings=analyzeMarkdown(doc.toString()).headings, items=[];
 syntaxTree(state).iterate({enter(ref){
  if(ref.name!=='ListItem')return;
  const node=ref.node;let depth=1;
  for(let p=node.parent;p;p=p.parent)if(p.name==='ListItem')depth++;
  const line=doc.lineAt(node.from),mark=/^\s*(?:[-+*]|\d+[.)])\s+/.exec(line.text);
  if(mark)items.push({from:line.from,to:node.to,depth,mark:mark[0],ordered:/\d/.test(mark[0])});
 }});
 const folds=new Map();
 headings.forEach((h,i)=>{const from=doc.lineAt(h.from).to, next=headings.slice(i+1).find(n=>n.level<=h.level),to=next?next.from-1:doc.length;
  if(to>from&&doc.sliceString(from,to).trim())folds.set(h.from,{from,to});});
 items.forEach(item=>{const from=doc.lineAt(item.from).to;if(item.to>from)folds.set(item.from,{from,to:item.to});});
 const value={headings,items,folds};structures.set(doc,{tree,value});return value;
}
class Toggle extends WidgetType {
 constructor(range,closed,level=0,label=''){super();Object.assign(this,{range,closed,level,label});}
 eq(b){return JSON.stringify(this)===JSON.stringify(b);}
 toDOM(view){
  const b=document.createElement(this.range?'button':'span');b.className=this.level?'leaf-list-marker':'leaf-heading-fold';
  b.textContent=this.level?(this.label||['●','○','■','□','–'][Math.min(this.level-1,4)]):(this.closed?'▸':'▾');
  // Shape carries the hierarchy; small glyphs must retain full contrast.
  if(this.level&&!this.label)b.style.fontSize='12px';
  if(!this.level)b.innerHTML=`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="${this.closed?'m9 6 6 6-6 6':'m6 9 6 6 6-6'}"/></svg>`;
  if(this.range){b.type='button';b.setAttribute('aria-label',`${this.closed?'展开':'收起'}${this.level?'列表':'标题'}`);b.setAttribute('aria-expanded',String(!this.closed));
   b.onmousedown=e=>e.preventDefault();b.onclick=e=>{e.preventDefault();view.dispatch({effects:(this.closed?unfoldEffect:foldEffect).of(this.range)});};}
  return b;
 }
 ignoreEvent(){return true;}
}
function decorations(view){
 if(view.state.field(sourceMode,false))return Decoration.none;
 const {state}=view,doc=state.doc,{headings,items,folds}=structure(state),ranges=[],closed=new Set();
 foldedRanges(state).between(0,doc.length,from=>closed.add(from));
 const visible=pos=>view.visibleRanges.some(r=>pos>=r.from&&pos<=r.to);
 for(const h of headings){const range=folds.get(h.from);if(range&&visible(h.from))ranges.push(Decoration.widget({widget:new Toggle(range,closed.has(range.from)),side:-1}).range(h.from));}
 const lines=new Map();
 for(const item of items)for(let n=doc.lineAt(item.from).number;n<=doc.lineAt(item.to).number;n++)lines.set(n,item);
 for(const [n,item] of lines){const line=doc.line(n);if(!visible(line.from)||!line.text.trim())continue;
  const guides=Array.from({length:item.depth-1},()=>`linear-gradient(var(--line),var(--line))`).join(',');
  const positions=Array.from({length:item.depth-1},(_,i)=>`calc(var(--editor-font-size) * ${1+i*2}) 0`).join(',');
  ranges.push(Decoration.line({attributes:{class:'cm-leaf-nested-list',style:`padding-left:calc(var(--editor-font-size) * ${item.depth*2});text-indent:0;${guides?`background-image:${guides};background-position:${positions};background-size:1px 100%;background-repeat:no-repeat;`:''}`}}).range(line.from));
  if(line.from===item.from){const range=folds.get(item.from);ranges.push(Decoration.replace({widget:new Toggle(range,range&&closed.has(range.from),item.depth,item.ordered?item.mark.trim():'')}).range(line.from,line.from+item.mark.length));}
  else {const spaces=/^\s+/.exec(line.text)?.[0];if(spaces)ranges.push(Decoration.replace({}).range(line.from,line.from+spaces.length));}
 }
 return Decoration.set(ranges,true);
}
export const outlineFolding=[codeFolding(),foldService.of((state,start)=>structure(state).folds.get(start)||null),keymap.of(foldKeymap),
 ViewPlugin.fromClass(class {constructor(view){this.decorations=decorations(view);}update(u){this.decorations=decorations(u.view);}}, {decorations:v=>v.decorations})];

export function readingFolding(root){
 const make=(label,action)=>{const b=document.createElement('button');b.className='leaf-reading-fold';b.innerHTML='<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';b.setAttribute('aria-label',`收起${label}`);b.setAttribute('aria-expanded','true');b.onclick=()=>{const open=b.getAttribute('aria-expanded')==='true';b.setAttribute('aria-expanded',String(!open));b.setAttribute('aria-label',`${open?'展开':'收起'}${label}`);action(open);};return b;};
 for(const li of root.querySelectorAll('li')){const children=[...li.children].filter(e=>e.matches('ul,ol'));if(children.length)li.prepend(make('列表',closed=>children.forEach(e=>e.hidden=closed)));}
 const headings=[...root.children].filter(e=>/^H[1-6]$/.test(e.tagName)&&!e.classList.contains('leaf-file-name-title'));
 for(const h of headings){const children=[];for(let e=h.nextElementSibling;e&&(!/^H[1-6]$/.test(e.tagName)||e.tagName>h.tagName);e=e.nextElementSibling)children.push(e);
  if(children.length)h.prepend(make('标题',closed=>{for(const e of children){const count=Number(e.dataset.foldCount||0)+(closed?1:-1);e.dataset.foldCount=count;e.hidden=count>0;}}));}
}
