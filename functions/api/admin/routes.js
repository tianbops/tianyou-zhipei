// 天友智配One V1.0 - 系统管理：路线绑定
import { requireSystemAdmin } from '../_auth.js';
import { getRoute, getUser, normalizeRoute, encodeKey, routeRecordKey, routeBaseKey, atomicRouteBinding, publicUser, recordAdminLog, redisCommand, redisSet, scanUsers } from '../_data.js';

async function repairCreatedRoutesFromAdminLogs(env, records) {
  const logs = await redisCommand(env, ['GET', 'system:admin:logs']).catch(() => null);
  const list = Array.isArray(logs) ? logs : [];
  const known = new Set(records.map(record => normalizeRoute(record?.id)).filter(Boolean));
  const created = new Set(list
    .filter(item => item?.action === 'create_route' && item?.targetType === 'route')
    .map(item => normalizeRoute(item?.targetId))
    .filter(Boolean));

  for (const route of created) {
    if (known.has(route)) continue;
    const now = new Date().toISOString();
    const createLog = list.find(item =>
      item?.action === 'create_route' &&
      item?.targetType === 'route' &&
      normalizeRoute(item?.targetId) === route
    );
    const record = {
      schemaVersion: 1,
      id: route,
      name: route,
      driverUserId: '',
      deliveryUserId: '',
      boundUserIds: [],
      status: 'active',
      createdAt: String(createLog?.createdAt || now),
      updatedAt: now
    };
    if (!await getRoute(env, route)) {
      await redisSet(env, routeRecordKey(route), record);
      const base = await redisCommand(env, ['GET', routeBaseKey(route)]).catch(() => null);
      if (!base) {
        await redisSet(env, routeBaseKey(route), {
          schemaVersion: 1,
          route,
          stores: [],
          dataVersion: 1,
          updatedAt: now,
          source: 'route-repair'
        });
      }
    }
    const repaired = await getRoute(env, route);
    if (repaired) {
      records.push(repaired);
      known.add(route);
    }
  }
}

export async function onRequest({ request, env }) {
  const admin = await requireSystemAdmin(request, env);
  if (!admin) return json({ success: false, error: '无系统管理权限' }, 403);
  try {
    if (request.method === 'GET') {
      const route = normalizeRoute(new URL(request.url).searchParams.get('route'));
      if (route) {
        const record = await getRoute(env, route);
        return json({ success: true, route: record || { id: route, name: route, driverUserId: '', deliveryUserId: '', boundUserIds: [] } });
      }

      // 系统管理页面使用管理员专用列表接口，避免依赖普通调度接口。
      const records = [];
      let cursor = '0';
      do {
        const result = await redisCommand(env, ['SCAN', cursor, 'MATCH', 'route:*', 'COUNT', '200']);
        cursor = String(result?.[0] || '0');
        const keys = Array.isArray(result?.[1]) ? result[1] : [];
        for (const key of keys) {
          if (key.includes(':base') || key.includes(':orders:') || key.includes(':learning')) continue;
          const value = await redisCommand(env, ['GET', key]).catch(() => null);
          if (!value || typeof value !== 'object' || !value.id) continue;
          records.push(value);
        }
      } while (cursor !== '0');

      // 管理员创建日志是线路实体的审计依据。若历史线路记录异常缺失，读取管理列表时自动修复实体。
      await repairCreatedRoutesFromAdminLogs(env, records);
      const users = await scanUsers(env);
      const byId = new Map(records.map(record => [String(record.id), record]));
      for (const user of users) {
        const id = normalizeRoute(user?.boundRouteId);
        if (!id) continue;
        if (!byId.has(id)) byId.set(id, { id, name: id, driverUserId: '', deliveryUserId: '', boundUserIds: [] });
        const record = byId.get(id);
        if (user.routeDuty === 'driver') record.driverUserId = user.id;
        if (user.routeDuty === 'delivery') record.deliveryUserId = user.id;
        if (!Array.isArray(record.boundUserIds)) record.boundUserIds = [];
        if (!record.boundUserIds.includes(user.id)) record.boundUserIds.push(user.id);
      }
      return json({
        success: true,
        routes: [...byId.values()].sort((a, b) => String(a.id).localeCompare(String(b.id), 'zh-CN', { numeric: true }))
      });
    }

    if (request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const route = normalizeRoute(body.route);
      if (!route || !/^\d+号线$/.test(route)) return json({ success: false, error: '请输入有效线路，例如 17号线' }, 400);
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
      if (bound && bound !== route) return json({ success: false, error: `用户 ${user.name || user.username} 已绑定 ${bound}，一个用户只能绑定一条线路` }, 409);
      users.push(user);
    }

    const current = await getRoute(env, route);
    const now = new Date().toISOString();

    // 管理员直接设置线路人员时，也不得静默替换已有岗位人员。
    const currentDriver = String(current?.driverUserId || '');
    const currentDelivery = String(current?.deliveryUserId || '');
    if (driverUserId && currentDriver && currentDriver !== driverUserId) {
      return json({ success: false, error: '该线路驾驶员岗位已有人员，不能直接替换' }, 409);
    }
    if (deliveryUserId && currentDelivery && currentDelivery !== deliveryUserId) {
      return json({ success: false, error: '该线路配送员岗位已有人员，不能直接替换' }, 409);
    }
    if ([driverUserId, deliveryUserId].filter(Boolean).length > 2) {
      return json({ success: false, error: '线路人员已满，无法继续绑定' }, 409);
    }

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
      const oldUserBoundRoute = normalizeRoute(oldUser.boundRouteId);
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
