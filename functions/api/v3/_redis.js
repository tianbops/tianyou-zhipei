// 智配One V3 · Redis边界
export function v3Key(...parts){return ['zpei:v3',...parts.map(v=>encodeURIComponent(String(v??'')))].join(':');}
function ready(env){return Boolean(String(env.UPSTASH_REDIS_REST_URL||'').trim()&&String(env.UPSTASH_REDIS_REST_TOKEN||'').trim());}
async function request(env,path,options={}){
 if(!ready(env))throw new Error('Redis未配置');
 const base=String(env.UPSTASH_REDIS_REST_URL).replace(/\/+$/,'');
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),8000);
 try{return await fetch(base+path,{...options,headers:{Authorization:`Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`,...(options.headers||{})},cache:'no-store',signal:controller.signal});}
 finally{clearTimeout(timer);}
}
export async function get(env,key){
 const r=await request(env,'/get/'+encodeURIComponent(key));
 if(!r.ok)throw new Error(`Redis读取失败（HTTP ${r.status}）`);
 const d=await r.json().catch(()=>({}));
 if(d.result===null||d.result===undefined||d.result==='')return null;
 try{return typeof d.result==='string'?JSON.parse(d.result):d.result;}catch{return d.result;}
}
export async function set(env,key,value){
 const r=await request(env,'/set/'+encodeURIComponent(key),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)});
 if(!r.ok)throw new Error(`Redis保存失败（HTTP ${r.status}）`);
 const d=await r.json().catch(()=>({}));
 if(d.result!==undefined&&d.result!=='OK')throw new Error('Redis保存未确认');
 return true;
}
export async function evalRedis(env,script,keys=[],args=[]){
 const r=await request(env,'',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(['EVAL',script,String(keys.length),...keys,...args])});
 if(!r.ok)throw new Error(`Redis事务执行失败（HTTP ${r.status}）`);
 const d=await r.json().catch(()=>({}));
 if(d.error)throw new Error(String(d.error));
 return d.result;
}