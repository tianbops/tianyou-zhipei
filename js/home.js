/* 天友智配One - 首页业务逻辑 */
(function(){
'use strict';

let parsedOrders=[],serverOrder=null,pendingMeta={},reviewMode=false,primaryActionMode='idle',statusBaseDetails=[],pendingReviewCount=0;
const $=id=>document.getElementById(id);
function toast(message,type=''){let el=$('homeToast');if(!el){el=document.createElement('div');el.id='homeToast';el.className='toast';document.body.appendChild(el)}el.textContent=message;el.className=`toast show ${type}`;clearTimeout(toast.timer);toast.timer=setTimeout(()=>el.classList.remove('show'),2800)}
window.homeToast=toast;
function error(message){const box=$('error-box');if(!box)return;box.textContent='页面错误：'+message;box.classList.add('show');setTimeout(()=>box.classList.remove('show'),5000)}
function currentDate(){return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date())}
function storeName(store){return String(store?.name||store?.storeName||store?.shopName||'').trim()}
function currentRoute(){return Auth.getDispatchRoute?Auth.getDispatchRoute():Auth.getCurrentRoute()}
async function loadDispatchRoutes(){
  const select=$('dispatchRouteSelect');
  const bound=Auth.getBoundRoute?Auth.getBoundRoute():Auth.getCurrentRoute();
  const selected=currentRoute();
  let available=[];
  try{
    const response=await fetch('/api/routes',{cache:'no-store',credentials:'same-origin'});
    const data=await response.json().catch(()=>({}));
    if(response.ok&&data.success){
      // 业务调度只允许使用启用中的真实线路；停用线路保留给系统管理端查看。
      available=(Array.isArray(data.routes)?data.routes:[])
        .filter(x=>x?.status!=='disabled')
        .map(x=>{const name=String(x?.name||'').trim();const id=String(x?.id||'').trim();const candidate=/^\d+(?:号线)?$/.test(name)?name:(/^\d+(?:号线)?$/.test(id)?id:'');return Auth.formatRouteCode?Auth.formatRouteCode(candidate):candidate;})
        .filter(Boolean);
      available=[...new Set(available)];
    }else{
      console.warn('线路列表读取失败',response.status,data?.error||'');
    }
  }catch(error){console.warn('线路列表请求失败',error)}
  if(bound){
    const normalizedBound=Auth.formatRouteCode?Auth.formatRouteCode(bound):String(bound).trim();
    if(normalizedBound&&!available.includes(normalizedBound))available.unshift(normalizedBound);
  }
  const normalizedSelected=Auth.formatRouteCode?Auth.formatRouteCode(selected):String(selected||'').trim();
  if(normalizedSelected&&!available.includes(normalizedSelected))available.unshift(normalizedSelected);
  if(select){
    select.innerHTML=available.map(route=>`<option value="${route}">${route}</option>`).join('');
    const initial=normalizedSelected|| (Auth.formatRouteCode?Auth.formatRouteCode(bound):String(bound||'').trim()) || available[0] || '';
    if(initial){
      Auth.setDispatchRoute?.(initial);
      select.value=initial;
    }
    select.onchange=handleDispatchRouteChange;
  }
  if($('menuRoute'))$('menuRoute').textContent=select?.value||normalizedSelected||bound||'未选择线路';
  return currentRoute();
}

let homeOrderLoadSeq=0;
async function handleDispatchRouteChange(){
  const select=$('dispatchRouteSelect');
  const next=Auth.formatRouteCode?Auth.formatRouteCode(select?.value):String(select?.value||'').trim();
  if(!next)return;
  const current=String(currentRoute()||'').trim();
  if(next===current){
    if($('menuRoute'))$('menuRoute').textContent=next;
    return;
  }

  // 线路是当前上传/当日任务的一级上下文。切换线路后，旧线路的解析结果和订单显示均必须失效。
  const seq=++homeOrderLoadSeq;
  Auth.setDispatchRoute?.(next);
  if($('menuRoute'))$('menuRoute').textContent=next;

  const overlay=$('uploadOverlay');
  if(overlay?.classList.contains('active')) window.cancelUpload?.();

  serverOrder=null;
  updateSummary();

  try{
    const order=await loadServerOrder(currentDate(),next);
    if(seq!==homeOrderLoadSeq||String(currentRoute()||'').trim()!==next)return;
    serverOrder=order;
    updateSummary();
  }catch(error){
    if(seq!==homeOrderLoadSeq||String(currentRoute()||'').trim()!==next)return;
    console.error('切换线路后刷新当日任务失败',error);
    serverOrder=null;
    updateSummary();
    toast(error?.message||'线路切换后数据读取失败','error');
  }
}

async function loadServerOrder(date='',expectedRoute=''){
  const route=String(expectedRoute||currentRoute()||'').trim();
  if(!route)throw Error('未指定配送线路');
  if(expectedRoute&&String(currentRoute()||'').trim()!==route)return null;
  const params=new URLSearchParams();
  params.set('route',route);
  if(date)params.set('date',date);
  const query=params.toString();
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),10000);
  try{
    const response=await fetch(`/api/orders${query?`?${query}`:''}`,{cache:'no-store',credentials:'same-origin',signal:controller.signal});
    if(!response.ok)throw Error(response.status===401?'登录已失效，请重新登录':`当日订单读取失败（${response.status}）`);
    const data=await response.json();
    const incoming=data?.today;
    const incomingValid=Boolean(incoming&&Array.isArray(incoming.orders)&&incoming.orders.length);
    if(incomingValid){
      const result={...incoming};
      result._todayWaybillCount=Math.max(0,Number(data?.todayWaybillCount)||0);
      result._todaySummary=data?.todaySummary||null;
      return result;
    }

    // 兜底：历史查询与当日入口必须共享同一份线路级业务数据。
    try{
      const hp=new URLSearchParams({route});
      if(date)hp.set('date',date);
      const hr=await fetch(`/api/history?${hp.toString()}`,{cache:'no-store',credentials:'same-origin'});
      if(hr.ok){
        const payload=await hr.json().catch(()=>[]);
        const records=Array.isArray(payload)?payload:(Array.isArray(payload?.data)?payload.data:[]);
        const valid=records.filter(item=>item&&Array.isArray(item.orders)&&item.orders.length);
        if(valid.length){
          const recovered=valid.slice().sort((a,b)=>(Date.parse(String(b?.updatedAt||b?.createdAt||''))||0)-(Date.parse(String(a?.updatedAt||a?.createdAt||''))||0))[0];
          const result={...recovered,date:date||recovered.date||currentDate(),route:recovered.route||route};
          result._todayWaybillCount=valid.length;
          const totalWeight=valid.reduce((sum,item)=>sum+parseWeight(item?.totalWeight??item?.weight),0);
          const storeCount=valid.reduce((sum,item)=>sum+(Number(item?.uniqueStoreCount)||Number(item?.count)||item.orders.length),0);
          result._todaySummary={
            storeCount,
            totalWeight:totalWeight>0?`${Math.round((totalWeight+Number.EPSILON)*1000000)/1000000}t`:''
          };
          return result;
        }
      }
    }catch(fallbackError){console.warn('当日订单接口为空，历史兜底读取失败',fallbackError)}
    return null;
  }catch(error){
    if(error?.name==='AbortError')throw Error('当日任务读取超时，请稍后重试');
    throw error;
  }finally{clearTimeout(timer)}
}
function parseWeight(value){if(value===null||value===undefined||value==='')return 0;const text=String(value).trim().replace(/,/g,'');const match=text.match(/[\d]+(?:\.\d+)?/);if(!match)return 0;const n=Number(match[0]);if(!Number.isFinite(n))return 0;const tons=/吨|\bt\b/i.test(text)?n:/kg|千克|公斤/i.test(text)?n/1000:n>=1000?n/1000:n;return Number.isFinite(tons)?tons:0}
function formatWeight(value){const tons=parseWeight(value);if(!(tons>0))return '暂无数据';const rounded=Math.round((tons+Number.EPSILON)*100)/100;return `${rounded.toFixed(2)}t`}
function updateSummary(){const hasToday=!!serverOrder&&Array.isArray(serverOrder.orders)&&serverOrder.orders.length>0;const route=serverOrder?.route||currentRoute()||'';const vehicle=serverOrder?.vehicle||'';if($('taskCard'))$('taskCard').style.display='block';if($('menuRoute'))$('menuRoute').textContent=route||'未选择线路';if(!hasToday){if($('homeRoute')){const text=$('homeRoute').querySelector('.vehicle-text');if(text)text.textContent='';}if($('storeCount'))$('storeCount').textContent='';if($('totalWeight'))$('totalWeight').textContent='';if($('statusDot')){const dot=$('statusDot');dot.textContent='0';dot.style.background='#5A6A7A';dot.classList.remove('has-count');dot.setAttribute('aria-label','今日运单笔数：0')}return}const orders=serverOrder.orders;const dailySummary=serverOrder._todaySummary||null;const count=Number(dailySummary?.storeCount)||Number(serverOrder.uniqueStoreCount||serverOrder.count)||orders.length;const orderCount=Math.max(1,Number(serverOrder._todayWaybillCount)||1);if($('homeRoute')){const text=$('homeRoute').querySelector('.vehicle-text');if(text)text.textContent=vehicle||route||'未绑定车辆';}if($('storeCount'))$('storeCount').textContent=count?`${count}家`:'暂无当日订单';if($('totalWeight'))$('totalWeight').textContent=dailySummary?.totalWeight?formatWeight(dailySummary.totalWeight):formatWeight(serverOrder.totalWeight);if($('statusDot')){const dot=$('statusDot');dot.textContent=String(orderCount);dot.style.background=count?'#3B82F6':'#5A6A7A';dot.classList.toggle('has-count',orderCount>0);dot.setAttribute('aria-label',`今日运单笔数：${orderCount}`)}}
window.openPendingReview=()=>{
  const pending=parsedOrders.filter(item=>item?.needsReview===true);
  if(!pending.length)return;
  if(typeof window.openPendingReviewDetail==='function')window.openPendingReviewDetail(pending);
  else window.renderReviewStores?.(pending);
};
function parseWeightFromText(text){const source=String(text||'').replace(/\s+/g,' ');const match=source.match(/(?:总\s*重\s*量|总重|重量)\s*[:：]?\s*([\d,]+(?:\.\d+)?)\s*(kg|千克|公斤|吨|t)?/i)||source.match(/([\d,]+(?:\.\d+)?)\s*(kg|千克|公斤|吨|t)\b/i);return match?`${match[1]}${match[2]||''}`:''}
function parseDateFromText(text){const match=String(text||'').match(/(20\d{2})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*日?/);return match?`${match[1]}-${String(match[2]).padStart(2,'0')}-${String(match[3]).padStart(2,'0')}`:''}
function parseVehicleFromText(text){const match=String(text||'').match(/(?:车牌号\s*[:：]?\s*)?(渝\s*[A-Z0-9]{5,7})/i);return match?match[1].replace(/\s+/g,'').toUpperCase():''}
function cleanFallbackStore(value){return String(value||'').replace(/^\s*[\d０-９]+\s*[、.．)）-]+\s*/,'').replace(/^\s*[|｜]+|[|｜]+\s*$/g,'').replace(/\s+/g,' ').trim()}
function isFallbackStore(value){const text=cleanFallbackStore(value),compact=text.replace(/\s/g,'');if(!text||text.length<3||!/[\u4e00-\u9fff]/.test(text))return false;if(/^(?:运单列表|运输日期|车牌号|额定载重|额定装载|额定体积|主司机|送货员|承运订单|总数量|总重量|总体积|订单编号|运单编号|车辆信息|配送信息)/.test(compact))return false;if(/^(?:20\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2}日?|渝[A-Z0-9]{5,7})$/.test(compact))return false;return true}
function fallbackStoresFromText(text){let source=String(text||'').replace(/\r\n?/g,'\n').replace(/[＞》➜➤⇒↦→]/g,'->').replace(/\s*->\s*/g,'->');const carrier=source.lastIndexOf('承运订单');if(carrier>=0)source=source.slice(carrier+'承运订单'.length);const parts=source.includes('->')?source.replace(/\s+/g,' ').split('->'):source.split('\n');const stores=[],seen=new Set();for(const part of parts){let name=cleanFallbackStore(part).replace(/(?:总数量|总重量|总体积|订单编号|运单编号|车牌号|运输日期|主司机|送货员|额定载重|额定体积)\s*[:：]?[^\n]*/gi,' ').trim();if(!isFallbackStore(name))continue;const key=name.replace(/\s/g,'').toLowerCase();if(seen.has(key))continue;seen.add(key);stores.push({code:String(stores.length+1).padStart(2,'0'),name,nav:'',note:'',weight:0,isNew:false,matched:false,needsReview:false,matchType:'raw-order',matchScore:0,rawName:name,rawNames:[name]})}return stores}
function fallbackParse(text){const stores=fallbackStoresFromText(text);if(!stores.length)throw Error('未识别到有效门店，请检查OCR文字后再解析');const totalWeight=parseWeightFromText(text);return{route:currentRoute(),date:parseDateFromText(text),vehicle:parseVehicleFromText(text),totalWeight,totalVolume:'',rawOrderCount:stores.length,recognizedCount:stores.length,uniqueStoreCount:stores.length,storeCount:stores.length,matchedCount:0,newStoreCount:0,reviewCount:0,duplicateCount:0,learnedCount:0,baseDatabaseAvailable:false,stores,warning:`未找到${currentRoute()}独立基准数据库，本次按运单识别顺序排列`}}
let parseAbortController=null,parseInFlight=false,parseCancelled=false;
function currentUploadTaskId(){return typeof window.getUploadTaskId==='function'?Number(window.getUploadTaskId())||0:0}
function ensureUploadTask(){if(typeof window.beginUploadTask!=='function')return 0;return currentUploadTaskId()||window.beginUploadTask()}
function invalidateUploadTask(){return typeof window.invalidateUploadTask==='function'?window.invalidateUploadTask():0}
function isUploadTaskActive(taskId){return !taskId||typeof window.isUploadTaskActive!=='function'||window.isUploadTaskActive(taskId)}
async function parseOrderText(text,taskId=0){
  const route=currentRoute();
  const parseRoute=String(route||'').trim();
  if(taskId&&!isUploadTaskActive(taskId))throw Object.assign(new Error('已取消处理'),{code:'PARSE_CANCELLED'});if(!route)throw Error('未指定配送线路');
  if(parseInFlight)throw Error('正在处理运单，请勿重复操作');
  parseInFlight=true;parseCancelled=false;parseAbortController=new AbortController();
  const PARSE_TIMEOUT_MS=120000; // 门店提取与基准库比对最多等待2分钟
  const timer=setTimeout(()=>parseAbortController?.abort(),PARSE_TIMEOUT_MS);
  try{
    const response=await fetch('/api/parse',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text,route}),credentials:'same-origin',cache:'no-store',signal:parseAbortController.signal});
    const data=await response.json().catch(()=>({}));
    if(taskId&&!isUploadTaskActive(taskId))throw Object.assign(new Error('已取消处理'),{code:'PARSE_CANCELLED'});
    if(String(currentRoute()||'').trim()!==parseRoute)throw Object.assign(new Error(`调度线路已从 ${parseRoute||'未选择'} 切换，当前运单已失效，请重新上传`),{code:'ROUTE_CHANGED'});
    if(!response.ok||!data.success){
      const message=String(data?.error||'');
      if(/未找到.*独立基准数据库/.test(message)){if(taskId&&!isUploadTaskActive(taskId))throw Object.assign(new Error('已取消处理'),{code:'PARSE_CANCELLED'});const fallback=fallbackParse(text);if(taskId&&!isUploadTaskActive(taskId))throw Object.assign(new Error('已取消处理'),{code:'PARSE_CANCELLED'});return fallback;}
      throw Error(message||`运单处理接口错误（${response.status}）`);
    }
    return data.data;
  }catch(e){
    if(e?.name==='AbortError'){
      if(parseCancelled)throw Object.assign(new Error('已取消处理'),{code:'PARSE_CANCELLED'});
      throw Error('运单处理超过2分钟，请检查网络后重试');
    }
    throw e;
  }finally{
    clearTimeout(timer);parseAbortController=null;parseInFlight=false;
  }
}
window.cancelParse=async()=>{invalidateUploadTask();if(parseAbortController){parseCancelled=true;parseAbortController.abort();}const cancelOCR=window.cancelOCR;if(typeof cancelOCR==='function')await cancelOCR().catch(()=>{});};

