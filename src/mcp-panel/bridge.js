import {App} from '@modelcontextprotocol/ext-apps';
import {createReaderState} from './state.js';

export function createReaderBridge({render,invalidate,context=()=>{},transport}) {
  const app=new App({name:'Leaf Reader',version:'1.0.0'},{},{autoResize:!transport,strict:true});
  let binding=null,closed=false,task_id;const state=createReaderState();
  const unwrap=result=>{if(result?.isError)throw new Error('reader_unavailable');return result?.structuredContent;};
  const accept=value=>{if(!value?.binding||!value.snapshot){end('empty');return;}if(!closed&&state.accept(value)){binding=value.binding;task_id=value.task?.task_id;render(value);}};
  // Register before connecting: some hosts send tool input immediately after init.
  app.ontoolinput=({arguments:args})=>{if(!closed&&args?.session_id){binding=args;void refresh();}};
  app.ontoolresult=result=>{try{accept(unwrap(result));}catch{end('invalid');}};
  app.onhostcontextchanged=params=>context(params);
  app.ontoolcancelled=()=>end('invalid');
  app.onteardown=async()=>{end('invalid');return {};};
  app.onclose=()=>end('disconnected');
  function end(reason){closed=true;binding=null;state.close();invalidate(reason);}
  async function refresh() {
    if(!binding||closed)return;
    try {accept(unwrap(await app.callServerTool({name:'reader_snapshot',arguments:binding},{timeout:5000})));}
    catch {end('disconnected');}
  }
  return {app,refresh,async connect(){await app.connect(transport);if(!app.getHostCapabilities()?.serverTools){end('unsupported');return;}context(app.getHostContext()??{});},async stop(){if(!binding||closed||!task_id)return;try{await app.callServerTool({name:'stop_edit',arguments:{...binding,task_id}},{timeout:5000});await refresh();}catch{end('disconnected');}},close(){end('invalid');void app.close();}};
}
