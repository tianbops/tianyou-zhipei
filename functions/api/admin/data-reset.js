// 智配One V1.0 - 安全数据重置
// 仅清理智配One已核实的Redis业务键，不执行FLUSHDB，不触碰Cloudflare环境变量。
import { requireSystemAdmin } from '../_auth.js';
import { redisCommand } from '../_data.js';

const SCAN_COUNT = 200;
const MAX_SCAN_ROUNDS = 1000;
const DELETE_BATCH = 50;

const PRIMARY_ADMIN_KEY = 'system:admin:primary';

const APP_PATTERNS = Object.freeze([
  'user:*',
  'route:*',
  'lock:*',
  'system:admin:logs',
  'system:admin:bootstrap:used',
  'wx:openid:*',
  'wx:unionid:*',
  'zpei:v3:*'
]);

export async function onRequest({ request, env }) {
  const admin = await requireSystemAdmin(request, env);
  if (!admin) return json({ success: false, error: '无系统管理权限' }, 403);
  if (request.method !== 'POST') return json({ success: false, error: 'Method not allowed' }, 405);

  const resetKey = String(env.DATA_RESET_KEY || '').trim();
  if (!resetKey) return json({ success: false, error: 'DATA_RESET_KEY 未配置；当前不会执行数据重置' }, 503);

  const suppliedKey = String(request.headers.get('X-Data-Reset-Key') || '');
  if (!suppliedKey || suppliedKey !== resetKey) return json({ success: false, error: '数据重置密钥错误' }, 403);

  const body = await request.json().catch(() => ({}));
  if (String(body.confirmation || '').trim() !== '确认清空智配One数据') {
    return json({ success: false, error: '缺少精确确认词：确认清空智配One数据' }, 400);
  }

  try {
    const primaryAdmin = await findPrimaryAdmin(env);
    if (!primaryAdmin) return json({ success: false, error: '未找到可保留的原始系统管理员；为安全起见未执行清空' }, 409);

    const keys = await scanAppKeys(env);
    // 数据重置的账号规则：仅保留主系统管理员，其余用户账号、登录索引及微信身份映射一并清除。
    const preserveKeys = new Set([
      `user:${encodeKey(primaryAdmin.id)}`,
      `user:username:${encodeURIComponent(String(primaryAdmin.username || '').trim().toLowerCase())}`,
      PRIMARY_ADMIN_KEY
    ]);
    const deleteKeys = keys.filter(key => !preserveKeys.has(key));
    let deleted = 0;

    for (let i = 0; i < deleteKeys.length; i += DELETE_BATCH) {
      const batch = deleteKeys.slice(i, i + DELETE_BATCH);
      const result = await redisCommand(env, ['DEL', ...batch]);
      deleted += Number(result || 0);
    }

    const preserved = {
      ...primaryAdmin,
      role: 'system_admin',
      adminLevel: 'primary',
      boundRouteId: '',
      route: '',
      vehicle: '',
      routeDuty: '',
      sessionVersion: Number(primaryAdmin.sessionVersion || 1) + 1,
      updatedAt: new Date().toISOString()
    };
    await redisCommand(env, ['SET', `user:${encodeKey(preserved.id)}`, JSON.stringify(preserved)]);
    await redisCommand(env, ['SET', `user:username:${encodeURIComponent(String(preserved.username || '').trim().toLowerCase())}`, preserved.id]);
    const primaryMarker = { userId: preserved.id, username: preserved.username, createdAt: primaryAdmin.createdAt || '', markedAt: new Date().toISOString() };
    await redisCommand(env, ['SET', PRIMARY_ADMIN_KEY, JSON.stringify(primaryMarker)]);
    await redisCommand(env, ['SET', 'system:admin:bootstrap:used', JSON.stringify({ usedAt: primaryMarker.markedAt, userId: preserved.id })]);

    return json({
      success: true,
      scanned: keys.length,
      deleted,
      preservedAdmin: { id: preserved.id, username: preserved.username, name: preserved.name, adminLevel: preserved.adminLevel },
      namespaces: APP_PATTERNS,
      message: '智配One数据重置完成；仅保留原始主系统管理员账号，其余用户账号、线路、基准库、运单、历史、学习数据、绑定关系及管理日志已清除。'
    });
  } catch (error) {
    console.error('admin data reset error', error);
    return json({ success: false, error: error?.message || '数据重置失败' }, 503);
  }
}

async function scanAppKeys(env) {
  const found = new Set();

  for (const pattern of APP_PATTERNS) {
    let cursor = '0';
    let rounds = 0;

    do {
      if (++rounds > MAX_SCAN_ROUNDS) {
        throw new Error('Redis数据量过大，重置扫描未完成；为安全起见已停止删除');
      }

      const result = await redisCommand(env, [
        'SCAN', cursor, 'MATCH', pattern, 'COUNT', String(SCAN_COUNT)
      ]);
      cursor = String(result?.[0] ?? '0');

      const batch = Array.isArray(result?.[1]) ? result[1] : [];
      for (const key of batch) {
        const value = String(key || '');
        if (isAppKey(value)) found.add(value);
      }
    } while (cursor !== '0');
  }

  return [...found];
}

async function findPrimaryAdmin(env) {
  const marker = await redisGetSafe(env, PRIMARY_ADMIN_KEY);
  if (marker?.userId) {
    const markedUser = await redisGetSafe(env, `user:${encodeKey(marker.userId)}`);
    if (markedUser?.id && markedUser?.username) return markedUser;
  }

  const bootstrap = await redisGetSafe(env, 'system:admin:bootstrap:used');
  if (bootstrap?.userId) {
    const bootstrapUser = await redisGetSafe(env, `user:${encodeKey(bootstrap.userId)}`);
    if (bootstrapUser?.id && bootstrapUser?.username) return bootstrapUser;
  }

  const users = await scanUsersForReset(env);
  const admins = users.filter(user => String(user?.role || '').trim().toLowerCase() === 'system_admin');
  admins.sort((a, b) => String(a?.createdAt || '').localeCompare(String(b?.createdAt || '')));
  return admins[0] || null;
}

async function redisGetSafe(env, key) {
  const result = await redisCommand(env, ['GET', key]);
  if (result === null || result === undefined || result === '') return null;
  try { return typeof result === 'string' ? JSON.parse(result) : result; } catch { return null; }
}

async function scanUsersForReset(env) {
  const users = [];
  let cursor = '0';
  do {
    const result = await redisCommand(env, ['SCAN', cursor, 'MATCH', 'user:*', 'COUNT', String(SCAN_COUNT)]);
    cursor = String(result?.[0] ?? '0');
    const batch = Array.isArray(result?.[1]) ? result[1] : [];
    for (const key of batch) {
      if (key.includes(':route:') || key.includes(':username:')) continue;
      const value = await redisGetSafe(env, key);
      if (value && typeof value === 'object' && value.id && value.username) users.push(value);
    }
  } while (cursor !== '0');
  return users;
}

function encodeKey(value) {
  return encodeURIComponent(String(value || '').trim()).replace(/%/g, '_');
}

function isAppKey(key) {
  return APP_PATTERNS.some(pattern => {
    if (pattern.endsWith(':*')) return key.startsWith(pattern.slice(0, -1));
    return key === pattern;
  });
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    }
  });
}
