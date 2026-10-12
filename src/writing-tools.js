import { t, setAttr, message as translatedMessage } from './i18n.js';
import { StateEffect } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { isolateHistory } from '@codemirror/commands';
import { safeTarget, markdownLink, setResourceReader, setResourceRevealer, refreshImages } from './resources.js';
import { bodyStart } from './markdown-model.js';
import { fileDropTarget } from './file-drop.js';
import { attachmentInsertion } from './attachment-insertion.js';
import { htmlToMarkdown } from './html-markdown.js';
import { renderPrintDocument } from './print-document.js';
import './writing.css';
import { shortcutText } from './platform-shortcuts.js';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { localImagePaths, materializeImageReferences, rewriteResourcePaths } from './resource-paths.js';

const IMAGE_CLIPBOARD_TYPE = 'application/x-leaf-markdown-images';

export function setupWriting({ editor, desktop, invoke, save, choose, serialized, editable, status, icon, }) {
  const view = editor.view, bookmarks = new Set();
  let insertionFollow=null;
  view.dispatch({ effects: StateEffect.appendConfig.of(EditorView.updateListener.of(update => {
    if (update.docChanged) for (const b of bookmarks) { b.from=update.changes.mapPos(b.from,1); b.to=update.changes.mapPos(b.to,-1); if(b.to<b.from)b.to=b.from; }
    if(insertionFollow&&(update.docChanged||update.selectionSet||(update.focusChanged&&!view.hasFocus)))insertionFollow.stop();
  })) });
  if (desktop) {
    setResourceReader(relative => invoke('read_resource', { relative }));
    setResourceRevealer(relative => invoke('reveal_resource', { relative }));
  }
  const remember = range => { const selection=range||view.state.selection.main; const b={from:selection.from,to:selection.to}; bookmarks.add(b); return b; };
  function insert(text, b, anchor=b.from+text.length, scrollIntoView=false) {
    view.dispatch({changes:{from:b.from,to:b.to,insert:text},selection:{anchor},scrollIntoView,userEvent:'input',annotations:isolateHistory.of('full')}); view.focus();
  }
  function followImageLoad(anchor, resources) {
    insertionFollow?.stop();
    if(!resources.length)return;
    const pending=new Set(resources),controller=new AbortController();
    const follow={stop:()=>{controller.abort();clearTimeout(timeout);if(insertionFollow===follow)insertionFollow=null;}};
    const timeout=setTimeout(follow.stop,16000);
    insertionFollow=follow;
    // A decoded image can grow after the insertion transaction was scrolled.
    // Follow only that insertion, and stop as soon as the user takes control.
    for(const event of ['wheel','pointerdown','keydown'])document.addEventListener(event,follow.stop,{capture:true,signal:controller.signal});
    window.addEventListener('blur',follow.stop,{signal:controller.signal});
    view.dom.addEventListener('leaf-image-ready',event=>{
      if(!pending.delete(event.target.dataset?.resource))return;
      const selection=view.state.selection.main;
      if(view.hasFocus&&selection.empty&&selection.head===anchor)view.dispatch({effects:EditorView.scrollIntoView(anchor,{y:'nearest'})});
      if(!pending.size)follow.stop();
    },{signal:controller.signal});
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
    const text=markdownLink(selected||t("writing_tools.link_text"),t("writing_tools.link_address"),false);
    const address=text.lastIndexOf(t("writing_tools.link_address"));
    const from=selected?range.from+address:range.from+1;
    const to=selected?from+4:from+t("writing_tools.link_text").length;
    view.dispatch({changes:{from:range.from,to:range.to,insert:text},selection:{anchor:from,head:to},scrollIntoView:true,userEvent:'input',annotations:isolateHistory.of('full')});
    view.focus();
  }
  async function attachments(files, image=true, point=null) {
    if (!editable()) return;
    if (!desktop) {status(translatedMessage("writing_tools.use_the_leaf_desktop_app_to_import"),'error');return;}
    // File imports also protect YAML/source mode and pending bookmarks: neither
    // a source caret nor a selection of the properties may replace the block.
    const target=point?fileDropTarget(view,point):null;
    if(point&&!target){status(translatedMessage("writing_tools.drop_attachments_in_the_body_editor"),'info');return;}
    if(target?.protected)status(translatedMessage("writing_tools.this_content_cannot_be_inserted_into_document"),'saved');
    const b=remember(target?{from:target.pos,to:target.pos}:null);
    try {
      if(!files){const paths=await choose(image);if(!paths)return;files=Array.isArray(paths)?paths:[paths];}
      if(!files.length)return;
      if(!await save())return;
      await serialized(async()=>{
        const links=[],images=[];
        for(const file of files){
          const name=typeof file==='string'?file.split(/[\\/]/).pop():file.name||'screenshot.png';
          const source=typeof file==='string'?{source:file}:{data:Array.from(new Uint8Array(await file.arrayBuffer()))};
          const relative=await invoke('import_attachment',{name,...source});
          // HEIC and HEIF are iPhone photos and only some platforms decode them;
          // SVG is text with no magic bytes. Both arrive as pictures everywhere
          // they are supported, and fall back to the placeholder where they are not.
          const isImage=/\.(png|jpe?g|gif|webp|bmp|heic|heif|svg)$/i.test(name);
          const target=encodeURI(relative).replace(/[()]/g,c=>c==='('?'%28':'%29');
          links.push(markdownLink(isImage?name.replace(/\.[^.]+$/,''):name,target,isImage));
          if(isImage)images.push(target);
        }
        const floor=bodyStart(view.state.doc.toString());
        b.from=Math.max(b.from,floor); b.to=Math.max(b.to,b.from);
        const {text,anchor}=attachmentInsertion(view.state.doc.toString(),b,links);
        insert(text,b,anchor,true); followImageLoad(anchor,images); refreshImages();
      });
    } catch(error){status(translatedMessage("writing_tools.could_not_import_attachments", {"error": error.message||error}),'error');}
    finally{bookmarks.delete(b);}
  }
  const toolbar=document.querySelector('.format-toolbar');
  for(const [id,label,glyph,action] of [['imageInsert',"writing_tools.insert_image",'image',()=>attachments(null,true)],['attachmentInsert',"writing_tools.insert_attachment",'attach',()=>attachments(null,false)],['linkInsert',"writing_tools.insert_or_edit_link",'link',()=>editLink()],['richCopy',"writing_tools.copy_as_rich_text",'copy',()=>copyRich()],['plainPaste',"writing_tools.paste_as_plain_text",'paste',()=>pastePlain()]]){
    const button=document.createElement('button');button.id=id;button.type='button';setAttr(button,'aria-label',()=>t(label));setAttr(button,'data-tooltip',()=>t(label));button.innerHTML=icon(glyph);button.onclick=action;button.onmousedown=e=>e.preventDefault();
    // Clipboard commands remain in command search and the native Edit menu.
    if (id === 'plainPaste') continue;
    toolbar.insertBefore(button, toolbar.querySelector(id === 'richCopy' ? '.toolbar-spacer' : '#calloutButton'));
  }
  setAttr(document.querySelector('#richCopy'), 'data-tooltip', () => shortcutText(t("writing_tools.copy_as_rich_text_c")));
  document.addEventListener('keydown',event=>{
    if(event.isComposing||!(event.metaKey||event.ctrlKey)||document.querySelector('.leaf-writing-backdrop,.recovery-dialog'))return;
    if(event.target.closest?.('input,textarea,.leaf-note-editor'))return;
    if(!event.shiftKey&&!event.altKey&&event.key.toLowerCase()==='t'){event.preventDefault();event.stopPropagation();void pastePlain();return;}
    if(event.key.toLowerCase()==='k'&&!event.shiftKey){event.preventDefault();event.stopPropagation();editLink();}
    if(event.shiftKey&&event.key.toLowerCase()==='c'){event.preventDefault();void copyRich();}
  },true);
  view.dom.addEventListener('copy',event=>{
    if (!desktop || !event.clipboardData || view.state.selection.ranges.length !== 1) return;
    const range=view.state.selection.main;
    if (range.empty) return;
    const content=materializeImageReferences(view.state.doc.sliceString(range.from,range.to),view.state.doc.toString());
    if (!localImagePaths(content).length) return;
    event.clipboardData.setData('text/plain',content);
    event.clipboardData.setData(IMAGE_CLIPBOARD_TYPE,JSON.stringify({sourceLabel:getCurrentWindow().label,content}));
    event.preventDefault();event.stopImmediatePropagation();
  },true);
  view.dom.addEventListener('paste',event=>{
    if(event.target.closest('input,textarea')||!editable())return;
    let copied=null;
    try { copied=JSON.parse(event.clipboardData.getData(IMAGE_CLIPBOARD_TYPE)); } catch { /* A normal clipboard has no Leaf image metadata. */ }
    if (desktop && copied && typeof copied.sourceLabel === 'string' && copied.content === event.clipboardData.getData('text/plain')) {
      const references=localImagePaths(copied.content);
      if (references.length) {
        event.preventDefault();event.stopImmediatePropagation();
        const b=remember();
        void (async()=>{
          try {
            if (!await save()) return;
            await serialized(async()=>{
              const mappings=await invoke('copy_pasted_images',{sourceLabel:copied.sourceLabel,references});
              const text=rewriteResourcePaths(copied.content,mappings);
              const floor=bodyStart(view.state.doc.toString());
              b.from=Math.max(b.from,floor);b.to=Math.max(b.to,b.from);
              insert(text,b);refreshImages();
            });
          } catch(error) { status(translatedMessage("writing_tools.could_not_paste_the_image", {"error": error.message||error}),'error'); }
          finally { bookmarks.delete(b); }
        })();
        return;
      }
    }
    const files=[...event.clipboardData.files];
    if(files.length){event.preventDefault();event.stopImmediatePropagation();void attachments(files);return;}
    const html=event.clipboardData.getData('text/html');
    if(html){event.preventDefault();event.stopImmediatePropagation();const b=remember();try{insert(htmlToMarkdown(html),b);}finally{bookmarks.delete(b);}}
  },true);
  async function pastePlain(){
    if(!editable())return;
    const b=remember();
    try{insert(await navigator.clipboard.readText(),b);}catch(error){status(translatedMessage("writing_tools.could_not_paste", {"error": error.message||error}),'error');}finally{bookmarks.delete(b);}
  }
  async function copyRich(){
    try{const range=view.state.selection.main;const source=range.empty?editor.getValue():view.state.doc.sliceString(range.from,range.to);const root=document.createElement('div');renderPrintDocument(root,source,{fallbackTitle:false});root.querySelectorAll('.leaf-image').forEach(n=>n.replaceWith(document.createTextNode(n.querySelector('img')?.alt||'')));
      // Targets without HTML support still receive the rendered words, not
      // YAML and Markdown syntax. innerText preserves paragraph/table breaks.
      root.style.cssText='position:fixed;left:-10000px;top:0;opacity:0;pointer-events:none;width:800px';
      root.setAttribute('aria-hidden','true');document.body.append(root);
      let plain;try{plain=root.innerText;}finally{root.remove();}
      await navigator.clipboard.write([new ClipboardItem({'text/html':new Blob([root.innerHTML],{type:'text/html'}),'text/plain':new Blob([plain],{type:'text/plain'})})]);status(translatedMessage("writing_tools.copied_as_rich_text"),'saved');
    }catch(error){status(translatedMessage("writing_tools.could_not_copy", {"error": error.message||error}),'error');}
  }
  document.addEventListener('mousedown',event=>{
    const link=event.target.closest?.('[data-leaf-link]');if(!link||!(event.metaKey||event.ctrlKey))return;
    // In the editor the modified image gesture belongs to image movement.
    // Reading-view links retain their existing open behavior.
    if(editable() && view.dom.contains(event.target) && event.target.matches?.('.leaf-image img'))return;
    event.preventDefault();event.stopImmediatePropagation();void openTarget(link.dataset.leafLink);
  },true);
  document.addEventListener('click',event=>{
    const link=event.target.closest?.('[data-leaf-link]');if(!link)return;
    event.preventDefault();
    if(link.closest('.reading-document'))void openTarget(link.dataset.leafLink);
  });
  async function openTarget(raw){
    try{const target=safeTarget(raw);if(!target)throw new Error(t("writing_tools.this_link_is_not_supported"));
      if(target.startsWith('#')){const name=decodeURIComponent(target.slice(1));const headings=editor.view.state.doc.toString().split('\n');const slug=s=>s.toLowerCase().replace(/[^\p{L}\p{N}_ -]/gu,'').trim().replace(/ +/g,'-');const line=headings.findIndex(l=>/^#{1,6}\s/.test(l)&&(slug(l.replace(/^#+\s*/,''))===name||l.replace(/^#+\s*/,'')===name));if(line>=0){document.dispatchEvent(new CustomEvent('leaf-heading-link',{detail:line+1}));}else throw new Error(t("writing_tools.heading_not_found_in_this_document"));return;}
      if(desktop)await invoke('open_link',{target:/^https?:|^mailto:/i.test(target)?target:decodeURIComponent(target)});else if(/^https?:|^mailto:/i.test(target))window.open(target,'_blank','noopener,noreferrer');else throw new Error(t("writing_tools.open_relative_file_links_in_the_desktop"));
    }catch(error){status(translatedMessage("writing_tools.could_not_open_the_link", {"error": error.message||error}),'error');}
  }
  return {attachments,editLink,copyRich,pastePlain};
}
