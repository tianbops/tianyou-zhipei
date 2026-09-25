/* 天友智配One - 首页业务逻辑 */
(function(){
'use strict';

let parsedOrders=[],serverOrder=null,pendingMeta={},reviewMode=false;
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
function parseWeightFromText(text){const source=String(text||'').replace(/\s+/g,' ');const match=source.match(/(?:总\s*重\s*量|总重|重量)\s*[:：]?\s*([\d,]+(?:\.\d+)?)\s*(kg|千克|公斤|吨|t)?/i)||source.match(/([\d,]+(?:\.\d+)?)\s*(kg|千克|公斤|吨|t)\b/i);return match?`${match[1]}${match[2]||''}`:''}
function parseDateFromText(text){const match=String(text||'').match(/(20\d{2})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*日?/);return match?`${match[1]}-${String(match[2]).padStart(2,'0')}-${String(match[3]).padStart(2,'0')}`:''}
function parseVehicleFromText(text){const match=String(text||'').match(/(?:车牌号\s*[:：]?\s*)?(渝\s*[A-Z0-9]{5,7})/i);return match?match[1].replace(/\s+/g,'').toUpperCase():''}
function cleanFallbackStore(value){return String(value||'').replace(/^\s*[\d０-９]+\s*[、.．)）-]+\s*/,'').replace(/^\s*[|｜]+|[|｜]+\s*$/g,'').replace(/\s+/g,' ').trim()}
function isFallbackStore(value){const text=cleanFallbackStore(value),compact=text.replace(/\s/g,'');if(!text||text.length<3||!/[\u4e00-\u9fff]/.test(text))return false;if(/^(?:运单列表|运输日期|车牌号|额定载重|额定装载|额定体积|主司机|送货员|承运订单|总数量|总重量|总体积|订单编号|运单编号|车辆信息|配送信息)/.test(compact))return false;if(/^(?:20\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2}日?|渝[A-Z0-9]{5,7})$/.test(compact))return false;return true}
function fallbackStoresFromText(text){
  let source=String(text||'').replace(/\r\n?/g,'\n')
    .replace(/[＞》➜➤⇒↦→]/g,'->')
    .replace(/[-﹣－—–]\s*\n?\s*[>＞]/g,'->')
    .replace(/-\s*>/g,'->')
    .replace(/(?<!-)\s*>\s*(?=[\u4e00-\u9fffA-Za-z0-9])/g,'->')
    .replace(/\s*->\s*/g,'->')
    .replace(/[｜]/g,'|');
  const carrier=source.lastIndexOf('承运订单');
  if(carrier>=0)source=source.slice(carrier+'承运订单'.length);
  const lines=source.split('\n').map(line=>line.trim()).filter(Boolean);
  const merged=[];
  for(let i=0;i<lines.length;i++){
    let current=lines[i];
    while(i+1<lines.length){
      const open=(current.match(/[（(\[【]/g)||[]).length;
      const close=(current.match(/[）)\]】]/g)||[]).length;
      const next=lines[i+1];
      if(open<=close && !/^[）)\]】]/.test(next))break;
      current+=next;i++;
      if(open<=close)break;
    }
    merged.push(current);
  }
  const prepared=merged.join('\n');
  const clean=value=>cleanFallbackStore(String(value||'')
    .replace(/(?:总数量|总重量|总体积)\s*[:：]?\s*[\d,.]+\s*(?:kg|KG|千克|公斤|吨|t|m³|m3|m²|m2|立方米)?(?:\s*\([^)]*\))?/gi,' ')
    .replace(/(?:订单编号|运单编号)\s*[:：]?\s*ZW[\w-]+/gi,' ')
    .replace(/(?:车牌号|运输日期|主司机|送货员|额定载重|额定体积)\s*[:：]?\s*[^|]+(?=\||$)/gi,' '));
  const candidates=[];
  candidates.push(...prepared.replace(/\s+/g,' ').split('->').map(clean).filter(isFallbackStore));
  candidates.push(...prepared.split('\n').filter(line=>!/->/.test(line)).map(clean).filter(isFallbackStore));
  candidates.push(...prepared.split(/[|｜]/).filter(part=>!/->/.test(part)).map(clean).filter(isFallbackStore));
  const stores=[],seen=new Set();
  for(const name of candidates){
    const key=name.replace(/\s/g,'').toLowerCase();
    if(seen.has(key))continue;
    seen.add(key);
    stores.push({code:String(stores.length+1).padStart(2,'0'),name,nav:'',note:'',weight:0,isNew:false,matched:false,needsReview:false,matchType:'raw-order',matchScore:0,rawName:name,rawNames:[name]});
  }
  return stores;
}
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
      throw Object.assign(new Error(message||`运单处理接口错误（${response.status}）`),{code:String(data?.code||'PARSE_FAILED'),stage:String(data?.stage||'parse')});
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

