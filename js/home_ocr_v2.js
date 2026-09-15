/* 天友智配One - OCR V2
 * 第一阶段只做图片转录，不做门店纠错、不排序、不保存原图。
 * 长图采用“有序分块 + 重叠区域复核”读取，避免后半段截断和重复。
 * 合并只使用通用视觉文本相似度，不维护任何门店错字字典。
 */
(function(){
'use strict';

const $=id=>document.getElementById(id);
const route=()=>window.Auth?.getCurrentRoute?.()||'';

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

function normalizeLine(value){
  return String(value||'')
    .replace(/[→＞》➜➤⇒]/g,'->')
    .replace(/[“”‘’]/g,'')
    .replace(/[\u200B-\u200D\uFEFF]/g,'')
    .replace(/[ \t]+/g,'')
    .trim();
}

function similarity(a,b){
  const x=normalizeLine(a),y=normalizeLine(b);
  if(!x||!y)return 0;
  if(x===y)return 1;
  const p=new Array(y.length+1);
  for(let j=0;j<=y.length;j++)p[j]=j;
  for(let i=1;i<=x.length;i++){
    let left=p[0];
    p[0]=i;
    for(let j=1;j<=y.length;j++){
      const up=p[j],cost=x[i-1]===y[j-1]?0:1;
      p[j]=Math.min(p[j]+1,p[j-1]+1,left+cost);
      left=up;
    }
  }
  return 1-p[y.length]/Math.max(x.length,y.length);
}

function lineQuality(line){
  const s=String(line||'');
  if(!s)return -999;
  const compact=normalizeLine(s);
  const cjk=(compact.match(/[\u4e00-\u9fff]/g)||[]).length;
  const latin=(compact.match(/[A-Za-z]/g)||[]).length;
  const digits=(compact.match(/[0-9]/g)||[]).length;
  const weird=(compact.match(/[|{}[\]<>~`@#$%^*_+=]/g)||[]).length;
  return compact.length + cjk*1.8 + digits*.25 - latin*.25 - weird*2;
}

function representative(a,b){
  if(!a)return b||'';
  if(!b)return a;
  if(normalizeLine(a)===normalizeLine(b))return a.length>=b.length?a:b;
  const sa=lineQuality(a),sb=lineQuality(b);
  if(Math.abs(sa-sb)>=3)return sa>sb?a:b;
  return a.length>=b.length?a:b;
}

function splitLines(block){
  return String(block||'')
    .replace(/\r\n/g,'\n')
    .replace(/\r/g,'\n')
    .split('\n')
    .map(v=>v.trim())
    .filter(Boolean);
}

function findSequenceOverlap(existing,next){
  const max=Math.min(30,existing.length,next.length);
  let best=0;
  let bestScore=-1;

  for(let n=max;n>=1;n--){
    let total=0;
    let strong=0;
    for(let i=0;i<n;i++){
      const score=similarity(existing[existing.length-n+i],next[i]);
      total+=score;
      if(score>=0.78)strong++;
    }
    const avg=total/n;
    const required=n===1?0:Math.max(2,Math.ceil(n*.55));
    const accepted=n===1?avg>=.93:(avg>=.70&&strong>=required);
    if(accepted&&avg>bestScore){best=n;bestScore=avg;}
  }
  return best;
}

function mergeOrderedBlocks(blocks){
  const result=[];
  for(const block of blocks){
    const lines=splitLines(block);
    if(!lines.length)continue;
    if(!result.length){result.push(...lines);continue;}

    const overlap=findSequenceOverlap(result,lines);
    if(overlap>0){
      for(let i=0;i<overlap;i++){
        const idx=result.length-overlap+i;
        result[idx]=representative(result[idx],lines[i]);
      }
      result.push(...lines.slice(overlap));
    }else{
      // 没有找到明确重叠时，不丢弃新区域；只过滤极高相似的单行重复。
      for(const line of lines){
        if(!result.some(v=>similarity(v,line)>=.96))result.push(line);
      }
    }
  }
  return dedupeRepeatedSequences(result).join('\n');
}

function dedupeRepeatedSequences(lines){
  const result=[];
  let i=0;
  while(i<lines.length){
    let removed=false;
    const max=Math.min(8,Math.floor((lines.length-i)/2));
    for(let n=max;n>=2;n--){
      const first=lines.slice(i,i+n);
      const second=lines.slice(i+n,i+n*2);
      if(second.length<n)continue;
      let total=0,strong=0;
      for(let j=0;j<n;j++){
        const score=similarity(first[j],second[j]);
        total+=score;
        if(score>=.78)strong++;
      }
      const avg=total/n;
      if(avg>=.80&&strong>=Math.ceil(n*.75)){
        result.push(...first);
        i+=n*2;
        removed=true;
        break;
      }
    }
    if(!removed){result.push(lines[i]);i++;}
  }
  return result;
}

async function imageTiles(file){
  const url=URL.createObjectURL(file);
  try{
    const img=await new Promise((resolve,reject)=>{
      const i=new Image();
      i.onload=()=>resolve(i);
      i.onerror=()=>reject(Error('图片读取失败'));
      i.src=url;
    });

    const ow=img.naturalWidth,oh=img.naturalHeight;
    if(!ow||!oh)throw Error('图片尺寸无效');

    // 提高移动截图的小字可辨识度，但限制最终宽度避免无意义地放大造成速度下降。
    const scale=Math.min(1.8,3000/ow);
    const w=Math.max(1,Math.round(ow*scale));
    const make=(top,bottom)=>{
      const c=document.createElement('canvas');
      c.width=w;
      c.height=Math.max(1,Math.round((bottom-top)*scale));
      const ctx=c.getContext('2d',{alpha:false});
      ctx.imageSmoothingEnabled=true;
      ctx.imageSmoothingQuality='high';
      ctx.fillStyle='#fff';
      ctx.fillRect(0,0,c.width,c.height);
      ctx.drawImage(img,0,top,ow,bottom-top,0,0,c.width,c.height);
      return c.toDataURL('image/jpeg',.96);
    };

    const ratio=oh/ow;
    if(ratio<=1.5)return[make(0,oh)];

    // 长图按纵向阅读顺序切块，并保留较大的重叠区，专门防止中后段门店被截断。
    const count=ratio>=3.4?4:3;
    const overlap=oh*(count===4?.18:.20);
    const step=oh/count;
    const tiles=[];
    for(let i=0;i<count;i++){
      const top=Math.max(0,i*step-overlap/2);
      const bottom=Math.min(oh,(i+1)*step+overlap/2);
      tiles.push(make(top,bottom));
    }
    return tiles;
  }finally{
    URL.revokeObjectURL(url);
  }
}

async function one(image){
  const r=await fetch('/api/ocr',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',cache:'no-store',body:JSON.stringify({image,route:route()})});
  const d=await r.json().catch(()=>({}));
  if(!r.ok||!d.success)throw Error(d.error||`OCR请求失败(${r.status})`);
  return d.data||{};
}

async function process(file){
  if(!file?.type?.startsWith('image/'))throw Error('请选择有效的运单图片');
  setStatus('正在优化图片...',12);
  const images=await imageTiles(file);
  setStatus(`正在按顺序识别 ${images.length} 个区域...`,30);

  const results=[];
  for(let i=0;i<images.length;i++){
    try{
      const data=await one(images[i]);
      if(data.rawText&&!placeholder(data.rawText))results.push(data.rawText);
    }catch(e){
      console.warn(`OCR区域${i+1}失败`,e);
    }
    setStatus(`正在识别第 ${i+1}/${images.length} 个区域...`,30+Math.round((i+1)/images.length*55));
  }

  if(!results.length)throw Error('OCR没有返回有效文字，请重新拍摄清晰、完整的运单图片');

  // 必须按图片空间顺序合并，不能再以“最长OCR结果”为主，否则长图中后段容易丢失。
  const rawText=mergeOrderedBlocks(results);
  if(!rawText)throw Error('OCR没有形成有效文字，请重新上传清晰、完整的运单图片');

  const input=$('manualOrderInput');
  if(input){
    input.value=rawText;
    input.dispatchEvent(new Event('input',{bubbles:true}));
    input.scrollTop=0;
  }
  if($('charCount'))$('charCount').textContent=String(rawText.length);
  setStatus('OCR完成，请核对原文。',100);
  if($('statusIcon'))$('statusIcon').textContent='✅';
  if($('statusCount'))$('statusCount').textContent='图片文字已提取，尚未解析门店';
  if(typeof window.homeToast==='function')window.homeToast('OCR完成，请核对文字后再开始解析');
  return{rawText};
}

async function selectFile(mode){
  let input=$('homeUploadInput');
  if(!input){
    input=document.createElement('input');
    input.id='homeUploadInput';
    input.type='file';
    input.hidden=true;
    document.body.appendChild(input);
    input.addEventListener('change',async()=>{
      const file=input.files?.[0];
      input.value='';
      if(!file)return;
      try{await process(file);}catch(e){
        setStatus(e.message||'OCR失败',100);
        if($('statusIcon'))$('statusIcon').textContent='⚠️';
        showError(e.message||'OCR失败');
      }
    });
  }
  input.accept='image/*';
  if(mode==='camera')input.setAttribute('capture','environment');
  else input.removeAttribute('capture');
  input.click();
}

window.callOCR=async file=>process(file);
window.triggerUpload=selectFile;
window.triggerCameraUpload=()=>selectFile('camera');
})();
