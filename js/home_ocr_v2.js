/* 天友智配One - OCR
 * 第一阶段：图片 -> 高保真可核对原文。
 * 免费本地方案：PaddleOCR.js + PP-OCRv5。
 * 图片先处理方向/压缩/HEIC，再进行整图+配送区域二次识别。
 * 低置信行才调用服务器视觉OCR；线路库只在 /api/parse 阶段参与匹配，绝不改写OCR原文。
 */
(function(){
'use strict';

const $=id=>document.getElementById(id);
const SDK='https://cdn.jsdelivr.net/npm/@paddleocr/paddleocr-js@0.4.2/+esm';
const ORT_WASM='https://cdn.jsdelivr.net/npm/onnxruntime-web/dist/';
const LOW_SCORE=.82;
const MAX_VLM_REVIEW=10;
const MAX_IMAGE_SIDE=2600;
let paddlePromise=null;
let paddleOCR=null;
let heicPromise=null;

const route=()=>window.Auth?.getCurrentRoute?.()||'';
const norm=v=>String(v??'').replace(/\r\n/g,'\n').replace(/\r/g,'\n').replace(/[\u200B-\u200D\uFEFF]/g,'').trim();
const line=v=>String(v??'').replace(/[→＞》➜➤⇒]/g,'->').replace(/-\s*>/g,'->').replace(/[“”‘’]/g,'').replace(/[ \t]+/g,' ').trim();
const minX=p=>p?.length?Math.min(...p.map(v=>+v?.[0]||0)):0;
const minY=p=>p?.length?Math.min(...p.map(v=>+v?.[1]||0)):0;
const maxX=p=>p?.length?Math.max(...p.map(v=>+v?.[0]||0)):0;
const maxY=p=>p?.length?Math.max(...p.map(v=>+v?.[1]||0)):0;
const boxH=p=>Math.max(1,maxY(p)-minY(p));
const centerY=x=>(minY(x.poly)+maxY(x.poly))/2;

function readingOrder(a,b){
  const d=Math.abs(centerY(a)-centerY(b));
  const t=Math.max(boxH(a.poly),boxH(b.poly))*.62;
  return d<=t?minX(a.poly)-minX(b.poly):centerY(a)-centerY(b);
}

function setStatus(text,progress=50){
  $('parseStatus')?.classList.add('active');
  if($('statusIcon'))$('statusIcon').textContent='⏳';
  if($('statusText'))$('statusText').textContent=text;
  if($('progressBar'))$('progressBar').style.width=`${progress}%`;
}

function showError(text){
  if(typeof window.showError==='function')window.showError(text);
  else if(typeof window.homeToast==='function')window.homeToast(text,'warning');
  else alert(text);
}

function placeholder(text){
  const s=norm(text).replace(/[“”\"'`]/g,'').replace(/\s+/g,'');
  if(!s)return true;
  return [
    '这里放整张图片的完整文字','这里放整张图片的完整原始文字','请提供您需要识别的图片',
    '请上传您需要识别的图片','请上传需要识别的图片','请提供图片','请上传图片',
    '图片无法读取','请重新上传图片'
  ].some(v=>s===v||s.includes(v));
}

async function loadHeic(){
  if(window.heic2any)return window.heic2any;
  if(heicPromise)return heicPromise;
  heicPromise=import('https://cdn.jsdelivr.net/npm/heic2any@0.0.4/+esm')
    .then(m=>m.default||m)
    .catch(e=>{heicPromise=null;throw e});
  return heicPromise;
}

async function normalizeImageFile(file){
  const name=String(file?.name||'').toLowerCase();
  const type=String(file?.type||'').toLowerCase();
  if(name.endsWith('.heic')||name.endsWith('.heif')||type==='image/heic'||type==='image/heif'){
    const convert=await loadHeic();
    const converted=await convert({blob:file,type:'image/jpeg',quality:.96});
    return Array.isArray(converted)?converted[0]:converted;
  }
  return file;
}

async function createBitmap(file){
  if(typeof createImageBitmap==='function'){
    try{return await createImageBitmap(file,{imageOrientation:'from-image'})}catch(_){/* fallback below */}
  }
  const url=URL.createObjectURL(file);
  try{
    return await new Promise((resolve,reject)=>{
      const img=new Image();
      img.onload=()=>resolve(img);
      img.onerror=()=>reject(Error('图片读取失败'));
      img.src=url;
    });
  }finally{URL.revokeObjectURL(url)}
}

async function preprocessImage(file){
  const source=await normalizeImageFile(file);
  const image=await createBitmap(source);
  const width=image.width||image.naturalWidth||0;
  const height=image.height||image.naturalHeight||0;
  if(!width||!height)throw Error('无法读取图片尺寸');
  const scale=Math.min(1,MAX_IMAGE_SIDE/Math.max(width,height));
  const w=Math.max(1,Math.round(width*scale));
  const h=Math.max(1,Math.round(height*scale));
  const canvas=document.createElement('canvas');
  canvas.width=w;canvas.height=h;
  const ctx=canvas.getContext('2d',{alpha:false});
  if(!ctx)throw Error('浏览器不支持图片处理');
  ctx.fillStyle='#fff';ctx.fillRect(0,0,w,h);
  ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality='high';
  ctx.drawImage(image,0,0,w,h);
  if(typeof image.close==='function')image.close();
  const jpeg=await new Promise((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(Error('图片压缩失败')),'image/jpeg',.92));
  return {blob:jpeg,width:w,height:h};
}

async function makeVariant(blob,mode){
  const image=await createBitmap(blob);
  const w=image.width||image.naturalWidth,h=image.height||image.naturalHeight;
  const canvas=document.createElement('canvas');canvas.width=w;canvas.height=h;
  const ctx=canvas.getContext('2d',{alpha:false});
  ctx.fillStyle='#fff';ctx.fillRect(0,0,w,h);
  if(mode==='gray')ctx.filter='grayscale(1) contrast(1.18) brightness(1.03)';
  else if(mode==='sharp')ctx.filter='grayscale(1) contrast(1.28) brightness(1.02)';
  ctx.drawImage(image,0,0,w,h);ctx.filter='none';
  if(typeof image.close==='function')image.close();
  return new Promise((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(Error('增强图片失败')),'image/jpeg',.94));
}

async function getOCR(){
  if(paddleOCR)return paddleOCR;
  if(paddlePromise)return paddlePromise;
  paddlePromise=(async()=>{
    const m=await import(SDK);
    const C=m.PaddleOCR||m.default?.PaddleOCR||m.default;
    if(!C?.create)throw Error('PaddleOCR SDK加载失败');
    const options={
      lang:'ch',
      ocrVersion:'PP-OCRv5',
      textDetectionBatchSize:2,
      textRecognitionBatchSize:6,
      ortOptions:{backend:'wasm',wasmPaths:ORT_WASM,numThreads:1,simd:true}
    };
    try{
      paddleOCR=await C.create({...options,worker:true});
    }catch(workerError){
      console.warn('PaddleOCR Worker初始化失败，改用主线程WASM',workerError);
      paddleOCR=await C.create({...options,worker:false});
    }
    return paddleOCR;
  })().catch(e=>{paddlePromise=null;throw e});
  return paddlePromise;
}

async function predict(input,params={}){
  const ocr=await getOCR();
  const results=await ocr.predict(input,{textRecScoreThresh:0,...params});
  const r=results?.[0];
  if(!r?.items?.length)throw Error('PaddleOCR未检测到文字');
  return {
    items:r.items.map((x,i)=>({id:i,text:line(x.text),score:Number(x.score)||0,poly:Array.isArray(x.poly)?x.poly:[]}))
      .filter(x=>x.text).sort(readingOrder),
    metrics:r.metrics||{}
  };
}

function findDeliveryHeader(items){
  return items.find(x=>/承运订单/.test(x.text));
}

async function cropDeliveryRegion(blob,items,header){
  const image=await createBitmap(blob);
  const W=image.width||image.naturalWidth,H=image.height||image.naturalHeight;
  const startY=header?.poly?.length?Math.max(0,minY(header.poly)-boxH(header.poly)*2):Math.round(H*.28);
  const canvas=document.createElement('canvas');
  const sourceH=Math.max(1,H-startY);
  const scale=Math.min(2.2,Math.max(1,2400/W));
  canvas.width=Math.round(W*scale);
  canvas.height=Math.round(sourceH*scale);
  const ctx=canvas.getContext('2d',{alpha:false});
  ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);
  ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality='high';
  ctx.drawImage(image,0,startY,W,sourceH,0,0,canvas.width,canvas.height);
  if(typeof image.close==='function')image.close();
  return {blob:await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',.96)),startY,scale};
}

function absoluteItems(items,region){
  return items.map(x=>({...x,poly:x.poly.map(p=>[(+p[0]/region.scale),(+p[1]/region.scale)+region.startY])}));
}

function overlap(a,b){
  if(!a.poly.length||!b.poly.length)return 0;
  const ax0=minX(a.poly),ax1=maxX(a.poly),ay0=minY(a.poly),ay1=maxY(a.poly);
  const bx0=minX(b.poly),bx1=maxX(b.poly),by0=minY(b.poly),by1=maxY(b.poly);
  const ox=Math.max(0,Math.min(ax1,bx1)-Math.max(ax0,bx0));
  const oy=Math.max(0,Math.min(ay1,by1)-Math.max(ay0,by0));
  return ox*oy/Math.max(1,Math.min((ax1-ax0)*(ay1-ay0),(bx1-bx0)*(by1-by0)));
}

function mergeSpatial(a,b){
  const out=[],used=new Set();
  for(const x of a){
    let hit=-1,best=0;
    for(let i=0;i<b.length;i++){
      if(used.has(i))continue;
      const score=overlap(x,b[i]);
      if(score>.30&&score>best){best=score;hit=i}
    }
    if(hit>=0){
      const y=b[hit];used.add(hit);
      out.push({...x,text:y.text.length>x.text.length?y.text:x.text,score:Math.max(x.score,y.score)});
    }else out.push(x);
  }
  b.forEach((x,i)=>{if(!used.has(i))out.push(x)});
  return out.sort(readingOrder).map((x,i)=>({...x,id:i}));
}

async function cropLine(blob,item){
  const image=await createBitmap(blob);
  const xs=item.poly.map(p=>+p[0]||0),ys=item.poly.map(p=>+p[1]||0);
  const x0=Math.min(...xs),x1=Math.max(...xs),y0=Math.min(...ys),y1=Math.max(...ys);
  const padX=Math.max(24,(x1-x0)*.08),padY=Math.max(18,(y1-y0)*.8);
  const left=Math.max(0,Math.floor(x0-padX)),top=Math.max(0,Math.floor(y0-padY));
  const right=Math.min(image.width||image.naturalWidth,Math.ceil(x1+padX));
  const bottom=Math.min(image.height||image.naturalHeight,Math.ceil(y1+padY));
  const w=Math.max(1,right-left),h=Math.max(1,bottom-top),scale=Math.min(3,Math.max(2,1800/w));
  const canvas=document.createElement('canvas');canvas.width=Math.round(w*scale);canvas.height=Math.round(h*scale);
  const ctx=canvas.getContext('2d',{alpha:false});ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);
  ctx.filter='grayscale(1) contrast(1.16) brightness(1.02)';ctx.drawImage(image,left,top,w,h,0,0,canvas.width,canvas.height);ctx.filter='none';
  if(typeof image.close==='function')image.close();
  return canvas.toDataURL('image/jpeg',.96);
}

async function serverLineOCR(images){
  const response=await fetch('/api/ocr',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',cache:'no-store',body:JSON.stringify({images,route:route(),mode:'line'})});
  const data=await response.json().catch(()=>({}));
  if(!response.ok||!data.success)throw Error(data.error||`OCR请求失败(${response.status})`);
  return data.data||{};
}

async function reviewLowConfidence(blob,items){
  const result=new Map();
  const targets=items.filter(x=>Number.isFinite(x.score)&&x.score<LOW_SCORE&&x.text.length>=2).slice(0,MAX_VLM_REVIEW);
  for(const item of targets){
    try{
      const crop=await cropLine(blob,item);
      const enhanced=await makeVariant(await (await fetch(crop)).blob(),'gray');
      const enhancedURL=await new Promise(resolve=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.readAsDataURL(enhanced)});
      const data=await serverLineOCR([crop,enhancedURL]);
      const value=norm(data.rawText).split('\n').map(line).filter(v=>v&&/[\u4e00-\u9fffA-Za-z0-9]/.test(v)).sort((a,b)=>b.length-a.length)[0];
      if(value)result.set(item.id,value);
    }catch(e){console.warn('低置信行复核失败',e)}
  }
  return result;
}

async function fullFallback(blob){
  const enhanced=await makeVariant(blob,'gray');
  const urls=[];
  for(const item of [blob,enhanced]){
    urls.push(await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=()=>reject(Error('图片编码失败'));r.readAsDataURL(item)}));
  }
  const response=await fetch('/api/ocr',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',cache:'no-store',body:JSON.stringify({images:urls,route:route(),mode:'full'})});
  const data=await response.json().catch(()=>({}));
  if(!response.ok||!data.success)throw Error(data.error||'视觉OCR失败');
  return norm(data.data?.rawText);
}

async function process(file){
  if(!file?.type?.startsWith('image/')&&!/\.(heic|heif)$/i.test(file?.name||''))throw Error('请选择有效的运单图片');
  setStatus('正在准备运单图片...',6);
  let prepared;
  try{prepared=await preprocessImage(file)}catch(e){throw Error(`图片预处理失败：${e.message}`)}
  try{
    setStatus('正在启动免费本地中文OCR...',12);
    const first=await predict(prepared.blob,{textDetLimitSideLen:2600,textDetMaxSideLimit:4000,textDetBoxThresh:.45,textRecScoreThresh:0});
    setStatus('正在识别整张运单版面...',30);
    const header=findDeliveryHeader(first.items);
    let final=first.items;
    let secondCount=0;
    try{
      setStatus('正在放大识别完整配送链...',44);
      const region=await cropDeliveryRegion(prepared.blob,first.items,header);
      if(region?.blob){
        const second=await predict(region.blob,{textDetLimitSideLen:3000,textDetMaxSideLimit:5000,textDetBoxThresh:.40,textRecScoreThresh:0});
        secondCount=second.items.length;
        final=mergeSpatial(first.items,absoluteItems(second.items,region));
      }
    }catch(e){console.warn('配送链二次OCR失败',e)}
    setStatus('正在复核低置信文字...',68);
    const review=await reviewLowConfidence(prepared.blob,final);
    const text=final.map(x=>review.get(x.id)||x.text).filter(Boolean).join('\n');
    if(!text||placeholder(text))throw Error('本地OCR没有形成有效文字');
    const input=$('manualOrderInput');
    if(input){input.value=text;input.dispatchEvent(new Event('input',{bubbles:true}));input.scrollTop=0}
    if($('charCount'))$('charCount').textContent=String(text.length);
    if($('statusCount'))$('statusCount').textContent=`本地OCR · 整图${first.items.length}区 · 配送链二次${secondCount}区 · 低置信复核${review.size}行 · 尚未解析门店`;
    setStatus('本地OCR完成，请核对原文。',100);
    if($('statusIcon'))$('statusIcon').textContent='✅';
    if(typeof window.homeToast==='function')window.homeToast('本地OCR完成，请核对原文后再开始解析');
    return{rawText:text,source:'paddleocr-v5'};
  }catch(localError){
    console.warn('本地PaddleOCR失败，启用服务器视觉OCR兜底',localError);
    setStatus('本地OCR暂不可用，启用视觉OCR兜底...',25);
    const text=await fullFallback(prepared.blob);
    if(!text||placeholder(text))throw Error('OCR没有成功读取运单图片文字，请重新上传清晰、完整的运单图片');
    const input=$('manualOrderInput');
    if(input){input.value=text;input.dispatchEvent(new Event('input',{bubbles:true}));input.scrollTop=0}
    if($('charCount'))$('charCount').textContent=String(text.length);
    setStatus('视觉OCR完成，请核对原文。',100);
    if($('statusIcon'))$('statusIcon').textContent='✅';
    if(typeof window.homeToast==='function')window.homeToast('视觉OCR完成，请核对原文');
    return{rawText:text,source:'vlm-fallback'};
  }
}

window.callOCR=process;
window.triggerUpload=function(type){
  const input=document.createElement('input');
  input.type='file';
  input.accept='image/*,.heic,.heif';
  if(type==='camera')input.capture='environment';
  input.style.display='none';
  input.onchange=()=>{const file=input.files?.[0];if(file)process(file).catch(e=>{console.error(e);showError(e?.message||'运单图片处理失败')})};
  document.body.appendChild(input);input.click();setTimeout(()=>input.remove(),1000);
};
window.triggerCameraUpload=()=>window.triggerUpload('camera');
})();
