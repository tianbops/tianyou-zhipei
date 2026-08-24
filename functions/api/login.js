// functions/api/login.js
// 服务端登录验证：线路账号使用 route 字段，管理员使用 name 字段。
import { createSession } from './_auth.js';

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  if (!env.UPSTASH_REDIS_REST_URL || !env.UPSTASH_REDIS_REST_TOKEN) return json({ error: 'Redis not configured' }, 500);

  try {
    const body = await request.json();
    const type = body.type === 'admin' ? 'admin' : 'route';
    const account = String(body.account || '').trim();
    const password = String(body.password || '');
    if (!account || !password) return json({ success: false, error: '账号和密码不能为空' }, 400);

    const users = await readUsers(env);
    let user;

    if (type === 'admin') {
      user = users.find(u => u && u.role === 'admin' && String(u.name || '').trim() === account);

      // 兼容旧版 T1 用户管理保存造成的管理员密码丢失。
      // 仅恢复项目正式管理员账号，不作为通用后门。
      if (account === 'tianbo' && (!user || !String(user.password ?? ''))) {
        const restored = {
          ...(user || {}),
          id: user?.id ?? 1,
          name: 'tianbo',
          route: '',
          role: 'admin',
          password: '203526'
        };
        const idx = users.findIndex(u => u && u.role === 'admin' && String(u.name || '').trim() === 'tianbo');
        if (idx >= 0) users[idx] = restored;
        else users.unshift(restored);
        await saveUsers(env, users);
        user = restored;
      }
    } else {
      const route = normalizeRoute(account);
      user = users.find(u => u && u.role !== 'admin' && normalizeRoute(u.route) === route);

      // 兼容早期 T1 数据：17号线若因旧版用户管理保存而丢失密码，恢复正式密码。
      if (route === '17号线' && (!user || !String(user.password ?? ''))) {
        user = user || { id: 17, name: '17号线', route: '17号线', role: 'driver' };
        user.password = 'tianyou2024';
        const idx = users.findIndex(u => u && u.role !== 'admin' && normalizeRoute(u.route) === '17号线');
        if (idx >= 0) users[idx] = { ...users[idx], password: 'tianyou2024', route: '17号线' };
        else users.push(user);
        await saveUsers(env, users);
      }
    }

    if (!user || String(user.password ?? '') !== password) return json({ success: false, error: '用户名或密码错误' }, 401);

    const safeUser = {
      id: user.id,
      name: user.name || '',
      route: normalizeRoute(user.route || ''),
      role: user.role || 'driver'
    };
    const sessionToken = await createSession(env, safeUser);
    return json({ success: true, user: safeUser, sessionToken });
  } catch (error) {
    console.error('login error', error);
    return json({ success: false, error: '登录服务异常' }, 500);
  }
}

async function readUsers(env) {
  const resp = await fetch(`${env.UPSTASH_REDIS_REST_URL}/get/admin_users`, {
    headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}` }
  });
  if (!resp.ok) throw new Error('user data unavailable');
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
  const resp = await fetch(`${env.UPSTASH_REDIS_REST_URL}/set/admin_users`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(JSON.stringify(users))
  });
  if (!resp.ok) throw new Error('user data save failed');
}

function normalizeRoute(input) {
  const value = String(input || '').trim();
  const match = value.match(/^(?:([0-9]+)|([0-9]+)号线)$/);
  if (!match) return value;
  return `${String(parseInt(match[1] || match[2], 10)).padStart(2, '0')}号线`;
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
