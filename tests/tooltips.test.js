import test from 'node:test';
import assert from 'node:assert/strict';
import {tooltipPosition,tooltipDelays} from '../src/tooltips.js';
const viewport={left:0,top:0,right:500,bottom:300};
test('control and operation timings are explicit',()=>assert.deepEqual(tooltipDelays,{control:600,operation:800}));
test('operation hint uses the right side, flips left, then clamps at viewport edges',()=>{
 assert.deepEqual(tooltipPosition({left:50,right:100,top:40,bottom:60,width:50},{width:120,height:30},viewport,true),{left:108,top:40});
 assert.deepEqual(tooltipPosition({left:400,right:450,top:280,bottom:300,width:50},{width:120,height:50},viewport,true),{left:272,top:242});
 assert.deepEqual(tooltipPosition({left:4,right:490,top:0,bottom:20,width:486},{width:484,height:50},viewport,true),{left:8,top:28});
});
test('control hint centers below or flips above and respects zoomed viewport offsets',()=>{
 assert.deepEqual(tooltipPosition({left:0,right:30,top:270,bottom:300,width:30},{width:100,height:30},viewport),{left:8,top:232});
 assert.deepEqual(tooltipPosition({left:102,right:142,top:204,bottom:224,width:40},{width:100,height:40},{left:100,top:200,right:350,bottom:400}),{left:108,top:232});
});
