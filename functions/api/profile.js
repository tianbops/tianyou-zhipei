// 天友智配One V1.0 - 用户资料
// 用户可以维护个人姓名/手机号/默认车辆，但不能自行修改路线绑定。
import { authRequired, createSession, sessionCookie } from './_auth.js';
import { publicUser, redisGet, redisSet } from './_data.js';

export async function onRequest({ request, env }) {
  const session = await authRequired(request, env, { allowAnyRoute: true });
  if (!session) return json({ success: false, error: '登录已失效' }, 401);
  try {
    const user = await redisGet(env, 'user:' + session.id);
    if (!user || user.status === 'disabled') return json({ success: false, error: '用户不存在或已停用' }, 401);

    if (request.method === 'GET') return json({ success: true, user: publicUser(user) });
    if (request.method !== 'PUT') return json({ success: false, error: 'Method not allowed' }, 405);

    const body = await request.json().catch(() => ({}));
    const name = String(body.name ?? user.name ?? '').trim();
    const phone = String(body.phone ?? user.phone ?? '').trim();
    const vehicle = String(body.vehicle ?? user.vehicle ?? '').trim();

    if (!name) return json({ success: false, error: '请输入姓名' }, 400);
    if (name.length > 40) return json({ success: false, error: '姓名不能超过40个字符' }, 400);
    if (phone.length > 30) return json({ success: false, error: '手机号不能超过30个字符' }, 400);
    if (vehicle.length > 30) return json({ success: false, error: '车辆信息不能超过30个字符' }, 400);

    const updated = {
      ...user,
      name,
      phone,
      vehicle,
      // 任何情况下都以服务器当前绑定关系为准。
      boundRouteId: String(user.boundRouteId || user.route || '').trim(),
      route: String(user.boundRouteId || user.route || '').trim(),
      updatedAt: new Date().toISOString(),
      sessionVersion: Number(user.sessionVersion || 1) + 1
    };
    await redisSet(env, 'user:' + session.id, updated);

    const safeUser = publicUser(updated);
    const token = await createSession(env, updated, { client: 'web' });
    return new Response(JSON.stringify({ success: true, user: safeUser }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Set-Cookie': sessionCookie(token)
      }
    });
  } catch (error) {
    console.error('profile error', error);
    return json({ success: false, error: '资料服务异常，请稍后重试' }, 500);
  }
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
}
