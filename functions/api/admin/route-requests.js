// 天友智配One V1.0 - 管理员审核线路绑定申请
import { requireSystemAdmin } from '../_auth.js';
import {
  atomicRouteBinding, atomicRouteSwitch, encodeKey, getRoute, getUser, normalizeRoute, publicUser,
  redisCommand, redisGet, redisSet, routeRecordKey, recordAdminLog
} from '../_data.js';

const REQUEST_PREFIX = 'route:binding-request:';
const USER_REQUEST_PREFIX = 'route:binding-request:user:';
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
    await redisSet(env, key, updated);
    // 审核结束后清理用户的“待审核申请”索引，避免后续申请被旧索引阻断。
    await redisCommand(env, ['DEL', USER_REQUEST_PREFIX + encodeKey(pending.userId)]);
    await recordAdminLog(env, admin, 'reject_route_request', 'route_request', requestId, { userId: pending.userId, route: pending.route });
      return json({ success: true, request: updated });
    }

    const user = await getUser(env, pending.userId);
  if (!user || user.status === 'disabled') return json({ success: false, error: '申请用户不存在或已停用' }, 409);
  const route = normalizeRoute(pending.route);
  const current = await getRoute(env, route);
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
      routeKey: routeRecordKey(route),
      expectedRouteUpdatedAt: current.updatedAt || '',
      routeRecord: updatedTargetRoute,
      userUpdates: [{
        key: 'user:' + encodeKey(user.id),
        expectedSessionVersion: Number(user.sessionVersion || 1),
        user: updatedUser
      }]
    });
  } else {
    // 已绑定旧线路时，进入新线路与退出旧线路必须一次性提交，禁止出现双线路绑定。
    const oldRoute = await getRoute(env, currentBound);
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
      fromRouteKey: routeRecordKey(currentBound),
      fromExpectedRouteUpdatedAt: oldRoute.updatedAt || '',
      fromRouteRecord: updatedOldRoute,
      toRouteKey: routeRecordKey(route),
      toExpectedRouteUpdatedAt: current.updatedAt || '',
      toRouteRecord: updatedTargetRoute,
      userUpdates: [{
        key: 'user:' + encodeKey(user.id),
        expectedSessionVersion: Number(user.sessionVersion || 1),
        user: updatedUser
      }]
    });
  }

  const approved = { ...pending, status: 'approved', reviewedBy: admin.id, reviewedAt: now, updatedAt: now };
  await persistApprovedRequest(env, key, approved);
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
  await persistApprovedRequest(env, key, approved);
  await recordAdminLog(env, admin, 'approve_route_request', 'route_request', pending.id, { userId: pending.userId, route: pending.route, duty: pending.duty });
  return json({ success: true, request: approved });
}

async function persistApprovedRequest(env, key, approved) {
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await redisSet(env, key, approved);
      const saved = await redisGet(env, key);
      if (saved && saved.status === 'approved' && saved.id === approved.id) return true;
      lastError = new Error('审核状态写入后未确认');
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error('线路绑定已完成，但审核状态同步未确认，请刷新申请列表后重试');
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
