// 天友智配One V1.0 - 系统管理：路线绑定
import { requireSystemAdmin } from '../_auth.js';
import { getRoute, getUser, normalizeRoute, redisSet, saveRoute, publicUser, recordAdminLog } from '../_data.js';

export async function onRequest({ request, env }) {
  const admin = await requireSystemAdmin(request, env);
  if (!admin) return json({ success: false, error: '无系统管理权限' }, 403);
  try {
    if (request.method === 'GET') {
      const route = normalizeRoute(new URL(request.url).searchParams.get('route'));
      if (!route) return json({ success: false, error: '缺少 route' }, 400);
      const record = await getRoute(env, route);
      return json({ success: true, route: record || { id: route, name: route, driverUserId: '', deliveryUserId: '', boundUserIds: [] } });
    }

    if (request.method !== 'PUT') return json({ success: false, error: 'Method not allowed' }, 405);
    const body = await request.json().catch(() => ({}));
    const route = normalizeRoute(body.route);
    const driverUserId = String(body.driverUserId || '').trim();
    const deliveryUserId = String(body.deliveryUserId || '').trim();
    if (!route) return json({ success: false, error: '缺少有效线路' }, 400);
    if (driverUserId && deliveryUserId && driverUserId === deliveryUserId) return json({ success: false, error: '驾驶员和配送员不能是同一用户' }, 400);

    const ids = [driverUserId, deliveryUserId].filter(Boolean);
    const users = [];
    for (const id of ids) {
      const user = await getUser(env, id);
      if (!user || user.status === 'disabled') return json({ success: false, error: '绑定用户不存在或已停用' }, 400);
      const bound = normalizeRoute(user.boundRouteId || user.route);
      if (bound && bound !== route) return json({ success: false, error: `用户 ${user.name || user.username} 已绑定 ${bound}，一个用户只能绑定一条路线` }, 409);
      users.push(user);
    }

    const current = await getRoute(env, route);
    const now = new Date().toISOString();
    const record = await saveRoute(env, route, {
      driverUserId,
      deliveryUserId,
      createdAt: current?.createdAt || now
    });

    for (const user of users) {
      const duty = user.id === driverUserId ? 'driver' : 'delivery';
      const updated = {
        ...user,
        boundRouteId: route,
        route,
        routeDuty: duty,
        updatedAt: now,
        sessionVersion: Number(user.sessionVersion || 1) + 1
      };
      await redisSet(env, `user:${encodeURIComponent(user.id).replace(/%/g, '_')}`, updated);
    }

    // 清理本次解绑的旧用户绑定字段。
    const oldIds = Array.isArray(current?.boundUserIds) ? current.boundUserIds : [];
    await recordAdminLog(env, admin, 'bind_route', 'route', route, { driverUserId, deliveryUserId });

    for (const oldId of oldIds) {
      if (ids.includes(oldId)) continue;
      const oldUser = await getUser(env, oldId);
      if (!oldUser) continue;
      const updated = { ...oldUser, boundRouteId: '', route: '', routeDuty: '', updatedAt: now, sessionVersion: Number(oldUser.sessionVersion || 1) + 1 };
      await redisSet(env, `user:${encodeURIComponent(oldId).replace(/%/g, '_')}`, updated);
    }

    return json({
      success: true,
      route: record,
      users: {
        driver: driverUserId ? publicUser(await getUser(env, driverUserId)) : null,
        delivery: deliveryUserId ? publicUser(await getUser(env, deliveryUserId)) : null
      }
    });
  } catch (error) {
    console.error('admin routes error', error);
    return json({ success: false, error: error?.message || '路线绑定失败' }, 503);
  }
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
}
