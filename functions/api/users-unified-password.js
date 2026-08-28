// 管理员：统一更新全部普通用户密码，并把企业统一密码保存到服务器配置。
import { authRequired } from './_auth.js';

const USERS_KEY = 'admin_users';
const CONFIG_KEY = 'system_config';

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  if (!env.UPSTASH_REDIS_REST_URL || !env.UPSTASH_REDIS_REST_TOKEN) return json({ error: 'Redis not configured' }, 500);
  const session = await authRequired(request, env, { admin: true });
  if (!session) return json({ error: '管理员登录已失效或无权限' }, 401);

  try {
    const body = await request.json();
    const password = String(body.password || '').trim();
    if (password.length < 6) return json({ error: '统一密码至少需要6位' }, 400);

    const users = await readJson(env, USERS_KEY, []);
    const targets = users.filter(u => u && u.role !== 'admin');
    const updated = users.map(u => u && u.role !== 'admin' ? { ...u, password } : u);

    await writeJson(env, USERS_KEY, updated);
    const config = await readJson(env, CONFIG_KEY, {});
    await writeJson(env, CONFIG_KEY, { ...(config || {}), unifiedPassword: password, updatedAt: new Date().toISOString() });

    return json({ success: true, updated: targets.length, message: `已成功更新 ${targets.length} 个普通用户密码` });
  } catch (e) {
    console.error('unified password error', e);
    return json({ error: '统一密码更新失败，请稍后重试' }, 500);
  }
}

async function readJson(env, key, fallback) {
  const r = await fetch(`${env.UPSTASH_REDIS_REST_URL}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}` } });
  if (!r.ok) throw new Error('读取数据失败');
  const d = await r.json();
  if (!d.result) return fallback;
  try { return JSON.parse(d.result); } catch { return fallback; }
}

async function writeJson(env, key, value) {
  const r = await fetch(`${env.UPSTASH_REDIS_REST_URL}/set/${encodeURIComponent(key)}`, {
    method: 'POST', headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(JSON.stringify(value))
  });
  if (!r.ok) throw new Error('写入数据失败');
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
}
