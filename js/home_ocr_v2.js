/* 天友智配One - OCR V2
 * OCR只负责读取图片；门店身份由 /api/parse + 当前线路基准库确认。
 * 不保存原图、不维护错字记忆。
 * 多视图结果只做通用的视觉文本合并，不写入任何门店纠错字典。
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
    .replace(/\s+/g,'')
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
      const up=p[j],c=x[i-1]===y[j-1]?0:1;
      p[j]=Math.min(p[j]+1,p[j-1]+1,left+c);
      left=up;
    }
  }
  return 1-p[y.length]/Math.max(x.length,y.length);
}

function splitLines(block){
  return String(block||'')
    .replace(/\r\n/g,'\n')
    .replace(/\r/g,'\n')
    .split('\n')
    .map(v=>v.trim())
    .filter(Boolean);
}

function mergeBlocks(blocks){
  const out=[];
  for(const block of blocks){
    const lines=splitLines(block);
    if(!lines.length)continue;
    if(!out.length){out.push(...lines);continue;}

    const overlap=findSequenceOverlap(out,lines);
    out.push(...lines.slice(overlap));
  }

  return dedupeRepeatedSequences(out).join('\n');
}

function findSequenceOverlap(existing,next){
  const max=Math.min(36,existing.length,next.length);
  let best=0;
  let bestScore=0;

  for(let n=max;n>=1;n--){
    let total=0;
    let strong=0;
    for(let i=0;i<n;i++){
      const score=similarity(existing[existing.length-n+i],next[i]);
      total+=score;
      if(score>=0.82)strong++;
    }
    const avg=total/n;
    const required=n===1?0.91:Math.max(2,Math.ceil(n*0.45));
    const accepted=n===1?avg>=0.91:(avg>=0.72&&strong>=required);
    if(accepted&&avg>bestScore){
      best=n;
      bestScore=avg;
    }
  }

  return best;
}

function dedupeRepeatedSequences(lines){
  const result=[];
  let i=0;
  while(i<lines.length){
    let removed=false;
    const max=Math.min(10,Math.floor((lines.length-i)/2));
    for(let n=max;n>=2;n--){
      const first=lines.slice(i,i+n);
      const secondStart=i+n;
      const second=lines.slice(secondStart,secondStart+n);
      if(second.length<n)continue;

      let total=0;
      let strong=0;
      for(let j=0;j<n;j++){
        const score=similarity(first[j],second[j]);
        total+=score;
        if(score>=0.78)strong++;
      }
      const avg=total/n;

      // 只删除高度相似的连续重复块；不依赖门店名称或线路文字。
      if(avg>=0.78&&strong>=Math.ceil(n*0.7)){
        result.push(...first);
        i+=n*2;
        removed=true;
        break;
      }
    }
    if(!removed){
      result.push(lines[i]);
      i++;
    }
  }
  return result;
}

function consensusMerge(blocks){
  const parsed=blocks.map(splitLines).filter(v=>v.length);
  if(!parsed.length)return '';
  if(parsed.length===1)return dedupeRepeatedSequences(parsed[0]).join('\n');

  // 先以最长文本作为主序列，再用其他OCR视图补充缺失行。
  const primary=parsed.reduce((a,b)=>b.length>a.length?b:a).slice();
  const all=parsed.flat();

  for(const line of all){
    if(!line||primary.some(v=>similarity(v,line)>=0.91))continue;
    const near=all.filter(v=>similarity(v,line)>=0.84);
    if(near.length>=2){
      const position=findInsertionPoint(primary,line);
      primary.splice(position,0,pickRepresentative(near));
    }
  }

  // 同一截图区域重叠造成的连续重复在这里统一消除。
  return dedupeRepeatedSequences(primary).join('\n');
}

function findInsertionPoint(primary,line){
  const target=normalizeLine(line);
  let bestIndex=primary.length;
  let bestScore=0;
  for(let i=0;i<primary.length;i++){
    const score=similarity(primary[i],target);
    if(score>bestScore){bestScore=score;bestIndex=i+1;}
  }
  return bestIndex;
}

function pickRepresentative(lines){
  const counts=lines.map(line=>({line,count:lines.filter(v=>similarity(v,line)>=0.88).length}));
  counts.sort((a,b)=>b.count-a.count||b.line.length-a.line.length);
  return counts[0].line;
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

    // 手机截图通常只有1080~1440px宽；适度放大后再交给视觉模型，提升小字号中文、Q/JM/A编号的可辨识度。
    const scale=Math.min(1.6,2600/ow);
    const w=Math.max(1,Math.round(ow*scale));
    const make=(top,bottom)=>{
      const c=document.createElement('canvas');
      c.width=w;
      c.height=Math.max(1,Math.round((bottom-top)*scale));
      const x=c.getContext('2d',{alpha:false});
      x.imageSmoothingEnabled=true;
      x.imageSmoothingQuality='high';
      x.fillStyle='#fff';
      x.fillRect(0,0,c.width,c.height);
      x.drawImage(img,0,top,ow,bottom-top,0,0,c.width,c.height);
      return c.toDataURL('image/jpeg',.94);
    };

    if(oh/ow>1.5){
      const part=oh/3;
      const overlap=oh*.12;
      return[
        make(0,Math.min(oh,part+overlap)),
        make(Math.max(0,part-overlap),Math.min(oh,part*2+overlap)),
        make(Math.max(0,part*2-overlap),oh)
      ];
    }
    return[make(0,oh)];
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
  setStatus('正在优化图片...',15);
  const images=await imageTiles(file);

  // 高截图只识别三个重叠区域；普通图片只识别整图。
  // 不再把每个区域简单首尾拼接，避免重叠区域形成连续重复回访段。
  setStatus(`正在并行识别 ${images.length} 个视图...`,35);
  const results=await Promise.allSettled(images.map(one));
  const ok=results
    .filter(x=>x.status==='fulfilled')
    .map(x=>x.value)
    .filter(x=>x.rawText&&!placeholder(x.rawText));

  if(!ok.length)throw Error('OCR没有返回有效文字，请重新拍摄清晰、完整的运单图片');

  const rawText=consensusMerge(ok.map(x=>x.rawText));
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

/* 覆盖旧的callOCR，使现有home.js无需复制一套OCR逻辑。 */
window.callOCR=async file=>process(file);
window.triggerUpload=selectFile;
window.triggerCameraUpload=()=>selectFile('camera');
})();
