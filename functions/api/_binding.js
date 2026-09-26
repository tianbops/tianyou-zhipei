import {get,command} from "./_redis.js";
export async function atomicBind(env,route,user,duty){
 const routeKey="zp:route:"+route.id,userKey="zp:user:"+user.id;
 const r={...route};const u={...user,boundRouteId:route.id,routeDuty:duty,sessionVersion:(user.sessionVersion??1)+1};
 if(duty==="driver")r.driverUserId=user.id;else r.deliveryUserId=user.id;
 const script="local r=ARGV[1]; local u=ARGV[2]; redis.call('SET',KEYS[1],r); redis.call('SET',KEYS[2],u); return 1";
 await command(env,["EVAL",script,"2",routeKey,userKey,JSON.stringify(r),JSON.stringify(u)]);
 return u;
}
export async function atomicUnbind(env,route,user){
 const routeKey="zp:route:"+route.id,userKey="zp:user:"+user.id;
 const r={...route};if(user.routeDuty==="driver"&&r.driverUserId===user.id)r.driverUserId=null;if(user.routeDuty==="delivery"&&r.deliveryUserId===user.id)r.deliveryUserId=null;
 const u={...user,boundRouteId:null,routeDuty:null,sessionVersion:(user.sessionVersion??1)+1};
 const script="local r=ARGV[1]; local u=ARGV[2]; redis.call('SET',KEYS[1],r); redis.call('SET',KEYS[2],u); return 1";
 await command(env,["EVAL",script,"2",routeKey,userKey,JSON.stringify(r),JSON.stringify(u)]);
 return u;
}
