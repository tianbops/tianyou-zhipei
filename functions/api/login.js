// functions/api/login.js
import { createSession, sessionCookie } from './_auth.js';

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  if (!env.UPSTASH_REDIS_REST_URL || !env.UPSTASH_REDIS_REST_TOKEN) return json({ error: 'Redis not configured' }, 500);
  try {
    const body = await request.json();
    const type = body.type === 'admin' ? 'admin' : 'route';
    const account = String(body.account || '').trim();
    const password = String(body.password || '');
    if (!account || !password) return json({ success: false, error: '账号和密码不能为空' }, 400);
    const users = await readUsers(env);
    let user;
    if (type === 'admin') user = users.find(u => u && u.role === 'admin' && String(u.name || '').trim() === account);
    else { const route = normalizeRoute(account); user = users.find(u => u && u.role !== 'admin' && normalizeRoute(u.route) === route); }
    if (!user || String(user.password ?? '') !== password) return json({ success: false, error: '用户名或密码错误' }, 401);
    const safeUser = { id:user.id, name:user.name||'', route:normalizeRoute(user.route||''), role:user.role||'driver' };
    const token = await createSession(env, { ...safeUser, sessionVersion:Number(user.sessionVersion||1) });
    return new Response(JSON.stringify({success:true,user:safeUser}), {status:200,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Set-Cookie':sessionCookie(token)}});
  } catch(error) { console.error('login error',error); return json({success:false,error:'登录服务异常'},500); }
}
async function readUsers(env){const resp=await fetch(`${env.UPSTASH_REDIS_REST_URL}/get/admin_users`,{headers:{Authorization:`Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`},cache:'no-store'});if(!resp.ok)throw new Error('user data unavailable');const data=await resp.json();if(!data.result)return[];try{const users=JSON.parse(data.result);return Array.isArray(users)?users:[]}catch{return[]}}
function normalizeRoute(input){const value=String(input||'').trim(),match=value.match(/^(?:([0-9]+)|([0-9]+)号线)$/);return match?`${String(parseInt(match[1]||match[2],10)).padStart(2,'0')}号线`:value}
function json(payload,status=200){return new Response(JSON.stringify(payload),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}})}
