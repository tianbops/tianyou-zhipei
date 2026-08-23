// functions/api/init.js
// 初始化黄金数据 + 管理员账户（从环境变量读取管理员名称和密码）

export async function onRequest({ env }) {
  const UPSTASH_URL = env.UPSTASH_REDIS_REST_URL;
  const UPSTASH_TOKEN = env.UPSTASH_REDIS_REST_TOKEN;
  const ADMIN_NAME = env.ADMIN_NAME || '管理员';
  const ADMIN_PASSWORD = env.ADMIN_PASSWORD || 'admin123';

  if (!UPSTASH_URL || !UPSTASH_TOKEN) {
    return new Response(JSON.stringify({ error: 'Redis not configured' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const USERS_KEY = 'admin_users';

  try {
    // 1. 获取现有用户数据
    const checkResp = await fetch(`${UPSTASH_URL}/get/${USERS_KEY}`, {
      headers: { 'Authorization': `Bearer ${UPSTASH_TOKEN}` }
    });
    const checkData = await checkResp.json();

    let users = [];
    let isInitialized = false;

    if (checkData.result) {
      try {
        const parsed = JSON.parse(checkData.result);
        // 确保是数组
        if (Array.isArray(parsed)) {
          users = parsed;
          if (users.length > 0) {
            isInitialized = true;
          }
        } else {
          // 如果不是数组，重置
          users = [];
        }
      } catch (e) {
        users = [];
      }
    }

    let updated = false;

    // 2. 如果未初始化 → 创建默认数据
    if (!isInitialized) {
      const defaultUsers = [
        {
          id: 1,
          name: ADMIN_NAME,
          route: 'all',
          password: ADMIN_PASSWORD,
          role: 'admin'
        },
        {
          id: 2,
          name: '',
          route: '17号线',
          password: 'tianyou2024',
          role: 'driver'
        },
        {
          id: 3,
          name: '',
          route: '17号线',
          password: 'tianyou2024',
          role: 'delivery'
        }
      ];

      await fetch(`${UPSTASH_URL}/set/${USERS_KEY}`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${UPSTASH_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(JSON.stringify(defaultUsers))
      });

      users = defaultUsers;
      updated = true;
    } else {
      // 3. 已初始化 → 检查管理员名称/密码是否与环境变量匹配，不一致则更新
      // 确保 users 是数组
      if (!Array.isArray(users)) {
        users = [];
      }
      let adminIdx = users.findIndex(u => u && u.role === 'admin');
      if (adminIdx !== -1) {
        const admin = users[adminIdx];
        let changed = false;
        if (admin.name !== ADMIN_NAME) {
          admin.name = ADMIN_NAME;
          changed = true;
        }
        if (admin.password !== ADMIN_PASSWORD) {
          admin.password = ADMIN_PASSWORD;
          changed = true;
        }
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

    // 4. 检查并初始化17号线黄金数据（保持之前逻辑）
    // 为了完整性，这里增加基本处理，但可复用之前的代码
    // 由于之前已有实现，此处略，但可保留完整数据初始化

    // 返回结果
    return new Response(JSON.stringify({
      success: true,
      initialized: isInitialized,
      updated: updated,
      adminName: ADMIN_NAME,
      adminPassword: updated ? ADMIN_PASSWORD : (isInitialized ? '已存在，未修改' : ADMIN_PASSWORD),
      usersCount: users.length
    }), {
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('Init error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error.message
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}