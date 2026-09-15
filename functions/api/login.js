// functions/api/login.js
// 当前测试版本：仅支持17号线司机登录。
import { createSession, sessionCookie } from './_auth.js';
import { hashPassword, verifyPassword, isPasswordHash } from './_password.js';

const REDIS_KEY = 'admin_users';
const TEST_ROUTE = '17号线';
const TEST_ROUTE_HASH = 'pbkdf2-sha256$310000$VFkxN1Rlc3RTYWx0MjAyNiE=$2lucRjE0g4HUgM0WswyvwwGAZQOQi6kMezfOBotXlRY=';

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method !== 'POST') {
    return json({ success: false, error: 'Method not allowed' }, 405);
  }

  if (!env.UPSTASH_REDIS_REST_URL || !env.UPSTASH_REDIS_REST_TOKEN) {
    return json({ success: false, error: 'Redis 未配置，登录服务暂不可用' }, 500);
  }

  try {
    const body = await request.json().catch(() => ({}));
    const password = String(body.password || '');
    const route = normalizeRoute(body.account || '');

    if (!password) {
      return json({ success: false, error: '密码不能为空' }, 400);
    }

    if (route !== TEST_ROUTE) {
      return json({ success: false, error: '当前系统仅开放17号线' }, 401);
    }

    let users = await readUsers(env);
    let user = users.find(u => u && u.role !== 'admin' && normalizeRoute(u.route) === TEST_ROUTE);

    let valid = false;
    if (user?.passwordHash && isPasswordHash(user.passwordHash)) {
      valid = await verifyPassword(password, user.passwordHash);
    }
    if (!valid && user?.password !== undefined) {
      valid = String(user.password) === password;
    }
    if (!valid && user?.initialPassword) {
      valid = String(user.initialPassword) === password;
    }
    if (!valid) {
      const configured = String(env.DEFAULT_DRIVER_PASSWORD || env.DEFAULT_UNIFIED_PASSWORD || '');
      if (configured && configured === password) valid = true;
    }
    if (!valid) {
      valid = await verifyPassword(password, TEST_ROUTE_HASH);
    }

    if (!valid) {
      return json({ success: false, error: '密码错误' }, 401);
    }

    // 账号不存在或旧版本账号结构异常时，自动恢复17号线测试账号。
    if (!user || !isPasswordHash(user.passwordHash)) {
      const next = {
        id: 17,
        name: TEST_ROUTE,
        route: TEST_ROUTE,
        role: 'driver',
        passwordHash: TEST_ROUTE_HASH,
        sessionVersion: Number(user?.sessionVersion || 1) + 1,
        createdAt: user?.createdAt || new Date().toISOString()
      };
      users = users.filter(u =>
        String(u?.id) !== '17' && normalizeRoute(u?.route || '') !== TEST_ROUTE
      );
      users.push(next);
      user = next;
      await saveUsers(env, users);
    }

    const safeUser = {
      id: user.id,
      name: TEST_ROUTE,
      route: TEST_ROUTE,
      role: 'driver'
    };

    const token = await createSession(env, {
      ...safeUser,
      sessionVersion: Number(user.sessionVersion || 1)
    });

    return new Response(JSON.stringify({ success: true, user: safeUser }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json;charset=utf-8',
        'Cache-Control': 'no-store',
        'Set-Cookie': sessionCookie(token)
      }
    });
  } catch (error) {
    console.error('login error', error);
    return json({ success: false, error: '登录服务异常：' + (error?.message || 'unknown') }, 500);
  }
}

async function readUsers(env) {
  const resp = await fetch(`${env.UPSTASH_REDIS_REST_URL}/get/${REDIS_KEY}`, {
    headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}` },
    cache: 'no-store'
  });
  if (!resp.ok) throw new Error('用户数据读取失败');
  const data = await resp.json();
  if (!data.result) return [];
  try {
    const users = JSON.parse(data.result);
    return Array.isArray(users) ? users : [];
  } catch {
    return [];
  }
}

async function saveUsers(env, users) {
  const resp = await fetch(`${env.UPSTASH_REDIS_REST_URL}/set/${REDIS_KEY}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(JSON.stringify(users)),
    cache: 'no-store'
  });
  if (!resp.ok) throw new Error('用户数据保存失败');
}

function normalizeRoute(value) {
  const s = String(value || '').trim();
  const m = s.match(/^(?:([0-9]+)|([0-9]+)号线)$/);
  return m ? `${String(parseInt(m[1] || m[2], 10)).padStart(2, '0')}号线` : s;
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json;charset=utf-8',
      'Cache-Control': 'no-store'
    }
  });
}
