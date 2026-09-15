// 天友智配One - 运单截图 OCR
// 第一阶段：图片 -> 可核对的运单文字。
// OCR阶段不解析门店、不排序、不保存订单；仅对已知门店OCR错字做基准名称纠正。
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
    const rawText=normalizeKnownStoreOCR(cleanRawText(parsed.rawText||''));
    if(!rawText||isPlaceholderText(rawText))return json({success:false,error:'图片文字提取失败：模型没有读取到运单图片内容，请重新上传清晰、完整的运单图片'},422);

    return json({success:true,data:{route,date:normalizeDate(parsed.date),vehicle:normalizeVehicle(parsed.vehicle),totalWeight:normalizeWeight(parsed.totalWeight),rawOrderCount:0,rawText,message:'图片文字提取完成，请先检查OCR原文。'}});
  }catch(e){
    console.error('OCR error',e);
    return json({success:false,error:e?.message||'运单图片处理失败'},500)
  }
}

async function runVisionOCR(AI,image){
  const payload=decodeImageBase64(image);
  if(!payload.length)throw new Error('图片数据无效或无法解码');

  const prompt='你现在执行的是运单图片OCR，不是聊天。你必须读取下面附带的图片本身。逐字抄录图片中所有可见文字，按从上到下、从左到右输出。保留中文、数字、字母、日期、车牌、重量、订单号、箭头和换行。不要猜测，不要总结，不要解释，不要回答“请提供图片”，不要复述任务说明。只输出图片中实际看到的文字。';
  const base64=bytesToBase64(payload);
  const imageDataUrl=toImageDataUrl(image);

  try{
    const result=await AI.run(OCR_MODEL,{
      image:base64,
      messages:[{
        role:'user',
        content:[
          {type:'text',text:prompt},
          {type:'image_url',image_url:{url:imageDataUrl}}
        ]
      }],
      max_completion_tokens:OCR_MAX_TOKENS,
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
    throw new Error('OCR没有成功读取运单图片文字，请重新上传清晰、完整的运单图片');
  }
}

function extractMeta(rawText){
  const s=normalizeKnownStoreOCR(String(rawText||''));
  const date=s.match(/(20\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2}日?)/);
  const vehicle=s.match(/(?:车牌号|车牌|车辆)\s*[:：]?\s*([\u4e00-\u9fa5][A-Z0-9]{5,7})/i);
  const weight=s.match(/(?:总重量|重量)\s*[:：]?\s*([\d]+(?:\.\d+)?)\s*(kg|KG|千克|公斤|吨|t)?/i);
  return{date:date?date[1]:'',vehicle:vehicle?vehicle[1]:'',totalWeight:weight?`${weight[1]}${weight[2]||'kg'}`:'',rawText:s};
}

function normalizeKnownStoreOCR(text){
  let s=String(text||'');

  // OCR可能把门店名称拆成多行、插入空格，或把相邻字符识别成近似字。
  // 这里按“忽略空白后的连续文本”进行精确纠正，只针对已经确认的17号线基准门店。
  const compact=s.replace(/[\s]+/g,'');
  const replacements=[
    ['天友24h重庆海滨酒店管理有限公司','天友24h重庆海浚酒店管理有限公司'],
    ['天友24h重庆海浸酒店管理有限公司','天友24h重庆海浚酒店管理有限公司'],
    ['江北重庆彩鲜供应链发展有限公司','江北重庆彩食鲜供应链发展有限公司'],
    ['江北沁园Q642绿地海外滩米拉公告店','江北沁园Q642绿地海外滩米拉公馆店']
  ];

  for(const [wrong,right] of replacements){
    const wrongCompact=wrong.replace(/\s+/g,'');
    if(!compact.includes(wrongCompact))continue;
    s=replaceIgnoringWhitespace(s,wrong,right);
  }
  return s;
}

function replaceIgnoringWhitespace(text,wrong,replacement){
  const source=String(text||'');
  const target=String(wrong||'').replace(/\s+/g,'');
  if(!target)return source;

  let compact='';
  const positions=[];
  for(let i=0;i<source.length;i++){
    if(/\s/.test(source[i]))continue;
    positions.push(i);
    compact+=source[i];
  }

  let start=0;
  let output=source;
  while(true){
    const index=compact.indexOf(target,start);
    if(index<0)break;
    const first=positions[index];
    const last=positions[index+target.length-1];
    output=output.slice(0,first)+replacement+output.slice(last+1);

    // 当前替换已经改变字符串长度，重新建立索引，避免后续位置错位。
    const nextStart=first+replacement.length;
    compact='';
    positions.length=0;
    for(let i=0;i<output.length;i++){
      if(/\s/.test(output[i]))continue;
      positions.push(i);
      compact+=output[i];
    }
    start=compact.indexOf(replacement.replace(/\s+/g,''),Math.max(0,nextStart-replacement.length));
    if(start<0)break;
    start+=replacement.replace(/\s+/g,'').length;
  }
  return output;
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
  const bad=[
    '这里放整张图片的完整文字',
    '这里放整张图片的完整原始文字',
    '请提供您需要识别的图片',
    '请上传您需要识别的图片',
    '请上传需要识别的图片',
    '请提供图片',
    '请上传图片',
    '图片无法读取',
    '请重新上传图片'
  ];
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
