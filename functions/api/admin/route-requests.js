// 天友智配One V1.0 - 管理员审核线路绑定申请
import { requireSystemAdmin } from '../_auth.js';
import { routeKey as v3RouteKey, userProfileKey, getRoute as getV3Route, bindingRequestKey, bindingRequestUserKey, bindingRequestIndexKey } from '../v3/data.js';
import {
  atomicRouteBinding, atomicRouteSwitch, encodeKey, getUser, normalizeRoute, publicUser,
  redisCommand, redisGet, redisSet, recordAdminLog
} from '../_data.js';

const REVIEW_LOCK_TTL_SECONDS = 30;

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
  const ids = await redisCommand(env, ['SMEMBERS', bindingRequestIndexKey()]).catch(() => []);
  for (const id of Array.isArray(ids) ? ids : []) {
    const value = await redisGet(env, bindingRequestKey(id)).catch(() => null);
    if (value && typeof value === 'object' && value.id && value.status === 'pending') records.push(value);
  }
  records.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  return json({ success: true, requests: records });
}
/* V3 list replacement marker */
/*
  do {
    const result = await redisCommand(env, ['SCAN', cursor, 'MATCH', 'zpei:v3:binding-request:*', 'COUNT', '200']);
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

  const key = bindingRequestKey(requestId);
  const reviewLockKey = `lock:route-binding-review:${encodeKey(requestId)}`;
  const reviewLockValue = crypto.randomUUID();
  if (!(await acquireReviewLock(env, reviewLockKey, reviewLockValue))) {
    return json({ success: false, error: '该线路申请正在审核，请稍后刷新重试' }, 409);
  }

  try {
    // 锁内重新读取申请，避免两个管理员同时审核时都基于同一份 pending 数据执行。
    const pending = await redisGet(env, key);
    if (!pending || pending.status !== 'pending') return json({ success: false, error: '申请不存在或已处理' }, 404);

    if (action === 'reject') {
      const updated = { ...pending, status: 'rejected', reviewedBy: admin.id, reviewedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      await finalizeRequestStatus(env, {
        requestKey: key,
        userRequestKey: bindingRequestUserKey(pending.userId),
        requestId,
        updated,
        deleteUserIndex: true
      });
      await recordAdminLog(env, admin, 'reject_route_request', 'route_request', requestId, { userId: pending.userId, route: pending.route });
      return json({ success: true, request: updated });
    }

    const user = await getUser(env, pending.userId);
  if (!user || user.status === 'disabled') return json({ success: false, error: '申请用户不存在或已停用' }, 409);
  const route = normalizeRoute(pending.route);
  const current = await getV3Route(env, route);
  if (!current || current.status === 'disabled') return json({ success: false, error: '申请线路不存在或已停用' }, 409);

  const currentBound = normalizeRoute(user.boundRouteId);
  const duty = pending.duty === 'delivery' ? 'delivery' : 'driver';

  // 同一线路同一岗位已经绑定本人：仅结束申请，不重复写绑定数据。
  if (currentBound === route && user.routeDuty === duty) {
    return finishApprovedWithoutRewrite(env, admin, pending, key);
  }

  // 新线路只能在“无人”或“尚未满员”时进入；对应岗位已有其他人员时也不得替换。
  const targetDriver = String(current.driverUserId || '');
  const targetDelivery = String(current.deliveryUserId || '');
  const targetCount = [targetDriver, targetDelivery].filter(Boolean).length;
  const targetSlotUserId = duty === 'driver' ? targetDriver : targetDelivery;
  if (targetSlotUserId && targetSlotUserId !== user.id) {
    return json({ success: false, error: '该线路对应岗位已有人员，不能替换原绑定人员' }, 409);
  }
  if (targetCount >= 2 && ![targetDriver, targetDelivery].includes(user.id)) {
    return json({ success: false, error: '该线路人员已满，无法进入新线路' }, 409);
  }

  const now = new Date().toISOString();
  const targetDriverUserId = duty === 'driver' ? user.id : targetDriver;
  const targetDeliveryUserId = duty === 'delivery' ? user.id : targetDelivery;
  if (targetDriverUserId && targetDeliveryUserId && targetDriverUserId === targetDeliveryUserId) {
    return json({ success: false, error: '驾驶员和配送员不能是同一用户' }, 409);
  }

  const updatedTargetRoute = {
    ...current,
    driverUserId: targetDriverUserId,
    deliveryUserId: targetDeliveryUserId,
    boundUserIds: [targetDriverUserId, targetDeliveryUserId].filter(Boolean),
    updatedAt: now
  };

  const updatedUser = {
    ...user,
    boundRouteId: route,
    route,
    routeDuty: duty,
    updatedAt: now,
    sessionVersion: Number(user.sessionVersion || 1) + 1
  };

  if (!currentBound) {
    await atomicRouteBinding(env, {
      routeKey: v3RouteKey(route),
      expectedRouteUpdatedAt: current.updatedAt || '',
      routeRecord: updatedTargetRoute,
      userUpdates: [{
        key: 'user:' + encodeKey(user.id),
        expectedSessionVersion: Number(user.sessionVersion || 1),
        user: updatedUser
      }],
      profileUpdates: [{
        key: userProfileKey(user.id),
        profile: { userId: String(user.id), boundRouteId: route, routeDuty: duty, status: String(user.status || 'active'), approvedAt: now, updatedAt: now, schemaVersion: 3 }
      }]
    });
  } else {
    // 已绑定旧线路时，进入新线路与退出旧线路必须一次性提交，禁止出现双线路绑定。
    const oldRoute = await getV3Route(env, currentBound);
    if (!oldRoute || oldRoute.status === 'disabled') {
      return json({ success: false, error: '原绑定线路不存在或已停用，请先处理原线路绑定状态' }, 409);
    }

    const oldDriver = String(oldRoute.driverUserId || '');
    const oldDelivery = String(oldRoute.deliveryUserId || '');
    if (oldDriver !== user.id && oldDelivery !== user.id) {
      return json({ success: false, error: '原线路人员绑定数据不一致，请刷新后重试' }, 409);
    }

    const updatedOldRoute = {
      ...oldRoute,
      driverUserId: oldDriver === user.id ? '' : oldDriver,
      deliveryUserId: oldDelivery === user.id ? '' : oldDelivery,
      boundUserIds: [oldDriver === user.id ? '' : oldDriver, oldDelivery === user.id ? '' : oldDelivery].filter(Boolean),
      updatedAt: now
    };

    await atomicRouteSwitch(env, {
      fromRouteKey: v3RouteKey(currentBound),
      fromExpectedRouteUpdatedAt: oldRoute.updatedAt || '',
      fromRouteRecord: updatedOldRoute,
      toRouteKey: v3RouteKey(route),
      toExpectedRouteUpdatedAt: current.updatedAt || '',
      toRouteRecord: updatedTargetRoute,
      userUpdates: [{
        key: 'user:' + encodeKey(user.id),
        expectedSessionVersion: Number(user.sessionVersion || 1),
        user: updatedUser
      }],
      profileUpdates: [{
        key: userProfileKey(user.id),
        profile: { userId: String(user.id), boundRouteId: route, routeDuty: duty, status: String(user.status || 'active'), approvedAt: now, updatedAt: now, schemaVersion: 3 }
      }]
    });
  }

  const approved = { ...pending, status: 'approved', reviewedBy: admin.id, reviewedAt: now, updatedAt: now };
  await finalizeRequestStatus(env, {
    requestKey: key,
    userRequestKey: bindingRequestUserKey(pending.userId),
    requestId,
    updated: approved,
    deleteUserIndex: true
  });
  await recordAdminLog(env, admin, 'approve_route_request', 'route_request', requestId, {
    userId: user.id, fromRoute: currentBound || '', route, duty
  });
    return json({ success: true, request: approved, user: publicUser(updatedUser), route: updatedTargetRoute });
  } finally {
    await releaseReviewLock(env, reviewLockKey, reviewLockValue).catch(() => {});
  }
}

async function finishApprovedWithoutRewrite(env, admin, pending, key) {
  const now = new Date().toISOString();
  const approved = { ...pending, status: 'approved', reviewedBy: admin.id, reviewedAt: now, updatedAt: now };
  await finalizeRequestStatus(env, {
    requestKey: key,
    userRequestKey: bindingRequestUserKey(pending.userId),
    requestId: pending.id,
    updated: approved,
    deleteUserIndex: true
  });
  await recordAdminLog(env, admin, 'approve_route_request', 'route_request', pending.id, { userId: pending.userId, route: pending.route, duty: pending.duty });
  return json({ success: true, request: approved });
}

async function finalizeRequestStatus(env, { requestKey, userRequestKey, indexKey = bindingRequestIndexKey(), requestId, updated, deleteUserIndex = false }) {
  const script = "local current = redis.call('GET', KEYS[1]) if not current then return 'MISSING' end local ok, obj = pcall(cjson.decode, current) if not ok or tostring(obj.id or '') ~= ARGV[1] or tostring(obj.status or '') ~= 'pending' then return 'CHANGED' end redis.call('SET', KEYS[1], ARGV[2]) if ARGV[3] == '1' and redis.call('GET', KEYS[2]) == ARGV[1] then redis.call('DEL', KEYS[2]) end redis.call('SREM', KEYS[3], ARGV[1]) return 'OK'";
  const result = await redisCommand(env, [
    'EVAL', script, '3', requestKey, userRequestKey, indexKey,
    requestId, JSON.stringify(updated), deleteUserIndex ? '1' : '0'
  ]);
  if (result === 'MISSING') throw new Error('申请不存在或已处理');
  if (result === 'CHANGED') throw new Error('申请状态已发生变化，请刷新申请列表后重试');
  if (result !== 'OK') throw new Error('线路申请状态提交未确认');
  return true;
}

async function acquireReviewLock(env, key, value) {
  const result = await redisCommand(env, ['SET', key, value, 'NX', 'EX', String(REVIEW_LOCK_TTL_SECONDS)]).catch(() => null);
  return result === 'OK';
}

async function releaseReviewLock(env, key, value) {
  const script = "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end";
  await redisCommand(env, ['EVAL', script, '1', key, value]).catch(() => null);
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
}
