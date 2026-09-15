/* 天友智配One - OCR V2 覆盖层
 * 只接管“图片 -> OCR原文”这一段，不改现有UI和解析/确认流程。
 * 目标：并行OCR、减少等待、保持原文完整，不做硬编码错字纠正。
 */
(function(){
  'use strict';
  const $=id=>document.getElementById(id);
  const route=()=>window.Auth?.getCurrentRoute?.()||'';

  function toast(message,type=''){
    if(typeof window.homeToast==='function')return window.homeToast(message,type);
    let el=$('homeToast');
    if(!el){el=document.createElement('div');el.id='homeToast';el.className='toast';document.body.appendChild(el)}
    el.textContent=message;el.className=`toast show ${type}`;
    clearTimeout(toast.timer);toast.timer=setTimeout(()=>el.classList.remove('show'),2800);
  }

  function setStatus(text,percent=50){
    const box=$('parseStatus');
    if(box)box.classList.add('active');
    if($('statusIcon'))$('statusIcon').textContent='⏳';
    if($('statusText'))$('statusText').textContent=text;
    if($('progressBar'))$('progressBar').style.width=`${percent}%`;
  }

  function setOCRText(text){
    const input=$('manualOrderInput');
    if(!input)return;
    const value=String(text||'').replace(/\r\n/g,'\n').replace(/\r/g,'\n');
    input.value=value;input.removeAttribute('placeholder');input.dispatchEvent(new Event('input',{bubbles:true}));
    if($('charCount'))$('charCount').textContent=String(value.length);
    input.scrollTop=0;
  }

  function placeholder(text){
    const s=String(text||'').replace(/[“”\"'`]/g,'').replace(/\s+/g,'');
    if(!s)return true;
    return ['这里放整张图片的完整文字','这里放整张图片的完整原始文字','请提供您需要识别的图片','请上传您需要识别的图片','请上传需要识别的图片','请提供图片','请上传图片','图片无法读取','请重新上传图片'].some(v=>s===v||s.includes(v));
  }

  function normalizeLine(v){return String(v||'').trim()}

  function similarity(a,b){
    const x=String(a||'').replace(/\s+/g,''),y=String(b||'').replace(/\s+/g,'');
    if(!x||!y)return 0;if(x===y)return 1;if(x.includes(y)||y.includes(x))return Math.min(x.length,y.length)/Math.max(x.length,y.length);
    const prev=new Array(y.length+1);for(let j=0;j<=y.length;j++)prev[j]=j;
    for(let i=1;i<=x.length;i++){
      let left=prev[0];prev[0]=i;
      for(let j=1;j<=y.length;j++){
        const up=prev[j],cost=x[i-1]===y[j-1]?0:1;
        prev[j]=Math.min(prev[j]+1,prev[j-1]+1,left+cost);left=up;
      }
    }
    return 1-prev[y.length]/Math.max(x.length,y.length);
  }

  function mergeBlocks(blocks){
    const result=[];
    for(const block of blocks){
      const lines=String(block||'').replace(/\r\n/g,'\n').replace(/\r/g,'\n').split('\n').map(normalizeLine).filter(Boolean);
      if(!lines.length)continue;
      if(!result.length){result.push(...lines);continue;}
      const max=Math.min(18,result.length,lines.length);let overlap=0;
      for(let size=max;size>=1;size--){
        let total=0,ok=true;
        for(let i=0;i<size;i++){
          const score=similarity(result[result.length-size+i],lines[i]);
          const threshold=size===1?(lines[i].replace(/\s/g,'').length>=12?.82:.9):.72;
          if(score<threshold){ok=false;break} total+=score;
        }
        if(ok&&total/size>=(size===1?.88:.82)){overlap=size;break;}
      }
      result.push(...lines.slice(overlap));
    }
    return result.join('\n');
  }

  async function readImage(file){
    const url=URL.createObjectURL(file);
    try{
      const img=await new Promise((resolve,reject)=>{const el=new Image();el.onload=()=>resolve(el);el.onerror=()=>reject(Error('图片读取失败'));el.src=url});
      const ow=img.naturalWidth||img.width,oh=img.naturalHeight||img.height;
      if(!ow||!oh)throw Error('图片尺寸无效');
      const maxWidth=2200,scale=Math.min(1,maxWidth/ow),w=Math.max(1,Math.round(ow*scale)),h=Math.max(1,Math.round(oh*scale));
      const encode=(top,bottom)=>{
        const canvas=document.createElement('canvas');canvas.width=w;canvas.height=Math.max(1,Math.round((bottom-top)*scale));
        const ctx=canvas.getContext('2d',{alpha:false});if(!ctx)throw Error('图片处理环境不可用');
        ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality='high';
        ctx.drawImage(img,0,top,ow,bottom-top,0,0,canvas.width,canvas.height);
        return canvas.toDataURL('image/jpeg',0.92);
      };
      if(h>w*1.5){
        const overlap=Math.round(oh*0.08),part=oh/3;
        return [encode(0,Math.min(oh,part+overlap)),encode(Math.max(0,part-overlap),Math.min(oh,part*2+overlap)),encode(Math.max(0,part*2-overlap),oh)];
      }
      return [encode(0,oh)];
    }finally{URL.revokeObjectURL(url)}
  }

  async function ocrOne(image,index,total){
    const response=await fetch('/api/ocr',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({image,route:route()}),credentials:'same-origin',cache:'no-store'});
    const data=await response.json().catch(()=>({}));
    if(!response.ok||!data.success)throw Error(data.error||`第${index+1}/${total}部分OCR失败（${response.status}）`);
    const text=String(data.data?.rawText||'').replace(/\r\n/g,'\n').replace(/\r/g,'\n').trim();
    return {text,meta:data.data||{}};
  }

  async function processImage(file){
    if(!file||!file.type.startsWith('image/'))throw Error('请选择有效的运单图片');
    setStatus('正在优化图片并准备OCR...',15);
    const images=await readImage(file);
    setStatus(`正在并行识别 ${images.length} 个图片区域...`,35);
    const settled=await Promise.allSettled(images.map((image,i)=>ocrOne(image,i,images.length)));
    const ok=settled.filter(v=>v.status==='fulfilled').map(v=>v.value).filter(v=>v.text&&!placeholder(v.text));
    if(!ok.length)throw Error('OCR没有返回有效文字，请重新拍摄清晰、完整的运单图片');
    const rawText=mergeBlocks(ok.map(v=>v.text));
    const meta=ok.map(v=>v.meta).find(v=>v.date||v.vehicle||v.totalWeight)||{};
    setStatus('OCR完成，请核对原文。',100);
    if($('statusIcon'))$('statusIcon').textContent='✅';
    if($('statusCount'))$('statusCount').textContent='图片文字已提取，尚未解析门店';
    setOCRText(rawText);
    if(typeof window.homeToast==='function')window.homeToast('OCR完成，请核对文字后再开始解析');
    return {rawText,meta};
  }

  window.triggerUpload=function(type){
    let input=$('homeUploadInput');
    if(!input){
      input=document.createElement('input');input.id='homeUploadInput';input.type='file';input.style.display='none';document.body.appendChild(input);
      input.addEventListener('change',async function(){
        const file=input.files?.[0];input.value='';if(!file)return;
        try{await processImage(file)}catch(e){setStatus(e.message||'OCR失败',100);if($('statusIcon'))$('statusIcon').textContent='⚠️';toast(e.message||'OCR失败','warning');}
      });
    }
    input.accept=type==='album'?'image/*':'image/*,.txt,.csv';
    input.removeAttribute('capture');
    input.click();
  };
})();
