// 天友智配One - 运单截图 OCR
// 第一阶段：图片 -> 可核对的高保真运单文字。
// 不做门店纠错、不排序、不保存原图；门店身份确认统一由 /api/parse 完成。
import { authRequired } from './_auth.js';

const OCR_MODEL='@cf/google/gemma-4-26b-a4b-it';
const OCR_MAX_TOKENS=6144;
const LINE_MAX_TOKENS=1536;
const OCR_PROMPT=`你正在执行“天友智配One 运单截图 OCR”。
任务只有一个：忠实读取图片中的实际文字，不是摘要、问答、门店匹配或纠错。

请先观察整张图片，再从顶部一直读取到图片底部。
配送链是最重要区域，必须完整读取到最后一个可见门店，不能因为前面已经识别出很多内容就提前停止。
对每个门店逐字符复核：中文、英文、数字、Q/JM/A编号、括号和箭头。
遇到小字时放大视觉区域重新检查；如果字符确实无法确认，只保留能确认的部分，绝不凭常识补字。

如果收到多张图片，它们表示同一视觉区域的原图/增强图，不是不同订单。请逐字符对照，原图用于确认字符位置和真实版面，增强图辅助辨认细小笔画。
不要使用线路数据库、公司名称常识、同音字或历史答案纠正OCR。
不要把OCR结果改写成标准门店名称。
不要删除看起来奇怪但实际存在的字符。
不要把“总数量266”理解成门店数量。
保留日期、车牌、额定装载、司机、送货员、总数量、总重量、总体积和配送链。
保留图片实际出现的箭头和换行结构。
不要输出Markdown、JSON、解释、摘要或“识别结果：”前缀。

最终必须再次检查图片底部，确认后半段配送链没有遗漏，再输出全文。`;

const LINE_PROMPT=`你正在执行运单OCR低置信区域复核。
只读取图片中实际可见的这一小段文字，从左到右逐字符转录。
检查中文、英文字母、数字、Q/JM/A编号、括号和箭头。
如果同时收到原图和增强图，它们是同一区域，只用于相互核对。
不要使用线路库、公司名称常识或历史答案纠错；看不清就保留可确认部分，不要猜测补字。
只输出图片中可视觉确认的原始文字，不要解释，不要Markdown，不要JSON。`;

export async function onRequest({request,env}){
  if(request.method!=='POST')return json({success:false,error:'Method not allowed'},405);
  const session=await authRequired(request,env);
  if(!session)return json({success:false,error:'登录已失效或无权限'},401);
  try{
    const body=await request.json();
    const image=String(body?.image||'').trim();
    const variants=Array.isArray(body?.images)?body.images.map(v=>String(v||'').trim()).filter(Boolean):[];
    const images=variants.length?variants:image?[image]:[];
    if(!images.length)return json({success:false,error:'缺少运单图片'},400);
    if(!env.AI||typeof env.AI.run!=='function')return json({success:false,error:'Cloudflare Workers AI 未绑定'},500);
    const route=normalizeRoute(session.route);
    if(!route)return json({success:false,error:'用户未绑定线路'},403);
    const mode=body?.mode==='line'?'line':'full';
    const parsed=await runVisionOCR(env.AI,images,mode);
    const rawText=cleanRawText(parsed.rawText);
    if(!rawText||isPlaceholderText(rawText))return json({success:false,error:'图片文字提取失败：模型没有读取到运单图片内容，请重新上传清晰、完整的运单图片'},422);
    return json({success:true,data:{route,date:mode==='line'?'':normalizeDate(parsed.date),vehicle:mode==='line'?'':normalizeVehicle(parsed.vehicle),totalWeight:mode==='line'?'':normalizeWeight(parsed.totalWeight),rawOrderCount:0,rawText,mode,message:mode==='line'?'低置信文字视觉复核完成。':'图片文字提取完成，请先检查OCR原文。'}});
  }catch(e){
    console.error('OCR error',e);
    return json({success:false,error:e?.message||'运单图片处理失败'},500);
  }
}

