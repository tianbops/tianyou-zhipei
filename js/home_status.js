/* 天友智配One - 统一运单处理弹窗状态框 */
(() => {
'use strict';

const STAGES=[
  {key:'recognize',label:'识别'},
  {key:'extract',label:'提取'},
  {key:'match',label:'匹配'},
  {key:'plan',label:'规划'},
  {key:'complete',label:'完成'}
];

let modal=null;
let successTimer=null;

function ensureModal(){
  if(modal&&document.body.contains(modal))return modal;
  modal=document.createElement('div');
  modal.id='zpeiProcessingModal';
  modal.className='zpei-processing-modal';
  modal.setAttribute('aria-hidden','true');
  modal.innerHTML=`
    <div class="zpei-processing-backdrop" aria-hidden="true"></div>
    <section class="zpei-processing-box" role="dialog" aria-modal="true" aria-labelledby="zpeiProcessingTitle">
      <div class="zpei-processing-title" id="zpeiProcessingTitle">正在处理运单</div>
      <div class="zpei-processing-stages" role="status" aria-live="polite"></div>
      <div class="zpei-processing-message"></div>
      <button type="button" class="zpei-processing-failure-btn">返回上传</button>
    </section>`;
  document.body.appendChild(modal);
  modal.querySelector('.zpei-processing-failure-btn')?.addEventListener('click',()=>{
    if(typeof window.resetUploadSession==='function')window.resetUploadSession();
    else{
      window.resetProcessingStatus?.();
      window.openUploadSource?.();
    }
  });
  return modal;
}

function stageIndex(progress,status){
  if(status==='success')return STAGES.length-1;
  if(status==='error'||status==='cancelled')return -1;
  const value=Math.max(0,Math.min(100,Number(progress)||0));
  if(value>=80)return 3;
  if(value>=60)return 2;
  if(value>=25)return 1;
  return 0;
}

function stageMessage(index,status){
  if(status==='success')return '处理完成';
  return [
    '正在识别运单…',
    '正在提取门店…',
    '正在匹配基准库…',
    '正在生成配送顺序…',
    '处理完成'
  ][Math.max(0,Math.min(STAGES.length-1,index))];
}

function renderStages(activeIndex,status){
  const root=ensureModal().querySelector('.zpei-processing-stages');
  root.textContent='';
  STAGES.forEach((stage,index)=>{
    const row=document.createElement('div');
    row.className='zpei-processing-stage';
    const node=document.createElement('span');
    node.className='zpei-processing-node';
    const label=document.createElement('span');
    label.className='zpei-processing-label';
    const complete=index<activeIndex||status==='success';
    const current=index===activeIndex&&status!=='success';
    node.textContent=complete?'●':current?'◉':'○';
    label.textContent=stage.label;
    if(complete)row.classList.add('done');
    else if(current)row.classList.add('current');
    else row.classList.add('pending');
    row.append(node,label);
    root.appendChild(row);
    if(index<STAGES.length-1){
      const line=document.createElement('div');
      line.className='zpei-processing-stage-line'+(index<activeIndex||status==='success'?' done':'');
      root.appendChild(line);
    }
  });
}

function setVisible(visible){
  document.body.classList.toggle('zpei-processing',visible);
}

function reset(){
  if(successTimer){clearTimeout(successTimer);successTimer=null;}
  setVisible(false);
  if(modal){
    modal.classList.remove('active','error','success');
    modal.setAttribute('aria-hidden','true');
  }
}

function showError(){
  if(successTimer){clearTimeout(successTimer);successTimer=null;}
  const node=ensureModal();
  node.classList.add('active','error');
  node.classList.remove('success');
  node.setAttribute('aria-hidden','false');
  const title=node.querySelector('.zpei-processing-title');
  const stages=node.querySelector('.zpei-processing-stages');
  const message=node.querySelector('.zpei-processing-message');
  const button=node.querySelector('.zpei-processing-failure-btn');
  if(title)title.textContent='运单处理失败';
  if(stages)stages.style.display='none';
  if(message)message.textContent='运单处理未完成，请重新上传运单';
  if(button)button.style.display='inline-flex';
  renderStages(-1,'error');
  setVisible(false);
}

function render(status='idle',progress=0){
  const state=['idle','loading','success','error','cancelled'].includes(status)?status:'idle';
  if(state==='idle'||state==='cancelled'){
    reset();
    return;
  }
  if(state==='error'){
    showError();
    return;
  }

  const node=ensureModal();
  node.classList.add('active');
  node.classList.remove('error','success');
  node.setAttribute('aria-hidden','false');
  const title=node.querySelector('.zpei-processing-title');
  const stages=node.querySelector('.zpei-processing-stages');
  const message=node.querySelector('.zpei-processing-message');
  const button=node.querySelector('.zpei-processing-failure-btn');
  if(stages)stages.style.display='flex';
  if(title)title.textContent=state==='success'?'处理完成':'正在处理运单';
  if(button)button.style.display='none';

  const activeIndex=stageIndex(progress,state);
  renderStages(activeIndex,state);
  if(message)message.textContent=stageMessage(activeIndex,state);
  setVisible(true);

  if(state==='success'){
    node.classList.add('success');
    successTimer=window.setTimeout(()=>reset(),520);
  }
}

window.renderUnifiedStatus=(status='idle',progress=0,message='')=>render(status,progress);
window.resetProcessingStatus=reset;

})();
