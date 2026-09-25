// 天友智配One V3 · 一体化规划编排器
import { loadRouteBase, normalizeRoute, canUseRoute, redisGet } from '../_data.js';
import { extractStores } from './extract.js';
import { matchStores } from './match.js';
import { dedupeStores } from './dedupe.js';
import { routePlan } from './route-plan.js';
import { savePlan } from './save.js';
function dateValue(v){const s=String(v||'').trim();return /^\d{4}-\d{2}-\d{2}$/.test(s)?s:'';}
export async function runPlan({env,session,route,date,vehicle,totalWeight,text,taskId}){
 route=normalizeRoute(route);
 if(!route)throw Object.assign(new Error('未指定配送线路'),{code:'ROUTE_REQUIRED',stage:'matching'});
 if(!canUseRoute(session?.user||session,route))throw Object.assign(new Error('无权使用该线路'),{code:'ROUTE_FORBIDDEN',stage:'matching'});
 const base=await loadRouteBase(env,route);
 if(!base)throw Object.assign(new Error('线路基准库不存在'),{code:'BASE_MISSING',stage:'matching'});
 const learning=await redisGet(env,'route:'+encodeURIComponent(route).replace(/%/g,'_')+':learning').catch(()=>null);
 const candidates=extractStores(text);
 if(!candidates.length)throw Object.assign(new Error('未提取到有效门店'),{code:'EXTRACT_FAILED',stage:'extracting'});
 const matched=matchStores(candidates,base,learning);
 const deduped=dedupeStores(matched.matched,candidates,matched.pendingStores);
 const planned=routePlan(deduped.stores,deduped.pendingStores);
 const result={taskId,route,date:dateValue(date)||new Date().toISOString().slice(0,10),vehicle:String(vehicle??'').trim(),totalWeight:String(totalWeight??'').trim(),stores:planned.plannedStores,pendingStores:planned.pendingStores,newStores:planned.pendingStores,rawCount:deduped.rawCount,totalStores:deduped.totalStores,corrections:planned.plannedStores.filter(x=>x.corrected).length,merged:deduped.merged,routeOrder:planned.routeOrder,createdAt:new Date().toISOString()};
 await savePlan(env,result);
 return result;
}