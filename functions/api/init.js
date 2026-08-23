// functions/api/init.js
export async function onRequest({ env }) {
  try {
    const UPSTASH_URL = env.UPSTASH_REDIS_REST_URL;
    const UPSTASH_TOKEN = env.UPSTASH_REDIS_REST_TOKEN;
    const ADMIN_NAME = env.ADMIN_NAME || '管理员';
    const ADMIN_PASSWORD = env.ADMIN_PASSWORD || 'admin123';

    if (!UPSTASH_URL || !UPSTASH_TOKEN) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Upstash credentials missing. Please set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.'
      }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }

    const USERS_KEY = 'admin_users';
    let users = [];
    let isInitialized = false;

    // 获取现有数据（失败视为未初始化）
    try {
      const resp = await fetch(`${UPSTASH_URL}/get/${USERS_KEY}`, {
        headers: { 'Authorization': `Bearer ${UPSTASH_TOKEN}` }
      });
      if (resp.ok) {
        const data = await resp.json();
        if (data.result) {
          const parsed = JSON.parse(data.result);
          if (Array.isArray(parsed) && parsed.length) {
            users = parsed;
            isInitialized = true;
          }
        }
      }
    } catch (e) {
      // 忽略网络错误，继续初始化
    }

    let updated = false;

    if (!isInitialized) {
      const defaultUsers = [
        { id: 1, name: ADMIN_NAME, route: 'all', password: ADMIN_PASSWORD, role: 'admin' },
        { id: 2, name: '', route: '17号线', password: 'tianyou2024', role: 'driver' },
        { id: 3, name: '', route: '17号线', password: 'tianyou2024', role: 'delivery' }
      ];
      const saveResp = await fetch(`${UPSTASH_URL}/set/${USERS_KEY}`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${UPSTASH_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(JSON.stringify(defaultUsers))
      });
      if (!saveResp.ok) {
        return new Response(JSON.stringify({ success: false, error: 'Failed to save default users' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      users = defaultUsers;
      updated = true;
    } else {
      // 更新管理员信息（如果变化）
      const adminIdx = users.findIndex(u => u?.role === 'admin');
      if (adminIdx !== -1) {
        const admin = users[adminIdx];
        let changed = false;
        if (admin.name !== ADMIN_NAME) { admin.name = ADMIN_NAME; changed = true; }
        if (admin.password !== ADMIN_PASSWORD) { admin.password = ADMIN_PASSWORD; changed = true; }
        if (changed) {
          users[adminIdx] = admin;
          await fetch(`${UPSTASH_URL}/set/${USERS_KEY}`, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${UPSTASH_TOKEN}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify(JSON.stringify(users))
          });
          updated = true;
        }
      }
    }

    return new Response(JSON.stringify({
      success: true,
      initialized: isInitialized,
      updated: updated,
      adminName: ADMIN_NAME,
      usersCount: users.length
    }), { headers: { 'Content-Type': 'application/json' } });

  } catch (error) {
    console.error('Init error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error.message || 'Internal error'
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
}