function setPrimaryActionMode(mode){
  primaryActionMode=mode==='confirm'?'confirm':mode==='error'?'error':'idle';
  const button=$('primaryActionBtn');
  if(!button)return;
  const visible=primaryActionMode==='confirm'||primaryActionMode==='error';
  button.textContent=primaryActionMode==='confirm'?'确认录入':primaryActionMode==='error'?'重新上传':'';
  button.classList.toggle('ready',primaryActionMode==='confirm');
  button.disabled=false;
  button.hidden=!visible;
  button.setAttribute('aria-hidden',visible?'false':'true');
}
window.openUploadSource=()=>{const menu=$('uploadSourceMenu');if(menu){menu.classList.add('active');menu.setAttribute('aria-hidden','false');const sheet=menu.closest('.upload-sheet');sheet?.classList.add('waiting')}}
window.closeUploadSource=()=>{const menu=$('uploadSourceMenu');if(menu){menu.classList.remove('active');menu.setAttribute('aria-hidden','true')}}
window.handlePrimaryAction=async()=>{
  if(primaryActionMode==='confirm'){
    if(typeof window.submitManualOrder!=='function'){
      const loaded=await ensureConfirmModule();
      if(!loaded){
        window.renderUnifiedStatus?.('error',100,'确认录入模块加载失败，请刷新页面后重试');
        window.homeToast?.('确认录入模块加载失败，请刷新页面后重试','error');
        return;
      }
    }
    return window.submitManualOrder();
  }
  if(primaryActionMode==='error'){
    window.restartUpload?.();
  }
};
let uploadDetailMode='';
function getCorrectionDetailText(){
  return Array.isArray(correctionDetails)&&correctionDetails.length?correctionDetails:[];
}
function renderUploadDetail(mode){
  const view=$('uploadDetailView'),title=$('uploadDetailTitle'),body=$('uploadDetailBody');
  if(!view||!title||!body)return;
  uploadDetailMode=mode==='correction'?'correction':'recognition';
  const sheet=document.querySelector('.upload-sheet');
  if(sheet){
    sheet.classList.remove('detail-mode-planning','detail-mode-recognition','detail-mode-correction');
    sheet.classList.add(`detail-mode-${uploadDetailMode}`);
  }
  title.textContent=uploadDetailMode==='correction'?'修正详情':'识别详情';
  body.textContent='';
  if(uploadDetailMode==='recognition'){
    const sectionTitle=document.createElement('div');sectionTitle.className='detail-section-title';sectionTitle.textContent='当日订单信息';body.appendChild(sectionTitle);
    const info=document.createElement('div');info.className='order-info-list';
    const lines=String($('manualOrderInput')?.value||'').split(/\n/).map(v=>v.trim()).filter(Boolean);const values={};
    lines.forEach(line=>{const m=line.match(/^(日期|线路|车辆|门店|重量|门店数|总重量)\\s*[:：]\\s*(.+)$/);if(m)values[m[1]]=m[2];});
    [['日期',values.日期||pendingMeta.date||'未识别'],['线路',values.线路||currentRoute()||'未识别'],['车辆',values.车辆||pendingMeta.vehicle||'未识别'],['门店',values.门店||`${Number(pendingMeta.uniqueStoreCount)||parsedOrders.length}家`],['重量',values.重量||pendingMeta.totalWeight||'未识别']].forEach(([label,value])=>{const row=document.createElement('div');row.className='order-info-row';const left=document.createElement('span');left.textContent=`${label}：`;const right=document.createElement('strong');right.textContent=String(value||'未识别');row.append(left,right);info.appendChild(row);});
    body.appendChild(info);const listTitle=document.createElement('div');listTitle.className='detail-subtitle';listTitle.textContent='门店列表';body.appendChild(listTitle);
    const pre=document.createElement('pre');pre.className='upload-detail-text';
    const detailStores=Array.isArray(parsedOrders)?parsedOrders:[];
    if(detailStores.length){
      const orderedStores=[...detailStores.filter(item=>item?.needsReview===true),...detailStores.filter(item=>item?.isNew===true&&item?.needsReview!==true),...detailStores.filter(item=>item?.needsReview!==true&&item?.isNew!==true)];
      pre.textContent=orderedStores.map((item,index)=>{
        const mark=item?.needsReview?'⚠️ 待定：':item?.isNew?'⚠️ 新增：':'';
        return `${String(index+1).padStart(2,'0')}. ${mark}${storeName(item)}`;
      }).join('\n');
    }else{
      const marker=lines.findIndex(v=>v.includes('门店列表'));
      pre.textContent=marker>=0?(lines.slice(marker+1).join('\n')||'暂无门店列表'):'暂无门店列表';
    }
    body.appendChild(pre);
  }else{
    const sectionTitle=document.createElement('div');
    sectionTitle.className='detail-section-title';
    sectionTitle.textContent='当日更改信息';
    body.appendChild(sectionTitle);
    const stats=document.createElement('div');
    stats.className='correction-stats';
    [['原始',correctionStats.raw],['更正',correctionStats.corrected],['合并',correctionStats.merged]].forEach(([label,value])=>{
      const item=document.createElement('div');
      item.className='correction-stat';
      const text=document.createElement('span');
      text.textContent=label+'：'+(Number(value)||0)+'家';
      item.appendChild(text);stats.appendChild(item);
    });
    body.appendChild(stats);
    const detailTitle=document.createElement('div');
    detailTitle.className='detail-subtitle';
    detailTitle.textContent='更改明细';
    body.appendChild(detailTitle);
    const items=getCorrectionDetailText();
    if(!items.length){
      const empty=document.createElement('div');
      empty.className='upload-detail-empty';
      empty.textContent='暂无修正记录';
      body.appendChild(empty);
    }else{
      items.forEach(item=>{
        const row=document.createElement('div');
        row.className='correction-item';
        const parts=String(item).split(' → ');
        const left=document.createElement('span');left.className='correction-left';left.textContent=parts[0]||'';
        const arrow=document.createElement('span');arrow.className='correction-arrow';arrow.textContent='→';
        const right=document.createElement('span');right.className='correction-right';right.textContent=parts.slice(1).join(' → ')||'';
        row.append(left,arrow,right);body.appendChild(row);
      });
    }
  }
  view.hidden=false;
  view.setAttribute('aria-hidden','false');
  document.querySelector('.upload-sheet')?.classList.add('detail-view-open');
}
function closeUploadDetail(){
  const view=$('uploadDetailView');if(!view)return;
  view.hidden=true;view.setAttribute('aria-hidden','true');
  const sheet=document.querySelector('.upload-sheet');
  sheet?.classList.remove('detail-view-open','detail-mode-planning','detail-mode-correction');
  uploadDetailMode='';
}
window.closeUploadDetail=closeUploadDetail;
window.openCorrectionDetails=()=>renderUploadDetail('correction');
window.restartUpload=()=>{window.clearManualInput?.();const overlay=$('uploadOverlay');if(!overlay)return;overlay.classList.add('active');openUploadHistoryGuard();window.renderUnifiedStatus?.('idle',0,'准备好开始今天的配送任务');window.openUploadSource?.();};
let uploadHistoryGuard=false;
function openUploadHistoryGuard(){
  if(uploadHistoryGuard)return;
  const overlay=$('uploadOverlay');
  if(!overlay)return;
  history.pushState({zpeiUploadOverlay:true},'',location.href);
  uploadHistoryGuard=true;
}
function closeUploadHistoryGuard(){
  if(!uploadHistoryGuard)return;
  uploadHistoryGuard=false;
  if(history.state&&history.state.zpeiUploadOverlay){history.back();}
}
window.cancelUpload=()=>{
  const overlay=$('uploadOverlay');
  if(overlay)overlay.classList.remove('active');
  window.closeUploadSource?.();
  closeUploadHistoryGuard();
  try{window.clearManualInput?.();}catch(e){console.warn('清理上传状态失败',e);}
};
window.toggleUpload=()=>{const overlay=$('uploadOverlay');if(!overlay)return;const opening=!overlay.classList.contains('active');if(opening){overlay.classList.add('active');openUploadHistoryGuard();window.renderUnifiedStatus?.('idle',0,'准备好开始今天的配送任务');window.openUploadSource?.();}else{window.cancelUpload?.();}};
window.addEventListener('popstate',()=>{
  const overlay=$('uploadOverlay');
  if(!overlay||!uploadHistoryGuard)return;
  uploadHistoryGuard=false;
  window.clearManualInput?.();
  overlay.classList.remove('active');
  window.closeUploadSource?.();
});
window.openHomeMenu=()=>{const menu=$('homeMenu');if(menu)menu.style.display=menu.style.display==='block'?'none':'block'};
function navigateApp(url){location.href=url}
window.navigateApp=navigateApp;
window.goToRouteEdit=()=>{const selected=currentRoute();const bound=Auth.getBoundRoute?Auth.getBoundRoute():Auth.getCurrentRoute();if(!selected||selected!==bound){toast('当前调度线路不是你的绑定线路，不能修改基准数据','error');return}navigateApp('pages/route_edit.html')};
window.goToOrderDetail=async()=>{
  const route=String(currentRoute()||'').trim();
  if(!route){toast('请先选择调度线路','error');return}
  try{
    const response=await fetch('/api/routes',{cache:'no-store',credentials:'same-origin'});
    const data=await response.json().catch(()=>({}));
    const current=(Array.isArray(data.routes)?data.routes:[]).find(x=>Auth.formatRouteCode?.(x?.id||x?.name)===Auth.formatRouteCode?.(route));
    if(current?.status==='disabled'){toast('当前线路已停用，无法查看当日线路','error');return}
  }catch(error){console.warn('线路状态校验失败',error)}
  navigateApp('pages/order_detail.html');
};
window.goToHistory=()=>navigateApp('pages/history.html');
window.logout=()=>Auth.logout();
window.clearManualInput=()=>{invalidateUploadTask();correctionDetails=[];setCorrectionSummary(0);if(parseAbortController){parseCancelled=true;parseAbortController.abort();}if(typeof window.cancelOCR==='function')window.cancelOCR().catch(()=>{});window.cancelConfirm?.();const input=$('manualOrderInput');if(input){input.value='';input.setAttribute('placeholder','上传运单后，这里显示识别文字，请核对识别结果。')}['ocrCameraInput','ocrAlbumInput','ocrFileInput'].forEach(id=>{const fileInput=$(id);if(fileInput)fileInput.value='';});parsedOrders=[];pendingMeta={};reviewMode=false;setPrimaryActionMode('idle');const status=$('parseStatus');if(status){status.classList.remove('active','loading','success','error','cancelled');if($('statusIcon'))$('statusIcon').className='status-icon';if($('statusText'))$('statusText').textContent='等待处理...';if($('statusText')){$('statusText').setAttribute('data-text','等待处理...');$('statusText').style.setProperty('--status-progress','0%')}}window.renderReviewStores?.([]);window.clearStatusDetail?.();const sheet=document.querySelector('.upload-sheet');if(sheet){sheet.classList.remove('processing','success','error','cancelled','review-ready','detail-view-open');sheet.classList.add('waiting')}closeUploadDetail?.();};
let correctionDetails=[];let correctionStats={raw:0,corrected:0,merged:0};function setCorrectionSummary(count){
  const row=$('reviewSummary');
  if(row)row.hidden=count<=0;
}
function renderCurrentStatusDetails(){
  const details=[...statusBaseDetails];
  if(pendingReviewCount>0)details.push(`待定${pendingReviewCount}家`);
  window.renderStatusDetail?.(details);
}
window.updatePendingReviewCount=count=>{
  pendingReviewCount=Math.max(0,Number(count)||0);
  renderCurrentStatusDetails();
};
window.parseManualInput=async(options={})=>{const auto=options?.auto===true;const source=String(options?.source||'manual');const taskId=Number(options?.taskId)||ensureUploadTask();if(taskId&&!isUploadTaskActive(taskId))return[];if(parseInFlight)return auto?[]:toast('运单正在处理，请勿重复点击','warning');try{const text=$('manualOrderInput')?.value||'';if(!text.trim()){if(auto)window.renderUnifiedStatus('error',0,'未识别到运单文字，请重试');else toast('请先输入或识别运单文字','warning');return [];}window.renderUnifiedStatus('loading',10,'正在处理运单…');const data=await parseOrderText(text,taskId);if(taskId&&!isUploadTaskActive(taskId))return[];window.renderUnifiedStatus('loading',78,'正在生成配送顺序…');parsedOrders=Array.isArray(data.stores)?data.stores:[];const parseContextId=`parse-${Date.now()}-${Math.random().toString(36).slice(2,10)}`;const parsedRoute=String(data?.route||parseRoute||currentRoute()||'').trim();if(parsedRoute&&Auth.setDispatchRoute)Auth.setDispatchRoute(parsedRoute);const parsedUserId=String(data?.userId||((typeof Auth!=='undefined'&&Auth.serverUser)?(Auth.serverUser.id||Auth.serverUser.username||Auth.serverUser.account||''):'')).trim();data.parseContextId=parseContextId;window.__zspParseContext={parseContextId,userId:parsedUserId,route:parsedRoute,date:data.date||'',vehicle:data.vehicle||'',totalWeight:data.totalWeight||'',stores:parsedOrders.map(item=>({...item}))};pendingMeta={parseContextId,userId:parsedUserId,route:parsedRoute,date:data.date||pendingMeta.date||'',vehicle:data.vehicle||pendingMeta.vehicle||'',totalWeight:data.totalWeight||pendingMeta.totalWeight||'',rawOrderCount:Number(data.rawOrderCount)||0,matchedCount:Number(data.matchedCount)||0,newStoreCount:Number(data.newStoreCount)||0,reviewCount:Number(data.reviewCount)||0,duplicateCount:Number(data.duplicateCount)||0,recognizedCount:Number(data.recognizedCount)||0,uniqueStoreCount:Number(data.uniqueStoreCount)||parsedOrders.length,baseDatabaseAvailable:data.baseDatabaseAvailable!==false,source:source||'web-confirm'};const uniqueCount=Number(data.uniqueStoreCount)||parsedOrders.length;const rawCount=Number(data.recognizedCount)||Number(data.rawOrderCount)||parsedOrders.length;if(taskId&&!isUploadTaskActive(taskId))return[];// 解析结果保留OCR/人工原文，不再把结构化摘要回写到输入框；这样用户可直接核对并修改原文，修改后由输入监听使当前解析结果失效并重新处理。\nwindow.onOrderParsed?.(data);reviewMode=true;
if(parsedOrders.length){
  let mergeCount=0,correctionCount=0;
  const newStoreCount=Number(data?.newStoreCount)||parsedOrders.filter(item=>item?.isNew===true||item?.matchType==='new').length;
  const mergeLines=[],correctionLines=[];
  parsedOrders.forEach(item=>{
    const baseName=String(item?.baseName||item?.name||'').trim();
    const rawNames=[...new Set((Array.isArray(item?.rawNames)?item.rawNames:[]).map(value=>String(value).trim()).filter(Boolean))];
    if(item?.matched&&rawNames.length>1){
      mergeCount++;
      mergeLines.push(`合并名称：${rawNames.join('、')} → ${baseName||item.name}`);
    }
    // 已合并的多条原始名称只归入“合并”，不再重复计入“更正”。
    // 只统计实质名称变化；OCR换行、空格、括号/标点差异不计入“更正”。
    if(rawNames.length<=1&&item?.matched&&baseName&&rawNames.some(value=>value!==baseName)){
      const changedNames=rawNames.filter(value=>value!==baseName);
      // “更正”只统计业务名称变化。OCR造成的空格、换行、全半角标点、
      // 中英文括号、常见罗马数字/字母误识别等，只属于识别格式差异，不计入名称更正。
      const normalizeForCompare=value=>{
        const romanMap={ 'Ⅰ':'I','Ⅱ':'II','Ⅲ':'III','Ⅳ':'IV','Ⅴ':'V','Ⅵ':'VI','Ⅶ':'VII','Ⅷ':'VIII','Ⅸ':'IX','Ⅹ':'X' };
        return String(value||'')
          .normalize('NFKC')
          .replace(/[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]/g,roman=>romanMap[roman]||roman)
          .replace(/((?:ii|iii|iv|v|vi|vii|viii|ix|x))l(?=类)/gi,'$1')
          .replace(/[\s\u3000，,。；;：:（）()【】\[\]<>《》“”"'‘’·、\/\\_-]/g,'')
          .toLowerCase();
      };
      const substantive=changedNames.filter(value=>normalizeForCompare(value)!==normalizeForCompare(baseName));
      if(substantive.length){
        correctionCount++;
        // 修正详情只清理OCR残留在名称末尾的连接符，不改变原始名称及匹配数据。
        const displayCorrectionNames=substantive.map(value=>String(value).trim().replace(/\\s*[-—–]+\\s*$/,'').trim()).filter(Boolean);
        correctionLines.push(`更正名称：${(displayCorrectionNames.length?displayCorrectionNames:substantive).join('、')} → ${baseName}`);
      }
    }
  });
  const rawWeight=String(data?.totalWeight||'').trim();
  const weightT=parseWeight(rawWeight);
  const resultWeight=weightT>0?`${(Math.round((weightT+Number.EPSILON)*100)/100).toFixed(2)}t`:'未识别';
  const resultDate=String(data?.date||pendingMeta.date||currentDate()).trim();
  correctionDetails=[...correctionLines,...mergeLines];
  correctionStats={raw:rawCount,corrected:correctionCount,merged:mergeCount};
  setCorrectionSummary(1);
  const statusDetails=[];
  if(newStoreCount>0)statusDetails.push(`新增${newStoreCount}家`);
  if(correctionCount>0)statusDetails.push(`更正${correctionCount}家`);
  if(mergeCount>0)statusDetails.push(`合并${mergeCount}家`);
  pendingReviewCount=parsedOrders.filter(item=>item?.needsReview===true).length;
  statusBaseDetails=statusDetails.slice();
  const structuredStatus={left:resultDate,right:`${uniqueCount}家 · ${resultWeight}`,compact:true,details:[...statusBaseDetails,...(pendingReviewCount>0?[`待定${pendingReviewCount}家`]:[])]};
  window.renderUnifiedStatus('success',100,structuredStatus);
  window.renderStatusDetail?.(structuredStatus.details);
}else{window.clearStatusDetail?.();correctionDetails=[];correctionStats={raw:0,corrected:0,merged:0};statusBaseDetails=[];pendingReviewCount=0;setCorrectionSummary(0);}
if(parsedOrders.length){setPrimaryActionMode('confirm');if(pendingReviewCount>0){const reviewButton=$('primaryActionBtn');if(reviewButton){reviewButton.hidden=false;reviewButton.setAttribute('aria-hidden','false');reviewButton.textContent=`确认待定门店（${pendingReviewCount}）`;reviewButton.classList.add('ready');reviewButton.onclick=()=>window.openPendingReview?.();}}}return parsedOrders}catch(e){if(taskId&&!isUploadTaskActive(taskId))return[];parsedOrders=[];reviewMode=false;setPrimaryActionMode('error');window.onOrderParsed?.({stores:[]});if(e?.code==='PARSE_CANCELLED'){window.renderUnifiedStatus('cancelled',0,'已取消');return[]}window.renderUnifiedStatus('error',0,e.message||'处理失败，请重试');return[]}};
async function refreshHomeOrder(){
  const seq=++homeOrderLoadSeq;
  const route=String(currentRoute()||'').trim();
  try{
    const order=await loadServerOrder(currentDate(),route);
    if(seq!==homeOrderLoadSeq||String(currentRoute()||'').trim()!==route)return;
    serverOrder=order;
    updateSummary();
  }catch(e){
    if(seq!==homeOrderLoadSeq||String(currentRoute()||'').trim()!==route)return;
    console.error('刷新当日任务失败',e);
  }
}
document.addEventListener('DOMContentLoaded',async()=>{try{if(typeof Auth==='undefined')throw Error('Auth 未加载');
if(!(await Auth.checkAuth()))return;const me=await Auth.getCurrentServerUser();if(me?.adminLevel==='primary'){location.replace('admin.html');return;}await loadDispatchRoutes();ensureConfirmModule().catch(()=>{});const initialSeq=++homeOrderLoadSeq;const initialRoute=String(currentRoute()||'').trim();const loaded=await loadServerOrder(currentDate(),initialRoute);if(initialSeq===homeOrderLoadSeq&&String(currentRoute()||'').trim()===initialRoute){serverOrder=loaded;updateSummary()}$('manualOrderInput')?.addEventListener('input',function(){if(reviewMode){reviewMode=false;parsedOrders=[];statusBaseDetails=[];pendingReviewCount=0;setPrimaryActionMode('idle');window.onOrderParsed?.({stores:[]});window.renderUnifiedStatus('idle',0,'订单信息已修改，请重新上传运单')}});document.addEventListener('click',event=>{const menu=$('homeMenu'),button=document.querySelector('.menu-btn');if(menu&&menu.style.display==='block'&&!menu.contains(event.target)&&!button?.contains(event.target))menu.style.display='none'})}catch(e){console.error('首页初始化失败',e);error(e.message||'首页初始化失败')}});
window.addEventListener('pageshow',event=>{document.body.classList.remove('is-leaving');const menu=$('homeMenu');if(menu)menu.style.display='none';const overlay=$('uploadOverlay');if(event.persisted)window.clearManualInput?.();if(overlay)overlay.classList.remove('active');closeUploadSource();if(event.persisted&&typeof Auth!=='undefined')refreshHomeOrder()});
})();
