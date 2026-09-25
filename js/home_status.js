/* 天友智配One - 全屏智能处理状态层 */
(() => {
'use strict';

const STAGES=[
  {key:'recognize',label:'识别'},
  {key:'extract',label:'提取'},
  {key:'match',label:'匹配'},
  {key:'plan',label:'规划'},
  {key:'complete',label:'完成'}
];

let layer=null;
let progressTimer=null;

function ensureLayer(){
  if(layer&&document.body.contains(layer))return layer;
  layer=document.createElement('div');
  layer.id='zpeiProcessingLayer';
  layer.className='zpei-processing-layer';
  layer.setAttribute('aria-live','polite');
  layer.setAttribute('aria-label','运单智能处理');
  layer.innerHTML='<div class="zpei-processing-rail" role="status"></div>';
  document.body.appendChild(layer);
  return layer;
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

function renderRail(activeIndex,status){
  const root=ensureLayer().querySelector('.zpei-processing-rail');
  root.textContent='';
  STAGES.forEach((stage,index)=>{
    const node=document.createElement('span');
    node.className='zpei-stage';
    node.dataset.stage=stage.key;
    if(index<activeIndex||status==='success')node.classList.add('done');
    else if(index===activeIndex)node.classList.add('current');
    else node.classList.add('pending');
    node.textContent=(index<activeIndex||status==='success'?'●':index===activeIndex?'◉':'○')+stage.label;
    root.appendChild(node);
    if(index<STAGES.length-1){
      const line=document.createElement('span');
      line.className='zpei-stage-line'+(index<activeIndex||status==='success'?' done':'');
      line.setAttribute('aria-hidden','true');
      root.appendChild(line);
    }
  });
}

function setProcessing(active){
  document.body.classList.toggle('zpei-processing',active);
  const overlay=document.getElementById('uploadOverlay');
  if(overlay)overlay.classList.toggle('zpei-processing-source',active);
}

function reset(){
  if(progressTimer)cancelAnimationFrame(progressTimer);
  progressTimer=null;
  setProcessing(false);
  if(layer){
    layer.classList.remove('active','error');
    layer.setAttribute('aria-hidden','true');
  }
}

function showError(message){
  const current=String(message||'运单处理失败，请重新上传').trim();
  const node=ensureLayer();
  node.classList.add('active','error');
  node.setAttribute('aria-hidden','false');
  const rail=node.querySelector('.zpei-processing-rail');
  rail.textContent='';
  const text=document.createElement('div');
  text.className='zpei-processing-error';
  text.textContent=current;
  rail.appendChild(text);
  setProcessing(false);
}

function render(status='idle',progress=0,message=''){
  const state=['idle','loading','success','error','cancelled'].includes(status)?status:'idle';
  if(state==='idle'||state==='cancelled'){
    reset();
    return;
  }
  if(state==='error'){
    showError(typeof message==='object'?'运单处理失败，请重新上传':message);
    return;
  }

  const node=ensureLayer();
  node.classList.add('active');
  node.classList.remove('error');
  node.setAttribute('aria-hidden','false');
  setProcessing(true);

  const activeIndex=stageIndex(progress,state);
  renderRail(activeIndex,state);

  if(state==='success'){
    renderRail(STAGES.length-1,'success');
    setProcessing(true);
    window.setTimeout(()=>reset(),420);
  }
}

window.renderUnifiedStatus=(status='idle',progress=0,message='')=>{
  render(status,progress,message);
};

window.renderStatusDetail=()=>{};
window.clearStatusDetail=()=>{};
window.resetProcessingStatus=reset;

})();
