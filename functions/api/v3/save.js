// V3 · 规划结果保存
import { set, v3Key } from './_redis.js';
export async function savePlan(env,result){
 const key=v3Key('route',result.route,'plan',result.date,result.taskId);
 await set(env,key,result);
 await set(env,v3Key('route',result.route,'latest-plan'),result);
 return {saved:true,key};
}
