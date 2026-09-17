// 天友智配One - 司机登录
// 登录凭据只从 Cloudflare Variables / Secrets 读取。
// Redis 保存用户资料，不保存密码。
import { createSession, sessionCookie } from './_auth.js';

export async function onRequest({ request, env }) {
  if (request.method !== 'POST') return json({ success: false, error: 'Method not allowed' }, 405);
  if (!env.UPSTASH_REDIS_REST_URL || !env.UPSTASH_REDIS_REST_TOKEN) return json({ success: false, error: 'Redis 未配置，登录服务暂不可用' }, 500);
  if (!env.SESSION_SECRET) return json({ success: false, error: 'SESSION_SECRET 未配置，登录服务暂不可用' }, 500);

  const configuredUsername = String(env.DRIVER_USERNAME || '').trim();
  const configuredPassword = String(env.DRIVER_PASSWORD || '');
  const configuredRoute = normalizeRoute(env.DRIVER_ROUTE);
  if (!configuredUsername || !configuredPassword || !configuredRoute) return json({ success: false, error: '登录配置不完整，请检查 DRIVER_USERNAME / DRIVER_PASSWORD / DRIVER_ROUTE' }, 500);

  try {
    const body = await request.json().catch(() => ({}));
    const username = String(body.username || body.account || '').trim();
    const password = String(body.password || '');
    if (!username) return json({ success: false, error: '用户名不能为空' }, 400);
    if (!password) return json({ success: false, error: '密码不能为空' }, 400);
    if (username !== configuredUsername || password !== configuredPassword) return json({ success: false, error: '用户名或密码错误' }, 401);

    const driverKey = `driver:${configuredRoute}`;
    const existing = await readDriver(env, driverKey);
    const driver = {
      id: String(existing?.id || `route-${configuredRoute}`),
      username: configuredUsername,
      name: String(existing?.name || configuredUsername),
      route: configuredRoute,
      vehicle: String(existing?.vehicle || ''),
      sessionVersion: Number(existing?.sessionVersion || 1),
      createdAt: existing?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    await writeDriver(env, driverKey, driver);
    const token = await createSession(env, driver);
    const safeUser = { id: driver.id, username: driver.username, name: driver.name, route: driver.route, vehicle: driver.vehicle };

    return new Response(JSON.stringify({ success: true, user: safeUser }), {
      status: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Set-Cookie': sessionCookie(token) }
    });
  } catch (error) {
    console.error('login error', error);
    return json({ success: false, error: '登录服务异常，请稍后重试' }, 500);
  }
}

async function readDriver(env, key) {
  const response = await fetch(`${env.UPSTASH_REDIS_REST_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}` },
    cache: 'no-store'
  });
  if (!response.ok) throw new Error('司机资料读取失败');
  const data = await response.json().catch(() => ({}));
  if (!data.result) return null;
  try { return typeof data.result === 'string' ? JSON.parse(data.result) : data.result; } catch { return null; }
}

async function writeDriver(env, key, driver) {
  const response = await fetch(`${env.UPSTASH_REDIS_REST_URL}/set/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(JSON.stringify(driver)),
    cache: 'no-store'
  });
  if (!response.ok) throw new Error('司机资料保存失败');
  const data = await response.json().catch(() => ({}));
  if (data.result !== undefined && data.result !== 'OK') throw new Error('司机资料保存未确认');
}

function normalizeRoute(value) {
  const s = String(value || '').trim();
  const m = s.match(/^(?:([0-9]+)|([0-9]+)号线)$/);
  return m ? `${String(parseInt(m[1] || m[2], 10)).padStart(2, '0')}号线` : s;
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
}
