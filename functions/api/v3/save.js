// 天友智配One V3 · 规划结果原子保存
import { get, set, evalRedis } from './_redis.js';
import { planKey, latestPlanKey, todayWaybillKey, todayCorrectionKey, acquireRouteDateLock, releaseRouteDateLock } from './data.js';
export async function savePlan(env,result){
 const existing=await get(env,planKey(result.route,result.date,result.taskId));
 if(existing)return {saved:true,idempotent:true,key:planKey(result.route,result.date,result.taskId),result:existing};
 const token=crypto.randomUUID();
 if(!(await acquireRouteDateLock(env,result.route,result.date,token,30)))throw Object.assign(new Error('当前线路当天正在保存另一笔运单，请稍后重试'),{code:'ROUTE_DATE_BUSY',stage:'saving'});
 try{
  const key=planKey(result.route,result.date,result.taskId);
  const waybillKey=todayWaybillKey(result.route,result.date,result.taskId);
  const correctionKey=todayCorrectionKey(result.route,result.date,result.taskId);
  const latestKey=latestPlanKey(result.route);

  const correctionData={taskId:result.taskId,route:result.route,date:result.date,orderBatchId:result.taskId,corrections:Array.isArray(result.correctionDetails)?result.correctionDetails:[],count:Number(result.corrections)||0,updatedAt:result.createdAt,schemaVersion:3};
  const script="if redis.call('EXISTS',KEYS[1])==1 then return 'EXISTS' end redis.call('SET',KEYS[1],ARGV[1]) redis.call('SET',KEYS[2],ARGV[1]) redis.call('SET',KEYS[3],ARGV[1]) redis.call('SET',KEYS[4],ARGV[2]) return 'OK'";
  const outcome=await evalRedis(env,script,[key,latestKey,waybillKey,correctionKey],[JSON.stringify(result),JSON.stringify(correctionData)]);
  if(outcome!=='OK'&&outcome!=='EXISTS')throw Object.assign(new Error('规划结果保存未确认'),{code:'SAVE_FAILED',stage:'saving'});
  return {saved:true,idempotent:outcome==='EXISTS',key};
 } finally {await releaseRouteDateLock(env,result.route,result.date,token).catch(()=>{});}
}