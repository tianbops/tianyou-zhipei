// 天友智配One - 运单截图 OCR
// 第一阶段：图片 -> 可核对的高保真运单文字。
// OCR不做门店纠错、不排序、不保存原图；门店身份确认统一由 /api/parse 完成。
import { authRequired } from './_auth.js';

const OCR_MODEL='@cf/google/gemma-4-26b-a4b-it';
const OCR_MAX_TOKENS=6144;
const LINE_MAX_TOKENS=1536;
const OCR_PROMPT=`你正在执行“天友智配One 运单截图 OCR”。
这不是摘要、问答或门店匹配任务，只进行高保真视觉转录。

【核心目标】
完整读取图片中实际可见的文字，从图片顶部开始按照视觉顺序一直读取到图片底部。
门店名称中的每一个汉字、英文字母、数字、业务编号都很重要。

【双图复核】
如果收到两张图片，它们是同一视觉区域的“原图”和“增强清晰版”，不是两份不同订单。
必须逐字符对照两张图：原图负责确认真实版面和字符位置，增强图辅助辨认小字、笔画和相似汉字。
只有图像本身能够支持的信息才可以输出；不能因为常识、公司名称或线路知识补字。

【识别流程】
1. 先观察整张图片的版面结构，再逐行读取。
2. 对配送链区域逐行复读：第一遍读取整行，第二遍专门检查容易混淆的单字、字母、数字。
3. 每个门店名称都进行字符级复核，特别检查：相似汉字、偏旁缺失、漏字、连续重复字、英文/数字混入中文。
4. 对每一行的结尾再次检查，区分“完整结束”和“图片边缘截断”；如果图片确实截断，不要凭常识补齐。
5. 如果一个字符看不清，只保留能够从图像确认的部分，不要凭上下文补写。
6. 如果同一文字因为截图重叠实际出现两次，只输出一次；只有图片明确存在两条真实重复订单时才输出两次。
7. 如果图片底部还有内容，即使内容较小，也必须继续读取，不能提前结束。

【必须保留】
- 中文原文、英文字母、数字
- 日期、车牌号、额定载重、额定体积、主司机、送货员
- 总数量、总重量及占比、总体积及占比
- Q、JM、A等业务编号
- 门店配送链
- 图片中的箭头：->、→、＞、》、➜、➤、⇒
- 原始换行结构

【特别注意】
“总数量”是订单商品数量，不是门店数量。
不要把“总数量266”解释成266家门店。
不要使用线路基准库、常见公司名称、同音字、相似字作为纠错依据。
不要把OCR结果改写成标准门店名称。
不要删除看起来奇怪的字符；如果图片确实出现异常字符，应忠实保留。
不要为了让公司名称“完整”而自行补写缺失文字。
不要输出Markdown、解释、摘要或“识别结果：”前缀。

【最终复核】
输出前再次从上到下检查一次图片底部，确认没有遗漏后半段配送链。
只输出图片中能够视觉确认的原始文字。`;

const LINE_PROMPT=`你正在执行“天友智配One OCR低置信行视觉复核”。
图片是一行或一小段从运单截图中裁出的原始文字区域。
只做视觉转录，不做摘要、不做门店匹配、不做业务纠错。

要求：
1. 从左到右读取图片中实际可见文字。
2. 逐字符检查中文、英文字母、数字、Q/JM/A编号、括号和箭头。
3. 原图与增强图属于同一视觉区域；增强图只辅助看清笔画，不能凭常识补字。
4. 看不清的字符不要猜，不要用线路库或常见公司名称替换。
5. 保留图片中实际出现的异常字符。
6. 如果图片只显示一行的一部分，只输出可视觉确认的部分，不要自行补齐。
7. 只输出这一小段图片中的原始文字，不要输出解释、Markdown、JSON或“识别结果：”。`;

