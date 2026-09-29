// Synthetic desktop IPC fixture; this does not replace native platform tests.
export async function desktopImageFixture(page, source, {platform}={}) {
  await page.addInitScript(({doc,platform}) => {
    if(platform){
      Object.defineProperty(navigator,'platform',{configurable:true,value:platform});
      Object.defineProperty(navigator,'userAgentData',{configurable:true,value:{platform}});
    }
    const callbacks=new Map(),listeners=new Map();let id=0;
    window.isTauri=true;window.imports=[];window.writes=[];window.disk=doc;
    window.emitNative=(event,payload)=>callbacks.get(listeners.get(event))({event,payload});
    window.__TAURI_INTERNALS__={
      metadata:{currentWindow:{label:'document-image-test'},currentWebview:{label:'document-image-test'}},
      transformCallback:fn=>{callbacks.set(++id,fn);return id;},
      invoke:async(command,args)=>{
        if(command==='plugin:event|listen'){listeners.set(args.event,args.handler);return args.handler;}
        if(command==='initial_path')return '/fixture/images.md';
        if(command==='observe_document')return {path:'/fixture/images.md',content:disk};
        if(command==='read_document')return disk;
        if(command==='recovery_list'||command==='recent_list')return [];
        if(command==='recovery_retention')return 30;
        if(command==='plugin:dialog|open')return ['/fixture/toolbar.svg'];
        if(command==='import_attachment'){
          imports.push(args);
          if(window.delayImport)await new Promise(resolve=>window.finishImport=resolve);
          return 'assets/'+args.name;
        }
        if(command==='read_resource')return Array.from(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><rect width="120" height="80" fill="#607b68"/></svg>'));
        if(command==='write_document'){disk=args.content;writes.push(disk);return null;}
        return null;
      },
    };
  },{doc:source,platform});
  await page.goto('http://127.0.0.1:41732');
  await page.waitForFunction(()=>document.querySelector('#welcomeScreen')?.hidden);
  await page.evaluate(async()=>{
    const {EditorView}=await import('/node_modules/@codemirror/view/dist/index.js');
    window.v=EditorView.findFromDOM(document.querySelector('.cm-content'));
  });
}
