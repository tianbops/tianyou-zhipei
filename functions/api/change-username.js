// 智配One - 更改登录账号
// 更改账号必须验证当前密码，并原子占用新账号名。
import { authRequired, createSession, sessionCookie } from './_auth.js';
import { publicUser, redisCommand } from './_data.js';

export async function onRequest({ request, env }) {
  if (request.method !== 'POST') return json({ success: false, error: 'Method not allowed' }, 405);
  if (!redisReady(env)) return json({ success: false, error: '账号服务未配置，请检查 Upstash 配置' }, 500);
  if (!env.SESSION_SECRET) return json({ success: false, error: 'SESSION_SECRET 未配置，账号服务暂不可用' }, 500);

  const session = await authRequired(request, env);
  if (!session) return json({ success: false, error: '登录已失效，请重新登录' }, 401);

  try {
    const user = parseRecord(await redisCommand(env, ['GET', `user:${session.id}`]));
    if (!user || user.status === 'disabled') return json({ success: false, error: '用户不存在或已停用' }, 401);

    const body = await request.json().catch(() => ({}));
    const newUsername = normalizeUsername(body.newUsername);
    const password = String(body.password || '');
    const oldUsername = normalizeUsername(user.username);

    if (!/^[a-z0-9_]{3,32}$/.test(newUsername)) return json({ success: false, error: '新账号需为3-32位字母、数字或下划线' }, 400);
    if (!password) return json({ success: false, error: '请输入当前密码' }, 400);
    if (newUsername === oldUsername) return json({ success: false, error: '新账号不能与当前账号相同' }, 400);
    if (!user.passwordHash || !(await verifyPassword(password, user.passwordHash))) return json({ success: false, error: '当前密码错误' }, 400);

    const newKey = `user:username:${encodeURIComponent(newUsername)}`;
    const oldKey = `user:username:${encodeURIComponent(oldUsername)}`;
    const claim = await redisCommand(env, ['SET', newKey, String(user.id), 'NX']);
    if (claim !== 'OK') return json({ success: false, error: '新账号已存在，请换一个账号' }, 409);

    const updated = {
      ...user,
      username: newUsername,
      name: user.name === oldUsername ? newUsername : String(user.name || newUsername),
      updatedAt: new Date().toISOString(),
      sessionVersion: Number(user.sessionVersion || 1) + 1
    };

    try {
      const saved = await redisCommand(env, ['SET', `user:${user.id}`, JSON.stringify(updated)]);
      if (saved !== 'OK') throw new Error('用户保存失败');
      await redisCommand(env, ['DEL', oldKey]);
    } catch (error) {
      await redisCommand(env, ['DEL', newKey]).catch(() => {});
      throw error;
    }

    const safeUser = publicUser(updated);
    const token = await createSession(env, safeUser);
    return new Response(JSON.stringify({ success: true, user: safeUser }), {
      status: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Set-Cookie': sessionCookie(token) }
    });
  } catch (error) {
    console.error('change username error', error);
    return json({ success: false, error: '账号服务异常，请稍后重试' }, 500);
  }
}

function normalizeUsername(value) { return String(value || '').trim().toLowerCase(); }
function parseRecord(value) { if (!value) return null; if (typeof value !== 'string') return value; try { const first = JSON.parse(value); return typeof first === 'string' ? JSON.parse(first) : first; } catch { return null; } }
async function verifyPassword(password, encoded) { try { const value = String(encoded || ''); let iterations = 100000; let salt; let stored; const parts = value.split('$'); if (parts.length === 3 && parts[0] === 'pbkdf2-sha256') { iterations = Number(parts[1]); [salt, stored] = parts[2].split(':'); } else { [salt, stored] = value.split(':'); } if (!salt || !stored || !Number.isInteger(iterations) || iterations < 1 || iterations > 100000) return false; const derived = await derivePassword(password, decodeBase64(salt), iterations); return timingSafeEqual(derived, decodeBase64(stored)); } catch { return false; } }
async function derivePassword(password, salt, iterations) { const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']); const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, material, 256); return new Uint8Array(bits); }
function decodeBase64(value) { const raw = atob(String(value || '')); return Uint8Array.from(raw, char => char.charCodeAt(0)); }
function timingSafeEqual(a, b) { if (a.length !== b.length) return false; let diff = 0; for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]; return diff === 0; }
function redisReady(env) { return Boolean(String(env.UPSTASH_REDIS_REST_URL || '').trim() && String(env.UPSTASH_REDIS_REST_TOKEN || '').trim()); }
function json(payload, status = 200) { return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } }); }
