import {json,body} from "../_json.js";
import {currentUser} from "../_auth.js";
import {get,set,newId} from "../_redis.js";
import {canUseRoute} from "../_permissions.js";
const clean=v=>String(v??"").trim();
const num=v=>{const n=Number(v);return Number.isFinite(n)?n:null};
export async function onRequestPost({request,env}){
 const user=await currentUser(request,env);
 if(!user)return json({success:false,error:"未登录"},401);
 if(!canUseRoute(user))return json({success:false,error:"无权限"},403);
 const input=await body(request), routeId=clean(input.routeId||user.boundRouteId);
 if(!routeId||!clean(input.date)||!clean(input.vehicle))return json({success:false,error:"运单信息不完整"},400);
 if(!Array.isArray(input.stores))return json({success:false,error:"stores 必须是数组"},400);
 const stores=input.stores.map((x,i)=>({rawName:clean(x.rawName||x.name),name:clean(x.name||x.rawName),storeId:clean(x.storeId)||null,quantity:num(x.quantity)||0,routeOrder:num(x.routeOrder)||i+1,matchStatus:clean(x.matchStatus)||"pending"})).filter(x=>x.rawName);
 const order={id:newId(),routeId,date:clean(input.date),vehicle:clean(input.vehicle),capacity:{load:num(input.load),volume:num(input.volume)},totalQuantity:num(input.totalQuantity),totalWeight:num(input.totalWeight),totalVolume:num(input.totalVolume),stores,rawText:clean(input.rawText),stage:"EXTRACTED",createdBy:user.id,createdAt:new Date().toISOString()};
 await set(env,"waybill:"+order.id,order);
 return json({success:true,waybill:order});
}