// 天友智配One V1.0 - 安全数据重置
// 仅清理智配One明确使用的Redis命名空间，不执行FLUSHDB，不触碰Cloudflare环境变量。
// 默认只允许系统管理员查看清理范围；真正删除还需要额外的 DATA_RESET_KEY + 精确确认词。
import { requireSystemAdmin } from '../_auth.js';
import { redisCommand } from '../_data.js';

const SCAN_COUNT = 200;
const MAX_SCAN_ROUNDS = 1000;
const DELETE_BATCH = 50;

const APP_PATTERNS = Object.freeze([
  'user:*',
  'route:*',
  'system:*',
  'lock:*',
  'wx:*'
]);

export async function onRequest({ request, env }) {
  const admin = await requireSystemAdmin(request, env);
  if (!admin) return json({ success: false, error: '无系统管理权限' }, 403);

  if (request.method !== 'POST') {
    return json({ success: false, error: 'Method not allowed' }, 405);
  }

  const resetKey = String(env.DATA_RESET_KEY || '').trim();
  if (!resetKey) {
    return json({
      success: false,
      error: 'DATA_RESET_KEY 未配置；当前仅允许在服务器配置该密钥后执行数据重置'
    }, 503);
  }

  const suppliedKey = String(request.headers.get('X-Data-Reset-Key') || '');
  if (!suppliedKey || suppliedKey !== resetKey) {
    return json({ success: false, error: '数据重置密钥错误' }, 403);
  }

  const body = await request.json().catch(() => ({}));
  if (String(body.confirmation || '').trim() !== '确认清空智配One数据') {
    return json({
      success: false,
      error: '缺少精确确认词：确认清空智配One数据'
    }, 400);
  }

  try {
    const keys = await scanAppKeys(env);
    let deleted = 0;

    for (let i = 0; i < keys.length; i += DELETE_BATCH) {
      const batch = keys.slice(i, i + DELETE_BATCH);
      if (!batch.length) continue;
      const result = await redisCommand(env, ['DEL', ...batch]);
      deleted += Number(result || 0);
    }

    return json({
      success: true,
      scanned: keys.length,
      deleted,
      namespaces: APP_PATTERNS,
      message: '智配One业务数据已清空；Cloudflare环境变量及代码未修改。请重新建立管理员、用户、路线和基准库。'
    });
  } catch (error) {
    console.error('admin data reset error', error);
    return json({
      success: false,
      error: error?.message || '数据重置失败'
    }, 503);
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

function isAppKey(key) {
  return APP_PATTERNS.some(pattern => {
    if (pattern === 'user:*') return key.startsWith('user:');
    if (pattern === 'route:*') return key.startsWith('route:');
    if (pattern === 'system:*') return key.startsWith('system:');
    if (pattern === 'lock:*') return key.startsWith('lock:');
    if (pattern === 'wx:*') return key.startsWith('wx:');
    return false;
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
