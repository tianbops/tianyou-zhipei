// functions/api/users.js
export async function onRequest(context) {
  const { request } = context;
  const method = request.method;
  
  const UPSTASH_URL = context.env.UPSTASH_REDIS_REST_URL;
  const UPSTASH_TOKEN = context.env.UPSTASH_REDIS_REST_TOKEN;
  
  if (!UPSTASH_URL || !UPSTASH_TOKEN) {
    return new Response(JSON.stringify({ error: 'Redis not configured' }), { 
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  const REDIS_KEY = 'admin_users';
  
  try {
    // GET - 获取用户数据
    if (method === 'GET') {
      const redisResponse = await fetch(`${UPSTASH_URL}/get/${REDIS_KEY}`, {
        headers: { 'Authorization': `Bearer ${UPSTASH_TOKEN}` }
      });
      
      if (redisResponse.ok) {
        const data = await redisResponse.json();
        if (data.result) {
          return new Response(JSON.stringify({ 
            users: JSON.parse(data.result) 
          }), {
            headers: { 'Content-Type': 'application/json' }
          });
        }
      }
      return new Response(JSON.stringify({ users: [] }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // POST - 保存用户数据
    if (method === 'POST') {
      const body = await request.json();
      const users = body.users || [];
      
      const redisResponse = await fetch(`${UPSTASH_URL}/set/${REDIS_KEY}`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${UPSTASH_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(JSON.stringify(users))
      });
      
      if (redisResponse.ok) {
        return new Response(JSON.stringify({ success: true, users: users }), {
          headers: { 'Content-Type': 'application/json' }
        });
      } else {
        return new Response(JSON.stringify({ error: 'Failed to save to Redis' }), {
          status: 500,
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
