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

    // 1. 调用 AI
    let aiResult;
    try {
      aiResult = await runAI(env, image);
    } catch (aiError) {
      return new Response(JSON.stringify({ 
        success: false, 
        error: `AI调用失败: ${aiError.message}` 
      }), { status: 500 });
    }

    if (!aiResult) {
      return new Response(JSON.stringify({ 
        success: false, 
        error: 'AI 识别结果为空' 
      }), { status: 500 });
    }

    // 2. 解析 AI 结果
    let parsed = parseAIResponse(aiResult);
    if (!parsed) {
      parsed = extractWithRegex(aiResult);
    }

    // 3. 获取基准门店
    let baseStores = [];
    try {
      baseStores = await getBaseStores(env, route);
    } catch (e) {
      // 如果获取基准门店失败，返回空列表
      console.warn('获取基准门店失败:', e);
    }

    // 4. 匹配并排序
    const matchedStores = matchStores(parsed.stores || [], baseStores);
    const sortedStores = sortByBaseOrder(matchedStores, baseStores);

    const matchRate = sortedStores.length / (parsed.stores?.length || 1);

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
    return new Response(JSON.stringify({ 
      success: false, 
      error: error.message 
    }), { 
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
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
    console.log('AI response:', text);
    return text;
  } catch (e) {
    console.error('AI call failed:', e);
    throw new Error(`AI 调用失败: ${e.message}`);
  }
}

// 其他辅助函数（parseAIResponse, extractWithRegex, getBaseStores, matchStores, levenshtein, sortByBaseOrder）...
// 这些函数与之前相同，这里省略，但请确保它们都在文件中。
