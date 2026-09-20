/* 天友智配One - 统一处理状态UI */
(() => {
'use strict';
const $=id=>document.getElementById(id);
const MESSAGES={idle:'准备好开始今天的配送任务',loading:'正在处理…',success:'路线规划完成',error:'运单识别失败',cancelled:'已取消'};
function setError(message){const text=String(message||'').trim();if($('statusText')&&text){$('statusText').textContent=text;$('statusText').setAttribute('data-text',text);}}
function clearError(){setError('');}
function render(status='idle',progress=0,message=''){
  const box=$('parseStatus');
  if(!box)return;
  const state=['idle','loading','success','error','cancelled'].includes(status)?status:'idle';
  box.classList.add('active');
  const sheet=box.closest('.upload-sheet');
  if(sheet){sheet.classList.remove('waiting','processing','success','error','cancelled');sheet.classList.add(state==='idle'?'waiting':state==='loading'?'processing':state);}
  box.classList.remove('loading','success','error','cancelled');
  if(state!=='idle')box.classList.add(state);
  const icon=$('statusIcon');
  if(icon){
    icon.className='status-icon';
    if(state!=='idle')icon.classList.add(state);
    icon.innerHTML=state==='loading'?'<span class="status-spinner" aria-hidden="true"></span>':'';
  }
  if($('statusText')){
    const text=String(message||MESSAGES[state]).trim();
    $('statusText').textContent=text;
    $('statusText').setAttribute('data-text',text);
  }
  if($('statusText'))$('statusText').style.setProperty('--status-progress',Math.max(0,Math.min(100,Number(progress)||0))+'%');
  if(state==='error')setError(message);else clearError();
  if(state!=='success')renderDetail([]);
}
function renderDetail(details){
  const row=$('statusDetail');
  if(!row)return;
  row.textContent='';
  const items=Array.isArray(details)?details.filter(Boolean):[];
  items.forEach(item=>{
    const line=document.createElement('span');
    line.className='detail-line';
    line.textContent=String(item);
    row.appendChild(line);
  });
  row.classList.toggle('active',items.length>0);
}
window.renderStatusDetail=renderDetail;
window.clearStatusDetail=()=>renderDetail([]);
let progressTimer=null;
function animateProgressTo(target){
  const el=$('statusText');
  if(!el)return;
  const next=Math.max(0,Math.min(100,Number(target)||0));
  const current=parseFloat(getComputedStyle(el).getPropertyValue('--status-progress'))||0;
  if(progressTimer)cancelAnimationFrame(progressTimer);
  const start=performance.now();
  const duration=Math.max(700,Math.min(2200,Math.abs(next-current)*18));
  const tick=now=>{
    const p=Math.min(1,(now-start)/duration);
    const eased=p<.5?2*p*p:1-Math.pow(-2*p+2,2)/2;
    const value=current+(next-current)*eased;
    el.style.setProperty('--status-progress',value.toFixed(2)+'%');
    if(p<1)progressTimer=requestAnimationFrame(tick);
  };
  progressTimer=requestAnimationFrame(tick);
}
window.renderUnifiedStatus=(status='idle',progress=0,message='')=>{
  render(status,0,message);
  animateProgressTo(progress);
};
window.setHomeStatusError=setError;
window.clearHomeStatusError=clearError;
})();