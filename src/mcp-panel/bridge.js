import {App} from '@modelcontextprotocol/ext-apps';

export function createReaderBridge({render,invalidate,context=()=>{},transport}) {
  const app=new App({name:'Leaf Reader',version:'1.0.0'},{},{autoResize:!transport,strict:true});
  let binding=null,closed=false;
  const unwrap=result=>{if(result?.isError)throw new Error('reader_unavailable');return result?.structuredContent;};
  const accept=value=>{if(value?.binding&&!closed){binding=value.binding;render(value);}};
  // Register before connecting: some hosts send tool input immediately after init.
  app.ontoolinput=({arguments:args})=>{if(!closed&&args?.session_id){binding=args;void refresh();}};
  app.ontoolresult=result=>accept(unwrap(result));
  app.onhostcontextchanged=params=>context(params);
  app.ontoolcancelled=()=>end('invalid');
  app.onteardown=async()=>{end('invalid');return {};};
  app.onclose=()=>end('disconnected');
  function end(reason){closed=true;binding=null;invalidate(reason);}
  async function refresh() {
    if(!binding||closed)return;
    try {accept(unwrap(await app.callServerTool({name:'reader_snapshot',arguments:binding},{timeout:5000})));}
    catch {end('disconnected');}
  }
  return {app,refresh,bindingTask:task_id=>{if(binding)binding={...binding,task_id};},async connect(){await app.connect(transport);if(!app.getHostCapabilities()?.serverTools){end('unsupported');return;}context(app.getHostContext()??{});},async stop(){if(!binding||closed)return;try{const {task_id,...identity}=binding;await app.callServerTool({name:'stop_edit',arguments:{...identity,task_id}},{timeout:5000});await refresh();}catch{end('disconnected');}},close(){end('invalid');void app.close();}};
}
