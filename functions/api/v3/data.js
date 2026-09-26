// 智配One V3 · 业务数据边界
import { get as redisGet, set as redisSet, evalRedis, v3Key } from './_redis.js';
export { v3Key };
export function routeKey(route){return v3Key('route',normalizeRoute(route));}
export function userProfileKey(userId){return v3Key('user',String(userId||'').trim(),'profile');}
export async function getUserProfile(env,userId){const v=await redisGet(env,userProfileKey(userId));return v&&typeof v==='object'?v:null;}
export async function setUserProfile(env,userId,value){return redisSet(env,userProfileKey(userId),{...value,userId:String(userId||'').trim(),schemaVersion:3,updatedAt:new Date().toISOString()});}
export async function getRoute(env,route){const v=await redisGet(env,routeKey(route));return v&&v.id?{...v,id:normalizeRoute(v.id),name:v.name||normalizeRoute(v.id)}:null;}
export async function setRoute(env,route,value){return redisSet(env,routeKey(route),{...value,id:normalizeRoute(route),name:value?.name||normalizeRoute(route),schemaVersion:3});}
export function baseKey(route){return v3Key('route',normalizeRoute(route),'base');}
export function learningKey(route){return v3Key('route',normalizeRoute(route),'learning');}
export function planKey(route,date,taskId){return v3Key('route',normalizeRoute(route),'plan',date,taskId);}
export function latestPlanKey(route){return v3Key('route',normalizeRoute(route),'latest-plan');}
export function todayWaybillKey(route,date,taskId){return v3Key('route',normalizeRoute(route),'today',date,'waybill',taskId);}
export function todayCorrectionKey(route,date,taskId){return v3Key('route',normalizeRoute(route),'today',date,'correction',taskId);}
export function todayIndexKey(route,date){return v3Key('route',normalizeRoute(route),'today',date,'index');}
export function historyIndexKey(route,date){return v3Key('route',normalizeRoute(route),'history',date,'index');}
export function todayLatestKey(route,date){return v3Key('route',normalizeRoute(route),'today',date,'latest');}
export function pendingKey(route,date,taskId){return v3Key('route',normalizeRoute(route),'pending',date,taskId);}
export function confirmationKey(route,date,taskId){return v3Key('route',normalizeRoute(route),'confirmation',date,taskId);}
export function lockKey(route,date){return v3Key('lock','route-date',normalizeRoute(route),date);}
export function bindingRequestKey(requestId){return v3Key('binding-request',String(requestId||'').trim());}
export function bindingRequestUserKey(userId){return v3Key('user',String(userId||'').trim(),'binding-request');}
export function bindingRequestIndexKey(){return v3Key('binding-request-index');}
export function normalizeRoute(v){const s=String(v||'').trim();const m=s.match(/^(?:([0-9]+)|([0-9]+)号线)$/);return m?String(parseInt(m[1]||m[2],10)).padStart(2,'0')+'号线':s;}
export async function getBase(env,route){const v=await redisGet(env,baseKey(route));return v&&Array.isArray(v.stores)?{...v,route:normalizeRoute(route)}:null;}
export async function setBase(env,route,value){return redisSet(env,baseKey(route),{...value,route:normalizeRoute(route),schemaVersion:3});}
export async function getLearning(env,route){const v=await redisGet(env,learningKey(route));return v&&typeof v==='object'?v:{schemaVersion:3,route:normalizeRoute(route),aliases:{}};}
export async function setLearning(env,route,value){return redisSet(env,learningKey(route),{...value,schemaVersion:3,route:normalizeRoute(route)});}
export async function acquireRouteDateLock(env,route,date,token,seconds=30){const script="if redis.call('SET',KEYS[1],ARGV[1],'NX','EX',ARGV[2]) then return 'OK' else return 'BUSY' end";return (await evalRedis(env,script,[lockKey(route,date)],[token,String(seconds)]))==='OK';}
export async function releaseRouteDateLock(env,route,date,token){const script="if redis.call('GET',KEYS[1]) == ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end";return evalRedis(env,script,[lockKey(route,date)],[token]);}
export function canUseRoute(session,route){
 const r=normalizeRoute(route); if(!session||session.status==='disabled'||!r)return false;
 const p=session.v3Profile||session; if(p.status==='disabled')return false;
 // V3：已有线路均可调度；绑定线路用户保留其维护权限，不允许跨线路修改基准库。
 return true;
}
export function isRouteMaintainer(session,route){
 const r=normalizeRoute(route), p=session?.v3Profile||session;
 return Boolean(p&&['driver','delivery'].includes(String(p.routeDuty||'').toLowerCase())&&normalizeRoute(p.boundRouteId)===r);
}
export { redisGet, redisSet };