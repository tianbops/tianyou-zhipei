// functions/api/register.js
// 新线路注册：企业统一密码由服务器校验，浏览器不得决定是否有效。
import { authRequired } from './_auth.js';

const USERS_KEY = 'admin_users';
const CONFIG_KEY = 'system_config';
const DEFAULT_UNIFIED_PASSWORD = 'tianyou2024';

export async function onRequest({request,env}) {
  if(request.method!=='POST') return json({error:'Method not allowed'},405);
  if(!env.UPSTASH_REDIS_REST_URL||!env.UPSTASH_REDIS_REST_TOKEN) return json({error:'Redis not configured'},500);
  try {
    const b=await request.json();
    const route=normalizeRoute(b.route),password=String(b.password||''),name=String(b.name||'').trim();
    if(!/^\d{2,}号线$/.test(route)||password.length<4)return json({success:false,error:'线路或密码格式不正确'},400);

    const users=await readJson(env,USERS_KEY,[]);
    const config=await readJson(env,CONFIG_KEY,{});
    const unifiedPassword=String(config?.unifiedPassword||'').trim() || findUnifiedPassword(users) || DEFAULT_UNIFIED_PASSWORD;
    if(password!==unifiedPassword)return json({success:false,error:'企业统一密码错误，请重试'},401);
    if(users.some(u=>u.role!=='admin'&&normalizeRoute(u.route)===route))return json({success:false,error:'该线路已注册'},409);

    const id=users.reduce((m,u)=>Math.max(m,Number(u.id)||0),0)+1;
    const user={id,name,route,password,role:'driver',createdAt:new Date().toISOString()};
    users.push(user);
    await writeJson(env,USERS_KEY,users);
    return json({success:true,user:{id,name,route,role:'driver'}});
  }catch(e){console.error('register error',e);return json({success:false,error:'注册服务异常'},500)}
}

function findUnifiedPassword(users){
  const normal=Array.isArray(users)?users.filter(u=>u&&u.role!=='admin'&&u.password):[];
  if(!normal.length)return '';
  const counts=new Map();
  for(const u of normal)counts.set(String(u.password),(counts.get(String(u.password))||0)+1);
  return [...counts.entries()].sort((a,b)=>b[1]-a[1])[0]?.[0]||'';
}

async function readJson(env,key,fallback){
  const r=await fetch(`${env.UPSTASH_REDIS_REST_URL}/get/${encodeURIComponent(key)}`,{headers:{Authorization:`Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`}});
  if(!r.ok)throw Error('read failed');
  const d=await r.json();
  if(!d.result)return fallback;
  try{return JSON.parse(d.result)}catch{return fallback}
}
async function writeJson(env,key,value){
  const r=await fetch(`${env.UPSTASH_REDIS_REST_URL}/set/${encodeURIComponent(key)}`,{method:'POST',headers:{Authorization:`Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`,'Content-Type':'application/json'},body:JSON.stringify(JSON.stringify(value))});
  if(!r.ok)throw Error('save failed');
}
function normalizeRoute(v){const s=String(v||'').trim(),m=s.match(/^(?:([0-9]+)|([0-9]+)号线)$/);return m?`${String(parseInt(m[1]||m[2],10)).padStart(2,'0')}号线`:s}
function json(p,status=200){return new Response(JSON.stringify(p),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}})}
