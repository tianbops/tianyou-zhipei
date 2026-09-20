/* 天友智配One - 首页业务逻辑 */
(function(){
'use strict';
let parsedOrders=[],serverOrder=null,pendingMeta={},reviewMode=false,primaryActionMode='plan';
const $=id=>document.getElementById(id);
function toast(message,type=''){let el=$('homeToast');if(!el){el=document.createElement('div');el.id='homeToast';el.className='toast';document.body.appendChild(el)}el.textContent=message;el.className=`toast show ${type}`;clearTimeout(toast.timer);toast.timer=setTimeout(()=>el.classList.remove('show'),2800)}
window.homeToast=toast;
function error(message){const box=$('error-box');if(!box)return;box.textContent='页面错误：'+message;box.classList.add('show');setTimeout(()=>box.classList.remove('show'),5000)}
function currentDate(){return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date())}
function storeName(store){return String(store?.name||store?.storeName||store?.shopName||'').trim()}
function currentRoute(){return Auth.getCurrentRoute()}
async function loadServerOrder(date=''){const route=currentRoute();if(!route)throw Error('未指定配送线路');const params=new URLSearchParams();if(date)params.set('date',date);const query=params.toString();const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),10000);try{const response=await fetch(`/api/orders${query?`?${query}`:''}`,{cache:'no-store',credentials:'same-origin',signal:controller.signal});if(!response.ok)throw Error(response.status===401?'登录已失效，请重新登录':`当日订单读取失败（${response.status}）`);const data=await response.json();serverOrder=data?.today||null;return serverOrder}catch(error){if(error?.name==='AbortError')throw Error('当日任务读取超时，请稍后重试');throw error}finally{clearTimeout(timer)}}
function parseWeight(value){if(value===null||value===undefined||value==='')return 0;const text=String(value).trim().replace(/,/g,'');const match=text.match(/[\d]+(?:\.\d+)?/);if(!match)return 0;const n=Number(match[0]);if(!Number.isFinite(n))return 0;const tons=/吨|\bt\b/i.test(text)?n:/kg|千克|公斤/i.test(text)?n/1000:n>=1000?n/1000:n;return Number.isFinite(tons)?tons:0}
function formatWeight(value){const tons=parseWeight(value);if(!(tons>0))return '暂无数据';const precise=Math.round((tons+Number.EPSILON)*1000000)/1000000;return `${precise.toFixed(6).replace(/0+$/,'').replace(/\.$/,'')}t`}
function updateSummary(){const hasToday=!!serverOrder&&Array.isArray(serverOrder.orders)&&serverOrder.orders.length>0;const route=serverOrder?.route||currentRoute()||'';const vehicle=serverOrder?.vehicle||'';if($('taskCard'))$('taskCard').style.display='block';if($('menuRoute'))$('menuRoute').textContent=route||'未选择线路';if(!hasToday){if($('homeRoute'))$('homeRoute').textContent='';if($('storeCount'))$('storeCount').textContent='';if($('totalWeight'))$('totalWeight').textContent='';if($('statusDot'))$('statusDot').style.background='#5A6A7A';return}const orders=serverOrder.orders;const count=Number(serverOrder.uniqueStoreCount||serverOrder.count)||orders.length;if($('homeRoute'))$('homeRoute').textContent=vehicle?`🚚 ${vehicle}`:`🚚 ${route}`;if($('storeCount'))$('storeCount').textContent=count?`${count}家`:'暂无当日订单';if($('totalWeight'))$('totalWeight').textContent=formatWeight(serverOrder.totalWeight);if($('statusDot'))$('statusDot').style.background=count?'#27AE60':'#5A6A7A'}
function setOCRText(text){const input=$('manualOrderInput');if(!input)return false;const value=String(text??'').replace(/\r\n/g,'\n').replace(/\r/g,'\n');input.value=value;input.removeAttribute('placeholder');input.dispatchEvent(new Event('input',{bubbles:true}));input.scrollTop=0;return !!value.trim()}
function setReviewText(data){const input=$('manualOrderInput');if(!input)return false;const stores=Array.isArray(data?.stores)?data.stores:[];const route=data?.route||currentRoute()||'';const date=data?.date||pendingMeta.date||currentDate();const vehicle=data?.vehicle||pendingMeta.vehicle||'';const totalWeight=data?.totalWeight||pendingMeta.totalWeight||'';const uniqueCount=Number(data?.uniqueStoreCount)||stores.length;const rawCount=Number(data?.recognizedCount)||Number(data?.rawOrderCount)||stores.length;const noBase=data?.baseDatabaseAvailable===false;const lines=[`【当日订单信息】`,`日期：${date}`,`线路：${route}`,`车辆：${vehicle||'未识别'}`,noBase?'基准库：⚠️ 未建立，以下按本次运单识别顺序显示':`原始门店记录：${rawCount}条`,`唯一门店：${uniqueCount}家`,`总重量：${totalWeight||'未识别'}`,'',`【门店列表】`];stores.forEach((item,index)=>{const prefix=String(index+1).padStart(2,'0');const mark=noBase?'':item?.isNew?'⚠️ 新增：':'';const review=noBase?'':item?.needsReview?'⚠️ 待确认：':'';lines.push(`${prefix}. ${mark||review}${storeName(item)}`)});const value=lines.join('\n');reviewMode=true;input.value=value;input.removeAttribute('placeholder');input.scrollTop=0;return true}
function parseWeightFromText(text){const source=String(text||'').replace(/\s+/g,' ');const match=source.match(/(?:总\s*重\s*量|总重|重量)\s*[:：]?\s*([\d,]+(?:\.\d+)?)\s*(kg|千克|公斤|吨|t)?/i)||source.match(/([\d,]+(?:\.\d+)?)\s*(kg|千克|公斤|吨|t)\b/i);return match?`${match[1]}${match[2]||''}`:''}
function parseDateFromText(text){const match=String(text||'').match(/(20\d{2})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*日?/);return match?`${match[1]}-${String(match[2]).padStart(2,'0')}-${String(match[3]).padStart(2,'0')}`:''}
function parseVehicleFromText(text){const match=String(text||'').match(/(?:车牌号\s*[:：]?\s*)?(渝\s*[A-Z0-9]{5,7})/i);return match?match[1].replace(/\s+/g,'').toUpperCase():''}
function cleanFallbackStore(value){return String(value||'').replace(/^\s*[\d０-９]+\s*[、.．)）-]+\s*/,'').replace(/^\s*[|｜]+|[|｜]+\s*$/g,'').replace(/\s+/g,' ').trim()}
function isFallbackStore(value){const text=cleanFallbackStore(value),compact=text.replace(/\s/g,'');if(!text||text.length<3||!/[\u4e00-\u9fff]/.test(text))return false;if(/^(?:运单列表|运输日期|车牌号|额定载重|额定装载|额定体积|主司机|送货员|承运订单|总数量|总重量|总体积|订单编号|运单编号|车辆信息|配送信息)/.test(compact))return false;if(/^(?:20\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2}日?|渝[A-Z0-9]{5,7})$/.test(compact))return false;return true}
function fallbackStoresFromText(text){let source=String(text||'').replace(/\r\n?/g,'\n').replace(/[＞》➜➤⇒↦→]/g,'->').replace(/\s*->\s*/g,'->');const carrier=source.lastIndexOf('承运订单');if(carrier>=0)source=source.slice(carrier+'承运订单'.length);const parts=source.includes('->')?source.replace(/\s+/g,' ').split('->'):source.split('\n');const stores=[],seen=new Set();for(const part of parts){let name=cleanFallbackStore(part).replace(/(?:总数量|总重量|总体积|订单编号|运单编号|车牌号|运输日期|主司机|送货员|额定载重|额定体积)\s*[:：]?[^\n]*/gi,' ').trim();if(!isFallbackStore(name))continue;const key=name.replace(/\s/g,'').toLowerCase();if(seen.has(key))continue;seen.add(key);stores.push({code:String(stores.length+1).padStart(2,'0'),name,nav:'',note:'',weight:0,isNew:false,matched:false,needsReview:false,matchType:'raw-order',matchScore:0,rawName:name,rawNames:[name]})}return stores}
function fallbackParse(text){const stores=fallbackStoresFromText(text);if(!stores.length)throw Error('未识别到有效门店，请检查OCR文字后再解析');const totalWeight=parseWeightFromText(text);return{route:currentRoute(),date:parseDateFromText(text)||currentDate(),vehicle:parseVehicleFromText(text),totalWeight,totalVolume:'',rawOrderCount:stores.length,recognizedCount:stores.length,uniqueStoreCount:stores.length,storeCount:stores.length,matchedCount:0,newStoreCount:0,reviewCount:0,duplicateCount:0,learnedCount:0,baseDatabaseAvailable:false,stores,warning:`未找到${currentRoute()}独立基准数据库，本次按运单识别顺序排列`}}
let parseAbortController=null,parseInFlight=false,parseCancelled=false;
async function parseOrderText(text){
  const route=currentRoute();if(!route)throw Error('未指定配送线路');
  if(parseInFlight)throw Error('规划正在进行，请勿重复点击');
  parseInFlight=true;parseCancelled=false;parseAbortController=new AbortController();
  const PARSE_TIMEOUT_MS=120000; // P0测试：门店提取与基准库比对最多等待2分钟
  const timer=setTimeout(()=>parseAbortController?.abort(),PARSE_TIMEOUT_MS);
  try{
    const response=await fetch('/api/parse',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text,route}),credentials:'same-origin',cache:'no-store',signal:parseAbortController.signal});
    const data=await response.json().catch(()=>({}));
    if(!response.ok||!data.success){
      const message=String(data?.error||'');
      if(/未找到.*独立基准数据库/.test(message))return fallbackParse(text);
      throw Error(message||`规划接口错误（${response.status}）`);
    }
    return data.data;
  }catch(e){
    if(e?.name==='AbortError'){
      if(parseCancelled)throw Object.assign(new Error('已取消规划'),{code:'PARSE_CANCELLED'});
      throw Error('规划超过2分钟，请检查网络后重试');
    }
    throw e;
  }finally{
    clearTimeout(timer);parseAbortController=null;parseInFlight=false;
  }
}
window.cancelParse=async()=>{if(parseAbortController){parseCancelled=true;parseAbortController.abort();}const cancelOCR=window.cancelOCR;if(typeof cancelOCR==='function')cancelOCR().catch(()=>{});toast('已取消规划','warning');};