export async function onRequest({request,env}){
  if(request.method!=='POST')return json({success:false,error:'Method not allowed'},405);
  const session=await authRequired(request,env);
  if(!session)return json({success:false,error:'登录已失效或无权限'},401);
  try{
    const body=await request.json();
    const image=String(body?.image||'').trim();
    const variants=Array.isArray(body?.images)?body.images.map(v=>String(v||'').trim()).filter(Boolean):[];
    const images=variants.length?[...variants]:image?[image]:[];
    if(!images.length)return json({success:false,error:'缺少运单图片'},400);
    if(!env.AI||typeof env.AI.run!=='function')return json({success:false,error:'Cloudflare Workers AI 未绑定'},500);
    const route=normalizeRoute(session.route);
    if(!route)return json({success:false,error:'用户未绑定线路'},403);

    const mode=body?.mode==='line'?'line':'full';
    const parsed=await runVisionOCR(env.AI,images,mode);
    const rawText=cleanRawText(parsed.rawText||'');
    if(!rawText||isPlaceholderText(rawText))return json({success:false,error:'图片文字提取失败：模型没有读取到运单图片内容，请重新上传清晰、完整的运单图片'},422);

    return json({success:true,data:{
      route,
      date:mode==='line'?'':normalizeDate(parsed.date),
      vehicle:mode==='line'?'':normalizeVehicle(parsed.vehicle),
      totalWeight:mode==='line'?'':normalizeWeight(parsed.totalWeight),
      rawOrderCount:0,
      rawText,
      mode,
      message:mode==='line'?'低置信文字视觉复核完成。':'图片文字提取完成，请先检查OCR原文。'
    }});
  }catch(e){
    console.error('OCR error',e);
    return json({success:false,error:e?.message||'运单图片处理失败'},500);
  }
}

async function runVisionOCR(AI,images,mode='full'){
  const payloads=images.map(decodeImageBase64);
  if(payloads.some(v=>!v.length))throw new Error('图片数据无效或无法解码');
  const imageDataUrls=images.map(toImageDataUrl);
  const base64=bytesToBase64(payloads[0]);
  const prompt=mode==='line'?LINE_PROMPT:OCR_PROMPT;
  const maxTokens=mode==='line'?LINE_MAX_TOKENS:OCR_MAX_TOKENS;

  try{
    const content=[{type:'text',text:prompt}];
    for(const url of imageDataUrls)content.push({type:'image_url',image_url:{url}});
    const result=await AI.run(OCR_MODEL,{
      image:base64,
      messages:[{role:'user',content}],
      max_completion_tokens:maxTokens,
      temperature:0,
      chat_template_kwargs:{enable_thinking:false}
    });
    const text=cleanRawText(extractAIText(result));
    if(hasUsableOCR(text))return extractMeta(text);
    throw new Error('主OCR模型没有读取到运单文字');
  }catch(first){
    console.warn('Primary OCR failed:',first?.message||first);
    try{
      const result=await AI.run('@cf/llava-hf/llava-1.5-7b-hf',{
        image:Array.from(payloads[0]),
        prompt,
        max_tokens:maxTokens,
        temperature:0
      });
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
function decodeImageBase64(input){
  let v=String(input||'').trim();
  const comma=v.indexOf(',');
  if(v.startsWith('data:')&&comma>=0)v=v.slice(comma+1);
  v=v.replace(/\s/g,'');
  if(!v)throw new Error('图片数据为空');
  const b=atob(v),a=new Uint8Array(b.length);
  for(let i=0;i<b.length;i++)a[i]=b.charCodeAt(i);
  return a;
}
function bytesToBase64(bytes){
  let binary='';
  const chunk=0x8000;
  for(let i=0;i<bytes.length;i+=chunk)binary+=String.fromCharCode(...bytes.subarray(i,Math.min(i+chunk,bytes.length)));
  return btoa(binary);
}
function toImageDataUrl(input){
  const v=String(input||'').trim();
  if(/^data:image\/[a-z0-9.+-]+;base64,/i.test(v))return v;
  return `data:image/jpeg;base64,${v.replace(/\s/g,'')}`;
}
function normalizeWeight(v){
  if(v===null||v===undefined||v==='')return '';
  const s=String(v).trim(),m=s.match(/[\d]+(?:\.\d+)?/);
  if(!m)return '';
  const n=Number(m[0]);
  return /吨|\bt\b/i.test(s)?`${(n*1000).toFixed(3).replace(/\.000$/,'')}kg`:`${n}kg`;
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
function json(data,status=200){return new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json;charset=UTF-8','Cache-Control':'no-store'}})}
