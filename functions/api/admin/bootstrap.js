// 天友智配One V1.0 - 首个系统管理员初始化
// 仅在环境变量 ADMIN_BOOTSTRAP_KEY 存在时可用；执行成功后立即删除/轮换该环境变量。
import { redisCommand, redisGet, redisSet, publicUser, scanUsers } from '../_data.js';

export async function onRequest({ request, env }) {
  if (request.method !== 'POST') return json({ success: false, error: 'Method not allowed' }, 405);
  const setupKey = String(env.ADMIN_BOOTSTRAP_KEY || '');
  if (!setupKey) return json({ success: false, error: 'ADMIN_BOOTSTRAP_KEY 未配置' }, 503);
  const supplied = String(request.headers.get('X-Admin-Bootstrap-Key') || '');
  if (!supplied || supplied !== setupKey) return json({ success: false, error: '初始化密钥错误' }, 403);

  const lockKey = 'lock:system-admin-bootstrap';
  const lockToken = crypto.randomUUID();
  const lockResult = await redisCommand(env, ['SET', lockKey, lockToken, 'NX', 'EX', '15']);
  if (lockResult !== 'OK') return json({ success: false, error: '系统管理员初始化正在处理中，请稍后重试' }, 409);
  try {
    const body = await request.json().catch(() => ({}));
    const isReset = String(body.action || '').trim().toLowerCase() === 'reset';
    const alreadyUsed = await redisGet(env, 'system:admin:bootstrap:used');
    if (alreadyUsed && !isReset) return json({ success: false, error: '系统管理员初始化密钥已经使用过，请先轮换 ADMIN_BOOTSTRAP_KEY 后再操作' }, 409);
    const userId = String(body.userId || '').trim();
    const username = String(body.username || '').trim().toLowerCase();
    let target = null;

    if (userId) target = await redisGet(env, `user:${encodeURIComponent(userId).replace(/%/g, '_')}`);
    if (!target && username) {
      const id = await redisGet(env, `user:username:${encodeURIComponent(username)}`);
      if (id) target = await redisGet(env, `user:${String(id).trim()}`);
    }
    if (!target) return json({ success: false, error: '找不到目标用户' }, 404);
    if (String(target.adminLevel || '') === 'primary' && !isReset) return json({ success: false, error: '主系统管理员已经初始化，无需重复设置' }, 409);
    const allUsers = await scanUsers(env);
    const existingAdmins = allUsers.filter(user => String(user?.role || '').trim().toLowerCase() === 'system_admin' && String(user?.id || '') !== String(target.id || ''));
    if (existingAdmins.length) return json({ success: false, error: '系统存在其他系统管理员身份，请先处理后再重置' }, 409);

    const updated = {
      ...target,
      role: 'system_admin',
      adminLevel: 'primary',
      boundRouteId: null,
      routeDuty: null,
      route: null,
      dispatchRoute: null,
      vehicle: null,
      updatedAt: new Date().toISOString(),
      sessionVersion: Number(target.sessionVersion || 1) + 1
    };
    await redisSet(env, `user:${encodeURIComponent(target.id).replace(/%/g, '_')}`, updated);
    await redisSet(env, 'system:admin:primary', { userId: target.id, username: String(target.username || '').trim().toLowerCase(), updatedAt: new Date().toISOString() });
    await redisSet(env, 'system:admin:bootstrap:used', { usedAt: new Date().toISOString(), userId: target.id, action: isReset ? 'reset' : 'bootstrap' });
    return json({ success: true, user: publicUser(updated), message: isReset ? '系统管理员已重置；请立即轮换 ADMIN_BOOTSTRAP_KEY' : '系统管理员初始化成功；请立即轮换 ADMIN_BOOTSTRAP_KEY' });
  } catch (error) {
    return json({ success: false, error: error?.message || '初始化失败' }, 503);
  } finally {
    const script = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";
    await redisCommand(env, ['EVAL', script, '1', lockKey, lockToken]).catch(() => {});
  }
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
}
