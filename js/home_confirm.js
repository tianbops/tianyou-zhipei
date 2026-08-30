/* 天友智配One - 解析结果人工确认层
 * 负责：显示疑似门店、选择候选、确认后调用服务器确认入库。
 * 不修改OCR原文；不在客户端决定最终线路顺序。
 */
(function(){
  'use strict';
  let reviewState=[];
  const $=id=>document.getElementById(id);
  const toast=(msg,type='')=>{if(typeof window.toast==='function')return window.toast(msg,type);let el=$('homeToast');if(!el){el=document.createElement('div');el.id='homeToast';el.className='toast';document.body.appendChild(el)}el.textContent=msg;el.className=`toast show ${type}`;setTimeout(()=>el.classList.remove('show'),2800)};
  function ensurePanel(){
    if($('reviewPanel'))return $('reviewPanel');
    const panel=document.createElement('div');panel.id='reviewPanel';panel.style.cssText='display:none;margin:12px 0;padding:14px;background:rgba(255,176,32,.08);border:1px solid rgba(255,176,32,.25);border-radius:16px;color:#fff';
    panel.innerHTML='<div style="font-weight:700;font-size:15px;margin-bottom:6px">⚠ 待确认门店</div><div id="reviewHint" style="font-size:11px;color:#AAB6C2;margin-bottom:10px">系统发现疑似匹配，请确认后再录入。</div><div id="reviewList"></div>';
    const status=$('parseStatus');if(status&&status.parentNode)status.parentNode.insertBefore(panel,status.nextSibling);else document.querySelector('.upload-sheet')?.prepend(panel);return panel;
  }
  function renderReviews(items){
    reviewState=(Array.isArray(items)?items:[]).filter(x=>x&&x.needsReview);
    const panel=ensurePanel(),list=$('reviewList');
    if(!reviewState.length){panel.style.display='none';if(list)list.innerHTML='';return}
    panel.style.display='block';if($('reviewHint'))$('reviewHint').textContent=`发现 ${reviewState.length} 家疑似门店。请逐项确认；未确认的门店不能生成正式订单。`;
    if(!list)return;
    list.innerHTML='';
    reviewState.forEach((item,index)=>{
      const row=document.createElement('div');row.dataset.reviewIndex=index;row.style.cssText='padding:10px 0;border-top:1px solid rgba(255,255,255,.08)';
      const title=document.createElement('div');title.style.cssText='font-size:13px;margin-bottom:7px';title.innerHTML=`<span style="color:#FFB020">${item.code||`R${String(index+1).padStart(2,'0')}`}</span>　识别：<b>${escapeHtml(item.name||'')}</b>`;
      const meta=document.createElement('div');meta.style.cssText='font-size:10px;color:#718092;margin-bottom:7px';meta.textContent=`匹配度 ${Math.round(Number(item.matchScore||0)*100)}%`;
      const select=document.createElement('select');select.dataset.reviewSelect='1';select.style.cssText='width:100%;height:40px;border-radius:10px;background:#10161D;color:#fff;border:1px solid rgba(255,255,255,.1);padding:0 10px;font-size:12px';
      const candidate=document.createElement('option');candidate.value=item.candidate||'';candidate.textContent=item.candidate?`采用候选：${item.candidate}`:'请选择基准门店';select.appendChild(candidate);
      const keep=document.createElement('option');keep.value='__new__';keep.textContent='作为新增门店（不匹配基准）';select.appendChild(keep);
      select.addEventListener('change',()=>{item._choice=select.value});
      row.append(title,meta,select);list.appendChild(row);
    });
    const actions=document.createElement('div');actions.style.cssText='display:flex;gap:8px;margin-top:10px';
    const apply=document.createElement('button');apply.type='button';apply.textContent='✓ 应用确认';apply.style.cssText='flex:1;height:40px;border:0;border-radius:11px;background:#2457A6;color:#fff;font-weight:600';apply.onclick=applyReviews;
    actions.appendChild(apply);list.appendChild(actions);
  }
  function applyReviews(){
    if(!Array.isArray(window.parsedOrders)||!window.parsedOrders.length)return;
    let unresolved=0;
    reviewState.forEach(item=>{
      const choice=item._choice||item.candidate||'';
      const target=window.parsedOrders.find(x=>x&&x.code===item.code)||window.parsedOrders.find(x=>x&&x.name===item.name);
      if(!target)return;
      if(!choice){unresolved++;return}
      if(choice==='__new__'){
        target.needsReview=false;target.candidate='';target.matchType='new';target.matched=false;target.isNew=true;target.matchScore=0;
      }else{
        target.name=choice;target.needsReview=false;target.candidate='';target.matchType='confirmed';target.matched=true;target.isNew=false;target.matchScore=1;
      }
    });
    if(unresolved){toast(`还有 ${unresolved} 家门店未确认`,'warning');return}
    reviewState=[];renderReviews([]);toast('待确认门店已确认，可以录入','');
    if(typeof window.renderTags==='function')window.renderTags(window.parsedOrders);
  }
  function escapeHtml(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
  async function confirmToServer(){
    const orders=Array.isArray(window.parsedOrders)?window.parsedOrders:[];
    if(!orders.length){toast('请先点击“开始解析”','warning');return}
    const pending=orders.filter(x=>x&&x.needsReview);
    if(pending.length){renderReviews(pending);toast(`请先确认 ${pending.length} 家疑似门店`,'warning');return}
    const meta=window.pendingMeta||{};const route=typeof window.currentRoute==='function'?window.currentRoute():'';
    if(!route){toast('未指定配送线路','warning');return}
    const btn=$('confirmBtn');if(btn){btn.disabled=true;btn.textContent='正在确认…'}
    try{
      const response=await fetch('/api/confirm',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',cache:'no-store',body:JSON.stringify({orders,date:meta.date||'',vehicle:meta.vehicle||'',totalWeight:meta.totalWeight||'',route,source:meta.source||'web-confirm',recognizedCount:Number(meta.recognizedCount)||orders.length,rawOrderCount:Number(meta.rawOrderCount)||0})});
      const data=await response.json().catch(()=>({}));
      if(!response.ok||!data.success){
        if(data.code==='REVIEW_REQUIRED'){renderReviews(data.review||[]);throw Error(data.error||'仍有疑似门店未确认')}
        throw Error(data.error||`确认失败（${response.status}）`);
      }
      window.serverToday=data.data||null;
      toast(`已确认并录入 ${data.data?.count||orders.length} 家门店`);
      $('uploadOverlay')?.classList.remove('active');
      setTimeout(()=>{if(typeof window.goToOrderDetail==='function')window.goToOrderDetail()},400);
    }catch(e){toast(e.message||'确认入库失败','warning');const box=$('error-box');if(box){box.textContent='页面错误：'+(e.message||'确认入库失败');box.classList.add('show')}}finally{if(btn){btn.disabled=false;btn.textContent='确认录入'}}
  }
  function hook(){
    const oldParse=window.parseManualInput;
    if(oldParse&&!oldParse.__reviewWrapped){
      const wrapped=async function(){const result=await oldParse.apply(this,arguments);renderReviews((Array.isArray(result)?result:[]).filter(x=>x&&x.needsReview));return result};wrapped.__reviewWrapped=true;window.parseManualInput=wrapped;
    }
    window.submitManualOrder=confirmToServer;
    ensurePanel();
  }
  document.addEventListener('DOMContentLoaded',hook);
  setTimeout(hook,300);
  setTimeout(hook,1000);
  window.renderReviewStores=renderReviews;
})();
