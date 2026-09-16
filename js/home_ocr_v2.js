/* 天友智配One - OCR V3
 * 第一阶段：图片 -> 可核对的高保真运单文字。
 * 主识别：浏览器本地 PaddleOCR.js / PP-OCRv5
 * 低置信行：只把该行裁剪图送入现有 VLM 做视觉复核
 * 最后兜底：PaddleOCR 不可用时才使用原有整图分块 VLM
 * OCR阶段绝不使用线路库、业务字典或硬编码纠错。
 */
(function(){
'use strict';

const $=id=>document.getElementById(id);
const route=()=>window.Auth?.getCurrentRoute?.()||'';
const PADDLE_SDK='https://cdn.jsdelivr.net/npm/@paddleocr/paddleocr-js@0.4.2/+esm';
const ORT_WASM='https://cdn.jsdelivr.net/npm/onnxruntime-web@1.23.2/dist/';
const LOW_SCORE=.85;
const MAX_VLM_REVIEW=6;
let paddlePromise=null;
let paddleOCR=null;

function setStatus(text,percent=50){
  $('parseStatus')?.classList.add('active');
  if($('statusIcon'))$('statusIcon').textContent='⏳';
  if($('statusText'))$('statusText').textContent=text;
  if($('progressBar'))$('progressBar').style.width=`${percent}%`;
}
function showError(message){
  if(typeof window.showError==='function')window.showError(message);
  else if(typeof window.homeToast==='function')window.homeToast(message,'warning');
  else alert(message);
}
function placeholder(text){
  const s=String(text||'').replace(/[“”\"'`]/g,'').replace(/\s+/g,'');
  if(!s)return true;
  return ['这里放整张图片的完整文字','这里放整张图片的完整原始文字','请提供您需要识别的图片','请上传您需要识别的图片','请上传需要识别的图片','请提供图片','请上传图片','图片无法读取','请重新上传图片'].some(v=>s===v||s.includes(v));
}
function normalizeLine(v){
  return String(v||'').replace(/[→＞》➜➤⇒]/g,'->').replace(/-\s*>/g,'->').replace(/[“”‘’]/g,'').replace(/[\u200B-\u200D\uFEFF]/g,'').replace(/[ \t]+/g,' ').trim();
}
function similarity(a,b){
  const x=normalizeLine(a),y=normalizeLine(b);
  if(!x||!y)return 0;
  if(x===y)return 1;
  const prev=new Array(y.length+1);
  for(let j=0;j<=y.length;j++)prev[j]=j;
  for(let i=1;i<=x.length;i++){
    let left=prev[0];prev[0]=i;
    for(let j=1;j<=y.length;j++){
      const up=prev[j],cost=x[i-1]===y[j-1]?0:1;
      prev[j]=Math.min(prev[j]+1,prev[j-1]+1,left+cost);
      left=up;
    }
  }
  return 1-prev[y.length]/Math.max(x.length,y.length);
}
function extractDeliveryBody(text){
  const s=String(text||''),m=s.search(/承运订单/);
  return m<0?'':s.slice(m+'承运订单'.length).replace(/^\s*[:：]?/,'').trim();
}
function splitOrderTokens(text){
  const body=extractDeliveryBody(text);
  if(!body)return [];
  return body.replace(/[→＞》➜➤⇒]/g,'->').replace(/-\s*>/g,'->').split(/\s*->\s*/).map(v=>normalizeLine(v).replace(/^\d+[.、)）]\s]*/,'')).filter(v=>v&&v.length>=2);
}
function isOrderToken(v){
  const s=normalizeLine(v);
  return /[\u4e00-\u9fff]/.test(s)&&s.length>=2&&!/^(总数量|总重量|总体积|额定载重|额定体积)/.test(s);
}
function tokenOverlap(previous,next){
  if(!previous.length||!next.length)return 0;
  const max=Math.min(14,previous.length,next.length);
  for(let n=max;n>=2;n--){
    let total=0,strong=0;
    for(let i=0;i<n;i++){
      const score=similarity(previous[previous.length-n+i],next[i]);
      total+=score;if(score>=.60)strong++;
    }
    const avg=total/n;
    if((n>=6&&avg>=.55&&strong>=Math.ceil(n*.60))||(n>=4&&avg>=.66&&strong>=Math.ceil(n*.67))||(n===2&&avg>=.84))return n;
  }
  return 0;
}
function mergeOrderTokens(previous,next){
  if(!previous.length)return next.filter(isOrderToken);
  if(!next.length)return previous.slice();
  const n=tokenOverlap(previous,next);
  if(!n)return previous.concat(next.filter(isOrderToken));
  const result=previous.slice(0,-n);
  for(let i=0;i<n;i++)result.push(previous[previous.length-n+i].length>=next[i].length?previous[previous.length-n+i]:next[i]);
  result.push(...next.slice(n).filter(isOrderToken));
  return result;
}
function cleanHeader(text){
  const s=String(text||'').trim(),i=s.search(/承运订单/);
  return i<0?s:s.slice(0,i+'承运订单'.length);
}
function mergeOCRResults(results){
  const valid=results.filter(v=>v&&!placeholder(v));
  if(!valid.length)return '';
  let header=cleanHeader(valid[0]),orders=[];
  for(const block of valid)orders=mergeOrderTokens(orders,splitOrderTokens(block));
  return orders.length?`${header}\n${orders.join(' -> ')}`:valid[0];
}

async function loadPaddleOCR(){
  if(paddleOCR)return paddleOCR;
  if(paddlePromise)return paddlePromise;
  paddlePromise=(async()=>{
    const mod=await import(PADDLE_SDK);
    const PaddleOCR=mod.PaddleOCR||mod.default?.PaddleOCR||mod.default;
    if(!PaddleOCR||typeof PaddleOCR.create!=='function')throw new Error('PaddleOCR.js SDK加载失败');
    const ocr=await PaddleOCR.create({
      lang:'ch',
      ocrVersion:'PP-OCRv5',
      worker:true,
      textDetectionBatchSize:2,
      textRecognitionBatchSize:6,
      ortOptions:{backend:'wasm',wasmPaths:ORT_WASM,numThreads:2,simd:true}
    });
    paddleOCR=ocr;
    return ocr;
  })().catch(error=>{paddlePromise=null;throw error;});
  return paddlePromise;
}

async function paddleRecognize(file){
  const ocr=await loadPaddleOCR();
  const resultList=await ocr.predict(file,{textRecScoreThresh:0});
  const result=resultList?.[0];
  if(!result?.items?.length)throw new Error('PaddleOCR未检测到文字');
  const items=result.items.map((item,index)=>({
    index,
    text:String(item?.text||'').trim(),
    score:Number(item?.score),
    poly:Array.isArray(item?.poly)?item.poly:[],
  })).filter(item=>item.text);
  items.sort((a,b)=>readingOrder(a,b,result.image));
  return {items,metrics:result.metrics||{}};
}
function readingOrder(a,b,image){
  const ay=minY(a.poly),by=minY(b.poly),ah=boxHeight(a.poly),bh=boxHeight(b.poly);
  const threshold=Math.max(ah,bh)*.55;
  if(Math.abs(ay-by)<=threshold)return minX(a.poly)-minX(b.poly);
  return ay-by;
}
function minX(poly){return Array.isArray(poly)&&poly.length?Math.min(...poly.map(p=>Number(p?.[0]||0))):0}
function minY(poly){return Array.isArray(poly)&&poly.length?Math.min(...poly.map(p=>Number(p?.[1]||0))):0}
function maxY(poly){return Array.isArray(poly)&&poly.length?Math.max(...poly.map(p=>Number(p?.[1]||0))):0}
function boxHeight(poly){return Math.max(1,maxY(poly)-minY(poly))}
function isLowConfidence(item){return Number.isFinite(item.score)&&item.score<LOW_SCORE&&item.text.length>=3}
function itemLooksUseful(item){return /[\u4e00-\u9fffA-Za-z0-9]/.test(item.text)}

async function cropLine(file,item){
  const poly=item.poly;
  if(!poly?.length) return null;
  const url=URL.createObjectURL(file);
  try{
    const img=await new Promise((resolve,reject)=>{const i=new Image();i.onload=()=>resolve(i);i.onerror=()=>reject(Error('图片读取失败'));i.src=url;});
    const xs=poly.map(p=>Number(p?.[0]||0)),ys=poly.map(p=>Number(p?.[1]||0));
    const padX=Math.max(18,Math.round((Math.max(...xs)-Math.min(...xs))*.04));
    const padY=Math.max(16,Math.round((Math.max(...ys)-Math.min(...ys))*.55));
    const sx=Math.max(0,Math.floor(Math.min(...xs)-padX)),sy=Math.max(0,Math.floor(Math.min(...ys)-padY));
    const ex=Math.min(img.naturalWidth,Math.ceil(Math.max(...xs)+padX)),ey=Math.min(img.naturalHeight,Math.ceil(Math.max(...ys)+padY));
    const sw=Math.max(1,ex-sx),sh=Math.max(1,ey-sy),scale=Math.min(3,Math.max(2,1800/sw));
    const c=document.createElement('canvas');c.width=Math.round(sw*scale);c.height=Math.round(sh*scale);
    const ctx=c.getContext('2d',{alpha:false});ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality='high';ctx.fillStyle='#fff';ctx.fillRect(0,0,c.width,c.height);
    ctx.filter='grayscale(1) contrast(1.12) brightness(1.02)';ctx.drawImage(img,sx,sy,sw,sh,0,0,c.width,c.height);ctx.filter='none';
    return c.toDataURL('image/jpeg',.96);
  }finally{URL.revokeObjectURL(url);}
}

async function reviewLowConfidenceLines(file,items){
  const targets=items.filter(isLowConfidence).filter(itemLooksUseful).slice(0,MAX_VLM_REVIEW);
  if(!targets.length)return new Map();
  const replacements=new Map();
  for(let i=0;i<targets.length;i++){
    try{
      const crop=await cropLine(file,targets[i]);
      if(!crop)continue;
      const enhanced=await enhancedVariant(crop);
      const data=await one([crop,enhanced],'line');
      const reviewed=extractSingleLine(data.rawText);
      if(reviewed)replacements.set(targets[i].index,reviewed);
    }catch(error){console.warn('低置信行视觉复核失败',error);}
  }
  return replacements;
}
function extractSingleLine(text){
  const s=String(text||'').replace(/\r/g,'\n').split('\n').map(v=>v.trim()).filter(Boolean);
  if(!s.length)return '';
  return s.find(v=>/[\u4e00-\u9fff]/.test(v)&&v.length>=2)||s[0];
}
function renderPaddleText(items,replacements){
  return items.map(item=>replacements.get(item.index)||item.text).filter(Boolean).join('\n');
}

async function imageTiles(file){
  const url=URL.createObjectURL(file);
  try{
    const img=await new Promise((resolve,reject)=>{const i=new Image();i.onload=()=>resolve(i);i.onerror=()=>reject(Error('图片读取失败'));i.src=url;});
    const ow=img.naturalWidth,oh=img.naturalHeight;if(!ow||!oh)throw Error('图片尺寸无效');
    const scale=Math.min(1.8,3000/ow),w=Math.max(1,Math.round(ow*scale));
    const make=(top,bottom)=>{const c=document.createElement('canvas');c.width=w;c.height=Math.max(1,Math.round((bottom-top)*scale));const ctx=c.getContext('2d',{alpha:false});ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality='high';ctx.fillStyle='#fff';ctx.fillRect(0,0,c.width,c.height);ctx.drawImage(img,0,top,ow,bottom-top,0,0,c.width,c.height);return c.toDataURL('image/jpeg',.96);};
    const ratio=oh/ow;if(ratio<=1.5)return[make(0,oh)];
    const count=ratio>=3.4?4:3,overlap=oh*.10,step=oh/count,tiles=[];
    for(let i=0;i<count;i++){const top=Math.max(0,i*step-overlap/2),bottom=Math.min(oh,(i+1)*step+overlap/2);tiles.push(make(top,bottom));}
    return tiles;
  }finally{URL.revokeObjectURL(url);}
}
async function enhancedVariant(dataUrl){
  const img=await new Promise((resolve,reject)=>{const i=new Image();i.onload=()=>resolve(i);i.onerror=()=>reject(Error('增强图片读取失败'));i.src=dataUrl;});
  const scale=Math.min(1.35,3600/img.naturalWidth),w=Math.max(1,Math.round(img.naturalWidth*scale)),h=Math.max(1,Math.round(img.naturalHeight*scale));
  const c=document.createElement('canvas');c.width=w;c.height=h;const ctx=c.getContext('2d',{alpha:false});ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality='high';ctx.filter='grayscale(1) contrast(1.16) brightness(1.02)';ctx.fillStyle='#fff';ctx.fillRect(0,0,w,h);ctx.drawImage(img,0,0,w,h);ctx.filter='none';return c.toDataURL('image/jpeg',.97);
}
async function one(images,mode='full'){
  const r=await fetch('/api/ocr',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',cache:'no-store',body:JSON.stringify({images,route:route(),mode})});
  const d=await r.json().catch(()=>({}));
  if(!r.ok||!d.success)throw Error(d.error||`OCR请求失败(${r.status})`);
  return d.data||{};
}

async function process(file){
  if(!file?.type?.startsWith('image/'))throw Error('请选择有效的运单图片');
  setStatus('正在启动本地中文OCR...',10);

  try{
    setStatus('正在本地检测文字区域...',22);
    const paddle=await paddleRecognize(file);
    setStatus(`本地OCR完成：识别 ${paddle.items.length} 个文字区域，正在复核低置信文字...`,62);
    const replacements=await reviewLowConfidenceLines(file,paddle.items);
    const rawText=renderPaddleText(paddle.items,replacements);
    if(!rawText||placeholder(rawText))throw Error('本地OCR没有形成有效文字');
    const input=$('manualOrderInput');
    if(input){input.value=rawText;input.dispatchEvent(new Event('input',{bubbles:true}));input.scrollTop=0;}
    if($('charCount'))$('charCount').textContent=String(rawText.length);
    setStatus('本地OCR完成，请核对原文。',100);if($('statusIcon'))$('statusIcon').textContent='✅';
    if($('statusCount'))$('statusCount').textContent=`本地PaddleOCR · ${paddle.items.length}行 · 低置信复核${replacements.size}行 · 尚未解析门店`;
    if(typeof window.homeToast==='function')window.homeToast('本地OCR完成，请核对文字后再开始解析');
    return{rawText,source:'paddleocr',metrics:paddle.metrics};
  }catch(localError){
    console.warn('PaddleOCR本地识别不可用，启用VLM兜底：',localError?.message||localError);
    setStatus('本地OCR暂不可用，启用视觉OCR兜底...',20);
  }

  const tiles=await imageTiles(file);setStatus(`正在进行视觉OCR兜底 ${tiles.length} 个区域...`,30);
  const results=[];
  for(let i=0;i<tiles.length;i++){
    try{const enhanced=await enhancedVariant(tiles[i]);const data=await one([tiles[i],enhanced],'full');if(data.rawText&&!placeholder(data.rawText))results.push(data.rawText);}catch(e){console.warn(`OCR区域${i+1}失败`,e);}
    setStatus(`正在复核第 ${i+1}/${tiles.length} 个区域...`,30+Math.round((i+1)/tiles.length*55));
  }
  if(!results.length)throw Error('OCR没有返回有效文字，请重新拍摄清晰、完整的运单图片');
  const rawText=mergeOCRResults(results);if(!rawText)throw Error('OCR没有形成有效文字，请重新上传清晰、完整的运单图片');
  const input=$('manualOrderInput');if(input){input.value=rawText;input.dispatchEvent(new Event('input',{bubbles:true}));input.scrollTop=0;}
  if($('charCount'))$('charCount').textContent=String(rawText.length);
  setStatus('视觉OCR完成，请核对原文。',100);if($('statusIcon'))$('statusIcon').textContent='✅';
  if($('statusCount'))$('statusCount').textContent='视觉OCR兜底 · 尚未解析门店';
  if(typeof window.homeToast==='function')window.homeToast('视觉OCR完成，请核对文字后再开始解析');
  return{rawText,source:'vlm-fallback'};
}

async function selectFile(mode){
  let input=$('homeUploadInput');
  if(!input){
    input=document.createElement('input');input.id='homeUploadInput';input.type='file';input.hidden=true;document.body.appendChild(input);
    input.addEventListener('change',async()=>{const file=input.files?.[0];input.value='';if(!file)return;try{await process(file);}catch(e){setStatus(e.message||'OCR失败',100);if($('statusIcon'))$('statusIcon').textContent='⚠️';showError(e.message||'OCR失败');}});
  }
  input.accept='image/*';
  if(mode==='camera')input.setAttribute('capture','environment');else input.removeAttribute('capture');
  input.click();
}
window.callOCR=async file=>process(file);
window.triggerUpload=selectFile;
window.triggerCameraUpload=()=>selectFile('camera');
})();
