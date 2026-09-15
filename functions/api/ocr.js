// 天友智配One - 运单截图 OCR
// 第一阶段：图片 -> 可核对的运单文字。
// OCR阶段只负责忠实读取图片，不做门店纠错、不排序、不保存订单。
// 门店身份纠正与基准库匹配统一放到 /api/parse，避免硬编码记忆OCR错字。
import { authRequired } from './_auth.js';

const OCR_MODEL='@cf/google/gemma-4-26b-a4b-it';
const OCR_MAX_TOKENS=4096;
const OCR_PROMPT=`你正在执行“天友智配One 运单截图 OCR”。这不是聊天问答，也不是摘要任务。

必须直接读取附带的运单图片本身，并尽可能忠实地转录图片中实际可见的文字。

严格要求：
1. 从图片顶部开始，按视觉阅读顺序逐行读取，直到图片底部；不要只读取局部。
2. 保留图片中的中文、数字、英文字母、日期、车牌号、重量、体积、订单字段、业务编号以及箭头。
3. 门店配送链中的“->”“→”“＞”“》”“➜”“➤”“⇒”都要原样保留；不要删除箭头。
4. 保留原始换行。一个门店如果因为屏幕换行被拆成两行，仍然逐字抄录，不要擅自改写成另一家门店。
5. 对中文相似字必须以图片字形为准：不要根据常识、记忆、上下文或基准门店名称擅自纠正。
6. Q、JM、A等门店业务编号必须尽量完整保留。
7. “总数量”是订单商品数量，不是门店数量；不要把它改写成门店数。
8. 不要总结，不要解释，不要补充图片里没有的内容。
9. 不要输出“请提供图片”“无法读取图片”“这里放文字”等模板回复。
10. 如果某个字符确实看不清，保留你能确认的字符，不要凭空猜测整个门店名称。
11. 只输出OCR转录结果，不要使用Markdown代码块，不要加“识别结果：”之类的前缀。`;

export async function onRequest({request,env}){
  if(request.method!=='POST')return json({success:false,error:'Method not allowed'},405);
  const session=await authRequired(request,env);
  if(!session)return json({success:false,error:'登录已失效或无权限'},401);
  try{
    const body=await request.json();
    const image=String(body?.image||'').trim();
    if(!image)return json({success:false,error:'缺少运单图片'},400);
    if(!env.AI||typeof env.AI.run!=='function')return json({success:false,error:'Cloudflare Workers AI 未绑定'},500);
    const route=normalizeRoute(session.route);
    if(!route)return json({success:false,error:'用户未绑定线路'},403);
    const parsed=await runVisionOCR(env.AI,image);
    const rawText=cleanRawText(parsed.rawText||'');
    if(!rawText||isPlaceholderText(rawText))return json({success:false,error:'图片文字提取失败：模型没有读取到运单图片内容，请重新上传清晰、完整的运单图片'},422);
    return json({success:true,data:{route,date:normalizeDate(parsed.date),vehicle:normalizeVehicle(parsed.vehicle),totalWeight:normalizeWeight(parsed.totalWeight),rawOrderCount:0,rawText,message:'图片文字提取完成，请先检查OCR原文。'}});
  }catch(e){
    console.error('OCR error',e);
    return json({success:false,error:e?.message||'运单图片处理失败'},500);
  }
}

async function runVisionOCR(AI,image){
  const payload=decodeImageBase64(image);
  if(!payload.length)throw new Error('图片数据无效或无法解码');
  const base64=bytesToBase64(payload);
  const imageDataUrl=toImageDataUrl(image);
  try{
    const result=await AI.run(OCR_MODEL,{image:base64,messages:[{role:'user',content:[{type:'text',text:OCR_PROMPT},{type:'image_url',image_url:{url:imageDataUrl}}]}],max_completion_tokens:OCR_MAX_TOKENS,temperature:0,chat_template_kwargs:{enable_thinking:false}});
    const text=cleanRawText(extractAIText(result));
    if(hasUsableOCR(text))return extractMeta(text);
    throw new Error('主OCR模型没有读取到运单文字');
  }catch(first){
    console.warn('Primary OCR failed:',first?.message||first);
    try{
      const result=await AI.run('@cf/llava-hf/llava-1.5-7b-hf',{image:Array.from(payload),prompt:OCR_PROMPT,max_tokens:OCR_MAX_TOKENS,temperature:0});
      const text=cleanRawText(extractAIText(result));
      if(hasUsableOCR(text))return extractMeta(text);
    }catch(second){
      console.warn('Fallback OCR failed:',second?.message||second);
    }
    throw new Error('OCR没有成功读取运单图片文字，请重新上传清晰、完整的运单图片');
  }
}

