// functions/api/login.js
import { createSession, sessionCookie } from './_auth.js';
import { hashPassword, verifyPassword, isPasswordHash } from './_password.js';

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== 'POST') return json({ success:false, error: 'Method not allowed' }, 405);
  if (!env.UPSTASH_REDIS_REST_URL || !env.UPSTASH_REDIS_REST_TOKEN) return json({ success:false, error: 'Redis 未配置，登录服务暂不可用' }, 500);
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
    } else {
      const route = normalizeRoute(account);
      user = users.find(u => u && u.role !== 'admin' && normalizeRoute(u.route) === route);
    }
    if (!user) return json({ success: false, error: '用户名或密码错误' }, 401);

    let valid = false;
    if (isPasswordHash(user.passwordHash)) {
      valid = await verifyPassword(password, user.passwordHash);
    } else if (Object.prototype.hasOwnProperty.call(user, 'password')) {
      // 兼容旧账号的明文密码。
      valid = String(user.password || '') === password;
    }
    if (!valid) return json({ success: false, error: '用户名或密码错误' }, 401);

    // 登录不能因为“旧密码迁移”失败而被阻断。
    // 迁移采用最佳努力方式，并保持 sessionVersion 不变，避免刚登录就被旧 Session 校验拒绝。
    if (!isPasswordHash(user.passwordHash) && Object.prototype.hasOwnProperty.call(user, 'password')) {
      try {
        const migratedHash = await hashPassword(password);
        const migratedUsers = users.map(item => {
          if (String(item?.id) !== String(user.id)) return item;
          const next = { ...item, passwordHash: migratedHash };
          delete next.password;
          return next;
        });
        await saveUsers(env, migratedUsers);
        user = migratedUsers.find(item => String(item?.id) === String(user.id)) || user;
      } catch (migrationError) {
        console.warn('password migration skipped; login will continue:', migrationError?.message || migrationError);
      }
    }

    const safeUser = {
      id: user.id,
      name: user.name || '',
      route: normalizeRoute(user.route || ''),
      role: user.role || 'driver'
    };

    // 如果迁移保存失败，当前内存中的用户仍保持原 sessionVersion。
    const token = await createSession(env, {
      ...safeUser,
      sessionVersion: Number(user.sessionVersion || 1)
    });

    return new Response(JSON.stringify({ success: true, user: safeUser }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
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
  const resp = await fetch(`${env.UPSTASH_REDIS_REST_URL}/get/admin_users`, {
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
  const resp = await fetch(`${env.UPSTASH_REDIS_REST_URL}/set/admin_users`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(JSON.stringify(users)),
    cache: 'no-store'
  });
  if (!resp.ok) throw new Error('用户数据迁移保存失败');
  const data = await resp.json().catch(() => ({}));
  if (data.result !== undefined && data.result !== 'OK') throw new Error('用户数据迁移未确认');
}

function normalizeRoute(input) {
  const value = String(input || '').trim();
  const match = value.match(/^(?:([0-9]+)|([0-9]+)号线)$/);
  return match ? `${String(parseInt(match[1] || match[2], 10)).padStart(2, '0')}号线` : value;
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
