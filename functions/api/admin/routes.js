// 天友智配One V1.0 - 系统管理：路线绑定
import { requireSystemAdmin } from '../_auth.js';
import { getRoute, getUser, normalizeRoute, encodeKey, routeRecordKey, routeBaseKey, atomicRouteBinding, publicUser, recordAdminLog, redisCommand } from '../_data.js';

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

    if (request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const route = normalizeRoute(body.route);
      if (!route || !/^\\d+号线$/.test(route)) return json({ success: false, error: '请输入有效线路，例如 17号线' }, 400);
      const now = new Date().toISOString();
      const record = {
        schemaVersion: 1,
        id: route,
        name: route,
        driverUserId: '',
        deliveryUserId: '',
        boundUserIds: [],
        status: 'active',
        createdAt: now,
        updatedAt: now
      };
      const base = {
        schemaVersion: 1,
        route,
        stores: [],
        dataVersion: 1,
        updatedAt: now,
        updatedBy: admin.id,
        source: 'route-create'
      };
      const script = "if redis.call('exists', KEYS[1]) == 1 then return 0 end if redis.call('exists', KEYS[2]) == 1 then return -1 end redis.call('set', KEYS[1], ARGV[1]) redis.call('set', KEYS[2], ARGV[2]) return 1";
      const result = await redisCommand(env, ['EVAL', script, '2', routeRecordKey(route), routeBaseKey(route), JSON.stringify(record), JSON.stringify(base)]);
      if (Number(result) === 0) return json({ success: false, error: '该线路已存在', code: 'ROUTE_EXISTS' }, 409);
      if (Number(result) !== 1) return json({ success: false, error: '该线路已有残留基准数据，请先检查后再创建', code: 'ROUTE_BASE_EXISTS' }, 409);
      await recordAdminLog(env, admin, 'create_route', 'route', route, { status: 'active' }).catch(error => console.warn('create route audit log failed', error));
      return json({ success: true, route: record, base });
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
      const bound = normalizeRoute(user.boundRouteId);
      if (bound && bound !== route) return json({ success: false, error: `用户 ${user.name || user.username} 已绑定 ${bound}，一个用户只能绑定一条路线` }, 409);
      users.push(user);
    }

    const current = await getRoute(env, route);
    const now = new Date().toISOString();

    // 清理本次解绑的旧用户绑定字段。
    // 同时读取角色字段，兼容早期路线记录中 boundUserIds 缺失/过期的情况。
    const oldIds = [...new Set([
      ...(Array.isArray(current?.boundUserIds) ? current.boundUserIds : []),
      String(current?.driverUserId || ''),
      String(current?.deliveryUserId || '')
    ].filter(Boolean))];

    const userUpdates = [];
    for (const user of users) {
      const duty = user.id === driverUserId ? 'driver' : 'delivery';
      userUpdates.push({
        key: `user:${encodeKey(user.id)}`,
        expectedSessionVersion: Number(user.sessionVersion || 1),
        user: {
          ...user,
          boundRouteId: route,
          route,
          routeDuty: duty,
          updatedAt: now,
          sessionVersion: Number(user.sessionVersion || 1) + 1
        }
      });
    }

    for (const oldId of oldIds) {
      if (ids.includes(oldId)) continue;
      const oldUser = await getUser(env, oldId);
      if (!oldUser) continue;
      // 防止旧路线记录中的过期绑定ID误清空用户当前已经绑定的新路线。
      const oldUserBoundRoute = normalizeRoute(oldUser.boundRouteId || oldUser.route);
      if (oldUserBoundRoute && oldUserBoundRoute !== route) continue;
      userUpdates.push({
        key: `user:${encodeKey(oldId)}`,
        expectedSessionVersion: Number(oldUser.sessionVersion || 1),
        user: { ...oldUser, boundRouteId: '', route: '', routeDuty: '', updatedAt: now, sessionVersion: Number(oldUser.sessionVersion || 1) + 1 }
      });
    }

    const record = {
      schemaVersion: 1,
      id: route,
      name: route,
      driverUserId,
      deliveryUserId,
      boundUserIds: [...new Set([driverUserId, deliveryUserId].filter(Boolean))],
      status: current?.status === 'disabled' ? 'disabled' : 'active',
      createdAt: current?.createdAt || now,
      updatedAt: now
    };

    await atomicRouteBinding(env, {
      routeKey: routeRecordKey(route),
      expectedRouteUpdatedAt: current?.updatedAt || '',
      routeRecord: record,
      userUpdates
    });

    // 核心绑定事务成功后，日志失败不能把“已成功绑定”误报成接口失败。
    await recordAdminLog(env, admin, 'bind_route', 'route', route, { driverUserId, deliveryUserId })
      .catch(error => console.warn('bind route audit log failed', error));

    const boundUsers = new Map(userUpdates.map(item => [String(item.user?.id || ''), item.user]));
    return json({
      success: true,
      route: record,
      users: {
        driver: driverUserId ? publicUser(boundUsers.get(driverUserId)) : null,
        delivery: deliveryUserId ? publicUser(boundUsers.get(deliveryUserId)) : null
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
