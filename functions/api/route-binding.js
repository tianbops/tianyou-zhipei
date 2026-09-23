// 天友智配One V1.0 - 用户线路申请/解除绑定
import { authRequired } from './_auth.js';
import {
  canUseRoute, encodeKey, getRoute, getUser, normalizeRoute, publicUser,
  redisCommand, redisGet, redisSet, routeRecordKey, atomicRouteBinding
} from './_data.js';

const REQUEST_PREFIX = 'route:binding-request:';
const USER_REQUEST_PREFIX = 'route:binding-request:user:';

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
  if (!canUseRoute(user, route)) return json({ success: false, error: '当前账号不可使用该线路' }, 403);

  const boundRoute = normalizeRoute(user.boundRouteId);
  if (boundRoute === route) return json({ success: false, error: '当前账号已在该线路，无需重复申请' }, 409);

  // 已绑定旧线路的用户可以申请新线路；审核通过后由服务端原子完成“退出旧线路 + 进入新线路”。
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
      schemaVersion: 1, id, userId: user.id, username: user.username,
      name: user.name || user.username, route, duty, status: 'pending',
      createdAt: now, updatedAt: now
    };
    await redisSet(env, REQUEST_PREFIX + encodeKey(id), record);
    await redisSet(env, USER_REQUEST_PREFIX + encodeKey(user.id), id);
    return json({ success: true, request: record }, 201);
  } finally {
    await releaseRequestLock(env, requestLockKey, requestLockToken);
  }
}

async function unbindSelf(env, user) {
  const route = normalizeRoute(user.boundRouteId);
  if (!route) return json({ success: false, error: '当前账号未绑定线路' }, 409);
  const current = await getRoute(env, route);
  if (!current) return json({ success: false, error: '绑定线路不存在，请联系管理员' }, 404);

  const duty = String(user.routeDuty || '').trim().toLowerCase();
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
  await atomicRouteBinding(env, {
    routeKey: routeRecordKey(route),
    expectedRouteUpdatedAt: current.updatedAt || '',
    routeRecord: updatedRoute,
    userUpdates: updates
  });

  return json({ success: true, route, user: publicUser(updates.find(x => x.user?.id === user.id)?.user || user), message: '已解除线路绑定，可重新申请其他线路' });
}

async function findPendingForUser(env, userId) {
  const index = await redisGet(env, USER_REQUEST_PREFIX + encodeKey(userId));
  if (!index) return null;
  const record = await redisGet(env, REQUEST_PREFIX + encodeKey(index));
  if (!record) return null;
  if (record.status !== 'pending') return null;
  return record;
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
