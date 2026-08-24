// functions/api/ocr.js
// 天友智配One：手机截图运单 AI 提取 → 门店标准化 → 去重 → 基准顺序排序

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== 'POST') return json({ success: false, error: 'Method not allowed' }, 405);

  try {
    const body = await request.json();
    const image = body?.image;
    const route = formatRoute(body?.route);

    if (!image || !route) return json({ success: false, error: '缺少运单图片或线路' }, 400);
    if (!env.AI || typeof env.AI.run !== 'function') {
      return json({ success: false, error: 'Cloudflare Workers AI 未绑定，请配置 AI Binding' }, 500);
    }

    const aiResult = await runAI(env.AI, image);
    const parsed = parseAIResponse(aiResult);
    const baseStores = await getBaseStores(env, route);
    const result = normalizeAndSort(parsed.stores, baseStores);

    return json({
      success: true,
      data: {
        route,
        stores: result.stores,
        totalWeight: normalizeWeight(parsed.totalWeight),
        vehicle: normalizeVehicle(parsed.vehicle),
        recognizedCount: result.recognizedCount,
        matchedCount: result.matchedCount,
        newStoreCount: result.newStoreCount,
        matchRate: result.recognizedCount ? Number((result.matchedCount / result.recognizedCount).toFixed(4)) : 0,
        warning: result.newStoreCount > 0 ? `发现 ${result.newStoreCount} 家新增/未匹配门店，请核对` : ''
      }
    });
  } catch (error) {
    console.error('OCR error:', error);
    return json({ success: false, error: error?.message || '运单图片处理失败' }, 500);
  }
}

async function runAI(AI, imageInput) {
  const bytes = decodeImageBase64(imageInput);
  if (!bytes.length) throw new Error('图片数据无效或无法解码');
  if (bytes.length < 100) throw new Error('图片数据过小');
  if (!isSupportedImage(bytes)) throw new Error('无法识别手机截图图片格式，请使用 PNG 或 JPG 截图');

  const prompt = `你是天友乳业配送运单识别助手。
请仔细读取整张手机截图运单，提取配送门店、总重量、车辆信息。
只返回一个 JSON 对象，不要 Markdown，不要解释。
严格使用以下格式：
{"stores":["门店1","门店2"],"totalWeight":"368.5kg","vehicle":"渝DK7692"}
规则：
1. stores 只填写图片中实际出现的配送客户/门店名称。
2. 保留完整中文公司、经销商、贸易公司、超市等名称。
3. 不要把编号、数量、单价、金额、重量、日期、备注、司机姓名当成门店。
4. 同一家门店只输出一次。
5. totalWeight 填运单明确写出的总重量；没有就填空字符串。
6. vehicle 填车牌号；没有就填空字符串。
7. 不要猜测图片中不存在的门店。
8. JSON 必须完整闭合。`;

  // Cloudflare Workers AI 的 LLaVA 当前支持 image 为 8-bit 图像字节数组。
  // 这里先把手机截图的 Base64/DataURL 真正还原成 JPEG/PNG 二进制字节，
  // 再转成普通数字数组，避免把 Base64 文本本身当成图片字节导致 3016 decode u8。
  return await AI.run('@cf/llava-hf/llava-1.5-7b-hf', {
    prompt,
    image: Array.from(bytes),
    max_tokens: 2048,
    temperature: 0.1
  });
}

function decodeImageBase64(input) {
  let value = String(input || '').trim();
  const comma = value.indexOf(',');
  if (value.startsWith('data:') && comma >= 0) value = value.slice(comma + 1);
  value = value.replace(/\s/g, '');
  if (!value) return new Uint8Array();

  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch (_) {
    throw new Error('图片Base64数据损坏，无法解码');
  }
}

function isSupportedImage(bytes) {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return true;
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return true;
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return true;
  return false;
}

function extractAIText(response) {
  if (typeof response === 'string') return response;
  if (!response || typeof response !== 'object') return '';
  return String(response.description ?? response.response ?? response.text ?? response.result?.description ?? response.result?.response ?? response.result?.text ?? '');
}

function parseAIResponse(response) {
  const source = extractAIText(response).trim();
  const candidates = [];
  const fenced = source.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced) candidates.push(fenced[1]);
  candidates.push(source);
  const objectMatch = source.match(/\{[\s\S]*\}/);
  if (objectMatch) candidates.push(objectMatch[0]);

  for (const candidate of candidates) {
    try {
      const data = JSON.parse(candidate);
      if (Array.isArray(data.stores)) {
        return {
          stores: unique(data.stores.map(item => typeof item === 'string' ? cleanStoreName(item) : cleanStoreName(item?.name || item?.storeName || '')).filter(Boolean)),
          totalWeight: data.totalWeight || '',
          vehicle: data.vehicle || ''
        };
      }
    } catch (_) {}
  }
  return extractFallback(source);
}

function extractFallback(text) {
  const stores = [];
  const lines = String(text || '').split(/[\r\n,，、；;]+/);
  for (const line of lines) {
    const value = cleanStoreName(line.replace(/^[-*\d.、）)]+\s*/, ''));
    if (value.length >= 3 && /(?:店|公司|经销商|加盟|厂|中心|超市|便利|生鲜|食品|贸易|供应链|商行|门市|乳业)/.test(value) && !/(总重量|重量|车牌|日期|合计|数量|司机|金额|单价)/.test(value)) stores.push(value);
  }
  const weight = String(text || '').match(/(?:总重量|重量|合计重量|总计)\s*[:：]?\s*([\d]+(?:\.\d+)?)\s*(kg|KG|千克|吨|t)?/i);
  const plate = String(text || '').match(/(?:车牌号|车牌|车辆)\s*[:：]?\s*([\u4e00-\u9fa5][A-Z0-9]{5,7})/i);
  return { stores: unique(stores), totalWeight: weight ? `${weight[1]}${weight[2] || 'kg'}` : '', vehicle: plate ? plate[1] : '' };
}

