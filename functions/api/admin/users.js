// 天友智配One V1.0 - 系统管理：用户
import { requireSystemAdmin } from '../_auth.js';
import { normalizeRole, publicUser, redisGet, redisSet, scanUsers, recordAdminLog, redisCommand, encodeKey } from '../_data.js';

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
    if (request.method === 'DELETE') return deleteUser(env, admin, userId);
    if (request.method !== 'PATCH') return json({ success: false, error: 'Method not allowed' }, 405);

    const user = await redisGet(env, `user:${encodeKey(userId)}`);
    if (!user) return json({ success: false, error: '用户不存在' }, 404);

    const updated = { ...user };
    if (body.name !== undefined) updated.name = String(body.name || '').trim().slice(0, 40);
    if (body.phone !== undefined) updated.phone = String(body.phone || '').trim().slice(0, 30);
    if (body.role !== undefined) return json({ success: false, error: '系统不支持设置或更改管理员身份；系统仅保留主系统管理员' }, 403);
    if (body.status !== undefined) {
      if (String(user.adminLevel || '') === 'primary' && String(body.status || '').trim() !== 'active') {
        return json({ success: false, error: '主系统管理员账号不可停用' }, 409);
      }
      const status = String(body.status || '').trim();
      if (!['active', 'disabled'].includes(status)) return json({ success: false, error: '非法用户状态' }, 400);
      if (status === 'disabled' && user.status !== 'disabled' && String(user.boundRouteId || '').trim()) {
        return json({ success: false, error: '该用户已绑定线路，请先解除线路绑定后再停用账号' }, 409);
      }
      updated.status = status;
    }
    updated.updatedAt = new Date().toISOString();
    updated.sessionVersion = Number(updated.sessionVersion || 1) + 1;
    await redisSet(env, `user:${encodeKey(userId)}`, updated);
    await recordAdminLog(env, admin, 'update_user', 'user', userId, { fields: Object.keys(body).filter(key => key !== 'userId') });

    return json({ success: true, user: publicUser(updated) });
  } catch (error) {
    console.error('admin users error', error);
    return json({ success: false, error: error?.message || '用户管理失败' }, 503);
  }
}

async function deleteUser(env, admin, userId) {
  if (String(admin?.id || '') === userId) return json({ success: false, error: '不能删除当前登录的系统管理员账号' }, 400);

  const user = await redisGet(env, `user:${encodeKey(userId)}`);
  if (!user) return json({ success: false, error: '用户不存在' }, 404);

  if (normalizeRole(user.role) === 'system_admin' || String(user.adminLevel || '') === 'primary') {
    return json({ success: false, error: '主系统管理员账号不可删除；系统不设其它管理员' }, 400);
  }

  const boundRoute = String(user.boundRouteId || '').trim();
  if (boundRoute) return json({ success: false, error: '该用户已绑定线路，请先解除线路绑定' }, 409);

  const userKey = `user:${encodeKey(userId)}`;
  const usernameKey = `user:username:${encodeURIComponent(String(user.username || '').trim().toLowerCase())}`;
  const script = `
local userKey = KEYS[1]
local usernameKey = KEYS[2]
local expectedId = ARGV[1]
local current = redis.call('GET', userKey)
if not current then return 'NOT_FOUND' end
local ok, obj = pcall(cjson.decode, current)
if not ok or tostring(obj.id or '') ~= expectedId then return 'CONFLICT' end
redis.call('DEL', userKey)
local indexedId = redis.call('GET', usernameKey)
if indexedId == expectedId then redis.call('DEL', usernameKey) end
return 'OK'
`;
  const result = await redisCommand(env, ['EVAL', script, '2', userKey, usernameKey, userId]);
  if (result === 'NOT_FOUND') return json({ success: false, error: '用户不存在' }, 404);
  if (result === 'CONFLICT') return json({ success: false, error: '用户数据已变化，请刷新后重试' }, 409);
  if (result !== 'OK') throw new Error('用户删除未确认');

  await recordAdminLog(env, admin, 'delete_user', 'user', userId, {
    username: String(user.username || ''),
    reason: 'admin_cleanup'
  });
  return json({ success: true, deletedUserId: userId });
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
}
