// 天友智配One - 用户资料设置
import { authRequired, createSession, sessionCookie } from './_auth.js';

export async function onRequest({ request, env }) {
  if (!redisReady(env)) return json({ success: false, error: '资料服务未配置，请检查 Upstash 配置' }, 500);
  const session = await authRequired(request, env);
  if (!session) return json({ success: false, error: '登录已失效' }, 401);

  try {
    const user = parseRecord(await redisGet(env, `user:${session.id}`));
    if (!user || user.status === 'disabled') return json({ success: false, error: '用户不存在或已停用' }, 401);

    if (request.method === 'GET') return json({ success: true, user: publicUser(user) });
    if (request.method !== 'PUT') return json({ success: false, error: 'Method not allowed' }, 405);

    const body = await request.json().catch(() => ({}));
    const name = String(body.name || '').trim();
    const route = normalizeRoute(body.route);
    const vehicle = String(body.vehicle || '').trim();

    if (!name) return json({ success: false, error: '请输入姓名' }, 400);
    if (name.length > 40) return json({ success: false, error: '姓名不能超过40个字符' }, 400);
    if (!route || !/^\d{2,3}号线$/.test(route)) return json({ success: false, error: '请输入有效线路，例如 17号线' }, 400);
    if (vehicle.length > 30) return json({ success: false, error: '车辆信息不能超过30个字符' }, 400);

    const currentRoute = normalizeRoute(user.route);

    const updated = { ...user, name, route, vehicle, updatedAt: new Date().toISOString(), sessionVersion: Number(user.sessionVersion || 1) + 1 };
    if (!await redisSet(env, `user:${session.id}`, updated)) {
      return json({ success: false, error: '资料保存失败，请稍后重试' }, 500);
    }

    const safeUser = publicUser(updated);
    const token = await createSession(env, updated);
    return new Response(JSON.stringify({ success: true, user: safeUser }), {
      status: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Set-Cookie': sessionCookie(token) }
    });
  } catch (error) {
    console.error('profile error', error);
    return json({ success: false, error: '资料服务异常，请稍后重试' }, 500);
  }
}

function publicUser(user) {
  return { id: String(user.id), username: String(user.username), name: String(user.name || user.username), route: normalizeRoute(user.route), vehicle: String(user.vehicle || '') };
}
function normalizeRoute(value) {
  const s = String(value || '').trim();
  const m = s.match(/^(?:([0-9]+)|([0-9]+)号线)$/);
  return m ? `${String(parseInt(m[1] || m[2], 10)).padStart(2, '0')}号线` : s;
}
function parseRecord(value) {
  if (!value) return null;
  if (typeof value !== 'string') return value;
  try { const first = JSON.parse(value); return typeof first === 'string' ? JSON.parse(first) : first; } catch { return null; }
}
async function redisGet(env, key) {
  const response = await fetch(`${env.UPSTASH_REDIS_REST_URL}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}` }, cache: 'no-store' });
  if (!response.ok) throw new Error('Redis 读取失败');
  const data = await response.json().catch(() => ({}));
  return data.result || null;
}
async function redisSetNx(env, key, value) {
  const response = await fetch(`${env.UPSTASH_REDIS_REST_URL}/set/${encodeURIComponent(key)}/${encodeURIComponent(value)}/NX`, { method: 'POST', headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}` }, cache: 'no-store' });
  if (!response.ok) throw new Error('Redis 写入失败');
  const data = await response.json().catch(() => ({}));
  return data.result === 'OK';
}
async function redisSet(env, key, value) {
  const response = await fetch(`${env.UPSTASH_REDIS_REST_URL}/set/${encodeURIComponent(key)}`, { method: 'POST', headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(value), cache: 'no-store' });
  const data = await response.json().catch(() => ({}));
  return response.ok && (data.result === undefined || data.result === 'OK');
}
async function redisDelete(env, key) {
  await fetch(`${env.UPSTASH_REDIS_REST_URL}/del/${encodeURIComponent(key)}`, { method: 'POST', headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}` }, cache: 'no-store' }).catch(() => {});
}
function redisReady(env) { return Boolean(env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN); }
function json(payload, status = 200) { return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } }); }
