// functions/api/ocr.js
// 天友智配One：运单截图 → AI视觉识别 → 固定字段提取 → 箭头路线拆店 → 基准排序 → 新增门店置底
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

    const aiRaw = await runAI(env.AI, image);
    const parsed = parseAIResponse(aiRaw);
    const base = await getBaseStores(env, route);
    const result = normalizeAndSort(parsed.stores, base);

    if (!result.stores.length) {
      return json({ success: false, error: 'AI未能从承运订单路线中识别出有效门店，请重新上传清晰截图' }, 422);
    }

    return json({
      success: true,
      data: {
        route,
        date: parsed.date || '',
        vehicle: normalizeVehicle(parsed.vehicle),
        totalWeight: normalizeWeight(parsed.totalWeight),
        rawOrderCount: parsed.rawOrderCount || 0,
        stores: result.stores,
        storeCount: result.stores.length,
        recognizedCount: result.recognizedCount,
        matchedCount: result.matchedCount,
        newStoreCount: result.newStoreCount,
        warning: result.newStoreCount ? `发现 ${result.newStoreCount} 家新增门店，请核对` : ''
      }
    });
  } catch (e) {
    console.error('OCR error:', e);
    return json({ success: false, error: e?.message || '运单图片处理失败' }, 500);
  }
}

async function runAI(AI, imageInput) {
  const bytes = decodeImageBase64(imageInput);
  if (!bytes.length) throw new Error('图片数据无效或无法解码');
  if (!isSupportedImage(bytes)) throw new Error('无法识别手机截图图片格式，请使用 PNG、JPG 或 WebP');

  const prompt = `你是“天友智配One”运单截图识别器。现在给你的是一张手机截图，不是普通照片。必须严格读取截图中真实可见的文字，不要猜测、不要补充不存在的门店。

【最重要的识别区域】
请重点读取截图中“承运订单”标题下面的白色订单卡片。
卡片先出现一行：总数量207 | 总重量1.806213t(10.03%) | 总体积4.022555m³(10.06%)。
这行里的“总数量”是商品/承运订单数量，绝对不是门店数量。
紧接着下一大段才是门店路线。

【门店路线的真实结构】
路线由多个客户名称组成，客户之间使用“->”箭头连接。
例如：
A -> B -> C -> D
必须得到4家门店，而不是1家。
手机截图中一条很长的门店名称可能因为屏幕宽度自动换行；换行本身绝对不能拆成新门店。
只有“->”才是门店之间的明确分隔符。
箭头可能显示为 ->、→、＞、》、➜、➤、⇒，都视为同一种分隔符。
不要把下面的ZW订单编号表识别成门店。

【本截图的版式】
上半部分固定字段依次包含：运输日期、车牌号、额定装载、主司机、送货员。
中下部“承运订单”卡片包含总数量/总重量/总体积，然后是一整段由箭头连接的门店路线，最后才是ZW订单编号表。
请忽略手机状态栏、页面标题、额定载重、额定体积、司机、送货员、ZW订单编号表。

【必须提取】
1. date：运输日期，例如 2026-08-22。
2. vehicle：车牌号，例如 渝DK7692。
3. totalWeight：承运订单这一行的总重量，例如 1.806213t。不要提取额定载重18吨。
4. rawOrderCount：总数量，例如207。这个数字只作记录，绝不能作为门店数量。
5. routeText：只复制“承运订单”下面的完整门店路线文字。必须保留门店之间的箭头“->”，不能把箭头删除，不能把换行当成门店分隔。
6. stores：根据routeText中的箭头拆分出的门店数组，每个箭头分隔一项。

【严格规则】
- stores的数量必须等于routeText中门店分隔箭头数量 + 1。
- 一家门店名称自动换行时仍然只算1家。
- 括号里的内容属于门店名称，例如“(客百年)”或“（救助管理站）”必须保留。
- 区域前缀、JM编号、Q编号、公司全称都属于门店名称的一部分。
- “总数量207”“总重量1.806213t”“总体积4.022555m³”不能进入stores。
- “ZW20260822CZZC 01501”等订单编号不能进入stores。
- 主司机、送货员、额定载重、额定体积不能进入stores。
- 不要根据门店名称猜测基准库，不要自行合并相似名称。
- 如果两个名称不同，即使看起来相似，也分别保留。

【只返回JSON】
不要Markdown，不要解释，不要代码块：
{
  "date":"2026-08-22",
  "vehicle":"渝DK7692",
  "rawOrderCount":207,
  "totalWeight":"1.806213t",
  "routeText":"A -> B -> C",
  "stores":["A","B","C"]
}`;

  return AI.run('@cf/llava-hf/llava-1.5-7b-hf', {
    prompt,
    image: Array.from(bytes),
    max_tokens: 4096,
    temperature: 0.01
  });
}

