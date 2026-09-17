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
function currentRoute(){return Auth.getCurrentRoute()}
async function loadServerOrder(date=''){const route=currentRoute();if(!route)throw Error('未指定配送线路');const params=new URLSearchParams();if(date)params.set('date',date);const query=params.toString();const response=await fetch(`/api/orders${query?`?${query}`:''}`,{cache:'no-store',credentials:'same-origin'});if(!response.ok)throw Error(response.status===401?'登录已失效，请重新登录':`当日订单读取失败（${response.status}）`);const data=await response.json();serverOrder=data?.today||null;return serverOrder}
function parseWeight(value){if(value===null||value===undefined||value==='')return 0;const text=String(value).trim().replace(/,/g,'');const match=text.match(/[\d]+(?:\.\d+)?/);if(!match)return 0;const n=Number(match[0]);if(!Number.isFinite(n))return 0;const tons=/吨|\bt\b/i.test(text)?n:/kg|千克|公斤/i.test(text)?n/1000:n>=1000?n/1000:n;return Number.isFinite(tons)?tons:0}
function formatWeight(value){const tons=parseWeight(value);if(!(tons>0))return '暂无数据';const precise=Math.round((tons+Number.EPSILON)*1000000)/1000000;return `${precise.toFixed(6).replace(/0+$/,'').replace(/\.$/,'')}t`}
function updateSummary(){
  // 当天没有订单时：保留“当日任务”卡片，只清空门店数量和重量，不隐藏整张卡片。
  const hasToday=!!serverOrder&&Array.isArray(serverOrder.orders)&&serverOrder.orders.length>0;
  const route=serverOrder?.route||currentRoute()||'';
  const vehicle=serverOrder?.vehicle||'';
  if($('taskCard'))$('taskCard').style.display='block';
  if($('menuRoute'))$('menuRoute').textContent=route||'未选择线路';
  if(!hasToday){
    if($('homeRoute'))$('homeRoute').textContent='';
    if($('storeCount'))$('storeCount').textContent='';
    if($('totalWeight'))$('totalWeight').textContent='';
    if($('statusDot'))$('statusDot').style.background='#5A6A7A';
    return;
  }
  const orders=serverOrder.orders;
  const count=Number(serverOrder.uniqueStoreCount||serverOrder.count)||orders.length;
  if($('homeRoute'))$('homeRoute').textContent=vehicle?`🚚 ${vehicle}`:`🚚 ${route}`;
  if($('storeCount'))$('storeCount').textContent=count?`${count}家`:'暂无当日订单';
  if($('totalWeight'))$('totalWeight').textContent=formatWeight(serverOrder.totalWeight);
  if($('statusDot'))$('statusDot').style.background=count?'#27AE60':'#5A6A7A';
}
function renderStatus(status,count=0,message=''){const box=$('parseStatus');if(!box)return;box.classList.add('active');if($('statusIcon'))$('statusIcon').textContent=status==='success'?'✅':status==='error'?'⚠️':'⏳';if($('statusText'))$('statusText').textContent=message||(status==='success'?'处理完成':status==='error'?'处理失败':'正在处理...');if($('progressBar'))$('progressBar').style.width=status==='success'||status==='error'?'100%':'50%';if($('statusCount'))$('statusCount').textContent=count?`解析得到 ${count} 条原始门店记录`:''}
function setOCRText(text){const input=$('manualOrderInput');if(!input)return false;const value=String(text??'').replace(/\r\n/g,'\n').replace(/\r/g,'\n');input.value=value;input.removeAttribute('placeholder');input.dispatchEvent(new Event('input',{bubbles:true}));if($('charCount'))$('charCount').textContent=String(value.length);input.scrollTop=0;return !!value.trim()}
function setReviewText(data){const input=$('manualOrderInput');if(!input)return false;const stores=Array.isArray(data?.stores)?data.stores:[];const route=data?.route||currentRoute()||'';const date=data?.date||pendingMeta.date||currentDate();const vehicle=data?.vehicle||pendingMeta.vehicle||'';const totalWeight=data?.totalWeight||pendingMeta.totalWeight||'';const uniqueCount=Number(data?.uniqueStoreCount)||stores.length;const rawCount=Number(data?.recognizedCount)||Number(data?.rawOrderCount)||stores.length;const lines=[`【当日订单信息】`,`日期：${date}`,`线路：${route}`,`车辆：${vehicle||'未识别'}`,`原始门店记录：${rawCount}条`,`唯一门店：${uniqueCount}家`,`总重量：${totalWeight||'未识别'}`,'',`【门店列表】`];stores.forEach((item,index)=>{const prefix=String(index+1).padStart(2,'0');const mark=item?.isNew?'⚠️ 新增：':'';const review=item?.needsReview?'⚠️ 待确认：':'';lines.push(`${prefix}. ${mark||review}${storeName(item)}`)});const value=lines.join('\n');reviewMode=true;input.value=value;input.removeAttribute('placeholder');if($('charCount'))$('charCount').textContent=String(value.length);input.scrollTop=0;return true}
async function parseOrderText(text){const route=currentRoute();if(!route)throw Error('未指定配送线路');const response=await fetch('/api/parse',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text,route}),credentials:'same-origin',cache:'no-store'});const data=await response.json().catch(()=>({}));if(!response.ok||!data.success)throw Error(data.error||`解析接口错误（${response.status}）`);return data.data}
window.toggleUpload=()=>{const overlay=$('uploadOverlay');if(overlay)overlay.classList.toggle('active')};
window.openHomeMenu=()=>{const menu=$('homeMenu');if(menu)menu.style.display=menu.style.display==='block'?'none':'block'};
window.goToRouteEdit=()=>{window.location.href='pages/route_edit.html'};
window.goToOrderDetail=()=>{window.location.href='pages/order_detail.html'};
window.goToHistory=()=>{window.location.href='pages/history.html'};
window.logout=()=>Auth.logout();
window.clearManualInput=()=>{const input=$('manualOrderInput');if(input){input.value='';input.setAttribute('placeholder','上传图片后，这里显示识别文字。请核对后再开始解析，也可直接粘贴运单文字.')}if($('charCount'))$('charCount').textContent='0';parsedOrders=[];pendingMeta={};reviewMode=false;renderStatus('idle');window.renderReviewStores?.([])};
window.pasteFromClipboard=async()=>{try{const text=await navigator.clipboard.readText();setOCRText(text);pendingMeta={};reviewMode=false}catch(_){toast('无法读取剪贴板，请手动粘贴','warning')}};
window.parseManualInput=async()=>{try{const text=$('manualOrderInput')?.value||'';if(!text.trim())return toast('请先输入或识别运单文字','warning');renderStatus('loading',0,'正在提取门店并与基准库比对...');const data=await parseOrderText(text);parsedOrders=Array.isArray(data.stores)?data.stores:[];pendingMeta={date:data.date||pendingMeta.date||'',vehicle:data.vehicle||pendingMeta.vehicle||'',totalWeight:data.totalWeight||pendingMeta.totalWeight||'',rawOrderCount:Number(data.rawOrderCount)||0,matchedCount:Number(data.matchedCount)||0,newStoreCount:Number(data.newStoreCount)||0,reviewCount:Number(data.reviewCount)||0,duplicateCount:Number(data.duplicateCount)||0,recognizedCount:Number(data.recognizedCount)||0,uniqueStoreCount:Number(data.uniqueStoreCount)||parsedOrders.length,source:'web-confirm'};const uniqueCount=Number(data.uniqueStoreCount)||parsedOrders.length;const rawCount=Number(data.recognizedCount)||Number(data.rawOrderCount)||parsedOrders.length;const message=parsedOrders.length?`解析完成：${uniqueCount} 家唯一门店（${rawCount} 条原始记录）${data.newStoreCount?`，新增 ${data.newStoreCount} 家`:''}${data.duplicateCount?`，合并重复 ${data.duplicateCount} 条`:''}`:'没有识别到有效门店';renderStatus(parsedOrders.length?'success':'error',rawCount,message);window.onOrderParsed?.(data);setReviewText(data);if(data.warning)toast(data.warning,'warning');return parsedOrders}catch(e){parsedOrders=[];reviewMode=false;window.onOrderParsed?.({stores:[]});renderStatus('error',0,e.message);toast(e.message||'解析失败','warning');error(e.message||'解析失败');return[]}};
async function refreshHomeOrder(){try{await loadServerOrder(currentDate());updateSummary()}catch(e){console.error('刷新当日任务失败',e)}}
document.addEventListener('DOMContentLoaded',async()=>{try{if(typeof Auth==='undefined')throw Error('Auth 未加载');if(!(await Auth.checkAuth()))return;await loadServerOrder(currentDate());updateSummary();$('manualOrderInput')?.addEventListener('input',function(){if($('charCount'))$('charCount').textContent=String(this.value.length);if(reviewMode){reviewMode=false;parsedOrders=[];window.onOrderParsed?.({stores:[]});renderStatus('idle',0,'订单信息已修改，请重新点击“开始解析”')}});document.addEventListener('click',event=>{const menu=$('homeMenu'),button=document.querySelector('.menu-btn');if(menu&&menu.style.display==='block'&&!menu.contains(event.target)&&!button?.contains(event.target))menu.style.display='none'})}catch(e){console.error(e);error(e.message||'首页初始化失败')}});
window.addEventListener('pageshow',()=>{if(typeof Auth!=='undefined')refreshHomeOrder()});
})();
