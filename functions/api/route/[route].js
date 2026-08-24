// functions/api/route/[route].js
// 天友智配One - 单线路基准门店数据库 API
// GET  /api/route/:route
// PUT  /api/route/:route

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    }
  });
}

function normalizeRoute(value) {
  const route = decodeURIComponent(String(value || '')).trim();
  const match = route.match(/^(\d+)号线$/);
  if (match) return `${String(parseInt(match[1], 10)).padStart(2, '0')}号线`;
  if (/^\d+$/.test(route)) return `${String(parseInt(route, 10)).padStart(2, '0')}号线`;
  return route;
}

function normalizeStores(stores) {
  if (!Array.isArray(stores)) return [];

  const seen = new Set();
  const result = [];

  stores.forEach((item, index) => {
    if (!item) return;

    const name = String(
      typeof item === 'string'
        ? item
        : item.name || item.storeName || item.shopName || item['门店名称'] || ''
    ).replace(/[\u3000]/g, ' ').trim();

    if (!name) return;

    const key = name
      .replace(/[\s，,。；;：:（）()【】\[\]]/g, '')
      .toLowerCase();

    if (!key || seen.has(key)) return;
    seen.add(key);

    const source = typeof item === 'object' ? item : {};
    result.push({
      code: String(source.code || source.index || index + 1).padStart(2, '0'),
      name,
      nav: String(source.nav || source.navigation || source.url || source.amap || source['导航'] || '').trim(),
      weight: source.weight ?? source['重量'] ?? 0,
      isNew: Boolean(source.isNew || source.newStore || source.is_new)
    });
  });

  result.forEach((store, index) => {
    store.code = String(index + 1).padStart(2, '0');
  });

  return result;
}

async function redisRequest(env, command, key, options = {}) {
  const url = env.UPSTASH_REDIS_REST_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) {
    throw new Error('UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN 未配置');
  }

  const endpoint = `${url.replace(/\/$/, '')}/${command}/${encodeURIComponent(key)}`;
  const response = await fetch(endpoint, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });

  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    throw new Error(data?.error || data?.message || `Upstash HTTP ${response.status}`);
  }

  return data;
}

export async function onRequest(context) {
  const { request, env, params } = context;
  const route = normalizeRoute(params?.route);

  if (!route) return json({ success: false, error: '缺少线路编号' }, 400);

  const key = `route:${route}`;

  try {
    if (request.method === 'GET') {
      const data = await redisRequest(env, 'get', key);
      let record = null;

      if (data?.result) {
        try {
          record = typeof data.result === 'string' ? JSON.parse(data.result) : data.result;
        } catch {
          record = null;
        }
      }

      const stores = normalizeStores(record?.stores || []);

      return json({
        success: true,
        route,
        stores,
        exists: stores.length > 0,
        updatedAt: record?.updatedAt || null
      });
    }

    if (request.method === 'PUT' || request.method === 'POST') {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ success: false, error: '请求数据不是有效 JSON' }, 400);
      }

      const stores = normalizeStores(body?.stores);
      if (!stores.length) {
        return json({ success: false, error: '没有可保存的基准门店数据' }, 400);
      }

      const record = {
        route,
        stores,
        storeCount: stores.length,
        updatedAt: new Date().toISOString()
      };

      await redisRequest(env, 'set', key, {
        method: 'POST',
        body: JSON.stringify(JSON.stringify(record))
      });

      // 保存后立即回读，确认数据库确实写入成功
      const verify = await redisRequest(env, 'get', key);
      let saved = null;
      if (verify?.result) {
        try {
          saved = typeof verify.result === 'string' ? JSON.parse(verify.result) : verify.result;
        } catch {
          saved = null;
        }
      }

      if (!saved || !Array.isArray(saved.stores) || saved.stores.length !== stores.length) {
        return json({ success: false, error: '数据库写入后校验失败' }, 500);
      }

      return json({
        success: true,
        route,
        stores: normalizeStores(saved.stores),
        storeCount: saved.stores.length,
        updatedAt: saved.updatedAt
      });
    }

    return json({ success: false, error: '不支持的请求方式' }, 405);
  } catch (error) {
    console.error('route API error:', error);
    return json({
      success: false,
      error: error?.message || '基准数据库服务异常'
    }, 500);
  }
}