function decodeImageBase64(input) {
  let v = String(input || '').trim();
  const comma = v.indexOf(',');
  if (v.startsWith('data:') && comma >= 0) v = v.slice(comma + 1);
  v = v.replace(/\s/g, '');
  try {
    const b = atob(v);
    const a = new Uint8Array(b.length);
    for (let i = 0; i < b.length; i++) a[i] = b.charCodeAt(i);
    return a;
  } catch (e) {
    throw new Error('图片Base64数据损坏，无法解码');
  }
}

function isSupportedImage(b) {
  return (
    (b.length >= 8 && b[0] === 137 && b[1] === 80 && b[2] === 78 && b[3] === 71) ||
    (b.length >= 3 && b[0] === 255 && b[1] === 216 && b[2] === 255) ||
    (b.length >= 12 && b[0] === 82 && b[1] === 73 && b[2] === 70 && b[3] === 70 && b[8] === 87 && b[9] === 69 && b[10] === 66 && b[11] === 80)
  );
}

function extractAIText(r) {
  if (typeof r === 'string') return r;
  if (!r || typeof r !== 'object') return '';
  return String(
    r.description ?? r.response ?? r.text ?? r.result?.description ?? r.result?.response ?? r.result?.text ?? ''
  );
}

function parseAIResponse(r) {
  const s = extractAIText(r).trim();
  const candidates = [];
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced) candidates.push(fenced[1]);
  candidates.push(s);
  const a = s.indexOf('{');
  const z = s.lastIndexOf('}');
  if (a >= 0 && z > a) candidates.push(s.slice(a, z + 1));

  for (const x of candidates) {
    try {
      const d = JSON.parse(x);
      if (d && (Array.isArray(d.stores) || d.routeText)) {
        const routeText = String(d.routeText || '');
        let stores = expandStoreList(d.stores || []);
        // 如果视觉模型返回了完整routeText，则以箭头作为最可靠的门店边界。
        if (routeText && countRouteSeparators(routeText) > 0) {
          const routeStores = splitStoreChain(routeText).map(cleanStoreName).filter(isLikelyStore);
          if (routeStores.length >= 2) stores = unique(routeStores);
        }
        return {
          stores,
          routeText,
          date: d.date || '',
          vehicle: d.vehicle || '',
          totalWeight: d.totalWeight || '',
          rawOrderCount: Number(d.rawOrderCount) || 0
        };
      }
    } catch (_) {}
  }
  return extractFallback(s);
}

function countRouteSeparators(v) {
  return String(v || '').match(/->|→|＞|》|➜|➤|⇒/g)?.length || 0;
}

function expandStoreList(items) {
  const out = [];
  for (const item of items || []) {
    const v = typeof item === 'string' ? item : item?.name || item?.storeName || item?.customerName || '';
    splitStoreChain(v).forEach(x => {
      const n = cleanStoreName(x);
      if (n) out.push(n);
    });
  }
  return unique(out);
}

function splitStoreChain(v) {
  return String(v || '')
    .replace(/→|＞|》|➜|➤|⇒/g, '->')
    .split(/\s*(?:->|-->)\s*/)
    .map(x => x.trim())
    .filter(Boolean);
}

function extractFallback(text) {
  const s = String(text || '').replace(/\r/g, '\n');
  const stores = [];
  const chains = s.match(/[^\n{}]{2,}(?:\s*(?:->|→|〉|》|➜|➤|⇒)\s*[^\n{}]{2,})+/g) || [];
  chains.forEach(c => splitStoreChain(c).forEach(p => {
    const n = cleanStoreName(p);
    if (isLikelyStore(n)) stores.push(n);
  }));

  const weight = s.match(/(?:总重量|重量|合计重量|总计)\s*[:：]?\s*([\d]+(?:\.\d+)?)\s*(kg|KG|千克|公斤|吨|t)?/i);
  const plate = s.match(/(?:车牌号|车牌|车辆)\s*[:：]?\s*([\u4e00-\u9fa5][A-Z0-9]{5,7})/i);
  const date = s.match(/(20\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2}日?)/);
  const count = s.match(/总数量\s*[:：]?\s*(\d+)/);
  const routeMatch = chains.sort((a, b) => b.length - a.length)[0] || '';

  return {
    stores: unique(stores),
    routeText: routeMatch,
    totalWeight: weight ? `${weight[1]}${weight[2] || 'kg'}` : '',
    vehicle: plate ? plate[1] : '',
    date: date ? normalizeDate(date[1]) : '',
    rawOrderCount: count ? Number(count[1]) : 0
  };
}

