// 天友智配One - 运单截图 OCR
// 第一阶段：图片 -> 完整原始文字。
// 不解析门店、不比对基准、不排序、不保存订单。
import { authRequired } from './_auth.js';

const OCR_MODEL='@cf/google/gemma-4-26b-a4b-it';
const OCR_MAX_TOKENS=4096;

export async function onRequest({request,env}){
  if(request.method!=='POST')return json({success:false,error:'Method not allowed'},405);
  const session=await authRequired(request,env);
  if(!session)return json({success:false,error:'登录已失效或无权限'},401);
  try{
    const body=await request.json(),image=body?.image;
    if(!image)return json({success:false,error:'缺少运单图片'},400);
    if(!env.AI||typeof env.AI.run!=='function')return json({success:false,error:'Cloudflare Workers AI 未绑定'},500);
    const parsed=await runVisionOCR(env.AI,image);
    const route=normalizeRoute(session.route);
    if(!route)return json({success:false,error:'用户未绑定线路'},403);

    const rawText=cleanRawText(parsed.rawText||parsed.text||parsed.content||'');
    if(!rawText||isPlaceholderText(rawText))return json({success:false,error:'图片中未提取到完整文字，请重新拍摄清晰、完整的运单图片'},422);

    return json({success:true,data:{
      route,
      date:normalizeDate(parsed.date),
      vehicle:normalizeVehicle(parsed.vehicle),
      totalWeight:normalizeWeight(parsed.totalWeight),
      rawOrderCount:0,
      rawText,
      message:'图片文字提取完成，请先检查OCR原文。'
    }});
  }catch(e){
    console.error('OCR error',e);
    return json({success:false,error:e?.message||'运单图片处理失败'},500)
  }
}

async function runVisionOCR(AI,image){
  const bytes=decodeImageBase64(image);
  if(!bytes.length)throw new Error('图片数据无效或无法解码');

  // 只要求模型输出原文，不再要求JSON，减少推理和无效输出，提高速度与稳定性。
  const prompt=`完整抄录这张天友乳业运单图片中的所有可见文字。\n从顶部到最底部按阅读顺序输出。保留中文、数字、字母、日期、车牌、重量、订单编号、箭头和原有换行。不要删除看起来无关的文字，不要纠正或改写门店名称。图片中的“总数量207”等文字必须原样保留。\n不要计算门店数量，不要匹配基准库，不要排序，不要生成订单。\n只输出图片原始文字，不要标题、说明、JSON、Markdown或任何占位文字。`;

  const messages=[{role:'user',content:[
    {type:'text',text:prompt},
    {type:'image_url',image_url:{url:String(image)}}
  ]}];

  try{
    const result=await AI.run(OCR_MODEL,{
      messages,
      max_completion_tokens:OCR_MAX_TOKENS,
      temperature:0,
      chat_template_kwargs:{thinking:false}
    });
    const parsed=parseAIResponse(result);
    if(hasUsableOCR(parsed.rawText))return parsed;
    throw new Error('主视觉模型未返回有效OCR原文');
  }catch(first){
    // 只有主模型真正失败时才启动备用模型，正常识别不会产生第二次AI请求。
    console.warn('Primary OCR model failed, using fallback:',first?.message||first);
    const result=await AI.run('@cf/llava-hf/llava-1.5-7b-hf',{
      prompt,
      image:Array.from(bytes),
      max_tokens:OCR_MAX_TOKENS,
      temperature:0.01
    });
    const parsed=parseAIResponse(result);
    if(hasUsableOCR(parsed.rawText))return parsed;
    throw new Error('视觉模型未返回有效的完整运单文字');
  }
}

function extractAIText(r){
  if(typeof r==='string')return r;
  if(!r||typeof r!=='object')return '';
  return String(r.response??r.text??r.description??r.content??r.result?.response??r.result?.text??r.result?.description??r.result?.content??'');
}

function parseAIResponse(r){
  const s=extractAIText(r).trim();
  if(!s)return{date:'',vehicle:'',totalWeight:'',rawOrderCount:0,rawText:''};

  // 兼容模型偶尔返回JSON的情况。
  const candidates=[];
  const fenced=s.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if(fenced)candidates.push(fenced[1]);
  const a=s.indexOf('{'),z=s.lastIndexOf('}');
  if(a>=0&&z>a)candidates.push(s.slice(a,z+1));
  for(const x of candidates){
    try{
      const d=JSON.parse(x),source=d?.data&&typeof d.data==='object'?d.data:d;
      if(d&&typeof d==='object'){
        const raw=cleanRawText(source?.rawText??source?.text??source?.content??source?.routeText??'');
        if(raw&&!isPlaceholderText(raw))return{date:source?.date||'',vehicle:source?.vehicle||'',totalWeight:source?.totalWeight||'',rawOrderCount:0,rawText:raw};
      }
    }catch(_){/* 按普通OCR文本继续处理 */}
  }
  return{date:'',vehicle:'',totalWeight:'',rawOrderCount:0,rawText:cleanRawText(s)};
}

function hasUsableOCR(v){const s=cleanRawText(v);return !!s&&!isPlaceholderText(s)}
function isPlaceholderText(v){const s=cleanRawText(v).replace(/[“”"'`]/g,'').replace(/\s+/g,'');return !s||s==='这里放整张图片的完整文字'||s==='这里放整张图片的完整原始文字'||s.includes('这里放整张图片的完整原始文字')}
function cleanRawText(v){return String(v??'').replace(/\r\n/g,'\n').replace(/\r/g,'\n').replace(/\u0000/g,'').trim()}
function decodeImageBase64(input){let v=String(input||'').trim(),comma=v.indexOf(',');if(v.startsWith('data:')&&comma>=0)v=v.slice(comma+1);v=v.replace(/\s/g,'');const b=atob(v),a=new Uint8Array(b.length);for(let i=0;i<b.length;i++)a[i]=b.charCodeAt(i);return a}
function normalizeWeight(v){if(v===null||v===undefined||v==='')return '';const s=String(v).trim(),m=s.match(/[\d]+(?:\.\d+)?/);if(!m)return '';const n=Number(m[0]);return/吨|\bt\b/i.test(s)?`${(n*1000).toFixed(3).replace(/\.000$/,'')}kg`:`${n}kg`}
function normalizeVehicle(v){return String(v||'').replace(/[\s>]+$/,'').trim()}
function normalizeDate(v){const s=String(v||'').replace(/[年月]/g,'-').replace(/日/g,'').replace(/[/.]/g,'-'),m=s.match(/(20\d{2})-(\d{1,2})-(\d{1,2})/);return m?`${m[1]}-${String(m[2]).padStart(2,'0')}-${String(m[3]).padStart(2,'0')}`:s}
function normalizeRoute(v){const s=String(v||'').trim(),m=s.match(/^(?:([0-9]+)|([0-9]+)号线)$/);return m?`${String(parseInt(m[1]||m[2],10)).padStart(2,'0')}号线`:s}
function json(data,status=200){return new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json;charset=UTF-8','Cache-Control':'no-store'}})}
