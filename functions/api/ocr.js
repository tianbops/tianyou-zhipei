// 天友智配One - 运单截图 OCR
// OCR 只负责把图片转换为可人工核对的原始文字与基础元数据。
// 门店提取、基准比对、排序和保存由后续“开始解析”流程完成。
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
    return json({success:true,data:{route,date:normalizeDate(parsed.date),vehicle:normalizeVehicle(parsed.vehicle),totalWeight:normalizeWeight(parsed.totalWeight),rawOrderCount:Number(parsed.rawOrderCount)||0,rawText:String(parsed.rawText||''),message:'图片识别完成，请核对OCR文字后点击“开始解析”'}});
  }catch(e){console.error('OCR error',e);return json({success:false,error:e?.message||'运单图片处理失败'},500)}
}

async function runVisionOCR(AI,image){
  const bytes=decodeImageBase64(image);if(!bytes.length)throw new Error('图片数据无效或无法解码');
  const prompt=`你是“天友智配One”运单截图OCR。请完整读取这张手机截图，目标是生成“原始文字”，供用户人工核对后再解析。不能猜测、不能遗漏。\n\n规则：\n1. 完整读取整张图片中的可见文字，并尽量保持原有阅读顺序。\n2. 重点完整读取“承运订单”下面的配送路线；长公司名即使在手机截图中自动换行，也必须保留为连续文字。\n3. 箭头可能是 ->、→、＞、》、➜、➤、⇒，原样保留或统一为 -> 均可。\n4. 提取运输日期、车牌号、总重量、总数量。\n5. “总数量207”是商品/订单数量，绝对不能解释成门店数量。\n6. 不要自行计算门店数量，不要自行删除疑似门店，也不要进行基准库匹配。\n7. 不要让额定载重、额定体积、司机、送货员以及底部ZW订单编号干扰路线文字。\n8. 必须从第一个客户一直读取到最后一个客户。\n\n只返回JSON，不要Markdown，不要解释：\n{"date":"2026-08-22","vehicle":"渝DK7692","rawOrderCount":207,"totalWeight":"1.806213t","rawText":"完整OCR原文"}`;
  const dataUrl=String(image),messages=[{role:'user',content:[{type:'text',text:prompt},{type:'image_url',image_url:{url:dataUrl}}]}];
  try{return parseAIResponse(await AI.run('@cf/google/gemma-4-26b-a4b-it',{messages,max_completion_tokens:4096,temperature:0,chat_template_kwargs:{thinking:false}}))}catch(first){return parseAIResponse(await AI.run('@cf/llava-hf/llava-1.5-7b-hf',{prompt,image:Array.from(bytes),max_tokens:4096,temperature:0.01}))}
}
function extractAIText(r){if(typeof r==='string')return r;if(!r||typeof r!=='object')return '';return String(r.response??r.text??r.description??r.result?.response??r.result?.text??r.result?.description??'')}
function parseAIResponse(r){const s=extractAIText(r).trim(),c=[];const f=s.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);if(f)c.push(f[1]);c.push(s);const a=s.indexOf('{'),z=s.lastIndexOf('}');if(a>=0&&z>a)c.push(s.slice(a,z+1));for(const x of c){try{const d=JSON.parse(x);if(d&&typeof d==='object')return{date:d.date||'',vehicle:d.vehicle||'',totalWeight:d.totalWeight||'',rawOrderCount:d.rawOrderCount||0,rawText:String(d.rawText||d.routeText||'')}}catch(_){}}return{date:'',vehicle:'',totalWeight:'',rawOrderCount:0,rawText:s}}
function decodeImageBase64(input){let v=String(input||'').trim(),comma=v.indexOf(',');if(v.startsWith('data:')&&comma>=0)v=v.slice(comma+1);v=v.replace(/\s/g,'');const b=atob(v),a=new Uint8Array(b.length);for(let i=0;i<b.length;i++)a[i]=b.charCodeAt(i);return a}
function normalizeWeight(v){if(v===null||v===undefined||v==='')return '';const s=String(v).trim(),m=s.match(/[\d]+(?:\.\d+)?/);if(!m)return '';const n=Number(m[0]);return/吨|\bt\b/i.test(s)?`${n}t`:`${n}kg`}
function normalizeVehicle(v){return String(v||'').replace(/[\s>]+$/,'').trim()}
function normalizeDate(v){const s=String(v||'').replace(/[年月]/g,'-').replace(/日/g,'').replace(/[/.]/g,'-'),m=s.match(/(20\d{2})-(\d{1,2})-(\d{1,2})/);return m?`${m[1]}-${String(m[2]).padStart(2,'0')}-${String(m[3]).padStart(2,'0')}`:s}
function normalizeRoute(v){const s=String(v||'').trim(),m=s.match(/^(?:([0-9]+)|([0-9]+)号线)$/);return m?`${String(parseInt(m[1]||m[2],10)).padStart(2,'0')}号线`:s}
function json(data,status=200){return new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json;charset=UTF-8','Cache-Control':'no-store'}})}
