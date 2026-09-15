/* 天友智配One - OCR V2
 * 第一阶段：图片 -> 可核对的高保真运单文字。
 * 长图采用“有序分块 + 相邻块序列对齐”，只在确认重叠时去重，禁止跨边界乱插文字。
 * 不维护任何门店错字字典，不用基准库改写OCR原文。
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
  return compact.length+cjk*1.8+digits*.25-latin*.25-weird*2;
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

/*
 * 相邻OCR块采用“尾部 -> 头部”的单调局部序列对齐。
 * 旧逻辑的问题是：只要找不到整体重叠，就把下一块所有文字直接追加；
 * 一旦模型在重叠区产生垃圾文本，就会把垃圾拼进主文本。
 * 这里严格限制：
 * 1. 只比较 previous 的尾部与 next 的头部；
 * 2. 允许少量漏行/多行，但不能跨越方向；
 * 3. 找到重叠后，只合并重叠部分，其余从 next 的重叠结束位置继续；
 * 4. 没有可靠重叠时，整块顺序追加，不进行“相似文本插入”。
 */
function alignBoundary(previous,next){
  const a=previous.slice(Math.max(0,previous.length-24));
  const b=next.slice(0,Math.min(24,next.length));
  if(!a.length||!b.length)return null;

  let best=null;
  const gapPenalty=.055;

  // dp[i][j]：a前i行、b前j行的局部对齐分数。
  // 允许跳过少量行，以应对OCR在边界处偶尔漏掉一行。
  const rows=a.length+1,cols=b.length+1;
  const dp=Array.from({length:rows},()=>Array(cols).fill(0));
  const path=Array.from({length:rows},()=>Array(cols).fill(null));

  for(let i=1;i<rows;i++){
    for(let j=1;j<cols;j++){
      const sim=similarity(a[i-1],b[j-1]);
      const diag=dp[i-1][j-1]+sim;
      const up=dp[i-1][j]-gapPenalty;
      const left=dp[i][j-1]-gapPenalty;
      let value=diag,move='diag';
      if(up>value){value=up;move='up';}
      if(left>value){value=left;move='left';}
      dp[i][j]=value;
      path[i][j]=move;
    }
  }

  // 只接受落在 previous 尾部、next 头部的局部路径。
  let bestEnd=null;
  for(let j=1;j<cols;j++){
    const score=dp[rows-1][j];
    if(!bestEnd||score>bestEnd.score)bestEnd={i:rows-1,j,score};
  }
  if(!bestEnd)return null;

  const pairs=[];
  let i=bestEnd.i,j=bestEnd.j;
  while(i>0&&j>0){
    const move=path[i][j];
    if(move==='diag'){
      const sim=similarity(a[i-1],b[j-1]);
      if(sim>=.58)pairs.push({ai:i-1,bj:j-1,sim});
      i--;j--;
    }else if(move==='up')i--;
    else if(move==='left')j--;
    else break;
  }
  pairs.reverse();

  if(!pairs.length)return null;
  const strong=pairs.filter(p=>p.sim>=.78).length;
  const avg=pairs.reduce((s,p)=>s+p.sim,0)/pairs.length;
  const first=pairs[0],last=pairs[pairs.length-1];
  const boundaryA=previous.length-a.length+last.ai+1;
  const consumedB=last.bj+1;

  // 单行必须非常强；多行必须至少两条可靠对应，防止误把两个不同门店当成重叠。
  const accepted=pairs.length===1
    ? pairs[0].sim>=.93
    : strong>=2&&avg>=.70&&pairs.length>=Math.min(5,strong);
  if(!accepted)return null;

  return{
    pairs,
    previousStart:previous.length-a.length+first.ai,
    previousEnd:boundaryA,
    nextConsumed:consumedB,
    avg,
    strong
  };
}

function mergeAdjacent(previous,next){
  if(!previous.length)return next.slice();
  if(!next.length)return previous.slice();

  const alignment=alignBoundary(previous,next);
  if(!alignment){
    // 没有可靠边界重叠时，只按空间顺序追加。
    // 这里绝不再用全局相似度把下一块文字插入旧块内部。
    return previous.concat(next);
  }

  const result=previous.slice();
  for(const pair of alignment.pairs){
    const index=alignment.previousStart+pair.ai;
    if(index>=0&&index<result.length){
      result[index]=representative(result[index],next[pair.bj]);
    }
  }

  // 只丢弃已经确认属于重叠区的next行。
  // 重叠区内如果OCR产生一条没有对应关系的垃圾行，不会被强行插入。
  const tail=next.slice(alignment.nextConsumed);
  result.push(...tail);
  return result;
}

function mergeOrderedBlocks(blocks){
  let result=[];
  for(const block of blocks){
    const lines=splitLines(block);
    if(!lines.length)continue;
    result=mergeAdjacent(result,lines);
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
      if(avg>=.82&&strong>=Math.ceil(n*.75)){
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
