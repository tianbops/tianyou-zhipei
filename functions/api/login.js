// functions/api/login.js
// 17号线司机登录：用户名和密码由 Cloudflare Variables / Secrets 控制。
import { createSession, sessionCookie } from './_auth.js';
import { hashPassword, verifyPassword, isPasswordHash } from './_password.js';

const REDIS_KEY = 'admin_users';
const TEST_ROUTE = '17号线';

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method !== 'POST') {
    return json({ success: false, error: 'Method not allowed' }, 405);
  }

  if (!env.UPSTASH_REDIS_REST_URL || !env.UPSTASH_REDIS_REST_TOKEN) {
    return json({ success: false, error: 'Redis 未配置，登录服务暂不可用' }, 500);
  }

  // 登录凭据只从 Cloudflare 环境变量/密钥读取，不再使用代码中的测试密码。
  const configuredUsername = String(env.DRIVER_USERNAME || '').trim();
  const configuredPassword = String(env.DRIVER_PASSWORD || '');

  if (!configuredUsername || !configuredPassword) {
    return json({ success: false, error: '登录密钥未配置，请检查 DRIVER_USERNAME / DRIVER_PASSWORD' }, 500);
  }

  try {
    const body = await request.json().catch(() => ({}));
    const username = String(body.username || body.account || '').trim();
    const password = String(body.password || '');

    if (!username) {
      return json({ success: false, error: '用户名不能为空' }, 400);
    }
    if (!password) {
      return json({ success: false, error: '密码不能为空' }, 400);
    }

    if (username !== configuredUsername || password !== configuredPassword) {
      return json({ success: false, error: '用户名或密码错误' }, 401);
    }

    let users = await readUsers(env);
    let user = users.find(u =>
      u &&
      u.role !== 'admin' &&
      normalizeRoute(u.route) === TEST_ROUTE &&
      String(u.username || '').trim() === configuredUsername
    );

    // 兼容旧版17号线司机账号：如果用户名字段尚未建立，则按17号线司机账号接管。
    if (!user) {
      user = users.find(u =>
        u && u.role !== 'admin' && normalizeRoute(u.route) === TEST_ROUTE
      );
    }

    const passwordHash = await hashPassword(configuredPassword);

    // 登录凭据以 Cloudflare 为准；Redis 只保存用于 Session 校验的用户资料。
    const next = {
      id: user?.id || 17,
      username: configuredUsername,
      name: configuredUsername,
      route: TEST_ROUTE,
      vehicle: '渝DK7692',
      role: 'driver',
      passwordHash,
      sessionVersion: Number(user?.sessionVersion || 1),
      createdAt: user?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    const oldIndex = users.findIndex(u => String(u?.id) === String(next.id));
    if (oldIndex >= 0) {
      users[oldIndex] = { ...users[oldIndex], ...next };
    } else {
      users.push(next);
    }
    user = next;
    await saveUsers(env, users);

    const safeUser = {
      id: user.id,
      username: configuredUsername,
      name: configuredUsername,
      route: TEST_ROUTE,
      vehicle: '渝DK7692',
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
