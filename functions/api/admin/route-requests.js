// 天友智配One V1.0 - 管理员审核线路绑定申请
import { requireSystemAdmin } from '../_auth.js';
import {
  atomicRouteBinding, encodeKey, getRoute, getUser, normalizeRoute, publicUser,
  redisCommand, redisGet, redisSet, routeRecordKey, recordAdminLog
} from '../_data.js';

const REQUEST_PREFIX = 'route:binding-request:';
const USER_REQUEST_PREFIX = 'route:binding-request:user:';

export async function onRequest({ request, env }) {
  const admin = await requireSystemAdmin(request, env);
  if (!admin) return json({ success: false, error: '无系统管理权限' }, 403);
  try {
    if (request.method === 'GET') return listRequests(env);
    if (request.method === 'PATCH') return reviewRequest(env, admin, request);
    return json({ success: false, error: 'Method not allowed' }, 405);
  } catch (error) {
    console.error('admin route requests error', error);
    return json({ success: false, error: error?.message || '线路申请处理失败' }, 503);
  }
}

async function listRequests(env) {
  const records = [];
  let cursor = '0';
  do {
    const result = await redisCommand(env, ['SCAN', cursor, 'MATCH', REQUEST_PREFIX + '*', 'COUNT', '200']);
    cursor = String(result?.[0] || '0');
    const keys = Array.isArray(result?.[1]) ? result[1] : [];
    for (const key of keys) {
      const value = await redisGet(env, key).catch(() => null);
      if (value && typeof value === 'object' && value.id && value.status === 'pending') records.push(value);
    }
  } while (cursor !== '0');
  records.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  return json({ success: true, requests: records });
}

async function reviewRequest(env, admin, request) {
  const body = await request.json().catch(() => ({}));
  const requestId = String(body.requestId || '').trim();
  const action = String(body.action || '').trim().toLowerCase();
  if (!requestId) return json({ success: false, error: '缺少 requestId' }, 400);
  if (!['approve', 'reject'].includes(action)) return json({ success: false, error: '非法审核操作' }, 400);

  const key = REQUEST_PREFIX + encodeKey(requestId);
  const pending = await redisGet(env, key);
  if (!pending || pending.status !== 'pending') return json({ success: false, error: '申请不存在或已处理' }, 404);

  if (action === 'reject') {
    const updated = { ...pending, status: 'rejected', reviewedBy: admin.id, reviewedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    await redisSet(env, key, updated);
    await redisSet(env, USER_REQUEST_PREFIX + encodeKey(pending.userId), requestId);
    await recordAdminLog(env, admin, 'reject_route_request', 'route_request', requestId, { userId: pending.userId, route: pending.route });
    return json({ success: true, request: updated });
  }

  const user = await getUser(env, pending.userId);
  if (!user || user.status === 'disabled') return json({ success: false, error: '申请用户不存在或已停用' }, 409);
  const route = normalizeRoute(pending.route);
  const current = await getRoute(env, route);
  if (!current || current.status === 'disabled') return json({ success: false, error: '申请线路不存在或已停用' }, 409);

  const currentBound = normalizeRoute(user.boundRouteId || user.route);
  if (currentBound && currentBound !== route) return json({ success: false, error: '申请用户已经绑定其他线路，请先解除后再审核' }, 409);
  if (currentBound === route && user.routeDuty === pending.duty) {
    return finishApprovedWithoutRewrite(env, admin, pending, key);
  }

  const duty = pending.duty === 'delivery' ? 'delivery' : 'driver';
  const oldSlotUserId = duty === 'driver' ? String(current.driverUserId || '') : String(current.deliveryUserId || '');
  const driverUserId = duty === 'driver' ? user.id : String(current.driverUserId || '');
  const deliveryUserId = duty === 'delivery' ? user.id : String(current.deliveryUserId || '');
  if (driverUserId && deliveryUserId && driverUserId === deliveryUserId) return json({ success: false, error: '驾驶员和配送员不能是同一用户' }, 409);

  const now = new Date().toISOString();
  const updates = [{
    key: 'user:' + encodeKey(user.id),
    expectedSessionVersion: Number(user.sessionVersion || 1),
    user: { ...user, boundRouteId: route, route, routeDuty: duty, updatedAt: now, sessionVersion: Number(user.sessionVersion || 1) + 1 }
  }];

  if (oldSlotUserId && oldSlotUserId !== user.id) {
    const oldUser = await getUser(env, oldSlotUserId);
    if (oldUser) {
      updates.push({
        key: 'user:' + encodeKey(oldUser.id),
        expectedSessionVersion: Number(oldUser.sessionVersion || 1),
        user: { ...oldUser, boundRouteId: '', route: '', routeDuty: '', updatedAt: now, sessionVersion: Number(oldUser.sessionVersion || 1) + 1 }
      });
    }
  }

  const updatedRoute = {
    ...current,
    driverUserId,
    deliveryUserId,
    boundUserIds: [driverUserId, deliveryUserId].filter(Boolean),
    updatedAt: now
  };
  await atomicRouteBinding(env, {
    routeKey: routeRecordKey(route),
    expectedRouteUpdatedAt: current.updatedAt || '',
    routeRecord: updatedRoute,
    userUpdates: updates
  });

  const approved = { ...pending, status: 'approved', reviewedBy: admin.id, reviewedAt: now, updatedAt: now };
  await redisSet(env, key, approved);
  await recordAdminLog(env, admin, 'approve_route_request', 'route_request', requestId, { userId: user.id, route, duty });
  return json({ success: true, request: approved, user: publicUser(user), route: updatedRoute });
}

async function finishApprovedWithoutRewrite(env, admin, pending, key) {
  const now = new Date().toISOString();
  const approved = { ...pending, status: 'approved', reviewedBy: admin.id, reviewedAt: now, updatedAt: now };
  await redisSet(env, key, approved);
  await recordAdminLog(env, admin, 'approve_route_request', 'route_request', pending.id, { userId: pending.userId, route: pending.route, duty: pending.duty });
  return json({ success: true, request: approved });
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
}
