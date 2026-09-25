// 天友智配One V3 · 规划结果原子保存
import { evalRedis } from './_redis.js';
import { planKey, latestPlanKey, todayWaybillKey, todayCorrectionKey, todayIndexKey, historyIndexKey, acquireRouteDateLock, releaseRouteDateLock } from './data.js';
export async function savePlan(env,result){
 const token=crypto.randomUUID();
 if(!(await acquireRouteDateLock(env,result.route,result.date,token,30)))throw Object.assign(new Error('当前线路当天正在保存另一笔运单，请稍后重试'),{code:'ROUTE_DATE_BUSY',stage:'saving'});
 try{
  const key=planKey(result.route,result.date,result.taskId);
  const waybillKey=todayWaybillKey(result.route,result.date,result.taskId);
  const correctionKey=todayCorrectionKey(result.route,result.date,result.taskId);
  const latestKey=latestPlanKey(result.route);
  const todayIndex=todayIndexKey(result.route,result.date);
  const historyIndex=historyIndexKey(result.route,result.date);

  const correctionData={taskId:result.taskId,route:result.route,date:result.date,orderBatchId:result.taskId,corrections:Array.isArray(result.correctionDetails)?result.correctionDetails:[],count:Number(result.corrections)||0,updatedAt:result.createdAt,schemaVersion:3};
  const script="if redis.call('EXISTS',KEYS[1])==1 then return 'EXISTS' end redis.call('SET',KEYS[1],ARGV[1]) redis.call('SET',KEYS[2],ARGV[1]) redis.call('SET',KEYS[3],ARGV[1]) redis.call('SET',KEYS[4],ARGV[2]) redis.call('SADD',KEYS[5],ARGV[3]) redis.call('SADD',KEYS[6],ARGV[3]) return 'OK'";
  const outcome=await evalRedis(env,script,[key,latestKey,waybillKey,correctionKey,todayIndex,historyIndex],[JSON.stringify(result),JSON.stringify(correctionData),result.taskId]);
  if(outcome!=='OK'&&outcome!=='EXISTS')throw Object.assign(new Error('规划结果保存未确认'),{code:'SAVE_FAILED',stage:'saving'});
  return {saved:true,idempotent:outcome==='EXISTS',key};
 } finally {await releaseRouteDateLock(env,result.route,result.date,token).catch(()=>{});}
}