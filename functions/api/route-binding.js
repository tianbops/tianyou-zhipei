// 天友智配One V1.0 - 用户线路申请/解除绑定
import { authRequired } from './_auth.js';
import {
  encodeKey, getUser, normalizeRoute, publicUser,
  redisCommand, redisGet, redisSet, atomicRouteBinding
} from './_data.js';
import { canUseRoute as canUseV3Route, userProfileKey, routeKey as v3RouteKey, getRoute as getV3Route, bindingRequestKey, bindingRequestUserKey, bindingRequestIndexKey } from './v3/data.js';

const REVIEW_LOCK_TTL_SECONDS = 30;

export async function onRequest({ request, env }) {
  const session = await authRequired(request, env, { allowAnyRoute: true });
  if (!session) return json({ success: false, error: '未登录或登录已失效' }, 401);
  const user = await getUser(env, session.id);
  if (!user || user.status === 'disabled') return json({ success: false, error: '用户不存在或已停用' }, 401);

  try {
    if (request.method === 'GET') return getStatus(env, user);
    if (request.method === 'POST') return createRequest(env, user, request);
    if (request.method === 'DELETE') return unbindSelf(env, user);
    return json({ success: false, error: 'Method not allowed' }, 405);
  } catch (error) {
    console.error('route binding api error', error);
    return json({ success: false, error: error?.message || '线路绑定服务异常' }, 503);
  }
}

async function getStatus(env, user) {
  const boundRoute = normalizeRoute(user.boundRouteId);
  const pending = await findPendingForUser(env, user.id);
  return json({
    success: true,
    user: publicUser(user),
    boundRoute,
    pending: pending ? {
      id: pending.id, route: pending.route, duty: pending.duty,
      status: pending.status, createdAt: pending.createdAt, updatedAt: pending.updatedAt
    } : null
  });
}

async function createRequest(env, user, request) {
  const body = await request.json().catch(() => ({}));
  const route = normalizeRoute(body.route);
  const duty = String(body.duty || '').trim().toLowerCase();
  if (!route) return json({ success: false, error: '请选择有效线路' }, 400);
  if (!['driver', 'delivery'].includes(duty)) return json({ success: false, error: '请选择驾驶员或配送员身份' }, 400);
  if (!canUseV3Route(user, route)) return json({ success: false, error: '当前账号不可使用该线路' }, 403);

  const boundRoute = normalizeRoute(user.boundRouteId);
  if (boundRoute === route) return json({ success: false, error: '当前账号已在该线路，无需重复申请' }, 409);

  // 已有正式线路绑定时，必须先解除当前绑定，才能提交其他线路申请。
  // 服务端强制执行该规则，不能仅依赖前端按钮状态。
  if (boundRoute) return json({ success: false, error: '当前已绑定 ' + boundRoute + '，请先解除当前绑定后再申请其他线路' }, 409);

  const existing = await findPendingForUser(env, user.id);
  if (existing) return json({ success: false, error: '已有待审核线路申请，请等待管理员处理' }, 409);

  // 同一账号并发点击提交时，先锁住“账号申请槽位”，避免产生两条 pending 申请。
  const requestLockKey = 'route:binding-request:lock:' + encodeKey(user.id);
  const requestLockToken = crypto.randomUUID();
  const locked = await acquireRequestLock(env, requestLockKey, requestLockToken);
  if (!locked) return json({ success: false, error: '线路申请正在处理中，请稍后再试' }, 409);
  try {
    const latestExisting = await findPendingForUser(env, user.id);
    if (latestExisting) return json({ success: false, error: '已有待审核线路申请，请等待管理员处理' }, 409);

    const routeRecord = await getRoute(env, route);
    if (!routeRecord || routeRecord.status === 'disabled') return json({ success: false, error: '该线路不存在或已停用' }, 404);

    // 待审核申请不占用线路正式岗位名额。
    // 同一线路、同一岗位可以同时存在多个不同用户的待审核申请，最终由管理员在审核通过时实时竞争岗位。
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const record = {
      schemaVersion: 3, id, userId: user.id, username: user.username,
      name: user.name || user.username, route, duty, status: 'pending',
      createdAt: now, updatedAt: now
    };
    const saved = await atomicCreateRequest(env, {
      requestKey: bindingRequestKey(id),
      userRequestKey: bindingRequestUserKey(user.id),
      indexKey: bindingRequestIndexKey(),
      record
    });
    if (!saved) return json({ success: false, error: '线路申请保存失败，请稍后重试' }, 503);
    return json({ success: true, request: record }, 201);
  } finally {
    await releaseRequestLock(env, requestLockKey, requestLockToken);
  }
}

