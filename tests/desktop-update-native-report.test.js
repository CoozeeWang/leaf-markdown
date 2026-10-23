import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareCases,verifyPrepareReport} from '../scripts/desktop-update-package-fixture.mjs';
// These are source-level report-validator examples, never native test evidence.
const effects=()=>({destroy:0,exit:0,install:0,restart:0,leaf_close:0,harness_exit:0,accepted_exit_requested:0,exit_events:0,rejected_exit_requested:0});
function sample(){
 const final={...effects(),exit:1,accepted_exit_requested:1,exit_events:1};
 const r={pass:true,layer:'actual-tauri',tracer:'updates-prepare',manual_driver:false,production_listeners:true,syntheticChooser:true,noOSDialogClaim:true,executed:prepareCases.length,side_effects:final,
 scenarios:prepareCases.map(name=>({name,pass:true,side_effects:effects(),details:{}}))};
 const details=name=>r.scenarios.find(row=>row.name===name).details;
 Object.assign(r.scenarios.at(-1),{side_effects:final,details:{actual_run_event_exit:true,permit_consumptions:1,verified_package_consumed:true,live_intent_required:true,actual_updater_confirmation:true,production_prepare_loop:true,production_participant_listeners:true,synthetic_native_ready_channel:true,installer_invocations:0,restart_invocations:0}});
 Object.assign(details('download_edits_new_document'),{download_state_fixture:true,network_download_exercised:false});
 Object.assign(details('reload_mid_saved_abort'),{actual_webview_reloaded_at_sealed:true,all_files_durable_before_reload:true,fresh_webview_global:true,native_ready_generation_changed:true,mcp_registration_and_ordinary_editing_restored:true,latest_durable_content_retained:true,dirty_unstaged_reload_claim:false});
 details('live_ime_draft_abort').real_ime_acceptance=false;details('timeout_and_loss').real_process_crash=false;
 return r;
}
test('prepare report guard accepts only the complete ordered contract',()=>{
 const valid=sample();assert.equal(verifyPrepareReport(valid),valid);
 for(const mutate of [r=>r.pass=false,r=>r.executed=0,r=>r.scenarios.pop(),r=>r.scenarios[1]=r.scenarios[0],r=>r.scenarios.reverse(),r=>r.manual_driver=true,r=>r.production_listeners=false,r=>r.tracer='updates-coordinator']){
  const r=sample();mutate(r);assert.throws(()=>verifyPrepareReport(r));
 }
});
test('prepare report guard rejects precommit effects and repeated or unproven final exits',()=>{
 for(const key of Object.keys(effects())){const r=sample();r.scenarios[0].side_effects[key]=1;assert.throws(()=>verifyPrepareReport(r));}
 for(const mutate of [r=>r.side_effects.exit=2,r=>r.scenarios.at(-1).details.verified_package_consumed=false,r=>r.scenarios.at(-1).details.actual_run_event_exit=false,r=>r.scenarios.at(-1).details.installer_invocations=1]){
  const r=sample();mutate(r);assert.throws(()=>verifyPrepareReport(r));
 }
});
test('prepare report guard keeps staged network, synthetic input and actual reload evidence distinct',()=>{
 for(const [name,key,value]of [['download_edits_new_document','network_download_exercised',true],['reload_mid_saved_abort','actual_webview_reloaded_at_sealed',false],['reload_mid_saved_abort','mcp_registration_and_ordinary_editing_restored',false],['live_ime_draft_abort','real_ime_acceptance',true],['timeout_and_loss','real_process_crash',true]]){
  const r=sample();r.scenarios.find(row=>row.name===name).details[key]=value;assert.throws(()=>verifyPrepareReport(r));
 }
});
