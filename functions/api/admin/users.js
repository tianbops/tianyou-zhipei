// 天友智配One V1.0 - 系统管理：用户
import { requireSystemAdmin } from '../_auth.js';
import { normalizeRoute, normalizeRole, publicUser, redisCommand, redisGet, redisSet, scanUsers } from '../_data.js';

export async function onRequest({ request, env }) {
  const admin = await requireSystemAdmin(request, env);
  if (!admin) return json({ success: false, error: '无系统管理权限' }, 403);
  if (!env.UPSTASH_REDIS_REST_URL || !env.UPSTASH_REDIS_REST_TOKEN) return json({ success: false, error: 'Redis not configured' }, 500);

  try {
    if (request.method === 'GET') {
      const users = await scanUsers(env);
      return json({
        success: true,
        users: users.map(user => ({
          ...publicUser(user),
          createdAt: user.createdAt || '',
          updatedAt: user.updatedAt || '',
          lastLoginAt: user.lastLoginAt || ''
        }))
      });
    }

    const body = await request.json().catch(() => ({}));
    const userId = String(body.userId || '').trim();
    if (!userId) return json({ success: false, error: '缺少 userId' }, 400);
    const user = await redisGet(env, `user:${encodeURIComponent(userId).replace(/%/g, '_')}`);
    if (!user) return json({ success: false, error: '用户不存在' }, 404);

    if (request.method !== 'PATCH') return json({ success: false, error: 'Method not allowed' }, 405);

    const updated = { ...user };
    if (body.name !== undefined) updated.name = String(body.name || '').trim().slice(0, 40);
    if (body.phone !== undefined) updated.phone = String(body.phone || '').trim().slice(0, 30);
    if (body.role !== undefined) {
      const role = normalizeRole(body.role);
      updated.role = role;
    }
    if (body.status !== undefined) {
      const status = String(body.status || '').trim();
      if (!['active', 'disabled'].includes(status)) return json({ success: false, error: '非法用户状态' }, 400);
      updated.status = status;
    }
    updated.updatedAt = new Date().toISOString();
    updated.sessionVersion = Number(updated.sessionVersion || 1) + 1;
    await redisSet(env, `user:${encodeURIComponent(userId).replace(/%/g, '_')}`, updated);

    return json({ success: true, user: publicUser(updated) });
  } catch (error) {
    console.error('admin users error', error);
    return json({ success: false, error: error?.message || '用户管理失败' }, 503);
  }
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
}