function isLikelyStore(v) {
  if (!v || v.length < 3 || v.length > 150) return false;
  if (/总重量|总数量|总体积|订单编号|运单编号|车牌|车辆|运输日期|日期|司机|送货员|主司机|承运订单|额定装载|额定载重|额定体积|总计|合计|单价|金额/.test(v)) return false;
  return /店|公司|经销商|加盟|工厂|中心|超市|便利|生鲜|食品|贸易|供应链|商行|门市|乳业|大厦|药房|餐饮|酒店|委员会|管理中心|服务中心/.test(v);
}

async function getBaseStores(env, route) {
  const url = env.UPSTASH_REDIS_REST_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return [];
  try {
    const r = await fetch(`${url}/get/${encodeURIComponent(`route:${route}`)}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!r.ok) return [];
    const d = await r.json();
    let p = null;
    if (d?.result) {
      try { p = typeof d.result === 'string' ? JSON.parse(d.result) : d.result; } catch (_) {}
    }
    return Array.isArray(p?.stores) ? p.stores : [];
  } catch (_) {
    return [];
  }
}

function normalizeBase(s, i) {
  if (typeof s === 'string') return { name: cleanStoreName(s), code: String(i + 1).padStart(2, '0'), nav: '', index: i };
  if (!s) return null;
  const name = cleanStoreName(s.name || s.storeName || s.title || s.customerName || '');
  return name ? {
    name,
    code: String(s.code || i + 1).padStart(2, '0'),
    nav: s.nav || s.navigation || s.url || '',
    index: i
  } : null;
}

function matchKey(s) {
  return cleanStoreName(s)
    .replace(/[\s\u3000，,。；;：:（）()【】\[\]<>《》“”"'‘’·]/g, '')
    .toLowerCase();
}

function normalizeAndSort(recognized, baseStores) {
  const src = unique((recognized || []).map(cleanStoreName).filter(Boolean));
  const base = (baseStores || []).map(normalizeBase).filter(Boolean);

  if (!base.length) {
    return {
      stores: src.map((name, i) => ({ code: String(i + 1).padStart(2, '0'), name, nav: '', isNew: true, matched: false })),
      recognizedCount: src.length,
      matchedCount: 0,
      newStoreCount: src.length
    };
  }

  const matched = [];
  const news = [];
  const used = new Set();

  src.forEach(raw => {
    const rk = matchKey(raw);
    let best = null;
    let score = 0;

    base.forEach(b => {
      if (used.has(b.index)) return;
      const bk = matchKey(b.name);
      if (rk === bk) {
        best = b;
        score = 1;
        return;
      }
      // 仅允许非常明确的包含关系，避免“御龙天峰”等相似门店误合并。
      if (rk.length > 12 && bk.length > 12 && (rk.includes(bk) || bk.includes(rk)) && score < 0.93) {
        best = b;
        score = 0.93;
      }
    });

    if (best && score >= 0.93) {
      used.add(best.index);
      matched.push({
        code: best.code,
        name: best.name,
        nav: best.nav || '',
        isNew: false,
        matched: true,
        _baseIndex: best.index
      });
    } else {
      news.push({ code: '', name: raw, nav: '', isNew: true, matched: false });
    }
  });

  matched.sort((a, b) => a._baseIndex - b._baseIndex);
  news.forEach((x, i) => x.code = `N${String(i + 1).padStart(2, '0')}`);

  const stores = matched.concat(news).map(x => {
    const y = { ...x };
    delete y._baseIndex;
    return y;
  });

  return {
    stores,
    recognizedCount: src.length,
    matchedCount: matched.length,
    newStoreCount: news.length
  };
}

function cleanStoreName(v) {
  return String(v || '')
    .replace(/^[\s\d]+[、.．)）-]+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function unique(a) {
  const s = new Set();
  return a.filter(x => {
    const k = matchKey(x);
    if (!k || s.has(k)) return false;
    s.add(k);
    return true;
  });
}

function normalizeWeight(v) {
  if (v === null || v === undefined || v === '') return '';
  const s = String(v).trim();
  const m = s.match(/[\d]+(?:\.\d+)?/);
  if (!m) return '';
  const n = Number(m[0]);
  return /吨|\bt\b/i.test(s) ? `${n}t` : `${n}kg`;
}

function normalizeVehicle(v) {
  return String(v || '').replace(/[\s>]+$/, '').trim();
}

function normalizeDate(v) {
  const s = String(v || '')
    .trim()
    .replace(/[年月]/g, '-')
    .replace(/日/g, '')
    .replace(/\//g, '-')
    .replace(/\./g, '-');
  const m = s.match(/(20\d{2})-(\d{1,2})-(\d{1,2})/);
  return m ? `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}` : s;
}

function formatRoute(v) {
  return String(v || '').trim();
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json;charset=UTF-8',
      'Cache-Control': 'no-store'
    }
  });
}
