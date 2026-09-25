// 天友智配One V3 · 统一显示统计口径
export function weightToTons(value){
  if(value===null||value===undefined||value==='')return 0;
  const s=String(value).trim().replace(/,/g,'');
  const m=s.match(/[0-9]+(?:\.[0-9]+)?/);
  if(!m)return 0;
  const n=Number(m[0]); if(!Number.isFinite(n))return 0;
  if(/kg|千克|公斤/i.test(s))return n/1000;
  if(/吨|\bt\b/i.test(s))return n;
  return n>=1000?n/1000:n;
}
export function roundTons(value){const n=Number(value)||0;return Math.round((n+Number.EPSILON)*100)/100;}
export function formatTons(value){const n=roundTons(weightToTons(value));return n>0?n.toFixed(2)+'t':'';}
export function waybillMetrics(rows){
  const list=Array.isArray(rows)?rows:[];
  const storeCount=list.reduce((sum,x)=>sum+(Number(x?.totalStores)||Number(x?.uniqueStoreCount)||Number(x?.count)||((Array.isArray(x?.stores)?x.stores.length:0))),0);
  const rawCount=list.reduce((sum,x)=>sum+(Number(x?.rawCount)||Number(x?.rawOrderCount)||0),0);
  const corrections=list.reduce((sum,x)=>sum+(Number(x?.corrections)||Number(x?.correctionDetails?.length)||0),0);
  const merged=list.reduce((sum,x)=>sum+(Number(x?.merged)||Number(x?.duplicateCount)||0),0);
  const pending=list.reduce((sum,x)=>sum+(Array.isArray(x?.pendingStores)?x.pendingStores.length:Number(x?.reviewCount)||0),0);
  const newStores=list.reduce((sum,x)=>sum+(Array.isArray(x?.newStores)?x.newStores.length:Number(x?.newStoreCount)||0),0);
  const totalWeight=roundTons(list.reduce((sum,x)=>sum+weightToTons(x?.totalWeight??x?.weight),0));
  return {waybillCount:list.length,storeCount,rawCount,corrections,merged,pending,newStores,totalWeight:totalWeight?totalWeight.toFixed(2)+'t':''};
}
