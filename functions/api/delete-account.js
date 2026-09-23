// 天友智配One - 注销账号
// 注销需验证当前密码；删除该用户的账号、订单、历史记录与学习数据，不删除线路公共基准库。
import { authRequired, clearSessionCookie } from './_auth.js';
import { redisCommand } from './_data.js';

const SCAN_COUNT = 100;
const MAX_SCAN_ROUNDS = 100;

export async function onRequest({ request, env }) {
  if (request.method !== 'POST') return json({ success: false, error: 'Method not allowed' }, 405);
  if (!redisReady(env)) return json({ success: false, error: '账号服务未配置，请检查 Upstash 配置' }, 500);

  const session = await authRequired(request, env);
  if (!session?.id) return json({ success: false, error: '登录已失效，请重新登录' }, 401);

  try {
    const userKey = `user:${session.id}`;
    const user = parseRecord(await redisCommand(env, ['GET', userKey]));
    if (!user || user.status === 'disabled') return json({ success: false, error: '用户不存在或已停用' }, 401);

    const body = await request.json().catch(() => ({}));
    const password = String(body.password || '');
    const confirmation = String(body.confirmation || '').trim();
    if (!password) return json({ success: false, error: '请输入当前密码' }, 400);
    if (confirmation !== '注销账号') return json({ success: false, error: '请输入“注销账号”确认操作' }, 400);
    if (!user.passwordHash || !(await verifyPassword(password, user.passwordHash))) {
      return json({ success: false, error: '当前密码错误' }, 400);
    }

    const keys = await scanUserKeys(env, session.id);
    const username = String(user.username || '').trim().toLowerCase();
    if (username) keys.push(`user:username:${encodeURIComponent(username)}`);

    const uniqueKeys = [...new Set(keys)].filter(Boolean);
    for (let i = 0; i < uniqueKeys.length; i += 50) {
      const batch = uniqueKeys.slice(i, i + 50);
      if (batch.length) await redisCommand(env, ['DEL', ...batch]);
    }

    // 保留一个极小的注销标记，用于阻止旧会话继续访问；不含密码、姓名等个人资料。
    await redisCommand(env, ['SET', `user:deleted:${session.id}`, '1', 'EX', '86400']);

    return new Response(JSON.stringify({ success: true, message: '账号已注销' }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Set-Cookie': clearSessionCookie()
      }
    });
  } catch (error) {
    console.error('delete account error', error);
    return json({ success: false, error: '注销服务异常，请稍后重试' }, 500);
  }
}

async function scanUserKeys(env, userId) {
  const prefix = `user:${userId}:`;
  const keys = [];
  let cursor = '0';
  for (let round = 0; round < MAX_SCAN_ROUNDS; round++) {
    const result = await redisCommand(env, ['SCAN', cursor, 'MATCH', `${prefix}*`, 'COUNT', SCAN_COUNT]);
    cursor = String(result?.[0] ?? '0');
    if (Array.isArray(result?.[1])) keys.push(...result[1]);
    if (cursor === '0') break;
  }
  if (cursor !== '0') throw new Error('用户数据量过大，注销未完成');
  return keys;
}

async function verifyPassword(password, encoded) {
  try {
    const value = String(encoded || '');
    let iterations = 100000;
    let salt, stored;
    const parts = value.split('$');
    if (parts.length === 3 && parts[0] === 'pbkdf2-sha256') {
      iterations = Number(parts[1]);
      [salt, stored] = parts[2].split(':');
    } else {
      [salt, stored] = value.split(':');
    }
    if (!salt || !stored || !Number.isInteger(iterations) || iterations < 1 || iterations > 100000) return false;
    const derived = await derivePassword(password, decodeBase64(salt), iterations);
    return timingSafeEqual(derived, decodeBase64(stored));
  } catch { return false; }
}

async function derivePassword(password, salt, iterations) {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, material, 256);
  return new Uint8Array(bits);
}
function decodeBase64(value) { const raw = atob(String(value || '')); return Uint8Array.from(raw, char => char.charCodeAt(0)); }
function timingSafeEqual(a, b) { if (a.length !== b.length) return false; let diff = 0; for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]; return diff === 0; }
function parseRecord(value) { if (!value) return null; if (typeof value !== 'string') return value; try { const first = JSON.parse(value); return typeof first === 'string' ? JSON.parse(first) : first; } catch { return null; } }
function redisReady(env) { return Boolean(String(env.UPSTASH_REDIS_REST_URL || '').trim() && String(env.UPSTASH_REDIS_REST_TOKEN || '').trim()); }
function json(payload, status = 200) { return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } }); }