function extractMeta(rawText){
  const s=String(rawText||'');
  const date=s.match(/(20\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2}日?)/);
  const vehicle=s.match(/(?:车牌号|车牌|车辆)\s*[:：]?\s*([\u4e00-\u9fa5][A-Z0-9]{5,7})/i);
  const weight=s.match(/(?:总重量|重量)\s*[:：]?\s*([\d]+(?:\.\d+)?)\s*(kg|KG|千克|公斤|吨|t)?/i);
  return{date:date?date[1]:'',vehicle:vehicle?vehicle[1]:'',totalWeight:weight?`${weight[1]}${weight[2]||'kg'}`:'',rawText:s};
}
function extractAIText(r){
  if(typeof r==='string')return r;
  if(!r||typeof r!=='object')return '';
  return String(r.response??r.text??r.description??r.content??r.result?.response??r.result?.text??r.result?.description??r.result?.content??r.choices?.[0]?.message?.content??'');
}
function hasUsableOCR(v){const s=cleanRawText(v);return !!s&&!isPlaceholderText(s)}
function isPlaceholderText(v){
  const s=cleanRawText(v).replace(/[“”\"'`]/g,'').replace(/\s+/g,'');
  if(!s)return true;
  const bad=['这里放整张图片的完整文字','这里放整张图片的完整原始文字','请提供您需要识别的图片','请上传您需要识别的图片','请上传需要识别的图片','请提供图片','请上传图片','图片无法读取','请重新上传图片'];
  return bad.some(v=>s===v||s.includes(v));
}
function cleanRawText(v){return String(v??'').replace(/\r\n/g,'\n').replace(/\r/g,'\n').replace(/\u0000/g,'').trim()}
function decodeImageBase64(input){let v=String(input||'').trim(),comma=v.indexOf(',');if(v.startsWith('data:')&&comma>=0)v=v.slice(comma+1);v=v.replace(/\s/g,'');if(!v)throw new Error('图片数据为空');const b=atob(v),a=new Uint8Array(b.length);for(let i=0;i<b.length;i++)a[i]=b.charCodeAt(i);return a}
function bytesToBase64(bytes){let binary='';const chunk=0x8000;for(let i=0;i<bytes.length;i+=chunk)binary+=String.fromCharCode(...bytes.subarray(i,Math.min(i+chunk,bytes.length)));return btoa(binary)}
function toImageDataUrl(input){const v=String(input||'').trim();if(/^data:image\/[a-z0-9.+-]+;base64,/i.test(v))return v;return `data:image/jpeg;base64,${v.replace(/\s/g,'')}`}
function normalizeWeight(v){if(v===null||v===undefined||v==='')return '';const s=String(v).trim(),m=s.match(/[\d]+(?:\.\d+)?/);if(!m)return '';const n=Number(m[0]);return/吨|\bt\b/i.test(s)?`${(n*1000).toFixed(3).replace(/\.000$/,'')}kg`:`${n}kg`}
function normalizeVehicle(v){return String(v||'').replace(/[\s>]+$/,'').trim()}
function normalizeDate(v){const s=String(v||'').replace(/[年月]/g,'-').replace(/日/g,'').replace(/[/.]/g,'-'),m=s.match(/(20\d{2})-(\d{1,2})-(\d{1,2})/);return m?`${m[1]}-${String(m[2]).padStart(2,'0')}-${String(m[3]).padStart(2,'0')}`:s}
function normalizeRoute(v){const s=String(v||'').trim(),m=s.match(/^(?:([0-9]+)|([0-9]+)号线)$/);return m?`${String(parseInt(m[1]||m[2],10)).padStart(2,'0')}号线`:s}
function json(data,status=200){return new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json;charset=UTF-8','Cache-Control':'no-store'}})}
