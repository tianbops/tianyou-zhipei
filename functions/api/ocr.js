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
    const images=Array.isArray(body?.images)&&body.images.length?body.images:[body?.image];
    const validImages=images.filter(Boolean).map(String);
    if(!validImages.length)return json({success:false,error:'缺少运单图片'},400);
    if(!env.AI||typeof env.AI.run!=='function')return json({success:false,error:'Cloudflare Workers AI 未绑定'},500);

    const parsed=await runVisionOCR(env.AI,validImages);
    const route=normalizeRoute(session.route);
    if(!route)return json({success:false,error:'用户未绑定线路'},403);
    const rawText=cleanRawText(parsed.rawText||'');
    if(!rawText||isPlaceholderText(rawText))return json({success:false,error:'图片中未提取到有效文字，请重新拍摄清晰、完整的运单图片'},422);

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

async function runVisionOCR(AI,images){
  const prompt=`逐字抄录图片中的可见文字。按从上到下、从左到右输出。只做OCR，不解释、不总结、不改写、不纠错。中文、数字、字母、日期、车牌、重量、订单号、箭头和换行都要保留；看不清的字不要猜。只输出识别到的原文，不要标题、JSON、Markdown或说明。`;

  // 长运单切块后并行识别，避免整张图中文字过小；每块只负责自己的可见文字。
  const results=await Promise.all(images.map(async image=>{
    const bytes=decodeImageBase64(image);
    if(!bytes.length)throw new Error('图片数据无效或无法解码');
    try{
      const result=await AI.run(OCR_MODEL,{
        messages:[{role:'user',content:[
          {type:'text',text:prompt},
          {type:'image_url',image_url:{url:image}}
        ]}],
        max_completion_tokens:OCR_MAX_TOKENS,
        temperature:0,
        chat_template_kwargs:{thinking:false}
      });
      const text=cleanRawText(extractAIText(result));
      if(!text||isPlaceholderText(text))throw new Error('视觉模型未返回有效文字');
      return text;
    }catch(first){
      console.warn('Primary OCR model failed:',first?.message||first);
      const result=await AI.run('@cf/llava-hf/llava-1.5-7b-hf',{
        prompt,
        image:Array.from(bytes),
        max_tokens:OCR_MAX_TOKENS,
        temperature:0
      });
      const text=cleanRawText(extractAIText(result));
      if(!text||isPlaceholderText(text))throw new Error('视觉模型未返回有效文字');
      return text;
    }
  }));

  const rawText=mergeOCRBlocks(results);
  return extractMeta(rawText);
}

function extractMeta(rawText){
  const s=String(rawText||'');
  const date=s.match(/(20\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2}日?)/);
  const vehicle=s.match(/(?:车牌号|车牌|车辆)\s*[:：]?\s*([\u4e00-\u9fa5][A-Z0-9]{5,7})/i);
  const weight=s.match(/(?:总重量|重量)\s*[:：]?\s*([\d]+(?:\.\d+)?)\s*(kg|KG|千克|公斤|吨|t)?/i);
  return{date:date?date[1]:'',vehicle:vehicle?vehicle[1]:'',totalWeight:weight?`${weight[1]}${weight[2]||'kg'}`:'',rawText};
}

function mergeOCRBlocks(blocks){
  const out=[];
  for(const block of blocks){
    const lines=cleanRawText(block).split('\n').map(v=>v.trim()).filter(Boolean);
    for(const line of lines){
      const last=out[out.length-1];
      if(last&&similarLine(last,line))continue;
      out.push(line);
    }
  }
  return out.join('\n');
}

function similarLine(a,b){
  const x=String(a).replace(/\s+/g,'');
  const y=String(b).replace(/\s+/g,'');
  if(!x||!y)return false;
  if(x===y)return true;
  if(x.length>=8&&y.length>=8&&(x.includes(y)||y.includes(x)))return true;
  return false;
}

function extractAIText(r){
  if(typeof r==='string')return r;
  if(!r||typeof r!=='object')return '';
  return String(r.response??r.text??r.description??r.content??r.result?.response??r.result?.text??r.result?.description??r.result?.content??'');
}
function isPlaceholderText(v){const s=cleanRawText(v).replace(/[“”\"'`]/g,'').replace(/\s+/g,'');return !s||s==='这里放整张图片的完整文字'||s==='这里放整张图片的完整原始文字'||s.includes('这里放整张图片的完整原始文字')}
function cleanRawText(v){return String(v??'').replace(/\r\n/g,'\n').replace(/\r/g,'\n').replace(/\u0000/g,'').trim()}
function decodeImageBase64(input){let v=String(input||'').trim(),comma=v.indexOf(',');if(v.startsWith('data:')&&comma>=0)v=v.slice(comma+1);v=v.replace(/\s/g,'');const b=atob(v),a=new Uint8Array(b.length);for(let i=0;i<b.length;i++)a[i]=b.charCodeAt(i);return a}
function normalizeWeight(v){if(v===null||v===undefined||v==='')return '';const s=String(v).trim(),m=s.match(/[\d]+(?:\.\d+)?/);if(!m)return '';const n=Number(m[0]);return/吨|\bt\b/i.test(s)?`${(n*1000).toFixed(3).replace(/\.000$/,'')}kg`:`${n}kg`}
function normalizeVehicle(v){return String(v||'').replace(/[\s>]+$/,'').trim()}
function normalizeDate(v){const s=String(v||'').replace(/[年月]/g,'-').replace(/日/g,'').replace(/[/.]/g,'-'),m=s.match(/(20\d{2})-(\d{1,2})-(\d{1,2})/);return m?`${m[1]}-${String(m[2]).padStart(2,'0')}-${String(m[3]).padStart(2,'0')}`:s}
function normalizeRoute(v){const s=String(v||'').trim(),m=s.match(/^(?:([0-9]+)|([0-9]+)号线)$/);return m?`${String(parseInt(m[1]||m[2],10)).padStart(2,'0')}号线`:s}
function json(data,status=200){return new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json;charset=UTF-8','Cache-Control':'no-store'}})}
