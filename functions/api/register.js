// 天友智配One - 用户注册
// 不设管理员。注册用户直接拥有自己的账号与线路基准库。
export async function onRequest({ request, env }) {
  if (request.method !== 'POST') return json({ success: false, error: 'Method not allowed' }, 405);
  if (!redisReady(env)) return json({ success: false, error: '注册服务未配置，请检查 Upstash 配置' }, 500);

  try {
    const body = await request.json().catch(() => ({}));
    const username = normalizeUsername(body.username);
    const password = String(body.password || '');
    const name = String(body.name || '').trim();
    const route = normalizeRoute(body.route);
    const vehicle = String(body.vehicle || '').trim();

    if (!/^[a-z0-9_]{3,32}$/.test(username)) return json({ success: false, error: '用户名需为3-32位字母、数字或下划线' }, 400);
    if (password.length < 6 || password.length > 72) return json({ success: false, error: '密码需为6-72位' }, 400);
    if (!route || !/^\d{2,3}号线$/.test(route)) return json({ success: false, error: '请输入有效线路，例如 17号线' }, 400);
    if (name.length > 40) return json({ success: false, error: '姓名不能超过40个字符' }, 400);
    if (vehicle.length > 30) return json({ success: false, error: '车辆信息不能超过30个字符' }, 400);

    const usernameKey = `user:username:${encodeURIComponent(username)}`;
    const routeKey = `user:route:${encodeURIComponent(route)}`;
    if (await redisGet(env, usernameKey)) return json({ success: false, error: '用户名已存在，请换一个用户名' }, 409);
    if (await redisGet(env, routeKey)) return json({ success: false, error: '该线路已注册，每条线路只能绑定一个用户' }, 409);

    const id = crypto.randomUUID();
    const passwordHash = await hashPassword(password);
    const now = new Date().toISOString();
    const user = {
      id,
      username,
      name: name || username,
      route,
      vehicle,
      passwordHash,
      status: 'active',
      sessionVersion: 1,
      createdAt: now,
      updatedAt: now
    };

    const userClaim = await redisSetNx(env, usernameKey, id);
    if (!userClaim) return json({ success: false, error: '用户名已存在，请换一个用户名' }, 409);

    const routeClaim = await redisSetNx(env, routeKey, id);
    if (!routeClaim) {
      await redisDelete(env, usernameKey);
      return json({ success: false, error: '该线路已注册，每条线路只能绑定一个用户' }, 409);
    }

    const saved = await redisSet(env, `user:${id}`, user);
    if (!saved) {
      await redisDelete(env, usernameKey);
      await redisDelete(env, routeKey);
      return json({ success: false, error: '用户保存失败，请稍后重试' }, 500);
    }

    return json({ success: true, user: { id, username, name: user.name, route, vehicle } }, 201);
  } catch (error) {
    console.error('register error', error);
    return json({ success: false, error: '注册服务异常，请稍后重试' }, 500);
  }
}

async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 120000, hash: 'SHA-256' }, material, 256);
  return `${base64(salt)}:${base64(new Uint8Array(bits))}`;
}

function base64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function redisGet(env, key) {
  const response = await fetch(`${env.UPSTASH_REDIS_REST_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}` }, cache: 'no-store'
  });
  if (!response.ok) throw new Error('Redis 读取失败');
  const data = await response.json().catch(() => ({}));
  return data.result || null;
}

async function redisSetNx(env, key, value) {
  const response = await fetch(`${env.UPSTASH_REDIS_REST_URL}/set/${encodeURIComponent(key)}/${encodeURIComponent(value)}/NX`, {
    method: 'POST', headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}` }, cache: 'no-store'
  });
  if (!response.ok) throw new Error('Redis 写入失败');
  const data = await response.json().catch(() => ({}));
  return data.result === 'OK';
}

async function redisSet(env, key, value) {
  const response = await fetch(`${env.UPSTASH_REDIS_REST_URL}/set/${encodeURIComponent(key)}`, {
    method: 'POST', headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(value), cache: 'no-store'
  });
  const data = await response.json().catch(() => ({}));
  return response.ok && (data.result === undefined || data.result === 'OK');
}

async function redisDelete(env, key) {
  await fetch(`${env.UPSTASH_REDIS_REST_URL}/del/${encodeURIComponent(key)}`, {
    method: 'POST', headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}` }, cache: 'no-store'
  }).catch(() => {});
}

function redisReady(env) { return Boolean(env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN); }
function normalizeUsername(value) { return String(value || '').trim().toLowerCase(); }
function normalizeRoute(value) {
  const s = String(value || '').trim();
  const m = s.match(/^(?:([0-9]+)|([0-9]+)号线)$/);
  return m ? `${String(parseInt(m[1] || m[2], 10)).padStart(2, '0')}号线` : s;
}
function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
}
