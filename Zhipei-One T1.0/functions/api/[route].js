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
  
  const DEFAULT_STORES = [
    { code: "01", name: "江北胡汪洋经销商（重庆胡建镜好食品有限公司）", nav: "https://surl.amap.com/zTkZfPL2fP" },
    { code: "02", name: "渝北中景隆(重庆)贸易有限公司 (胡汪洋代送)", nav: "" },
    { code: "03", name: "江北重庆兴农融资担保集团有限公司 (胡汪洋代送)", nav: "" },
    { code: "04", name: "江北重庆三峡融资担保集团有限公司 (胡汪洋代送)", nav: "" },
    { code: "05", name: "渝北Q312重庆沁园松石北路店", nav: "https://surl.amap.com/L0E65r1hcQ0" },
    { code: "06", name: "渝北Q044重庆沁园加州龙华小吃店", nav: "https://surl.amap.com/LMBE81r7aE" },
    { code: "07", name: "特渠部重庆明德商业保理有限公司 (胡汪洋代送)", nav: "" },
    { code: "08", name: "渝北Q398重庆沁园松石支路二店", nav: "https://surl.amap.com/LfpJ4R1h5Hw" },
    { code: "09", name: "渝北Q105重庆沁园财信国际小吃店 (胡汪洋代送)", nav: "" },
    { code: "10", name: "渝北格意东和春天店", nav: "https://surl.amap.com/MzBOpHEbHK" },
    { code: "11", name: "渝北JM03131谊品生鲜长安锦绣城店", nav: "https://surl.amap.com/AdXwff1e4Rz" },
    { code: "12", name: "特渠部重庆市卫生健康委员会", nav: "https://surl.amap.com/AweHMZ51hw" },
    { code: "13", name: "渝北钱大妈重庆东和春天店", nav: "https://surl.amap.com/AAhmTn1B2aU" },
    { code: "14", name: "天友24h重庆海浚酒店管理有限公司", nav: "https://surl.amap.com/Av3Msp1tbyg" },
    { code: "15", name: "特渠部重庆市市级机关后勤服务中心(龙脊花园食堂)", nav: "https://surl.amap.com/AEBwNPzfAK" },
    { code: "16", name: "渝北JM03050谊品生鲜温馨家园南门店", nav: "https://surl.amap.com/ASAMjvP8RY" },
    { code: "17", name: "渝北中国邮政集团江北分公司(佳阖养老)", nav: "https://surl.amap.com/XIREd4ZbaU" },
    { code: "18", name: "天友加盟韩志贤加盟重庆彭成商贸有限公司", nav: "https://surl.amap.com/BIThH3K4iZ" },
    { code: "19", name: "江北重庆彩食鲜供应链发展有限公司(中法供水花园新村)", nav: "https://surl.amap.com/BNfNhLHfqp" },
    { code: "20", name: "II类天友生活花卉东路店", nav: "https://surl.amap.com/BVENzHk6lp" },
    { code: "21", name: "江北重庆渝商餐饮文化产业投资有限公司", nav: "https://surl.amap.com/CjBlIB1dfQD" },
    { code: "22", name: "特渠部重庆市区嘉陵公园管理中心（大客户)", nav: "https://surl.amap.com/CQu3iNO3xc" },
    { code: "23", name: "江北重庆全嘉食品供应链科技有限公司（救助管理站）", nav: "https://surl.amap.com/D8ncdbEeHE" },
    { code: "24", name: "特渠部江北区全英食品经营部", nav: "https://surl.amap.com/D6PWU9Yfdl" },
    { code: "25", name: "江北沁园Q642绿地海外滩米拉公馆店", nav: "https://surl.amap.com/FIi3R7A1Lm" },
    { code: "26", name: "特渠部重庆市药品监督管理局检查一局", nav: "https://surl.amap.com/FVJ1YB12Mi" },
    { code: "27", name: "江北JM03022谊品生鲜重庆北国风光店", nav: "https://surl.amap.com/FAuespj1V5" },
    { code: "28", name: "江北亿达鲜半山华府店(客百年)", nav: "https://surl.amap.com/Fb9sjTL0kw" },
    { code: "29", name: "江北钱大妈半山华府店", nav: "https://surl.amap.com/F9F97bx8Bg" },
    { code: "30", name: "江北沁园Q568东方家园店", nav: "https://surl.amap.com/EX5L3rjctb" },
    { code: "31", name: "特渠部重庆市市级机关后勤服务中心（北滨路）", nav: "https://surl.amap.com/EvjVFLI17z" },
    { code: "32", name: "特渠部重庆市玖鑫酒店有限公司(市委统战部)", nav: "https://surl.amap.com/Ew9PFTTgsB" },
    { code: "33", name: "江北A02175谊品生鲜锦绣北滨路店", nav: "https://surl.amap.com/Erm38t34Ya" },
    { code: "34", name: "江北沁园Q432沁园金砂水岸店", nav: "https://surl.amap.com/EN7MNz1vaiA" },
    { code: "35", name: "江北Q784华唐立交店", nav: "https://surl.amap.com/pGIanJfg1O4" },
    { code: "36", name: "江北亿达鲜御龙天峰(客百年)", nav: "https://surl.amap.com/E28mE118bKv" },
    { code: "37", name: "江北JM03115谊品生鲜重庆御龙天峰店", nav: "https://surl.amap.com/E3x0Ex1sgRh" },
    { code: "38", name: "江北沁园Q714轨道华新街店", nav: "https://surl.amap.com/DPOFwRzdCq" },
    { code: "39", name: "江北益富隆观府国际店（客百年）", nav: "https://surl.amap.com/1flByr0485T" },
    { code: "40", name: "天友加盟农垦大厦店", nav: "https://surl.amap.com/DNucIhMedX" },
    { code: "41", name: "天友加盟三钢厂加盟", nav: "https://surl.amap.com/UdCgRcL0in" }
  ];
  
  try {
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
    
    if (method === 'PUT') {
      const body = await request.json();
      const redisKey = `route:${route}`;
      const dataToSave = JSON.stringify({ route: route, stores: body.stores || [], updatedAt: new Date().toISOString() });
      
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