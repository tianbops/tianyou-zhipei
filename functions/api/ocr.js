// functions/api/ocr.js
// 天友智配One：运单图片 → AI识别 → 门店拆分 → 去重 → 基准匹配 → 排序

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== 'POST') return json({ success: false, error: 'Method not allowed' }, 405);

  try {
    const body = await request.json();
    const image = body?.image;
    const route = formatRoute(body?.route);
    if (!image || !route) return json({ success: false, error: '缺少运单图片或线路' }, 400);
    if (!env.AI || typeof env.AI.run !== 'function') return json({ success: false, error: 'Cloudflare Workers AI 未绑定，请配置 AI Binding' }, 500);

    const aiResult = await runAI(env.AI, image);
    const parsed = parseAIResponse(aiResult);
    const baseStores = await getBaseStores(env, route);
    const result = normalizeAndSort(parsed.stores, baseStores);

    if (!result.stores.length) return json({ success: false, error: 'AI未能从运单中识别出有效门店，请重新上传清晰截图' }, 422);

    return json({
      success: true,
      data: {
        route,
        date: parsed.date || '',
        vehicle: normalizeVehicle(parsed.vehicle),
        stores: result.stores,
        storeCount: result.stores.length,
        recognizedCount: result.recognizedCount,
        matchedCount: result.matchedCount,
        newStoreCount: result.newStoreCount,
        totalWeight: normalizeWeight(parsed.totalWeight),
        rawOrderCount: parsed.rawOrderCount || null,
        warning: result.newStoreCount ? `发现 ${result.newStoreCount} 家新增/未匹配门店，请核对` : ''
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

  const prompt = `你是天友乳业配送运单识别助手。请读取整张手机截图，不要根据常识猜测。

这是一个非常重要的规则：运单中的“总数量207”表示承运订单/商品数量，不是门店数量，绝对不能把207当成门店数。

请重点寻找“承运订单”下面的客户/门店路线。路线通常表现为：
门店A -> 门店B -> 门店C -> 门店D
“->”两侧就是不同门店，请把它们逐一拆开。

只返回一个完整 JSON，不要 Markdown，不要解释：
{"date":"2026-08-22","vehicle":"渝DK7692","rawOrderCount":207,"totalWeight":"1.806213t","stores":["门店A","门店B","门店C"]}

规则：
1. stores 必须是实际配送客户/门店名称数组，每一家门店一个元素。
2. 如果图片中出现 A -> B -> C，必须返回 ["A","B","C"]，不能把整条 A -> B -> C 当成一家门店。
3. 优先读取“承运订单”区域的客户/门店路线。
4. 不要把“总数量”“总重量”“总体积”“订单编号”“司机”“送货员”“日期”“车牌”等当成门店。
5. 同一家门店重复出现时只保留一次，但不要因为名称相似而错误合并不同门店。
6. 保留门店完整名称，包括区域、编号、公司名、括号内容。
7. rawOrderCount 只填写运单明确写出的总数量，例如207；它不是门店数量。
8. totalWeight 只填写运单明确写出的总重量，例如1.806213t；没有就填空字符串。
9. vehicle 填车牌号，没有就填空字符串。
10. date 填运输日期，没有就填空字符串。
11. 不要自行补充图片中不存在的门店。
12. JSON 必须完整闭合。`;

  return await AI.run('@cf/llava-hf/llava-1.5-7b-hf', {
    prompt,
    image: Array.from(bytes),
    max_tokens: 4096,
    temperature: 0.05
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

  const objectStart = source.indexOf('{');
  const objectEnd = source.lastIndexOf('}');
  if (objectStart >= 0 && objectEnd > objectStart) candidates.push(source.slice(objectStart, objectEnd + 1));

  for (const candidate of candidates) {
    try {
      const data = JSON.parse(candidate);
      if (data && Array.isArray(data.stores)) {
        return {
          stores: expandStoreList(data.stores),
          totalWeight: data.totalWeight || '',
          vehicle: data.vehicle || '',
          date: data.date || '',
          rawOrderCount: Number(data.rawOrderCount) || 0
        };
      }
    } catch (_) {}
  }
  return extractFallback(source);
}

function expandStoreList(items) {
  const result = [];
  for (const item of items || []) {
    const value = typeof item === 'string' ? item : item?.name || item?.storeName || item?.customerName || '';
    splitStoreChain(value).forEach(name => result.push(cleanStoreName(name)));
  }
  return unique(result.filter(Boolean));
}

function splitStoreChain(value) {
  return String(value || '')
    .replace(/→|＞|》|➜|➤/g, '->')
    .split(/\s*(?:->|-->|→|〉|》)\s*/)
    .map(s => s.trim())
    .filter(Boolean);
}

function extractFallback(text) {
  const source = String(text || '').replace(/\r/g, '\n');
  const stores = [];

  // 先处理真实运单最常见的“门店A -> 门店B -> 门店C”结构。
  const chains = source.match(/[^\n{}]{2,}(?:\s*(?:->|→|〉|》)\s*[^\n{}]{2,})+/g) || [];
  for (const chain of chains) {
    splitStoreChain(chain).forEach(part => {
      const name = cleanStoreName(part);
      if (isLikelyStore(name)) stores.push(name);
    });
  }

  // 再处理逐行门店。
  for (const line of source.split(/\n+/)) {
    const value = cleanStoreName(line.replace(/^[-*\d.、）)]+\s*/, ''));
    if (isLikelyStore(value)) stores.push(value);
  }

  const weight = source.match(/(?:总重量|重量|合计重量|总计)\s*[:：]?\s*([\d]+(?:\.\d+)?)\s*(kg|KG|千克|公斤|吨|t)?/i);
  const plate = source.match(/(?:车牌号|车牌|车辆)\s*[:：]?\s*([\u4e00-\u9fa5][A-Z0-9]{5,7})/i);
  const date = source.match(/(20\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2}日?)/);
  const count = source.match(/总数量\s*[:：]?\s*(\d+)/);

  return {
    stores: unique(stores),
    totalWeight: weight ? `${weight[1]}${weight[2] || 'kg'}` : '',
    vehicle: plate ? plate[1] : '',
    date: date ? normalizeDate(date[1]) : '',
    rawOrderCount: count ? Number(count[1]) : 0
  };
}

function isLikelyStore(value) {
  if (!value || value.length < 3 || value.length > 120) return false;
  if (/(总重量|总数量|总体积|订单编号|运单编号|车牌|车辆|运输日期|日期|司机|送货员|主司机|承运订单|额定装载|额定载重|额定体积|总计|合计|单价|金额)/.test(value)) return false;
  return /(?:店|公司|经销商|加盟|工厂|中心|超市|便利|生鲜|食品|贸易|供应链|商行|门市|乳业|大厦|药房|餐饮|酒店)/.test(value);
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
      try { await caches.default.put(new Request(cacheKey), new Response(JSON.stringify({ stores }), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=3600' } })); } catch (_) {}
    }
    return stores;
  } catch (_) {
    return [];
  }
}

function normalizeAndSort(recognized, baseStores) {
  const recognizedUnique = unique((recognized || []).map(cleanStoreName).filter(Boolean));
  const base = (baseStores || []).map(normalizeBaseStore).filter(Boolean);

  // 没有基准数据：严格保留原始订单门店顺序。
  if (!base.length) {
    return {
      stores: recognizedUnique.map((name, i) => ({ code: String(i + 1).padStart(2, '0'), name, nav: '', isNew: false, matched: false, matchScore: 0 })),
      recognizedCount: recognizedUnique.length,
      matchedCount: 0,
      newStoreCount: 0
    };
  }

  const used = new Set();
  const matched = [];
  const newStores = [];

  for (const raw of recognizedUnique) {
    const a = normalizeForMatch(raw);
    let best = null;
    let bestScore = 0;
    for (const item of base) {
      if (used.has(item.index)) continue;
      const b = normalizeForMatch(item.name);
      if (!b) continue;
      let score = a === b ? 1 : 1 - levenshtein(a, b) / Math.max(a.length, b.length);
      if (a.includes(b) || b.includes(a)) score = Math.max(score, 0.92);
      if (score > bestScore) { best = item; bestScore = score; }
    }

    if (best && bestScore >= 0.72) {
      used.add(best.index);
      matched.push({ code: best.code || String(best.index + 1).padStart(2, '0'), name: best.name, nav: best.nav || '', isNew: false, matched: true, matchScore: Number(bestScore.toFixed(3)), _order: best.index });
    } else {
      newStores.push({ code: '', name: raw, nav: '', isNew: true, matched: false, matchScore: 0, _order: 999999 });
    }
  }

  matched.sort((a, b) => a._order - b._order);
  const stores = [...matched, ...newStores].map((item, index) => ({
    code: item.isNew ? `N${String(index - matched.length + 1).padStart(2, '0')}` : item.code,
    name: item.name,
    nav: item.nav,
    isNew: item.isNew,
    matched: item.matched,
    matchScore: item.matchScore
  }));

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
  return cleanStoreName(value)
    .replace(/[（）()【】\[\]「」“”\"'‘’·・,，。；;：:、\s]/g, '')
    .replace(/^(重庆|渝北|江北|巴南|南岸|九龙坡|沙坪坝|大渡口|北碚|万州|涪陵)/, '');
}

function cleanStoreName(value) {
  return String(value || '')
    .replace(/^(门店名称|门店|客户名称|客户|名称|配送客户)\s*[:：]?/i, '')
    .replace(/^\s*[\d]{1,3}[.、)）]\s*/, '')
    .replace(/^[编号\s]*[\d]{1,3}\s*[-—:]\s*/i, '')
    .replace(/^[\s\-—:：]+|[\s\-—:：]+$/g, '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function normalizeWeight(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const match = text.match(/[\d]+(?:\.\d+)?/);
  if (!match) return '';
  const number = Number(match[0]);
  if (!Number.isFinite(number)) return '';
  if (/吨|\bt\b/i.test(text)) return `${number * 1000}kg`;
  return `${number}kg`;
}

function normalizeVehicle(value) {
  const text = String(value || '').trim().replace(/\s+/g, '').toUpperCase();
  const match = text.match(/[\u4e00-\u9fa5][A-Z0-9]{5,7}/);
  return match ? match[0] : text;
}

function normalizeDate(value) {
  const text = String(value || '').replace(/年|月/g, '-').replace(/日/g, '').replace(/\//g, '-').replace(/--+/g, '-');
  const match = text.match(/(20\d{2})-(\d{1,2})-(\d{1,2})/);
  return match ? `${match[1]}-${String(match[2]).padStart(2, '0')}-${String(match[3]).padStart(2, '0')}` : '';
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
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}
