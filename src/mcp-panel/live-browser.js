// The native /reader route sets a short-lived HttpOnly, SameSite cookie after
// exchanging its one-use launch ticket. This module never sees a bearer.
export function createLiveBrowser({render,invalidate}){
 let binding=null,closed=false,task_id;
 async function request(action){const response=await fetch('/reader-api',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action}),credentials:'same-origin',cache:'no-store'});if(!response.ok)throw new Error('reader_unavailable');return response.json();}
 async function refresh(){if(closed)return;try{const value=await request('snapshot');binding=value.binding;task_id=value.task?.task_id;render(value);}catch{closed=true;binding=null;invalidate('disconnected');}}
 return {connect:refresh,refresh,bindingTask:id=>task_id=id,async stop(){if(closed||!binding||!task_id)return;try{await request('stop');await refresh();}catch{closed=true;invalidate('disconnected');}},close(){closed=true;binding=null;}};
}
