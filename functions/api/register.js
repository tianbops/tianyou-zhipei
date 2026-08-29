// functions/api/register.js
// 新线路注册：企业统一密码仅由服务器环境变量校验；数据库只保存密码哈希。
import { authRequired } from './_auth.js';
import { hashPassword } from './_password.js';
const USERS_KEY = 'admin_users';
export async function onRequest({request,env}) {
  if(request.method!=='POST') return json({error:'Method not allowed'},405);
  if(!env.UPSTASH_REDIS_REST_URL||!env.UPSTASH_REDIS_REST_TOKEN) return json({error:'Redis not configured'},500);
  const session=await authRequired(request,env,{admin:true});
  if(!session) return json({success:false,error:'管理员登录已失效或无权限'},401);
  try{
    const b=await request.json(); const route=normalizeRoute(b.route),password=String(b.password||''),name=String(b.name||'').trim();
    const unifiedPassword=String(env.DEFAULT_UNIFIED_PASSWORD||'').trim();
    if(!/^\d{2,}号线$/.test(route)||password.length<4)return json({success:false,error:'线路或密码格式不正确'},400);
    if(!unifiedPassword)return json({success:false,error:'服务器未配置新线路统一密码'},500);
    if(password!==unifiedPassword)return json({success:false,error:'企业统一密码错误，请重试'},401);
    const users=await readJson(env,USERS_KEY,[]);
    if(users.some(u=>u.role!=='admin'&&normalizeRoute(u.route)===route))return json({success:false,error:'该线路已注册'},409);
    const id=users.reduce((m,u)=>Math.max(m,Number(u.id)||0),0)+1;
    const user={id,name:name||route,route,passwordHash:await hashPassword(unifiedPassword),role:'driver',createdAt:new Date().toISOString(),sessionVersion:1};
    users.push(user); await writeJson(env,USERS_KEY,users);
    return json({success:true,user:{id:user.id,name:user.name,route:user.route,role:user.role}});
  }catch(e){console.error('register error',e);return json({success:false,error:'注册服务异常'},500)}
}
async function readJson(env,key,fallback){const r=await fetch(`${env.UPSTASH_REDIS_REST_URL}/get/${encodeURIComponent(key)}`,{headers:{Authorization:`Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`},cache:'no-store'});if(!r.ok)throw Error('read failed');const d=await r.json();if(!d.result)return fallback;try{return JSON.parse(d.result)}catch{return fallback}}
async function writeJson(env,key,value){const r=await fetch(`${env.UPSTASH_REDIS_REST_URL}/set/${encodeURIComponent(key)}`,{method:'POST',headers:{Authorization:`Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`,'Content-Type':'application/json'},body:JSON.stringify(JSON.stringify(value)),cache:'no-store'});if(!r.ok)throw Error('save failed');const d=await r.json().catch(()=>null);if(!d||d.result!=='OK')throw Error('save not confirmed')}
function normalizeRoute(v){const s=String(v||'').trim(),m=s.match(/^(?:([0-9]+)|([0-9]+)号线)$/);return m?`${String(parseInt(m[1]||m[2],10)).padStart(2,'0')}号线`:s}
function json(p,status=200){return new Response(JSON.stringify(p),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}})}