async function unbindSelf(env, user) {
  // 未通过审核时，DELETE 表示“取消当前申请”；只有已正式绑定时才执行解除绑定。
  // 取消申请与管理员审核共用申请级锁，避免“管理员批准”和“用户取消”同时操作同一 pending。
  const initialPending = await findPendingForUser(env, user.id);
  if (initialPending) {
    const reviewLockKey = `lock:route-binding-review:${encodeKey(initialPending.id)}`;
    const reviewLockValue = crypto.randomUUID();
    if (!(await acquireReviewLock(env, reviewLockKey, reviewLockValue))) {
      return json({ success: false, error: '该线路申请正在审核，请稍后刷新重试' }, 409);
    }
    try {
      const pending = await findPendingForUser(env, user.id);
      if (pending) {
        const cancelled = await atomicCancelRequest(env, {
          requestKey: bindingRequestKey(pending.id),
          userRequestKey: bindingRequestUserKey(user.id),
          indexKey: bindingRequestIndexKey(),
          requestId: pending.id
        });
        if (!cancelled) return json({ success: false, error: '线路申请状态已发生变化，请刷新后重试' }, 409);
        return json({ success: true, cancelled: true, requestId: pending.id, route: pending.route, message: '线路申请已取消' });
      }
    } finally {
      await releaseReviewLock(env, reviewLockKey, reviewLockValue).catch(() => {});
    }
  }

  const route = normalizeRoute(user.boundRouteId);
  if (!route) return json({ success: false, error: '当前账号未绑定线路' }, 409);
  const current = await getV3Route(env, route);
  if (!current) return json({ success: false, error: '绑定线路不存在，请联系管理员' }, 404);

  const duty = String(user.routeDuty || '').trim().toLowerCase();
  if (!['driver', 'delivery'].includes(duty)) {
    return json({ success: false, error: '当前线路绑定岗位信息异常，请联系系统管理员处理' }, 409);
  }
  const boundSlotUserId = duty === 'driver' ? String(current.driverUserId || '') : String(current.deliveryUserId || '');
  if (boundSlotUserId !== String(user.id)) {
    return json({ success: false, error: '当前账号与线路岗位绑定数据不一致，请联系系统管理员处理' }, 409);
  }
  const driverUserId = duty === 'driver' ? '' : String(current.driverUserId || '');
  const deliveryUserId = duty === 'delivery' ? '' : String(current.deliveryUserId || '');
  const ids = [driverUserId, deliveryUserId].filter(Boolean);
  const updates = [];
  for (const id of ids) {
    const other = await getUser(env, id);
    if (!other) continue;
    updates.push({
      key: 'user:' + encodeKey(id),
      expectedSessionVersion: Number(other.sessionVersion || 1),
      user: other
    });
  }
  updates.push({
    key: 'user:' + encodeKey(user.id),
    expectedSessionVersion: Number(user.sessionVersion || 1),
    user: { ...user, boundRouteId: '', route: '', routeDuty: '', updatedAt: new Date().toISOString(), sessionVersion: Number(user.sessionVersion || 1) + 1 }
  });

  const now = new Date().toISOString();
  const updatedRoute = {
    ...current,
    driverUserId,
    deliveryUserId,
    boundUserIds: [driverUserId, deliveryUserId].filter(Boolean),
    updatedAt: now
  };
  const profileUpdates = [{
    key: userProfileKey(user.id),
    profile: {
      userId: String(user.id),
      boundRouteId: '',
      routeDuty: '',
      status: String(user.status || 'active'),
      approvedAt: user.approvedAt || '',
      updatedAt: now,
      schemaVersion: 3
    }
  }];
  await atomicRouteBinding(env, {
    routeKey: v3RouteKey(route),
    expectedRouteUpdatedAt: current.updatedAt || '',
    routeRecord: updatedRoute,
    userUpdates: updates,
    profileUpdates
  });

  return json({ success: true, route, user: publicUser(updates.find(x => x.user?.id === user.id)?.user || user), message: '已解除线路绑定，可重新申请其他线路' });
}

async function findPendingForUser(env, userId) {
  const index = await redisGet(env, bindingRequestUserKey(userId));
  if (!index) return null;
  const record = await redisGet(env, bindingRequestKey(index));
  if (!record) return null;
  if (record.status !== 'pending') return null;
  return record;
}

async function atomicCreateRequest(env, { requestKey, userRequestKey, indexKey, record }) {
  const script = "if redis.call('EXISTS', KEYS[1]) == 1 then return 'EXISTS' end if redis.call('EXISTS', KEYS[2]) == 1 then return 'USER_PENDING' end redis.call('SET', KEYS[1], ARGV[1]) redis.call('SET', KEYS[2], ARGV[2]) redis.call('SADD', KEYS[3], ARGV[3]) return 'OK'";
  const result = await redisCommand(env, ['EVAL', script, '3', requestKey, userRequestKey, indexKey, JSON.stringify(record), record.id]).catch(() => null);
  return result === 'OK';
}

async function atomicCancelRequest(env, { requestKey, userRequestKey, indexKey, requestId }) {
  const script = "local current = redis.call('GET', KEYS[1]) if not current then return 'MISSING' end local ok, obj = pcall(cjson.decode, current) if not ok or tostring(obj.id or '') ~= ARGV[1] or tostring(obj.status or '') ~= 'pending' then return 'CHANGED' end redis.call('DEL', KEYS[1]) if redis.call('GET', KEYS[2]) == ARGV[1] then redis.call('DEL', KEYS[2]) end redis.call('SREM', KEYS[3], ARGV[1]) return 'OK'";
  const result = await redisCommand(env, ['EVAL', script, '3', requestKey, userRequestKey, indexKey, requestId]).catch(() => null);
  return result === 'OK';
}

async function acquireReviewLock(env, key, value) {
  const result = await redisCommand(env, ['SET', key, value, 'NX', 'EX', String(REVIEW_LOCK_TTL_SECONDS)]).catch(() => null);
  return result === 'OK';
}

async function releaseReviewLock(env, key, value) {
  const script = "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end";
  await redisCommand(env, ['EVAL', script, '1', key, value]).catch(() => {});
}

async function acquireRequestLock(env, key, token) {
  const result = await redisCommand(env, ['SET', key, token, 'NX', 'EX', '10']);
  return String(result || '') === 'OK';
}

async function releaseRequestLock(env, key, token) {
  const script = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";
  await redisCommand(env, ['EVAL', script, '1', key, token]).catch(() => {});
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
}
