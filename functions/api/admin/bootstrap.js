// 天友智配One V1.0 - 首个系统管理员初始化
// 仅在环境变量 ADMIN_BOOTSTRAP_KEY 存在时可用；执行成功后立即删除/轮换该环境变量。
import { redisGet, redisSet, normalizeRole, publicUser } from '../_data.js';

export async function onRequest({ request, env }) {
  if (request.method !== 'POST') return json({ success: false, error: 'Method not allowed' }, 405);
  const setupKey = String(env.ADMIN_BOOTSTRAP_KEY || '');
  if (!setupKey) return json({ success: false, error: 'ADMIN_BOOTSTRAP_KEY 未配置' }, 503);
  const supplied = String(request.headers.get('X-Admin-Bootstrap-Key') || '');
  if (!supplied || supplied !== setupKey) return json({ success: false, error: '初始化密钥错误' }, 403);

  try {
    const body = await request.json().catch(() => ({}));
    const userId = String(body.userId || '').trim();
    const username = String(body.username || '').trim().toLowerCase();
    let target = null;

    if (userId) target = await redisGet(env, `user:${encodeURIComponent(userId).replace(/%/g, '_')}`);
    if (!target && username) {
      const id = await redisGet(env, `user:username:${encodeURIComponent(username)}`);
      if (id) target = await redisGet(env, `user:${String(id).trim()}`);
    }
    if (!target) return json({ success: false, error: '找不到目标用户' }, 404);

    const updated = {
      ...target,
      role: 'system_admin',
      updatedAt: new Date().toISOString(),
      sessionVersion: Number(target.sessionVersion || 1) + 1
    };
    await redisSet(env, `user:${encodeURIComponent(target.id).replace(/%/g, '_')}`, updated);
    return json({ success: true, user: publicUser(updated), message: '系统管理员初始化成功；请立即轮换 ADMIN_BOOTSTRAP_KEY' });
  } catch (error) {
    return json({ success: false, error: error?.message || '初始化失败' }, 503);
  }
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
}
