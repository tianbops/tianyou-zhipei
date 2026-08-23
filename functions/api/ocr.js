// functions/api/ocr.js
// 运单图片 OCR + 门店排序 + 模糊匹配 + 缓存 + 纠错

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 });
  }

  try {
    const { image, route } = await request.json();
    if (!image || !route) {
      return new Response(JSON.stringify({ error: 'Missing image or route' }), { status: 400 });
    }

    // 1. 调用 AI 识别图片
    const aiResult = await runAI(env, image);
    if (!aiResult) {
      return new Response(JSON.stringify({ success: false, error: 'AI recognition failed' }), { status: 500 });
    }

    // 2. 解析 AI 返回的 JSON
    let parsed = parseAIResponse(aiResult);
    if (!parsed) {
      parsed = extractWithRegex(aiResult);
    }

    // 3. 获取基准门店列表（带缓存）
    const baseStores = await getBaseStores(env, route);

    // 4. 模糊匹配门店名称
    const matchedStores = matchStores(parsed.stores || [], baseStores);

    // 5. 按基准顺序排序
    const sortedStores = sortByBaseOrder(matchedStores, baseStores);

    // 6. 计算匹配率
    const matchRate = sortedStores.length / (parsed.stores?.length || 1);

    // 7. 构造响应
    const responseData = {
      success: true,
      data: {
        stores: sortedStores,
        totalWeight: parsed.totalWeight || '',
        vehicle: parsed.vehicle || '',
        matchRate: matchRate,
        warning: matchRate < 0.7 ? '部分门店未能识别，请检查' : undefined
      }
    };

    return new Response(JSON.stringify(responseData), {
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('OCR Error:', error);
    return new Response(JSON.stringify({ success: false, error: error.message }), { status: 500 });
  }
}

// ============================================================
// AI 调用
// ============================================================
async function runAI(env, imageBase64) {
  const prompt = `你是一个运单信息提取助手。请从图片中提取以下信息，并只返回 JSON 格式：
- 门店名称列表（数组，每个门店名称用完整名称，按实际顺序）
- 总重量（字符串，如 "368.5kg"）
- 车牌号（字符串，如 "渝DK7692"）

要求：
1. 只返回 JSON，不要任何解释文字。
2. JSON 格式：{"stores": ["门店1", "门店2"], "totalWeight": "xxx", "vehicle": "xxx"}
3. 如果某项不存在，请留空字符串或空数组。

图片数据已提供。`;

  try {
    const response = await env.AI.run('@cf/llava-hf/llava-1.5-7b-hf', {
      prompt: prompt,
      image: imageBase64
    });
    const text = typeof response === 'string' ? response : response.response || '';
    return text;
  } catch (e) {
    console.error('AI call failed:', e);
    return null;
  }
}

// ============================================================
// 解析 AI 返回的 JSON
// ============================================================
function parseAIResponse(text) {
  try {
    const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/);
    const jsonStr = jsonMatch ? jsonMatch[1] : text;
    const data = JSON.parse(jsonStr);
    if (data.stores && Array.isArray(data.stores)) {
      return {
        stores: data.stores.map(s => s.trim()).filter(Boolean),
        totalWeight: data.totalWeight || '',
        vehicle: data.vehicle || ''
      };
    }
    return null;
  } catch (e) {
    return null;
  }
}

// ============================================================
// 正则提取（备用）
// ============================================================
function extractWithRegex(text) {
  const stores = [];
  const keywords = ['店', '公司', '经销商', '加盟', '厂', '中心', '超市', '便利', '生鲜', '食品', '贸易', '供应链'];
  const lines = text.split(/[\n,，、；;]+/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length > 2 && keywords.some(kw => trimmed.includes(kw))) {
      stores.push(trimmed);
    }
  }
  const weightMatch = text.match(/总重量[:：]?\s*([\d.]+)\s*(kg|千克|吨)/i);
  const totalWeight = weightMatch ? weightMatch[0] : '';
  const vehicleMatch = text.match(/车牌号[:：]?\s*([A-Z0-9]{6,8})/i);
  const vehicle = vehicleMatch ? vehicleMatch[1] : '';
  return { stores, totalWeight, vehicle };
}

// ============================================================
// 获取基准门店（带缓存）
// ============================================================
async function getBaseStores(env, route) {
  const cacheKey = `base_stores:${route}`;
  const cache = caches.default;

  const cached = await cache.match(new Request(`https://cache/${cacheKey}`));
  if (cached) {
    const data = await cached.json();
    return data.stores;
  }

  const UPSTASH_URL = env.UPSTASH_REDIS_REST_URL;
  const UPSTASH_TOKEN = env.UPSTASH_REDIS_REST_TOKEN;
  const redisKey = `route:${route}`;
  const resp = await fetch(`${UPSTASH_URL}/get/${redisKey}`, {
    headers: { 'Authorization': `Bearer ${UPSTASH_TOKEN}` }
  });
  if (!resp.ok) {
    return [];
  }
  const data = await resp.json();
  let stores = [];
  if (data.result) {
    try {
      const parsed = JSON.parse(data.result);
      stores = parsed.stores || [];
    } catch (e) {
      stores = [];
    }
  }

  const cacheResp = new Response(JSON.stringify({ stores }), {
    headers: { 'Cache-Control': 'max-age=3600' }
  });
  await cache.put(new Request(`https://cache/${cacheKey}`), cacheResp);

  return stores;
}

// ============================================================
// 模糊匹配（Levenshtein + 子串）
// ============================================================
function matchStores(recognized, baseStores) {
  if (!baseStores.length) return recognized;

  const matched = [];
  const matchedIndices = new Set();

  for (const name of recognized) {
    let bestMatch = null;
    let bestScore = -1;

    for (let i = 0; i < baseStores.length; i++) {
      if (matchedIndices.has(i)) continue;
      const base = baseStores[i];
      if (name.includes(base) || base.includes(name)) {
        bestMatch = base;
        bestScore = 1;
        matchedIndices.add(i);
        break;
      }
      const dist = levenshtein(name, base);
      const maxLen = Math.max(name.length, base.length);
      const similarity = 1 - dist / maxLen;
      if (similarity > 0.7 && similarity > bestScore) {
        bestScore = similarity;
        bestMatch = base;
        matchedIndices.add(i);
      }
    }

    if (bestMatch) {
      matched.push(bestMatch);
    } else {
      matched.push(name);
    }
  }

  return matched;
}

function levenshtein(a, b) {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const matrix = [];
  for (let i = 0; i <= b.length; i++) matrix[i] = [i];
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      const cost = a[j-1] === b[i-1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i-1][j] + 1,
        matrix[i][j-1] + 1,
        matrix[i-1][j-1] + cost
      );
    }
  }
  return matrix[b.length][a.length];
}

// ============================================================
// 按基准顺序排序
// ============================================================
function sortByBaseOrder(stores, baseStores) {
  if (!baseStores.length) return stores;
  const orderMap = {};
  baseStores.forEach((name, idx) => { orderMap[name] = idx; });
  return stores.sort((a, b) => {
    const idxA = orderMap[a] !== undefined ? orderMap[a] : 9999;
    const idxB = orderMap[b] !== undefined ? orderMap[b] : 9999;
    return idxA - idxB;
  });
}