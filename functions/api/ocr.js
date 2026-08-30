// 天友智配One - 运单截图 OCR
// 第一阶段只做一件事：图片 -> 完整原始文字。
// 不解析门店、不比对基准、不排序、不保存订单。
import { authRequired } from './_auth.js';

export async function onRequest({request,env}){
  if(request.method!=='POST')return json({success:false,error:'Method not allowed'},405);
  const session=await authRequired(request,env);
  if(!session)return json({success:false,error:'登录已失效或无权限'},401);
  try{
    const body=await request.json(),image=body?.image;
    if(!image)return json({success:false,error:'缺少运单图片'},400);
    if(!env.AI||typeof env.AI.run!=='function')return json({success:false,error:'Cloudflare Workers AI 未绑定'},500);
    const parsed=await runVisionOCR(env.AI,image);
    const sessionRoute=normalizeRoute(session.route),requestedRoute=normalizeRoute(body?.route||''),route=session.role==='admin'?(requestedRoute||sessionRoute):sessionRoute;
    if(!route)return json({success:false,error:'用户未绑定线路'},403);

    // 第一阶段：rawText 是唯一核心输出。
    // 即使模型没有成功返回JSON，也必须尽可能把模型原始文本交给前端人工核对。
    const rawText=cleanRawText(parsed.rawText||parsed.text||parsed.content||'');
    if(!rawText)return json({success:false,error:'图片中未提取到可识别文字，请重新拍摄清晰、完整的运单图片'},422);

    return json({
      success:true,
      data:{
        route,
        date:normalizeDate(parsed.date),
        vehicle:normalizeVehicle(parsed.vehicle),
        totalWeight:normalizeWeight(parsed.totalWeight),
        rawOrderCount:Number(parsed.rawOrderCount)||0,
        rawText,
        message:'图片文字提取完成，请先检查OCR原文；当前阶段不会自动解析、比对或排序。'
      }
    });
  }catch(e){
    console.error('OCR error',e);
    return json({success:false,error:e?.message||'运单图片处理失败'},500)
  }
}

async function runVisionOCR(AI,image){
  const bytes=decodeImageBase64(image);
  if(!bytes.length)throw new Error('图片数据无效或无法解码');

  const prompt=`你是“天友智配One”的运单图片文字提取引擎。当前任务只有一个：把图片中可见的文字尽可能完整地提取出来，交给用户人工检查。\n\n严格要求：\n1. 从图片顶部开始，按照正常阅读顺序读取整张图片，直到最底部。\n2. 必须尽可能保留所有可见文字、数字、字母、中文、符号、日期、车牌、重量、订单编号、路线文字。\n3. 不能因为文字看起来像“无关信息”而主动删除；第一阶段宁可多提取，不要漏提。\n4. OCR原文尽量保持原来的换行和阅读顺序。\n5. 手机截图中一条长文字可能自动换行，换行属于版式，不代表这里已经完成业务解析。\n6. 箭头 ->、→、＞、》、➜、➤、⇒ 等均应保留。\n7. “总数量207”必须原样保留为图片文字，绝对不要改成门店数量。\n8. 不要计算门店数量。\n9. 不要删除、合并、纠正门店名称。即使怀疑OCR错误，也按图片实际看到的内容输出。\n10. 不要进行基准库匹配，不要排序，不要生成订单。\n11. 如果某处无法确认，保留能识别的字符，不要凭空编造。\n\n返回JSON对象，rawText字段必须包含完整OCR原文；rawText中的换行必须使用JSON合法的\\n转义。不要Markdown，不要解释：\n{"date":"","vehicle":"","rawOrderCount":0,"totalWeight":"","rawText":"这里放整张图片的完整原始文字"}`;

  const dataUrl=String(image);
  const messages=[{
    role:'user',
    content:[
      {type:'text',text:prompt},
      {type:'image_url',image_url:{url:dataUrl}}
    ]
  }];

  // 优先使用当前Workers AI视觉模型；失败后使用兼容的视觉模型。
  try{
    const result=await AI.run('@cf/google/gemma-4-26b-a4b-it',{
      messages,
      max_completion_tokens:6144,
      temperature:0,
      chat_template_kwargs:{thinking:false}
    });
    const parsed=parseAIResponse(result);
    if(cleanRawText(parsed.rawText||parsed.text||parsed.content||''))return parsed;
    throw new Error('主视觉模型未返回有效OCR原文');
  }catch(first){
    console.warn('Primary OCR model failed, using fallback:',first?.message||first);
    return parseAIResponse(await AI.run('@cf/llava-hf/llava-1.5-7b-hf',{
      prompt,
      image:Array.from(bytes),
      max_tokens:6144,
      temperature:0.01
    }));
  }
}

