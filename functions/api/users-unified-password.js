// 管理员：统一更新全部普通用户密码，不修改管理员密码。
import { authRequired } from './_auth.js';

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  if (!env.UPSTASH_REDIS_REST_URL || !env.UPSTASH_REDIS_REST_TOKEN) return json({ error: 'Redis not configured' }, 500);
  const session = await authRequired(request, env, { admin: true });
  if (!session) return json({ error: '管理员登录已失效或无权限' }, 401);

  try {
    const body = await request.json();
    const password = String(body.password || '');
    if (password.length < 6) return json({ error: '统一密码至少需要6位' }, 400);

    const users = await readUsers(env);
    const targets = users.filter(u => u && u.role !== 'admin');
    if (!targets.length) return json({ success: true, updated: 0, message: '没有需要更新的普通用户' });

    const updated = users.map(u => u && u.role !== 'admin' ? { ...u, password } : u);
    await saveUsers(env, updated);
    return json({ success: true, updated: targets.length, message: `已成功更新 ${targets.length} 个普通用户密码` });
  } catch (e) {
    console.error('unified password error', e);
    return json({ error: '统一密码更新失败' }, 500);
  }
}

async function readUsers(env) {
  const r = await fetch(`${env.UPSTASH_REDIS_REST_URL}/get/admin_users`, { headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}` } });
  if (!r.ok) throw new Error('读取用户数据失败');
  const d = await r.json();
  if (!d.result) return [];
  try { const users = JSON.parse(d.result); return Array.isArray(users) ? users : []; } catch { return []; }
}

async function saveUsers(env, users) {
  const r = await fetch(`${env.UPSTASH_REDIS_REST_URL}/set/admin_users`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(JSON.stringify(users))
  });
  if (!r.ok) throw new Error('写入用户数据失败');
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
}