window.openUploadSource=()=>{const menu=$('uploadSourceMenu');if(menu){menu.classList.add('active');menu.setAttribute('aria-hidden','false');}};
window.closeUploadSource=()=>{const menu=$('uploadSourceMenu');if(menu){menu.classList.remove('active');menu.setAttribute('aria-hidden','true')}};
window.resetUploadSession=()=>{
  // 失败返回按钮的唯一业务出口：一次性释放当前上传会话，不依赖 history、定时器、query 或 sessionStorage。
  try{window.clearManualInput?.();}catch(error){console.warn('清理上传会话失败',error);}
  try{document.body.classList.remove('zpei-processing','is-leaving','navigating-to-order');}catch(_){}
  const overlay=$('uploadOverlay');
  const menu=$('uploadSourceMenu');
  if(overlay)overlay.classList.add('active');
  if(menu){menu.classList.add('active');menu.setAttribute('aria-hidden','false');}
  window.resetProcessingStatus?.();
};
window.cancelUpload=()=>{
  const overlay=$('uploadOverlay');
  if(overlay)overlay.classList.remove('active');
  window.closeUploadSource?.();
  try{window.clearManualInput?.();}catch(e){console.warn('清理上传状态失败',e);}
};
window.toggleUpload=()=>{
  const overlay=$('uploadOverlay');
  if(!overlay)return;
  const opening=!overlay.classList.contains('active');
  if(opening){
    overlay.classList.add('active');
    window.renderUnifiedStatus?.('idle',0,'');
    window.openUploadSource?.();
  }else{
    window.cancelUpload?.();
  }
};
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
window.clearManualInput=()=>{invalidateUploadTask();correctionDetails=[];setCorrectionSummary(0);window.__zspParseContext=null;if(parseAbortController){parseCancelled=true;parseAbortController.abort();}if(typeof window.cancelOCR==='function')window.cancelOCR().catch(()=>{});window.cancelConfirm?.();const input=$('manualOrderInput');if(input){input.value='';input.setAttribute('placeholder','上传运单后，这里显示识别文字，请核对识别结果。')}['ocrCameraInput','ocrAlbumInput','ocrFileInput'].forEach(id=>{const fileInput=$(id);if(fileInput)fileInput.value='';});parsedOrders=[];pendingMeta={};reviewMode=false;window.resetProcessingStatus?.();window.renderReviewStores?.([]);closeUploadDetail?.();};
window.parseManualInput=async(options={})=>{
 const auto=options?.auto===true,source=String(options?.source||'manual'),taskId=Number(options?.taskId)||ensureUploadTask();
 if(taskId&&!isUploadTaskActive(taskId))return[];
 if(parseInFlight)return auto?[]:toast('运单正在处理，请勿重复操作','warning');
 const text=$('manualOrderInput')?.value||'';
 if(!text.trim()){if(auto)window.renderUnifiedStatus('error',0,'未识别到运单文字，请重试');else toast('请先输入或识别运单文字','warning');return[];}
 parseInFlight=true;parseCancelled=false;parseAbortController=new AbortController();
 try{
  window.renderUnifiedStatus('loading',45,'正在规划线路…');
  const route=currentRoute();if(!route)throw Object.assign(new Error('未指定配送线路'),{code:'ROUTE_REQUIRED'});
  const body={route,date:parseDateFromText(text)||currentDate(),vehicle:parseVehicleFromText(text),totalWeight:parseWeightFromText(text),text};
  const planner=window.WaybillPlanner;
  if(!planner)throw Object.assign(new Error('自动规划模块未加载'),{code:'PLANNER_UNAVAILABLE'});
  const plannerTask=await planner.run({ocrText:text,waybill:{route,date:parseDateFromText(text)||currentDate(),vehicle:parseVehicleFromText(text),totalWeight:parseWeightFromText(text)}});
  if(!plannerTask?.result)throw Object.assign(new Error('自动规划未返回结果'),{code:'PLAN_EMPTY'});
  const result=plannerTask.result;parsedOrders=Array.isArray(result.stores)?result.stores:[];
  if(!parsedOrders.length&&!Array.isArray(result.pendingStores))throw Object.assign(new Error('未识别到有效门店'),{code:'EXTRACT_FAILED'});
  const parsedRoute=String(result.route||route).trim();if(parsedRoute&&Auth.setDispatchRoute)Auth.setDispatchRoute(parsedRoute);
  pendingMeta={parseContextId:plannerTask.id,userId:String(Auth.serverUser?.id||''),route:parsedRoute,date:result.date||body.date,vehicle:result.vehicle||body.vehicle,totalWeight:result.totalWeight||body.totalWeight,rawOrderCount:Number(result.rawCount)||0,matchedCount:parsedOrders.length,newStoreCount:Array.isArray(result.newStores)?result.newStores.length:0,reviewCount:Array.isArray(result.pendingStores)?result.pendingStores.length:0,duplicateCount:Number(result.merged)||0,recognizedCount:Number(result.rawCount)||0,uniqueStoreCount:Number(result.totalStores)||parsedOrders.length,baseDatabaseAvailable:true,source};
  window.__zspParseContext={...pendingMeta,stores:parsedOrders};
  reviewMode=true;window.renderUnifiedStatus('success',100,'规划完成');window.onOrderParsed?.({success:true,...result,stores:parsedOrders});
  return parsedOrders;
 }catch(e){
  if(e?.name==='AbortError'||e?.code==='PARSE_CANCELLED'){window.renderUnifiedStatus('cancelled',0,'已取消');return[];}
  window.handleUploadProcessingFailure?.(e.message||'规划失败，请重新上传',e.code||'PLAN_FAILED');if(auto)throw e;return[];
 }finally{parseAbortController=null;parseInFlight=false;}
};

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
if(!(await Auth.checkAuth()))return;
const me=await Auth.getCurrentServerUser();if(me?.adminLevel==='primary'){location.replace('admin.html');return;}
await loadDispatchRoutes();ensureConfirmModule().catch(()=>{});const initialSeq=++homeOrderLoadSeq;const initialRoute=String(currentRoute()||'').trim();const loaded=await loadServerOrder(currentDate(),initialRoute);if(initialSeq===homeOrderLoadSeq&&String(currentRoute()||'').trim()===initialRoute){serverOrder=loaded;updateSummary()}$('manualOrderInput')?.addEventListener('input',function(){if(reviewMode){reviewMode=false;parsedOrders=[];window.onOrderParsed?.({stores:[]});window.renderUnifiedStatus('idle',0,'订单信息已修改，请重新上传运单')}});document.addEventListener('click',event=>{const menu=$('homeMenu'),button=document.querySelector('.menu-btn');if(menu&&menu.style.display==='block'&&!menu.contains(event.target)&&!button?.contains(event.target))menu.style.display='none'})}catch(e){console.error('首页初始化失败',e);error(e.message||'首页初始化失败')}});
window.addEventListener('pageshow',event=>{document.body.classList.remove('is-leaving');const menu=$('homeMenu');if(menu)menu.style.display='none';if(event.persisted){const overlay=$('uploadOverlay');window.clearManualInput?.();if(overlay)overlay.classList.remove('active');closeUploadSource();if(typeof Auth!=='undefined')refreshHomeOrder()}});
})();