function extractAIText(r){
  if(typeof r==='string')return r;
  if(!r||typeof r!=='object')return '';
  return String(
    r.response??r.text??r.description??r.content??
    r.result?.response??r.result?.text??r.result?.description??r.result?.content??''
  );
}

function parseAIResponse(r){
  const s=extractAIText(r).trim();
  if(!s)return{date:'',vehicle:'',totalWeight:'',rawOrderCount:0,rawText:''};

  const candidates=[];
  const fenced=s.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if(fenced)candidates.push(fenced[1]);
  candidates.push(s);

  // 尝试从模型夹杂说明文字的响应中截取最外层JSON。
  const a=s.indexOf('{'),z=s.lastIndexOf('}');
  if(a>=0&&z>a)candidates.push(s.slice(a,z+1));

  for(const x of candidates){
    try{
      const d=JSON.parse(x);
      if(d&&typeof d==='object'){
        const source=d.data&&typeof d.data==='object'?d.data:d;
        return{
          date:source.date||'',
          vehicle:source.vehicle||'',
          totalWeight:source.totalWeight||'',
          rawOrderCount:source.rawOrderCount||0,
          rawText:String(source.rawText??source.text??source.content??source.routeText??'')
        };
      }
    }catch(_){/* 继续尝试下一种响应格式 */}
  }

  // JSON失败时不丢掉模型文本，交给前端人工核对。
  return{date:'',vehicle:'',totalWeight:'',rawOrderCount:0,rawText:s};
}

function cleanRawText(v){
  return String(v??'')
    .replace(/\r\n/g,'\n')
    .replace(/\r/g,'\n')
    .replace(/\u0000/g,'')
    .trim();
}

function decodeImageBase64(input){
  let v=String(input||'').trim(),comma=v.indexOf(',');
  if(v.startsWith('data:')&&comma>=0)v=v.slice(comma+1);
  v=v.replace(/\s/g,'');
  const b=atob(v),a=new Uint8Array(b.length);
  for(let i=0;i<b.length;i++)a[i]=b.charCodeAt(i);
  return a;
}

function normalizeWeight(v){
  if(v===null||v===undefined||v==='')return '';
  const s=String(v).trim(),m=s.match(/[\d]+(?:\.\d+)?/);
  if(!m)return '';
  const n=Number(m[0]);
  return/吨|\bt\b/i.test(s)?`${n}t`:`${n}kg`;
}

function normalizeVehicle(v){return String(v||'').replace(/[\s>]+$/,'').trim()}

function normalizeDate(v){
  const s=String(v||'').replace(/[年月]/g,'-').replace(/日/g,'').replace(/[/.]/g,'-');
  const m=s.match(/(20\d{2})-(\d{1,2})-(\d{1,2})/);
  return m?`${m[1]}-${String(m[2]).padStart(2,'0')}-${String(m[3]).padStart(2,'0')}`:s;
}

function normalizeRoute(v){
  const s=String(v||'').trim(),m=s.match(/^(?:([0-9]+)|([0-9]+)号线)$/);
  return m?`${String(parseInt(m[1]||m[2],10)).padStart(2,'0')}号线`:s;
}

function json(data,status=200){
  return new Response(JSON.stringify(data),{
    status,
    headers:{'Content-Type':'application/json;charset=UTF-8','Cache-Control':'no-store'}
  });
}
