// 天友智配One V3 · 业务数据边界
import { get as redisGet, set as redisSet, evalRedis, v3Key } from './_redis.js';
export { v3Key };
export function routeKey(route){return v3Key('route',normalizeRoute(route));}
export function baseKey(route){return v3Key('route',normalizeRoute(route),'base');}
export function learningKey(route){return v3Key('route',normalizeRoute(route),'learning');}
export function planKey(route,date,taskId){return v3Key('route',normalizeRoute(route),'plan',date,taskId);}
export function latestPlanKey(route){return v3Key('route',normalizeRoute(route),'latest-plan');}
export function pendingKey(route,date,taskId){return v3Key('route',normalizeRoute(route),'pending',date,taskId);}
export function lockKey(route,date){return v3Key('lock','route-date',normalizeRoute(route),date);}
export function normalizeRoute(v){const s=String(v||'').trim();const m=s.match(/^(?:([0-9]+)|([0-9]+)号线)$/);return m?String(parseInt(m[1]||m[2],10)).padStart(2,'0')+'号线':s;}
export async function getBase(env,route){const v=await redisGet(env,baseKey(route));return v&&Array.isArray(v.stores)?{...v,route:normalizeRoute(route)}:null;}
export async function setBase(env,route,value){return redisSet(env,baseKey(route),{...value,route:normalizeRoute(route),schemaVersion:3});}
export async function getLearning(env,route){const v=await redisGet(env,learningKey(route));return v&&typeof v==='object'?v:{schemaVersion:3,route:normalizeRoute(route),aliases:{}};}
export async function setLearning(env,route,value){return redisSet(env,learningKey(route),{...value,schemaVersion:3,route:normalizeRoute(route)});}
export async function acquireRouteDateLock(env,route,date,token,seconds=30){const script="if redis.call('SET',KEYS[1],ARGV[1],'NX','EX',ARGV[2]) then return 'OK' else return 'BUSY' end";return (await evalRedis(env,script,[lockKey(route,date)],[token,String(seconds)]))==='OK';}
export async function releaseRouteDateLock(env,route,date,token){const script="if redis.call('GET',KEYS[1]) == ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end";return evalRedis(env,script,[lockKey(route,date)],[token]);}
export function canUseRoute(session,route){return Boolean(session&&session.status!=='disabled'&&normalizeRoute(route));}
export function isRouteMaintainer(session,route){return Boolean(session&&normalizeRoute(session.boundRouteId)===normalizeRoute(route));}
export { redisGet, redisSet };