import { StateEffect } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { isolateHistory } from '@codemirror/commands';
import { safeTarget, markdownLink, setResourceReader, refreshImages } from './resources.js';
import { htmlToMarkdown } from './html-markdown.js';
import { renderPrintDocument } from './print-document.js';
import './writing.css';
import { shortcutText } from './platform-shortcuts.js';

export function setupWriting({ editor, desktop, invoke, save, choose, serialized, editable, status, icon, }) {
  const view = editor.view, bookmarks = new Set();
  view.dispatch({ effects: StateEffect.appendConfig.of(EditorView.updateListener.of(update => {
    if (update.docChanged) for (const b of bookmarks) { b.from=update.changes.mapPos(b.from,1); b.to=update.changes.mapPos(b.to,-1); if(b.to<b.from)b.to=b.from; }
  })) });
  if (desktop) setResourceReader(relative => invoke('read_resource', { relative }));
  const remember = range => { const selection=range||view.state.selection.main; const b={from:selection.from,to:selection.to}; bookmarks.add(b); return b; };
  function insert(text, b) {
    view.dispatch({changes:{from:b.from,to:b.to,insert:text},selection:{anchor:b.from+text.length},userEvent:'input',annotations:isolateHistory.of('full')}); view.focus();
  }
  function currentLink() {
    let node=null;
    for(const bias of [1,-1]) {
      let candidate=syntaxTree(view.state).resolveInner(view.state.selection.main.head,bias);
      while(candidate && !['Link','Image'].includes(candidate.name))candidate=candidate.parent;
      if(candidate){node=candidate;break;}
    }
    if(!node)return null;
    const url=node.getChild('URL'); if(!url)return null;
    const raw=view.state.doc.sliceString(node.from,node.to); const image=node.name==='Image';
    return {urlFrom:url.from,urlTo:url.to,from:node.from,to:node.to,image,label:raw.slice(image?2:1,raw.indexOf(']')),target:view.state.doc.sliceString(url.from,url.to)};
  }
  function editLink() {
    if (!editable()) return;
    const existing=currentLink();
    if(existing){
      view.dispatch({selection:{anchor:existing.urlFrom,head:existing.urlTo},scrollIntoView:true});
      view.focus();return;
    }
    const range=view.state.selection.main, selected=view.state.doc.sliceString(range.from,range.to);
    const text=markdownLink(selected||'链接文字','链接地址',false);
    const address=text.lastIndexOf('链接地址');
    const from=selected?range.from+address:range.from+1;
    const to=selected?from+4:from+'链接文字'.length;
    view.dispatch({changes:{from:range.from,to:range.to,insert:text},selection:{anchor:from,head:to},scrollIntoView:true,userEvent:'input',annotations:isolateHistory.of('full')});
    view.focus();
  }
  async function attachments(files, image=true, point=null) {
    if (!editable()) return;
    if (!desktop) {status('本地附件导入请使用 Leaf 桌面版','error');return;}
    if(point){const pos=view.posAtCoords({x:point.x/devicePixelRatio,y:point.y/devicePixelRatio});if(pos!==null)view.dispatch({selection:{anchor:pos}});}
    const b=remember();
    try {
      if(!files){const paths=await choose(image);if(!paths)return;files=Array.isArray(paths)?paths:[paths];}
      if(!files.length)return;
      if(!await save())return;
      await serialized(async()=>{
        const links=[];
        for(const file of files){
          const name=typeof file==='string'?file.split(/[\\/]/).pop():file.name||'screenshot.png';
          const source=typeof file==='string'?{source:file}:{data:Array.from(new Uint8Array(await file.arrayBuffer()))};
          const relative=await invoke('import_attachment',{name,...source});
          const isImage=/\.(png|jpe?g|gif|webp|bmp)$/i.test(name);
          links.push(markdownLink(isImage?name.replace(/\.[^.]+$/,''):name,encodeURI(relative),isImage));
        }
        const before=view.state.doc.sliceString(0,b.from), after=view.state.doc.sliceString(b.to);
        const prefix=before&&!before.endsWith('\n\n')?(before.endsWith('\n')?'\n':'\n\n'):'';
        const suffix=after&&!after.startsWith('\n\n')?(after.startsWith('\n')?'\n':'\n\n'):'';
        insert(prefix+links.join('\n\n')+suffix,b); refreshImages();
      });
    } catch(error){status(`附件导入失败：${error.message||error}`,'error');}
    finally{bookmarks.delete(b);}
  }
  const toolbar=document.querySelector('.format-toolbar');
  for(const [id,label,glyph,action] of [['imageInsert','插入图片','image',()=>attachments(null,true)],['attachmentInsert','插入附件','attach',()=>attachments(null,false)],['linkInsert','插入或编辑链接','link',()=>editLink()],['richCopy','复制为富文本','copy',()=>copyRich()],['plainPaste','粘贴为纯文本','paste',()=>pastePlain()]]){
    const button=document.createElement('button');button.id=id;button.type='button';button.setAttribute('aria-label',label);button.dataset.tooltip=label;button.innerHTML=icon(glyph);button.onclick=action;button.onmousedown=e=>e.preventDefault();
    // Clipboard commands remain in command search and the native Edit menu.
    if (id === 'plainPaste') continue;
    toolbar.insertBefore(button, toolbar.querySelector(id === 'richCopy' ? '.toolbar-spacer' : '#calloutButton'));
  }
  document.querySelector('#richCopy').dataset.tooltip = shortcutText('复制为富文本  ⇧⌘C');
  document.addEventListener('keydown',event=>{
    if(event.isComposing||!(event.metaKey||event.ctrlKey)||document.querySelector('.leaf-writing-backdrop,.recovery-dialog'))return;
    if(event.target.closest?.('input,textarea'))return;
    if(!event.shiftKey&&!event.altKey&&event.key.toLowerCase()==='t'){event.preventDefault();event.stopPropagation();void pastePlain();return;}
    if(event.key.toLowerCase()==='k'&&!event.shiftKey){event.preventDefault();event.stopPropagation();editLink();}
    if(event.shiftKey&&event.key.toLowerCase()==='c'){event.preventDefault();void copyRich();}
  },true);
  view.dom.addEventListener('paste',event=>{
    if(event.target.closest('input,textarea')||!editable())return;
    const files=[...event.clipboardData.files];
    if(files.length){event.preventDefault();event.stopImmediatePropagation();void attachments(files);return;}
    const html=event.clipboardData.getData('text/html');
    if(html){event.preventDefault();event.stopImmediatePropagation();const b=remember();try{insert(htmlToMarkdown(html),b);}finally{bookmarks.delete(b);}}
  },true);
  async function pastePlain(){
    if(!editable())return;
    const b=remember();
    try{insert(await navigator.clipboard.readText(),b);}catch(error){status(`粘贴失败：${error.message||error}`,'error');}finally{bookmarks.delete(b);}
  }
  async function copyRich(){
    try{const range=view.state.selection.main;const source=range.empty?editor.getValue():view.state.doc.sliceString(range.from,range.to);const root=document.createElement('div');renderPrintDocument(root,source,{fallbackTitle:false});root.querySelectorAll('.leaf-image').forEach(n=>n.replaceWith(document.createTextNode(n.querySelector('img')?.alt||'')));
      await navigator.clipboard.write([new ClipboardItem({'text/html':new Blob([root.innerHTML],{type:'text/html'}),'text/plain':new Blob([source],{type:'text/plain'})})]);status('已复制为富文本','saved');
    }catch(error){status(`复制失败：${error.message||error}`,'error');}
  }
  document.addEventListener('mousedown',event=>{
    const link=event.target.closest?.('[data-leaf-link]');if(!link||!(event.metaKey||event.ctrlKey))return;
    event.preventDefault();event.stopImmediatePropagation();void openTarget(link.dataset.leafLink);
  },true);
  document.addEventListener('click',event=>{
    const link=event.target.closest?.('[data-leaf-link]');if(!link)return;
    event.preventDefault();
    if(link.closest('.reading-document'))void openTarget(link.dataset.leafLink);
  });
  async function openTarget(raw){
    try{const target=safeTarget(raw);if(!target)throw new Error('不支持此链接');
      if(target.startsWith('#')){const name=decodeURIComponent(target.slice(1));const headings=editor.view.state.doc.toString().split('\n');const slug=s=>s.toLowerCase().replace(/[^\p{L}\p{N}_ -]/gu,'').trim().replace(/ +/g,'-');const line=headings.findIndex(l=>/^#{1,6}\s/.test(l)&&(slug(l.replace(/^#+\s*/,''))===name||l.replace(/^#+\s*/,'')===name));if(line>=0){document.dispatchEvent(new CustomEvent('leaf-heading-link',{detail:line+1}));}else throw new Error('未找到文内标题');return;}
      if(desktop)await invoke('open_link',{target:/^https?:|^mailto:/i.test(target)?target:decodeURIComponent(target)});else if(/^https?:|^mailto:/i.test(target))window.open(target,'_blank','noopener,noreferrer');else throw new Error('相对文件链接请使用桌面版');
    }catch(error){status(`链接打开失败：${error.message||error}`,'error');}
  }
  return {attachments,editLink,copyRich,pastePlain};
}
