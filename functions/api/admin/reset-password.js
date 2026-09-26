// 智配One V1.0 - 系统管理员重置用户密码
import { requireSystemAdmin } from '../_auth.js';
import { redisGet, redisSet, recordAdminLog } from '../_data.js';

export async function onRequest({ request, env }) {
  const admin = await requireSystemAdmin(request, env);
  if (!admin) return json({ success: false, error: '无系统管理权限' }, 403);
  if (request.method !== 'POST') return json({ success: false, error: 'Method not allowed' }, 405);

  try {
    const body = await request.json().catch(() => ({}));
    const userId = String(body.userId || '').trim();
    const password = String(body.password || '');
    if (!userId) return json({ success: false, error: '缺少 userId' }, 400);
    if (password.length < 6 || password.length > 72) return json({ success: false, error: '密码需为6-72位' }, 400);

    const user = await redisGet(env, 'user:' + userId);
    if (!user) return json({ success: false, error: '用户不存在' }, 404);
    user.passwordHash = await hashPassword(password);
    user.updatedAt = new Date().toISOString();
    user.sessionVersion = Number(user.sessionVersion || 1) + 1;
    await redisSet(env, 'user:' + userId, user);
    await recordAdminLog(env, admin, 'reset_password', 'user', userId);

    return json({ success: true, message: '密码已重置，旧设备会话已全部失效' });
  } catch (error) {
    console.error('admin reset password error', error);
    return json({ success: false, error: error?.message || '密码重置失败' }, 503);
  }
}

async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const iterations = 100000;
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, material, 256);
  return 'pbkdf2-sha256$' + iterations + '$' + base64(salt) + ':' + base64(new Uint8Array(bits));
}
function base64(bytes) { let binary=''; for (const byte of bytes) binary += String.fromCharCode(byte); return btoa(binary); }
function json(payload,status=200){return new Response(JSON.stringify(payload),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}});}
