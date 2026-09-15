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
    const body=await request.json();
    const image=String(body?.image||'').trim();
    if(!image)return json({success:false,error:'缺少运单图片'},400);
    if(!env.AI||typeof env.AI.run!=='function')return json({success:false,error:'Cloudflare Workers AI 未绑定'},500);

    const parsed=await runVisionOCR(env.AI,image);
    const route=normalizeRoute(session.route);
    if(!route)return json({success:false,error:'用户未绑定线路'},403);
    const rawText=cleanRawText(parsed.rawText||'');
    if(!rawText||isPlaceholderText(rawText))return json({success:false,error:'图片中未提取到有效文字，请重新拍摄清晰、完整的运单图片'},422);

    return json({success:true,data:{route,date:normalizeDate(parsed.date),vehicle:normalizeVehicle(parsed.vehicle),totalWeight:normalizeWeight(parsed.totalWeight),rawOrderCount:0,rawText,message:'图片文字提取完成，请先检查OCR原文。'}});
  }catch(e){
    console.error('OCR error',e);
    return json({success:false,error:e?.message||'运单图片处理失败'},500)
  }
}

async function runVisionOCR(AI,image){
  const payload=decodeImageBase64(image);
  if(!payload.length)throw new Error('图片数据无效或无法解码');

  const prompt='只做图片文字识别。逐字抄录图片中所有可见文字，按从上到下、从左到右输出。保留中文、数字、字母、日期、车牌、重量、订单号、箭头和换行。不要猜测模糊文字，不要纠错，不要总结，不要解释，不要JSON，不要Markdown。必须读取我提供的图片本身，只输出图片中实际看到的原文；如果图片无法读取，明确返回“图片无法读取”，不要返回这段指令。';
  const imageDataUrl=toImageDataUrl(image);

  try{
    // Gemma 4 的视觉输入保留 data:image/...;base64,... 形式，避免图片被当成普通文本处理。
    const result=await AI.run(OCR_MODEL,{
      image:imageDataUrl,
      messages:[{role:'user',content:prompt}],
      max_completion_tokens:OCR_MAX_TOKENS,
      temperature:0,
      chat_template_kwargs:{enable_thinking:false}
    });
    const text=cleanRawText(extractAIText(result));
    if(hasUsableOCR(text))return extractMeta(text);
    throw new Error('主OCR模型没有返回有效文字');
  }catch(first){
    console.warn('Primary OCR failed:',first?.message||first);
    try{
      const result=await AI.run('@cf/llava-hf/llava-1.5-7b-hf',{
        image:Array.from(payload),
        prompt,
        max_tokens:OCR_MAX_TOKENS,
        temperature:0
      });
      const text=cleanRawText(extractAIText(result));
      if(hasUsableOCR(text))return extractMeta(text);
    }catch(second){
      console.warn('Fallback OCR failed:',second?.message||second);
    }
    throw new Error('OCR模型未返回有效文字，请重新上传清晰、完整的运单图片');
  }
}

function extractMeta(rawText){
  const s=String(rawText||'');
  const date=s.match(/(20\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2}日?)/);
  const vehicle=s.match(/(?:车牌号|车牌|车辆)\s*[:：]?\s*([\u4e00-\u9fa5][A-Z0-9]{5,7})/i);
  const weight=s.match(/(?:总重量|重量)\s*[:：]?\s*([\d]+(?:\.\d+)?)\s*(kg|KG|千克|公斤|吨|t)?/i);
  return{date:date?date[1]:'',vehicle:vehicle?vehicle[1]:'',totalWeight:weight?`${weight[1]}${weight[2]||'kg'}`:'',rawText};
}

function extractAIText(r){
  if(typeof r==='string')return r;
  if(!r||typeof r!=='object')return '';
  return String(r.response??r.text??r.description??r.content??r.result?.response??r.result?.text??r.result?.description??r.result?.content??r.choices?.[0]?.message?.content??'');
}
function hasUsableOCR(v){const s=cleanRawText(v);return !!s&&!isPlaceholderText(s)}
function isPlaceholderText(v){const s=cleanRawText(v).replace(/[“”\"'`]/g,'').replace(/\s+/g,'');return !s||s==='这里放整张图片的完整文字'||s==='这里放整张图片的完整原始文字'||s.includes('这里放整张图片的完整原始文字')||s.includes('请上传您需要识别的图片')}
function cleanRawText(v){return String(v??'').replace(/\r\n/g,'\n').replace(/\r/g,'\n').replace(/\u0000/g,'').trim()}
function decodeImageBase64(input){let v=String(input||'').trim(),comma=v.indexOf(',');if(v.startsWith('data:')&&comma>=0)v=v.slice(comma+1);v=v.replace(/\s/g,'');if(!v)throw new Error('图片数据为空');const b=atob(v),a=new Uint8Array(b.length);for(let i=0;i<b.length;i++)a[i]=b.charCodeAt(i);return a}
function toImageDataUrl(input){const v=String(input||'').trim();if(/^data:image\/[a-z0-9.+-]+;base64,/i.test(v))return v;return `data:image/jpeg;base64,${v.replace(/\s/g,'')}`}
function normalizeWeight(v){if(v===null||v===undefined||v==='')return '';const s=String(v).trim(),m=s.match(/[\d]+(?:\.\d+)?/);if(!m)return '';const n=Number(m[0]);return/吨|\bt\b/i.test(s)?`${(n*1000).toFixed(3).replace(/\.000$/,'')}kg`:`${n}kg`}
function normalizeVehicle(v){return String(v||'').replace(/[\s>]+$/,'').trim()}
function normalizeDate(v){const s=String(v||'').replace(/[年月]/g,'-').replace(/日/g,'').replace(/[/.]/g,'-'),m=s.match(/(20\d{2})-(\d{1,2})-(\d{1,2})/);return m?`${m[1]}-${String(m[2]).padStart(2,'0')}-${String(m[3]).padStart(2,'0')}`:s}
function normalizeRoute(v){const s=String(v||'').trim(),m=s.match(/^(?:([0-9]+)|([0-9]+)号线)$/);return m?`${String(parseInt(m[1]||m[2],10)).padStart(2,'0')}号线`:s}
function json(data,status=200){return new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json;charset=UTF-8','Cache-Control':'no-store'}})}