function setPrimaryActionMode(mode){primaryActionMode=mode==='confirm'?'confirm':'plan';const button=$('primaryActionBtn');if(!button)return;button.textContent=primaryActionMode==='confirm'?'确认录入':'规划路线';button.classList.toggle('ready',primaryActionMode==='confirm');button.disabled=false}
window.openUploadSource=()=>{const menu=$('uploadSourceMenu');if(menu){menu.classList.add('active');menu.setAttribute('aria-hidden','false')}}
window.closeUploadSource=()=>{const menu=$('uploadSourceMenu');if(menu){menu.classList.remove('active');menu.setAttribute('aria-hidden','true')}}
window.handlePrimaryAction=async()=>{if(primaryActionMode==='confirm'){if(typeof window.submitManualOrder==='function')return window.submitManualOrder();return}const button=$('primaryActionBtn');if(!button||parseInFlight)return;button.disabled=true;button.textContent='正在规划…';button.classList.remove('ready');try{const stores=await window.parseManualInput?.();if(Array.isArray(stores)&&stores.length)setPrimaryActionMode('confirm');else setPrimaryActionMode('plan')}finally{if(primaryActionMode==='plan')setPrimaryActionMode('plan')}};
window.toggleUpload=()=>{const overlay=$('uploadOverlay');if(overlay)overlay.classList.toggle('active')};
window.openHomeMenu=()=>{const menu=$('homeMenu');if(menu)menu.style.display=menu.style.display==='block'?'none':'block'};
window.goToRouteEdit=()=>{window.location.href='pages/route_edit.html'};
window.goToOrderDetail=()=>{window.location.href='pages/order_detail.html'};
window.goToHistory=()=>{window.location.href='pages/history.html'};
window.logout=()=>Auth.logout();
window.clearManualInput=()=>{if(parseAbortController){parseCancelled=true;parseAbortController.abort();}if(typeof window.cancelOCR==='function')window.cancelOCR().catch(()=>{});const input=$('manualOrderInput');if(input){input.value='';input.setAttribute('placeholder','上传运单后，这里显示识别文字，请核对后规划路线。')}parsedOrders=[];pendingMeta={};reviewMode=false;setPrimaryActionMode('plan');const status=$('parseStatus');if(status){status.classList.remove('active','loading','success','error','cancelled');if($('statusIcon'))$('statusIcon').className='status-icon';if($('statusText'))$('statusText').textContent='等待处理...';if($('statusText')){$('statusText').setAttribute('data-text','等待处理...');$('statusText').style.setProperty('--status-progress','0%')}}window.renderReviewStores?.([])};
window.parseManualInput=async(options={})=>{const auto=options?.auto===true;const source=String(options?.source||'manual');if(parseInFlight)return auto?[]:toast('规划正在进行，请勿重复点击','warning');try{const text=$('manualOrderInput')?.value||'';if(!text.trim()){if(auto)window.renderUnifiedStatus('error',0,'未识别到运单文字，请重试');else toast('请先输入或识别运单文字','warning');return [];}window.renderUnifiedStatus('loading',10,auto?'正在根据运单生成路线…':'正在规划路线…');const data=await parseOrderText(text);window.renderUnifiedStatus('loading',78,'正在生成配送顺序…');parsedOrders=Array.isArray(data.stores)?data.stores:[];pendingMeta={date:data.date||pendingMeta.date||'',vehicle:data.vehicle||pendingMeta.vehicle||'',totalWeight:data.totalWeight||pendingMeta.totalWeight||'',rawOrderCount:Number(data.rawOrderCount)||0,matchedCount:Number(data.matchedCount)||0,newStoreCount:Number(data.newStoreCount)||0,reviewCount:Number(data.reviewCount)||0,duplicateCount:Number(data.duplicateCount)||0,recognizedCount:Number(data.recognizedCount)||0,uniqueStoreCount:Number(data.uniqueStoreCount)||parsedOrders.length,baseDatabaseAvailable:data.baseDatabaseAvailable!==false,source:source||'web-confirm'};const uniqueCount=Number(data.uniqueStoreCount)||parsedOrders.length;const rawCount=Number(data.recognizedCount)||Number(data.rawOrderCount)||parsedOrders.length;const message=parsedOrders.length?`已完成：${uniqueCount} 家门店`:'没有找到可用的门店';window.onOrderParsed?.(data);setReviewText(data);window.renderUnifiedStatus(parsedOrders.length?'success':'error',100,parsedOrders.length?message:'没有识别到有效门店');
const detailLines=[];
if(parsedOrders.length){
  let mergeCount=0,correctionCount=0;
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
        correctionLines.push(`更正名称：${substantive.join('、')} → ${baseName}`);
      }
    }
  });
  if(mergeCount||correctionCount){
    detailLines.push(`信息统计：现在${uniqueCount}家，原始${rawCount}家${mergeCount?`，合并${mergeCount}家`:''}${correctionCount?`，更正${correctionCount}家`:''}`);
    detailLines.push('修改详情');
    if(mergeLines.length)detailLines.push(...mergeLines);
    if(correctionLines.length)detailLines.push(...correctionLines);
    window.renderStatusDetail?.(detailLines);
  }else{
    window.clearStatusDetail?.();
  }
}else{window.clearStatusDetail?.();}
if(parsedOrders.length)setPrimaryActionMode('confirm');return parsedOrders}catch(e){parsedOrders=[];reviewMode=false;setPrimaryActionMode('plan');window.onOrderParsed?.({stores:[]});if(e?.code==='PARSE_CANCELLED'){window.renderUnifiedStatus('cancelled',0,'已取消');return[]}window.renderUnifiedStatus('error',0,e.message||'处理失败，请重试');return[]}};
async function refreshHomeOrder(){try{await loadServerOrder(currentDate());updateSummary()}catch(e){console.error('刷新当日任务失败',e)}}
document.addEventListener('DOMContentLoaded',async()=>{try{if(typeof Auth==='undefined')throw Error('Auth 未加载');if(!(await Auth.checkAuth()))return;await loadServerOrder(currentDate());updateSummary();$('manualOrderInput')?.addEventListener('input',function(){if(reviewMode){reviewMode=false;parsedOrders=[];setPrimaryActionMode('plan');window.onOrderParsed?.({stores:[]});window.renderUnifiedStatus('idle',0,'订单信息已修改，请重新规划')}});document.addEventListener('click',event=>{const menu=$('homeMenu'),button=document.querySelector('.menu-btn');if(menu&&menu.style.display==='block'&&!menu.contains(event.target)&&!button?.contains(event.target))menu.style.display='none'})}catch(e){console.error('首页初始化失败',e);error(e.message||'首页初始化失败')}});
window.addEventListener('pageshow',()=>{const menu=$('homeMenu');if(menu)menu.style.display='none';const overlay=$('uploadOverlay');if(overlay)overlay.classList.remove('active');closeUploadSource();setPrimaryActionMode('plan');if(typeof Auth!=='undefined')refreshHomeOrder()});
})();