async function runVisionOCR(AI,images,mode='full'){
  const payloads=images.map(decodeImageBase64);
  if(payloads.some(v=>!v.length))throw new Error('图片数据无效或无法解码');
  const dataUrls=images.map(toImageDataUrl);
  const base64=bytesToBase64(payloads[0]);
  const prompt=mode==='line'?LINE_PROMPT:OCR_PROMPT;
  const maxTokens=mode==='line'?LINE_MAX_TOKENS:OCR_MAX_TOKENS;

  try{
    const content=[{type:'text',text:prompt},...dataUrls.map(url=>({type:'image_url',image_url:{url}}))];
    const result=await AI.run(OCR_MODEL,{image:base64,messages:[{role:'user',content}],max_completion_tokens:maxTokens,temperature:0,chat_template_kwargs:{enable_thinking:false}});
    const text=cleanRawText(extractAIText(result));
    if(hasUsableOCR(text))return extractMeta(text);
    throw new Error('主OCR模型没有读取到运单文字');
  }catch(first){
    console.warn('Primary OCR failed:',first?.message||first);
    try{
      const result=await AI.run('@cf/llava-hf/llava-1.5-7b-hf',{image:Array.from(payloads[0]),prompt,max_tokens:maxTokens,temperature:0});
      const text=cleanRawText(extractAIText(result));
      if(hasUsableOCR(text))return extractMeta(text);
    }catch(second){console.warn('Fallback OCR failed:',second?.message||second)}
    throw new Error('OCR没有成功读取运单图片文字，请重新上传清晰、完整的运单图片');
  }
}

function extractMeta(rawText){
  const s=String(rawText||''),date=s.match(/(20\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2}日?)/),vehicle=s.match(/(?:车牌号|车牌|车辆)\s*[:：]?\s*([\u4e00-\u9fa5][A-Z0-9]{5,7})/i),weight=s.match(/(?:总重量|重量)\s*[:：]?\s*([\d]+(?:\.\d+)?)\s*(kg|KG|千克|公斤|吨|t)?/i);
  return{date:date?date[1]:'',vehicle:vehicle?vehicle[1]:'',totalWeight:weight?`${weight[1]}${weight[2]||'kg'}`:'',rawText:s};
}
function extractAIText(r){if(typeof r==='string')return r;if(!r||typeof r!=='object')return '';return String(r.response??r.text??r.description??r.content??r.result?.response??r.result?.text??r.result?.description??r.result?.content??r.choices?.[0]?.message?.content??'')}
function hasUsableOCR(v){const s=cleanRawText(v);return !!s&&!isPlaceholderText(s)}
function isPlaceholderText(v){const s=cleanRawText(v).replace(/[“”\"'`]/g,'').replace(/\s+/g,'');if(!s)return true;const bad=['这里放整张图片的完整文字','这里放整张图片的完整原始文字','请提供您需要识别的图片','请上传您需要识别的图片','请上传需要识别的图片','请提供图片','请上传图片','图片无法读取','请重新上传图片'];return bad.some(x=>s===x||s.includes(x))}
function cleanRawText(v){return String(v??'').replace(/\r\n/g,'\n').replace(/\r/g,'\n').replace(/\u0000/g,'').trim()}
function decodeImageBase64(input){let v=String(input||'').trim(),comma=v.indexOf(',');if(v.startsWith('data:')&&comma>=0)v=v.slice(comma+1);v=v.replace(/\s/g,'');if(!v)throw new Error('图片数据为空');const b=atob(v),a=new Uint8Array(b.length);for(let i=0;i<b.length;i++)a[i]=b.charCodeAt(i);return a}
function bytesToBase64(bytes){let binary='';const chunk=0x8000;for(let i=0;i<bytes.length;i+=chunk)binary+=String.fromCharCode(...bytes.subarray(i,Math.min(i+chunk,bytes.length)));return btoa(binary)}
function toImageDataUrl(input){const v=String(input||'').trim();if(/^data:image\/[a-z0-9.+-]+;base64,/i.test(v))return v;return `data:image/jpeg;base64,${v.replace(/\s/g,'')}`}
function normalizeWeight(v){if(v===null||v===undefined||v==='')return '';const s=String(v).trim(),m=s.match(/[\d]+(?:\.\d+)?/);if(!m)return '';const n=Number(m[0]);return /吨|\bt\b/i.test(s)?`${(n*1000).toFixed(3).replace(/\.000$/,'')}kg`:`${n}kg`}
function normalizeVehicle(v){return String(v||'').replace(/[\s>]+$/,'').trim()}
function normalizeDate(v){const s=String(v||'').replace(/[年月]/g,'-').replace(/日/g,'').replace(/[/.]/g,'-'),m=s.match(/(20\d{2})-(\d{1,2})-(\d{1,2})/);return m?`${m[1]}-${String(m[2]).padStart(2,'0')}-${String(m[3]).padStart(2,'0')}`:s}
function normalizeRoute(v){const s=String(v||'').trim(),m=s.match(/^(?:([0-9]+)|([0-9]+)号线)$/);return m?`${String(parseInt(m[1]||m[2],10)).padStart(2,'0')}号线`:s}
function json(data,status=200){return new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json;charset=UTF-8','Cache-Control':'no-store'}})}
