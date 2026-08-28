// functions/api/users-unified-password.js
// 管理员统一更新普通用户密码。
// 密码只保存于 admin_users，不再重复写入 system_config。
import { authRequired } from './_auth.js';

const USERS_KEY = 'admin_users';

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
    let updated = 0;
    const nextUsers = users.map(user => {
      if (!user || user.role === 'admin') return user;
      updated += 1;
      return {
        ...user,
        password,
        sessionVersion: Number(user.sessionVersion || 1) + 1
      };
    });

    await writeJson(env, USERS_KEY, nextUsers);

    return json({
      success: true,
      updated,
      message: `已成功更新 ${updated} 个普通用户密码；旧登录会话已失效`
    });
  } catch (e) {
    console.error('unified password error', e);
    return json({ error: '统一密码更新失败，请稍后重试' }, 500);
  }
}

async function readJson(env, key, fallback) {
  const r = await fetch(`${env.UPSTASH_REDIS_REST_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}` },
    cache: 'no-store'
  });
  if (!r.ok) throw new Error('读取数据失败');
  const d = await r.json();
  if (!d.result) return fallback;
  try {
    const value = JSON.parse(d.result);
    return value ?? fallback;
  } catch {
    return fallback;
  }
}

async function writeJson(env, key, value) {
  const r = await fetch(`${env.UPSTASH_REDIS_REST_URL}/set/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(JSON.stringify(value)),
    cache: 'no-store'
  });
  if (!r.ok) throw new Error('写入数据失败');
  const result = await r.json().catch(() => null);
  if (!result || result.result !== 'OK') throw new Error('Redis 写入未确认成功');
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    }
  });
}