async function getBaseStores(env, route) {
  const cacheKey = `https://tianyou-zhipei-cache.invalid/${encodeURIComponent(route)}`;
  try {
    const cached = await caches.default.match(new Request(cacheKey));
    if (cached) {
      const data = await cached.json();
      if (Array.isArray(data.stores) && data.stores.length) return data.stores;
    }
  } catch (_) {}

  const url = env.UPSTASH_REDIS_REST_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return [];

  try {
    const response = await fetch(`${url}/get/${encodeURIComponent(`route:${route}`)}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) return [];
    const data = await response.json();
    let parsed = null;
    if (data?.result) {
      try { parsed = typeof data.result === 'string' ? JSON.parse(data.result) : data.result; } catch (_) {}
    }
    const stores = Array.isArray(parsed?.stores) ? parsed.stores : [];
    if (stores.length) {
      try {
        await caches.default.put(new Request(cacheKey), new Response(JSON.stringify({ stores }), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=3600' } }));
      } catch (_) {}
    }
    return stores;
  } catch (error) {
    console.warn('读取基准门店失败:', error);
    return [];
  }
}

function normalizeAndSort(recognized, baseStores) {
  const base = baseStores.map(normalizeBaseStore).filter(Boolean);
  const used = new Set();
  const matched = [];
  const newStores = [];
  const recognizedUnique = unique(recognized.map(cleanStoreName));

  for (const raw of recognizedUnique) {
    let best = null;
    let bestScore = 0;
    const a = normalizeForMatch(raw);
    if (!a) continue;

    for (const item of base) {
      if (used.has(item.index)) continue;
      const b = normalizeForMatch(item.name);
      if (!b) continue;
      let score = 1 - levenshtein(a, b) / Math.max(a.length, b.length);
      if (a === b) score = 1;
      else if (a.includes(b) || b.includes(a)) score = Math.max(score, 0.92);
      if (score > bestScore) { bestScore = score; best = item; }
    }

    if (best && bestScore >= 0.60) {
      used.add(best.index);
      matched.push({ code: best.code || String(best.index + 1).padStart(2, '0'), name: best.name, nav: best.nav || '', isNew: false, matchScore: Number(bestScore.toFixed(3)), _order: best.index });
    } else {
      newStores.push({ code: '', name: raw, nav: '', isNew: true, matchScore: 0, _order: 999999 });
    }
  }

  matched.sort((a, b) => a._order - b._order);
  const stores = [...matched, ...newStores].map((item, index) => ({ code: item.code || String(index + 1).padStart(2, '0'), name: item.name, nav: item.nav, isNew: item.isNew, matchScore: item.matchScore }));
  return { stores, recognizedCount: recognizedUnique.length, matchedCount: matched.length, newStoreCount: newStores.length };
}

function normalizeBaseStore(store, index) {
  if (typeof store === 'string') {
    const name = cleanStoreName(store);
    return name ? { index, code: '', name, nav: '' } : null;
  }
  if (!store || typeof store !== 'object') return null;
  const name = cleanStoreName(store.name || store.storeName || store.title || store.customerName || '');
  if (!name) return null;
  return { index, code: String(store.code || store.id || '').trim(), name, nav: store.nav || store.navigation || store.url || '' };
}

function normalizeForMatch(value) {
  return cleanStoreName(value).replace(/[（）()【】\[\]「」“”\"'‘’·・,，。；;：:、\s]/g, '').replace(/^(重庆|渝北|江北|巴南|南岸|九龙坡|沙坪坝|大渡口|北碚|万州|涪陵)/, '');
}

function cleanStoreName(value) {
  return String(value || '').replace(/^(门店名称|门店|客户名称|客户|名称|配送客户)\s*[:：]?/i, '').replace(/^\s*[\d]{1,3}[.、)）]\s*/, '').replace(/^[编号\s]*[\d]{1,3}\s*[-—:]\s*/i, '').replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

function normalizeWeight(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const match = text.match(/[\d]+(?:\.\d+)?/);
  if (!match) return text;
  const unit = /吨|\bt\b/i.test(text) ? 't' : 'kg';
  return `${match[0]}${unit}`;
}

function normalizeVehicle(value) {
  const text = String(value || '').trim().replace(/\s+/g, '').toUpperCase();
  const match = text.match(/[\u4e00-\u9fa5][A-Z0-9]{5,7}/);
  return match ? match[0] : text;
}

function formatRoute(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const match = text.match(/^(\d+)号线$/);
  if (match) return `${String(parseInt(match[1], 10)).padStart(2, '0')}号线`;
  if (/^\d+$/.test(text)) return `${String(parseInt(text, 10)).padStart(2, '0')}号线`;
  return text;
}

function unique(list) {
  const seen = new Set();
  return list.filter(item => {
    const key = normalizeForMatch(item);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function levenshtein(a, b) {
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + cost);
    }
    previous = current;
  }
  return previous[b.length];
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
}
