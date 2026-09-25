// 天友智配One V3 · 一体化规划核心
import { loadRouteBase, normalizeRoute, canUseRoute, redisGet } from '../_data.js';
import { set, v3Key } from './_redis.js';

const SUMMARY = /^(总数量|总重量|总体积|合计|订单编号|运单编号|单号|ZW\w*)/i;
const ID = /^[A-Z]{1,4}\d{3,6}$/i;

function clean(v){ return String(v ?? '').replace(/[\u200b\ufeff]/g,'').replace(/\s+/g,' ').trim(); }
function key(v){ return clean(v).toLowerCase().replace(/[\s·•,，。.!！:：;；、_()（）\[\]{}【】'"“”‘’\-]/g,''); }
function joinWrapped(s){
  let out='', depth=0;
  for(const ch of String(s)){
    if('（(['.includes(ch)) depth++;
    if('）)]'.includes(ch)) depth=Math.max(0,depth-1);
    if(ch==='\n' && depth>0) continue;
    out+=ch;
  }
  return clean(out);
}
function validCandidate(s){
  s=clean(s);
  if(!s || s.length<3 || SUMMARY.test(s) || /^ZW[A-Z0-9-]+$/i.test(s) || ID.test(s)) return false;
  return /[\u4e00-\u9fff]/.test(s);
}
export function extractStores(text){
  let raw=String(text ?? '').replace(/\r/g,'').replace(/[\t]+/g,' ');
  raw=raw.replace(/总数量[：:]?.*$/gim,'').replace(/总重量[：:]?.*$/gim,'').replace(/总体积[：:]?.*$/gim,'');
  const arrowParts=raw.split(/\s*(?:->|→|➜|➔)\s*/).map(joinWrapped).filter(validCandidate);
  if(arrowParts.length){
    const result=[];
    for(const p of arrowParts) for(const x of p.split(/\n+/).map(joinWrapped)) if(validCandidate(x)) result.push(x);
    return result;
  }
  return raw.split(/\n+/).map(joinWrapped).filter(validCandidate);
}
function storeList(base){ return Array.isArray(base?.stores)?base.stores:Array.isArray(base?.data?.stores)?base.data.stores:Array.isArray(base)?base:[]; }
function storeName(s){ return clean(s?.name||s?.storeName||s?.title||s?.customerName||s?.['门店名称']); }
function aliases(learning){
  const m=new Map();
  for(const [a,r] of Object.entries(learning?.aliases||{})){ const id=String(r?.storeId||'').trim(); if(id) m.set(key(a),id); }
  return m;
}
function similarity(a,b){
  const x=key(a), y=key(b);
  if(!x||!y)return 0;
  if(x===y)return 1;
  if(x.includes(y)||y.includes(x))return Math.min(x.length,y.length)/Math.max(x.length,y.length)*0.96;
  let hit=0; for(const ch of new Set(x)) if(y.includes(ch)) hit++;
  return hit/Math.max(new Set(x).size,new Set(y).size,1);
}
function matchOne(name,stores,aliasMap){
  const aid=aliasMap.get(key(name));
  if(aid){
    const s=stores.find(x=>String(x?.storeId||'')===aid);
    if(s)return {store:s,confidence:1,corrected:storeName(s)!==name,via:'alias'};
  }
  let best=null;
  for(const s of stores){ const score=similarity(name,storeName(s)); if(!best||score>best.confidence) best={store:s,confidence:score}; }
  if(best&&best.confidence>=0.72)return {...best,corrected:storeName(best.store)!==name,via:'name'};
  return {store:null,confidence:best?.confidence||0};
}
export function planStores(candidates,base,learning){
  const stores=storeList(base), aliasMap=aliases(learning), seen=new Set(), matched=[], pending=[];
  for(const original of candidates){
    const m=matchOne(original,stores,aliasMap);
    if(!m.store){ const k=key(original); if(!pending.some(x=>key(x.name)===k)) pending.push({name:original}); continue; }
    const id=String(m.store.storeId||'').trim();
    if(!id||seen.has(id))continue;
    seen.add(id);
    matched.push({storeId:id,name:storeName(m.store)||original,originalName:original,routeOrder:Number(m.store.routeOrder??m.store.order??999999),corrected:Boolean(m.corrected),matchConfidence:m.confidence,matchVia:m.via,nav:m.store.nav||m.store.navigation||''});
  }
  matched.sort((a,b)=>a.routeOrder-b.routeOrder);
  return {stores:matched,pendingStores:pending,newStores:pending.slice(),corrections:matched.filter(x=>x.corrected).length,merged:Math.max(0,candidates.length-matched.length-pending.length),rawCount:candidates.length,totalStores:matched.length+pending.length};
}
function dateValue(v){ const s=String(v||'').trim(); return /^\d{4}-\d{2}-\d{2}$/.test(s)?s:''; }
export async function runPlan({env,session,route,date,vehicle,totalWeight,text,taskId}){
  route=normalizeRoute(route);
  if(!route)throw Object.assign(new Error('未指定配送线路'),{code:'ROUTE_REQUIRED',stage:'matching'});
  if(!canUseRoute(session?.user||session,route))throw Object.assign(new Error('无权使用该线路'),{code:'ROUTE_FORBIDDEN',stage:'matching'});
  const base=await loadRouteBase(env,route);
  if(!base)throw Object.assign(new Error('线路基准库不存在'),{code:'BASE_MISSING',stage:'matching'});
  const learning=await redisGet(env,'route:'+encodeURIComponent(route).replace(/%/g,'_')+':learning').catch(()=>null);
  const candidates=extractStores(text);
  if(!candidates.length)throw Object.assign(new Error('未提取到有效门店'),{code:'EXTRACT_FAILED',stage:'extracting'});
  const planned=planStores(candidates,base,learning);
  const cleanDate=dateValue(date)||new Date().toISOString().slice(0,10);
  const result={taskId,route,date:cleanDate,vehicle:clean(vehicle),totalWeight:String(totalWeight??'').trim(),...planned,createdAt:new Date().toISOString()};
  const orderKey=v3Key('route',route,'plan',cleanDate,taskId);
  await set(env,orderKey,result);
  await set(env,v3Key('route',route,'latest-plan'),result);
  return result;
}
