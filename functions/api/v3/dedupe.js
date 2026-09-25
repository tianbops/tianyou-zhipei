// V3 · 去重
export function dedupeStores(matched,candidates,pendingStores){
 const seen=new Set(),stores=[];
 for(const s of matched||[]){if(!s?.storeId||seen.has(s.storeId))continue;seen.add(s.storeId);stores.push(s);}
 stores.sort((a,b)=>Number(a.routeOrder)-Number(b.routeOrder));
 return {stores,rawCount:(candidates||[]).length,totalStores:stores.length+(pendingStores||[]).length,merged:Math.max(0,(candidates||[]).length-stores.length-(pendingStores||[]).length)};
}
