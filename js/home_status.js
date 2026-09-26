/* 智配One - 统一运单处理弹窗状态框 */
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
      <div class="zpei-processing-error-message" role="alert" aria-live="assertive"></div>
      <div class="zpei-processing-stages" role="status" aria-live="polite"></div>
      <button type="button" class="zpei-processing-cancel-btn">取消</button>
      <button type="button" class="zpei-processing-failure-btn">返回上传</button>
    </section>`;
  document.body.appendChild(modal);
  modal.querySelector('.zpei-processing-cancel-btn')?.addEventListener('click',()=>{
    if(typeof window.cancelUpload==='function')window.cancelUpload();
    else window.resetProcessingStatus?.();
  });
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

function userFriendlyError(message, code=''){
  const text=String(message||'').trim();
  const failureCode=String(code||'').trim();
  if(failureCode==='STORE_CANDIDATES_INVALID'||failureCode==='EXTRACT_FAILED')return '运单文字提取失败，请重新上传清晰的运单图片。';
  if(failureCode==='ROUTE_REQUIRED')return '请先选择调度线路，再上传运单。';
  if(failureCode==='ROUTE_FORBIDDEN')return '当前账号无权使用所选调度线路，请切换到可用线路。';
  if(failureCode==='ROUTE_NOT_FOUND')return '所选调度线路不存在或已停用，请重新选择线路。';
  if(failureCode==='BASE_MISSING'||failureCode==='BASE_DATABASE_UNAVAILABLE')return '当前线路基准库不存在，请先建立线路基准数据。';
  if(failureCode==='MATCH_FAILED')return '门店匹配未完成，请稍后重试。';
  if(failureCode==='PLAN_FAILED')return '配送顺序生成失败，请稍后重试。';
  if(failureCode==='OCR_INVALID')return '运单识别失败，请重新上传清晰的运单图片。';
  if(failureCode==='TIMEOUT')return '网络或服务器处理超时，请稍后重试。';
  // 真实业务回归阶段：直接显示后端错误代码和原始信息，便于定位实际故障。
  if(failureCode)return (window.__zpeiLastFailureStage?String(window.__zpeiLastFailureStage)+'阶段失败：':'处理失败：')+failureCode+(text?'（'+text+'）':'');
  if(failureCode==='WAYBILL_DATE_MISSING')return '未识别到运单日期，请重新上传清晰的运单图片。';
  if(failureCode==='WEIGHT_MISSING')return '未识别到商品总量，请重新上传清晰的运单图片。';
  if(failureCode==='REVIEW_REQUIRED')return '仍有待定门店未确认，请先完成门店确认。';
  if(/基准|数据库|Redis/.test(text))return '当前线路数据读取失败，请稍后重试。';
  if(/未提取到有效门店|未识别到有效门店|有效门店/.test(text))return '运单文字提取失败，请重新上传清晰的运单图片。';
  if(/OCR|识别引擎|OCR文字|无法识别运单/.test(text))return '运单识别失败，请重新上传清晰的运单图片。';
  if(/超时|网络|请求/.test(text))return '网络或服务器处理超时，请稍后重试。';
  if(/线路/.test(text))return '当前线路发生变化，请重新上传运单。';
  // 真实回归期间禁止吞掉后端失败原因：后端已有 code/stage 时直接显示，
  // 便于根据真实运行结果定位“识别 → 提取 → 匹配 → 规划”断点。
  return text||'运单处理未完成，请重新上传。';
}

function showError(message='',code=''){
  if(successTimer){clearTimeout(successTimer);successTimer=null;}
  const node=ensureModal();
  node.classList.add('active','error');
  node.classList.remove('success');
  node.setAttribute('aria-hidden','false');
  const title=node.querySelector('.zpei-processing-title');
  const stages=node.querySelector('.zpei-processing-stages');
  const detail=node.querySelector('.zpei-processing-error-message');
  const button=node.querySelector('.zpei-processing-failure-btn');
  const cancelButton=node.querySelector('.zpei-processing-cancel-btn');
  if(title)title.textContent='运单处理失败';
  if(detail)detail.textContent=userFriendlyError(message,code);
  if(stages)stages.style.display='none';
  if(button)button.style.display='inline-flex';
  if(cancelButton)cancelButton.style.display='none';
  renderStages(-1,'error');
  setVisible(true);
}

function render(status='idle',progress=0,message='',code=''){
  const state=['idle','loading','success','error','cancelled'].includes(status)?status:'idle';
  if(state==='idle'||state==='cancelled'){
    reset();
    return;
  }
  if(state==='error'){
    showError(message,code);
    return;
  }

  const node=ensureModal();
  node.classList.add('active');
  node.classList.remove('error','success');
  node.setAttribute('aria-hidden','false');
  const title=node.querySelector('.zpei-processing-title');
  const stages=node.querySelector('.zpei-processing-stages');
  const button=node.querySelector('.zpei-processing-failure-btn');
  const cancelButton=node.querySelector('.zpei-processing-cancel-btn');
  if(stages)stages.style.display='flex';
  if(title)title.textContent=state==='success'?'处理完成':'正在处理运单';
  if(button)button.style.display='none';
  if(cancelButton)cancelButton.style.display=state==='loading'?'inline-flex':'none';

  const activeIndex=stageIndex(progress,state);
  renderStages(activeIndex,state);
  setVisible(true);

  if(state==='success'){
    node.classList.add('success');
    successTimer=window.setTimeout(()=>reset(),520);
  }
}

window.renderUnifiedStatus=(status='idle',progress=0,message='',code='')=>render(status,progress,message,code);
window.handleUploadProcessingFailure=(message='',code='',stage='')=>{window.__zpeiLastFailureStage=String(stage||'').trim();render('error',100,message,code);};
window.resetProcessingStatus=reset;

})();
