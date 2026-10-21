// Shared patch validation; independent of structure-specific planners.
export function planSourceChanges(source,changes,scope,{keepUnchanged=false}={}) {
  if(typeof source!=='string'||!Array.isArray(changes)||changes.length>256||!scope||!Number.isInteger(scope.from)||!Number.isInteger(scope.to)||scope.from<0||scope.to>source.length||scope.from>scope.to)throw new Error('invalid_batch');
  const boundaries=new Set([0,source.length]);
  for(const item of new Intl.Segmenter('und',{granularity:'grapheme'}).segment(source))boundaries.add(item.index);
  const planned=changes.map(change=>{
    if(!change||typeof change!=='object')throw new Error('invalid_patch');
    const {from,to,insert,expected}=change;
    if(!Number.isInteger(from)||!Number.isInteger(to)||from<scope.from||to>scope.to||from>to||to>source.length||typeof insert!=='string'||typeof expected!=='string'||!boundaries.has(from)||!boundaries.has(to)||source.slice(from,to)!==expected)throw new Error('invalid_patch');
    return {from,to,insert};
  }).sort((a,b)=>a.from-b.from||a.to-b.to);
  for(let i=1;i<planned.length;i++)if(planned[i].from<planned[i-1].to||planned[i].from===planned[i-1].from)throw new Error('overlapping_patches');
  return keepUnchanged?planned:planned.filter(change=>source.slice(change.from,change.to)!==change.insert);
}
