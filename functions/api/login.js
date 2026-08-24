// functions/api/login.js
// 登录验证 API：密码只在服务端比较，成功后签发短期签名会话。
import { createSession } from './_auth.js';

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const UPSTASH_URL = env.UPSTASH_REDIS_REST_URL;
  const UPSTASH_TOKEN = env.UPSTASH_REDIS_REST_TOKEN;
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return json({ error: 'Redis not configured' }, 500);

  try {
    const body = await request.json();
    const type = body.type === 'admin' ? 'admin' : 'route';
    const account = String(body.account || '').trim();
    const password = String(body.password || '');
    if (!account || !password) return json({ success: false, error: '账号和密码不能为空' }, 400);

    const resp = await fetch(`${UPSTASH_URL}/get/admin_users`, { headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` } });
    if (!resp.ok) return json({ success: false, error: '用户数据服务不可用' }, 503);
    const data = await resp.json();
    let users = [];
    if (data.result) { try { users = JSON.parse(data.result); } catch { users = []; } }
    if (!Array.isArray(users)) users = [];

    let user;
    if (type === 'admin') {
      user = users.find(u => u.role === 'admin' && String(u.name || '').trim() === account);
    } else {
      const route = normalizeRoute(account);
      user = users.find(u => u.role !== 'admin' && normalizeRoute(u.route) === route);
    }

    if (!user || String(user.password ?? '') !== password) return json({ success: false, error: '账号或密码错误' }, 401);

    const safeUser = { id: user.id, name: user.name || '', route: normalizeRoute(user.route || ''), role: user.role || 'driver' };
    const sessionToken = await createSession(env, safeUser);
    return json({ success: true, user: safeUser, sessionToken });
  } catch (error) {
    console.error('login error', error);
    return json({ success: false, error: '登录服务异常' }, 500);
  }
}

function normalizeRoute(input) {
  const value = String(input || '').trim();
  const match = value.match(/^(?:([0-9]+)|([0-9]+)号线)$/);
  if (!match) return value;
  return `${String(parseInt(match[1] || match[2], 10)).padStart(2, '0')}号线`;
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
}
