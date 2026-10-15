import {AppBridge,PostMessageTransport} from '@modelcontextprotocol/ext-apps/app-bridge';
import {listAiComments} from '../src/ai-comment-operations.js';
export async function setupHost(html){
 const source='---\ntitle: "Reader"\n---\n\n# Synthetic 😀é\n\n{==**anchor**==}{>>range note<<} end{>>point note<<}.\n\n%%hidden note%%\n\n| A | B |\n| --- | --- |\n| one | two |\n\nCitation[^1]\n\n[^1]: Footnote **body**\n\n{--old--}{++new++}\n\n<script>alert(1)</script>\n\n![image](https://untrusted.invalid/image.png)';
 const binding={document_id:'synthetic-document',session_id:'synthetic-session',authorization_epoch:4};
 window.readerValue=revision=>{const content=revision===1?source:source.replace('one','updated');return {binding,task:window.readerStopped?null:{task_id:'synthetic-task'},snapshot:{content,revision,name:'Synthetic.md',line_ending:'\r\n',saved:false,range:{from:0,to:content.length}},comments:listAiComments(content,{...binding,revision,source_fingerprint:'synthetic-source-fingerprint',scope:{from:0,to:content.length}}).comments};};
 window.readerCurrent=window.readerValue(1);window.readerCalls=[];window.readerDenied=false;
 const iframe=document.createElement('iframe');iframe.id='panel';iframe.style.cssText='border:0;width:100%;height:900px';iframe.srcdoc=html;
 const loaded=new Promise(resolve=>iframe.onload=resolve);document.getElementById('host').append(iframe);
 const host=new AppBridge(null,{name:'Synthetic browser host',version:'1.0'},{serverTools:{}},{hostContext:{theme:'light',locale:'en'}});
 host.oncalltool=async({name,arguments:args})=>{window.readerCalls.push({name,args});if(window.readerDenied)return {content:[],structuredContent:{error:'not_authorized'},isError:true};if(name==='stop_edit'){window.readerStopped=true;window.readerCurrent={...window.readerCurrent,task:null};return {content:[],structuredContent:{state:'finished'}};}return {content:[],structuredContent:window.readerCurrent};};
 const initialized=new Promise(resolve=>host.oninitialized=resolve);
 await host.connect(new PostMessageTransport(iframe.contentWindow,iframe.contentWindow));await loaded;await initialized;
 await host.sendToolInput({arguments:binding});window.readerHost=host;return binding;
}
