// functions/api/register.js
import { authRequired } from './_auth.js';

export async function onRequest({request,env}) {
  if(request.method!=='POST')return json({error:'Method not allowed'},405);
  if(!env.UPSTASH_REDIS_REST_URL||!env.UPSTASH_REDIS_REST_TOKEN)return json({error:'Redis not configured'},500);
  try{
    const b=await request.json();
    const route=normalizeRoute(b.route),password=String(b.password||''),name=String(b.name||'').trim();
    if(!/^\d{2,}号线$/.test(route)||password.length<4)return json({success:false,error:'线路或密码格式不正确'},400);
    const users=await readUsers(env);
    if(users.some(u=>u.role!=='admin'&&normalizeRoute(u.route)===route))return json({success:false,error:'该线路已注册'},409);
    const id=users.reduce((m,u)=>Math.max(m,Number(u.id)||0),0)+1;
    const user={id,name,route,password,role:'driver',createdAt:new Date().toISOString()};
    users.push(user);await saveUsers(env,users);
    return json({success:true,user:{id,name,route,role:'driver'}});
  }catch(e){console.error('register error',e);return json({success:false,error:'注册服务异常'},500)}
}
async function readUsers(env){const r=await fetch(`${env.UPSTASH_REDIS_REST_URL}/get/admin_users`,{headers:{Authorization:`Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`}});if(!r.ok)throw Error('read failed');const d=await r.json();try{const u=d.result?JSON.parse(d.result):[];return Array.isArray(u)?u:[]}catch{return[]}}
async function saveUsers(env,users){const r=await fetch(`${env.UPSTASH_REDIS_REST_URL}/set/admin_users`,{method:'POST',headers:{Authorization:`Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`,'Content-Type':'application/json'},body:JSON.stringify(JSON.stringify(users))});if(!r.ok)throw Error('save failed')}
function normalizeRoute(v){const s=String(v||'').trim(),m=s.match(/^(?:([0-9]+)|([0-9]+)号线)$/);return m?`${String(parseInt(m[1]||m[2],10)).padStart(2,'0')}号线`:s}
function json(p,status=200){return new Response(JSON.stringify(p),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}})}
