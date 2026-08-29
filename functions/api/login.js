// functions/api/login.js
import { createSession, sessionCookie } from './_auth.js';
import { hashPassword, verifyPassword, isPasswordHash } from './_password.js';

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
    if (!user) return json({ success: false, error: '用户名或密码错误' }, 401);

    let valid = false;
    if (isPasswordHash(user.passwordHash)) valid = await verifyPassword(password, user.passwordHash);
    else if (Object.prototype.hasOwnProperty.call(user, 'password')) valid = String(user.password || '') === password;
    if (!valid) return json({ success: false, error: '用户名或密码错误' }, 401);

    // 兼容现有账号：第一次成功登录时立即把旧明文迁移为 PBKDF2 哈希，并删除 password 字段。
    if (!isPasswordHash(user.passwordHash)) {
      user.passwordHash = await hashPassword(password);
      delete user.password;
      user.sessionVersion = Number(user.sessionVersion || 1) + 1;
      await saveUsers(env, users);
    }

    const safeUser = { id:user.id, name:user.name||'', route:normalizeRoute(user.route||''), role:user.role||'driver' };
    const token = await createSession(env, { ...safeUser, sessionVersion:Number(user.sessionVersion||1) });
    return new Response(JSON.stringify({success:true,user:safeUser}), {status:200,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Set-Cookie':sessionCookie(token)}});
  } catch(error) { console.error('login error',error); return json({success:false,error:'登录服务异常'},500); }
}
async function readUsers(env){const resp=await fetch(`${env.UPSTASH_REDIS_REST_URL}/get/admin_users`,{headers:{Authorization:`Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`},cache:'no-store'});if(!resp.ok)throw new Error('user data unavailable');const data=await resp.json();if(!data.result)return[];try{const users=JSON.parse(data.result);return Array.isArray(users)?users:[]}catch{return[]}}
async function saveUsers(env,users){const resp=await fetch(`${env.UPSTASH_REDIS_REST_URL}/set/admin_users`,{method:'POST',headers:{Authorization:`Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`,'Content-Type':'application/json'},body:JSON.stringify(JSON.stringify(users)),cache:'no-store'});if(!resp.ok)throw new Error('user migration save failed');const data=await resp.json().catch(()=>({}));if(data.result!==undefined&&data.result!=='OK')throw new Error('user migration not confirmed')}
function normalizeRoute(input){const value=String(input||'').trim(),match=value.match(/^(?:([0-9]+)|([0-9]+)号线)$/);return match?`${String(parseInt(match[1]||match[2],10)).padStart(2,'0')}号线`:value}
function json(payload,status=200){return new Response(JSON.stringify(payload),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}})}
