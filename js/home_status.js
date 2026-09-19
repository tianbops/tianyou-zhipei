/* 天友智配One - 统一处理状态UI */
(() => {
'use strict';
const $=id=>document.getElementById(id);
const MESSAGES={idle:'等待处理...',loading:'正在处理...',success:'处理完成',error:'处理失败',cancelled:'已取消'};
function setError(message){const row=$('statusError');if(!row)return;const text=String(message||'').trim();row.textContent=text?'处理提示：'+text:'';row.classList.toggle('active',!!text);}
function clearError(){setError('');}
function render(status='idle',progress=0,message=''){
  const box=$('parseStatus');
  if(!box)return;
  const state=['idle','loading','success','error','cancelled'].includes(status)?status:'idle';
  box.classList.add('active');
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
  }
  if($('progressBar'))$('progressBar').style.width=Math.max(0,Math.min(100,Number(progress)||0))+'%';
  if(state==='error')setError(message);else clearError();
}
function renderDetail(details){
  const row=$('statusDetail');
  if(!row)return;
  const items=Array.isArray(details)?details.filter(Boolean):[];
  row.innerHTML=items.map(item=>`<span class="detail-line">${item}</span>`).join('');
  row.classList.toggle('active',items.length>0);
}
window.renderStatusDetail=renderDetail;
window.clearStatusDetail=()=>renderDetail([]);
window.renderUnifiedStatus=render;
window.setHomeStatusError=setError;
window.clearHomeStatusError=clearError;
})();