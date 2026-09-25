/* 天友智配One - 当日修正详情：展示指定历史运单保存的真实修正记录 */
(function(){
'use strict';
const $=id=>document.getElementById(id);
let currentRoute='',currentDate='',currentBatch='';
const authHeaders=()=>Auth.getAuthHeaders?Auth.getAuthHeaders():{};
function clean(v){return String(v||'').replace(/[\u3000]/g,' ').replace(/\s+/g,' ').trim()}
function compareKey(v){return clean(v).normalize('NFKC').replace(/[\s\u3000，,。；;：:（）()【】\[\]<>《》“”\"'‘’·\-_/]/g,'').toLowerCase()}
function validCorrection(x){const from=clean(x?.from),to=clean(x?.to);return from&&to&&compareKey(from)!==compareKey(to)}
function fallbackCorrections(record){
  return (Array.isArray(record?.orders)?record.orders:[]).map(x=>{
    const from=clean(x?.rawName||(Array.isArray(x?.rawNames)?x.rawNames[0]:'')),to=clean(x?.baseName||x?.name);
    return validCorrection({from,to})?{storeId:String(x?.storeId||''),code:String(x?.code||''),from,to}:null;
  }).filter(Boolean);
}
function normalizeCorrections(record){
  const saved=Array.isArray(record?.correctionDetails)?record.correctionDetails.filter(validCorrection):[];
  return saved.length?saved:fallbackCorrections(record);
}
async function loadRecord(){
  const r=await fetch('/api/history?date='+encodeURIComponent(currentDate)+'&route='+encodeURIComponent(currentRoute),{cache:'no-store',headers:authHeaders(),credentials:'same-origin'});
  if(!r.ok)throw Error('历史数据服务不可用（'+r.status+'）');
  const payload=await r.json().catch(()=>[]);
  const records=Array.isArray(payload)?payload:(Array.isArray(payload?.data)?payload.data:[]);
  return records.find(x=>String(x?.orderBatchId||'').trim()===currentBatch)||null;
}
function render(record){
  const list=$('correctionList'),items=normalizeCorrections(record);
  $('correctionDate').textContent=record?.date||currentDate;
  $('routeName').textContent=record?.route||currentRoute;
  $('correctionCount').textContent=items.length+'家';
  $('totalWeight').textContent=normalizeWeight(record?.totalWeight??record?.weight??'')||'0t';
  if(!items.length){list.innerHTML='<div class="correction-detail-empty">暂无修正记录</div>';return}
  list.innerHTML=items.map((x,i)=>'<div class="correction-detail-item"><div class="correction-detail-code">'+(String(x.code||'').trim()||String(i+1).padStart(2,'0'))+'</div><div class="correction-detail-name correction-detail-from">'+escapeHtml(x.from)+'</div><div class="correction-detail-arrow">↓</div><div class="correction-detail-name correction-detail-to">'+escapeHtml(x.to)+'</div></div>').join('');
}
function normalizeWeight(v){if(v===null||v===undefined||v==='')return '';const s=String(v).trim().replace(/,/g,''),m=s.match(/[0-9]+(?:\.\d+)?/);if(!m)return '';const n=Number(m[0]);if(!Number.isFinite(n))return '';const tons=/吨|\bt\b/i.test(s)?n:/kg|千克|公斤/i.test(s)?n/1000:n>=1000?n/1000:n;return Number.isFinite(tons)?tons.toFixed(2)+'t':''}
function escapeHtml(v){return String(v??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])}
window.goBack=()=>{if(window.history.length>1)window.history.back();else location.replace('history.html')};
document.addEventListener('DOMContentLoaded',async()=>{
  try{
    if(typeof Auth==='undefined'||!(await Auth.checkAuth()))return;
    const p=new URLSearchParams(location.search);
    currentDate=String(p.get('date')||'').trim();
    currentBatch=String(p.get('orderBatchId')||'').trim();
    const dispatch=Auth.getDispatchRoute?Auth.getDispatchRoute():Auth.getCurrentRoute();
    currentRoute=String(p.get('route')||dispatch||'').trim();
    if(!currentDate||!currentBatch||!currentRoute)throw Error('修正记录参数不完整');
    const record=await loadRecord();
    if(!record)throw Error('未找到对应历史运单');
    render(record);
  }catch(e){
    console.error(e);
    $('correctionList').innerHTML='<div class="correction-detail-empty">'+escapeHtml(e.message||'修正记录读取失败')+'</div>';
    $('correctionCount').textContent='—';$('totalWeight').textContent='—';
  }
});
})();
