// Layout only: preserve the translated sentence content and native result state.
export function splitUpdateResult(value) {
  const end = value.search(/[。！？]|[.!?](?=\s|$)/u);
  return end < 0 ? {title:value, detail:''} : {title:value.slice(0,end+1),detail:value.slice(end+1).trim()};
}
