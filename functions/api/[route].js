export async function onRequest(context) {
  const { request, params } = context;
  const route = params.route;
  const method = request.method;
  
  const UPSTASH_URL = context.env.UPSTASH_REDIS_REST_URL;
  const UPSTASH_TOKEN = context.env.UPSTASH_REDIS_REST_TOKEN;
  
  if (!UPSTASH_URL || !UPSTASH_TOKEN) {
    return new Response(JSON.stringify({ error: 'Redis not configured' }), { 
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  // 默认门店数据
  const DEFAULT_STORES = [
    { code: "01", name: "江北胡汪洋经销商", nav: "https://surl.amap.com/zTkZfPL2fP" },
    { code: "02", name: "渝北中景隆贸易有限公司", nav: "" },
    { code: "03", name: "江北重庆兴农融资担保集团", nav: "" }
  ];
  
  try {
    // GET - 获取线路数据
    if (method === 'GET') {
      const redisKey = `route:${route}`;
      const redisResponse = await fetch(`${UPSTASH_URL}/get/${redisKey}`, {
        headers: { 'Authorization': `Bearer ${UPSTASH_TOKEN}` }
      });
      
      if (redisResponse.ok) {
        const data = await redisResponse.json();
        if (data.result) {
          return new Response(JSON.stringify(JSON.parse(data.result)), {
            headers: { 'Content-Type': 'application/json' }
          });
        }
      }
      
      return new Response(JSON.stringify({ route: route, stores: DEFAULT_STORES }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // PUT - 保存线路数据
    if (method === 'PUT') {
      const body = await request.json();
      const redisKey = `route:${route}`;
      const dataToSave = JSON.stringify({
        route: route,
        stores: body.stores || [],
        updatedAt: new Date().toISOString()
      });
      
      const redisResponse = await fetch(`${UPSTASH_URL}/set/${redisKey}`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${UPSTASH_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(dataToSave)
      });
      
      if (redisResponse.ok) {
        return new Response(JSON.stringify({ success: true }), {
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }
    
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' }
    });
    
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
