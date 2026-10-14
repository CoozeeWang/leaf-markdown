// The native /reader route sets a short-lived HttpOnly, SameSite cookie after
// exchanging its one-use launch ticket. This module never sees a bearer.
import {createReaderState} from './state.js';
export function createLiveBrowser({render,invalidate}){
 let binding=null,closed=false,task_id;const state=createReaderState();
 async function request(action){const response=await fetch('/reader-api',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action}),credentials:'same-origin',cache:'no-store'});if(!response.ok)throw new Error('reader_unavailable');return response.json();}
 async function refresh(){if(closed)return;try{const value=await request('snapshot');if(state.accept(value)){binding=value.binding;task_id=value.task?.task_id;render(value);}}catch{closed=true;binding=null;state.close();invalidate('disconnected');}}
 return {async connect(){try{const ticket=location.hash.slice(1);history.replaceState(null,'','/reader');if(ticket){const response=await fetch('/reader-auth',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ticket}),credentials:'same-origin',cache:'no-store'});if(!response.ok)throw new Error('invalid_ticket');}await refresh();}catch{closed=true;state.close();invalidate('invalid');}},refresh,async stop(){if(closed||!binding||!task_id)return;try{await request('stop');await refresh();}catch{closed=true;state.close();invalidate('disconnected');}},close(){closed=true;binding=null;state.close();}};
}
