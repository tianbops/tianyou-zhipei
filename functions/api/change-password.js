// 智配One - 修改登录密码
// 修改密码必须验证当前密码；新密码仅保存 PBKDF2-SHA256 哈希，不保存明文。
import { authRequired } from './_auth.js';
import { redisCommand } from './_data.js';

export async function onRequest({ request, env }) {
  if (request.method !== 'POST') return json({ success: false, error: 'Method not allowed' }, 405);
  if (!redisReady(env)) return json({ success: false, error: '密码服务未配置，请检查 Upstash 配置' }, 500);

  const session = await authRequired(request, env);
  if (!session) return json({ success: false, error: '登录已失效，请重新登录' }, 401);

  try {
    const user = parseRecord(await redisCommand(env, ['GET', `user:${session.id}`]));
    if (!user || user.status === 'disabled') return json({ success: false, error: '用户不存在或已停用' }, 401);

    const body = await request.json().catch(() => ({}));
    const currentPassword = String(body.currentPassword || '');
    const newPassword = String(body.newPassword || '');
    const confirmPassword = String(body.confirmPassword || '');

    if (!currentPassword) return json({ success: false, error: '请输入当前密码' }, 400);
    if (!user.passwordHash || !(await verifyPassword(currentPassword, user.passwordHash))) {
      return json({ success: false, error: '当前密码错误' }, 400);
    }
    if (newPassword.length < 6 || newPassword.length > 72) return json({ success: false, error: '新密码需为6-72位' }, 400);
    if (newPassword !== confirmPassword) return json({ success: false, error: '两次输入的新密码不一致' }, 400);
    if (newPassword === currentPassword) return json({ success: false, error: '新密码不能与当前密码相同' }, 400);

    const passwordHash = await hashPassword(newPassword);
    const updated = {
      ...user,
      passwordHash,
      updatedAt: new Date().toISOString(),
      sessionVersion: Number(user.sessionVersion || 1) + 1
    };
    const saved = await redisCommand(env, ['SET', `user:${session.id}`, JSON.stringify(updated)]);
    if (saved !== 'OK') return json({ success: false, error: '密码修改失败，请稍后重试' }, 500);

    return json({ success: true, message: '密码修改成功' });
  } catch (error) {
    console.error('change password error', error);
    return json({ success: false, error: '密码服务异常，请稍后重试' }, 500);
  }
}

async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const iterations = 100000;
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, material, 256);
  return `pbkdf2-sha256$${iterations}$${base64(salt)}:${base64(new Uint8Array(bits))}`;
}

async function verifyPassword(password, encoded) {
  try {
    const value = String(encoded || '');
    let iterations = 100000;
    let salt;
    let stored;
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

function decodeBase64(value) {
  const raw = atob(String(value || ''));
  return Uint8Array.from(raw, char => char.charCodeAt(0));
}
function base64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
function parseRecord(value) {
  if (!value) return null;
  if (typeof value !== 'string') return value;
  try { const first = JSON.parse(value); return typeof first === 'string' ? JSON.parse(first) : first; } catch { return null; }
}
function redisReady(env) { return Boolean(String(env.UPSTASH_REDIS_REST_URL || '').trim() && String(env.UPSTASH_REDIS_REST_TOKEN || '').trim()); }
function json(payload, status = 200) { return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } }); }
