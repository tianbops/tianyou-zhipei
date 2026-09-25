/* 天友智配One - 当日订单人工确认与录入 */
(function(){
  'use strict';
  let reviewState=[];
  let parsedState=[];
  let metaState={};
  const $=id=>document.getElementById(id);
  const routeContext=()=>typeof Auth!=='undefined'?(Auth.getDispatchRoute?Auth.getDispatchRoute():''):'';
  function candidateList(item){
    const rawCandidates=[item?.candidate,...(Array.isArray(item?.candidates)?item.candidates:[])];
    const names=rawCandidates.map(v=>typeof v==='object'?String(v?.name||v?.storeName||'').trim():String(v||'').trim()).filter(Boolean);
    const codes=[String(item?.candidateCode||'').trim(),...(Array.isArray(item?.candidateCodes)?item.candidateCodes.map(v=>String(v||'').trim()):[])];
    const ids=[String(item?.candidateStoreId||item?.storeId||'').trim(),...(Array.isArray(item?.candidateStoreIds)?item.candidateStoreIds.map(v=>String(v||'').trim()):[])];
    return [...new Map(names.map((name,index)=>[name,{name,code:codes[index]||'',storeId:ids[index]||''}])).values()];
  }
  function renderReview(items){
    reviewState=(Array.isArray(items)?items:[]).filter(item=>item?.needsReview);
    const box=$('statusDetail');
    if(!box)return;
    box.innerHTML='';
    if(!reviewState.length){box.classList.remove('active','review-detail');return;}
    box.classList.add('active','review-detail');
    const hint=document.createElement('div');hint.className='review-hint';hint.textContent=`发现 ${reviewState.length} 家疑似门店，请确认后再录入`;box.appendChild(hint);
    const list=document.createElement('div');list.className='review-list';
    reviewState.forEach((item,index)=>{
      const row=document.createElement('div');row.className='review-item';
      const label=document.createElement('button');label.type='button';label.className='review-name review-name-button';label.textContent=`${item.code||`R${String(index+1).padStart(2,'0')}`} · ${String(item.name||'').trim()}`;
      const select=document.createElement('select');select.className='review-select';
      const candidates=candidateList(item);
      select.innerHTML='<option value="">选择处理方式</option>'+candidates.map((candidate,i)=>`<option value="candidate:${i}">采用候选：${candidate.name}</option>`).join('')+'<option value="new">作为新增门店</option>';
      select.value=item._choice||'';
      select.addEventListener('change',()=>{
        item._choice=select.value;
        const selected=select.value.startsWith('candidate:')?candidates[Number(select.value.slice(10))]:null;
        item._selectedCandidate=selected?.name||'';
        item._selectedCandidateCode=selected?.code||'';
        item._selectedCandidateStoreId=selected?.storeId||'';
      });
      label.addEventListener('click',()=>{select.focus();select.click?.();});
      row.append(label,select);list.appendChild(row);
    });
    box.appendChild(list);
    const button=document.createElement('button');button.type='button';button.className='review-apply';button.textContent='✓ 应用确认';button.addEventListener('click',applyReview);box.appendChild(button);
  }
  async function applyReview(){let pending=0;for(const item of reviewState)if(!item._choice)pending++;if(pending){window.renderUnifiedStatus?.('error',100,`还有 ${pending} 家门店未确认`);return;}const button=document.querySelector('.review-apply');if(button){button.disabled=true;button.textContent='正在应用…';}try{for(const item of reviewState){const target=parsedState.find(store=>store===item||store.code===item.code||store.name===item.name);if(!target)continue;if(item._choice==='new'){target.needsReview=false;target.candidate='';target.candidates=[];target.matchType='new';target.matched=false;target.isNew=true;target.matchScore=0;}else{const selected=String(item._selectedCandidate||'').trim();if(!selected)throw Error('请选择正确的候选门店');const rawName=String(item.name||'').trim();const rawNames=Array.isArray(target.rawNames)?target.rawNames.filter(Boolean):[];if(rawName&&!rawNames.includes(rawName))rawNames.push(rawName);target.rawNames=rawNames.slice(-5);target.baseName=selected;target.baseCode=item._selectedCandidateCode||item.candidateCode||'';target.storeId=item._selectedCandidateStoreId||item.candidateStoreId||target.storeId||target.baseCode||'';target.name=selected;target.needsReview=false;target.candidate='';target.candidates=[];target.matchType='confirmed';target.matched=true;target.isNew=false;target.matchScore=1;}}renderReview([]);window.updatePendingReviewCount?.(0);window.closePendingReviewDetail?.();window.renderUnifiedStatus?.('success',100,'待定门店已处理');}catch(error){window.renderUnifiedStatus?.('error',100,error.message||'处理失败，请重试');}finally{if(button){button.disabled=false;button.textContent='✓ 应用确认';}}}
  function renderPendingReviewDetail(items){
    const view=$('uploadDetailView'),title=$('uploadDetailTitle'),body=$('uploadDetailBody');
    if(!view||!title||!body)return;
    reviewState=(Array.isArray(items)?items:[]).filter(item=>item?.needsReview);
    if(!reviewState.length)return;
    title.textContent='待定门店确认';
    body.textContent='';
    const hint=document.createElement('div');hint.className='pending-review-summary';
    hint.innerHTML=`<strong>还有 ${reviewState.length} 家门店需要确认</strong><span>请选择对应门店，或作为新增门店处理</span>`;
    body.appendChild(hint);
    const list=document.createElement('div');list.className='pending-review-list';
    reviewState.forEach((item,index)=>{
      const card=document.createElement('div');card.className='pending-review-card';
      const top=document.createElement('div');top.className='pending-review-card-top';
      const name=document.createElement('button');name.type='button';name.className='pending-review-name';
      name.textContent=`${String(index+1).padStart(2,'0')} · ${String(item.name||'').trim()}`;
      const select=document.createElement('select');select.className='pending-review-select';
      const candidates=candidateList(item);
      select.innerHTML='<option value="">选择门店</option>'+candidates.map((candidate,i)=>`<option value="candidate:${i}">${candidate.name}</option>`).join('')+'<option value="new">作为新增门店</option>';
      select.value=item._choice||'';
      const applyChoice=()=>{
        item._choice=select.value;
        const selected=select.value.startsWith('candidate:')?candidates[Number(select.value.slice(10))]:null;
        item._selectedCandidate=selected?.name||'';
        item._selectedCandidateCode=selected?.code||'';
        item._selectedCandidateStoreId=selected?.storeId||'';
        card.classList.toggle('is-selected',!!select.value);
        if(select.value==='new'){item._selectedCandidate='';item._selectedCandidateCode='';item._selectedCandidateStoreId='';}
      };
      select.addEventListener('change',applyChoice);
      name.addEventListener('click',()=>{select.focus();select.click?.();});
      top.append(name,select);card.appendChild(top);
      const hintLine=document.createElement('div');hintLine.className='pending-review-choice-hint';hintLine.textContent='点击门店名称也可直接选择';card.appendChild(hintLine);
      list.appendChild(card);
    });
    body.appendChild(list);
    const cancel=$('.sheet-footer .btn-cancel');
    window.__pendingReviewFooterMode=true;
    if(cancel){cancel.textContent='返回';cancel.onclick=()=>window.closePendingReviewDetail?.();}
    view.hidden=false;view.setAttribute('aria-hidden','false');
    const sheet=document.querySelector('.upload-sheet');
    sheet?.classList.add('detail-view-open','detail-mode-review');
    window.renderUnifiedStatus?.('success',100,`还有 ${reviewState.length} 家门店需要确认`);
  }
  window.openPendingReviewDetail=renderPendingReviewDetail;
  window.closePendingReviewDetail=()=>{
    const view=$('uploadDetailView');if(!view)return;
    view.hidden=true;view.setAttribute('aria-hidden','true');
    const sheet=document.querySelector('.upload-sheet');
    sheet?.classList.remove('detail-view-open','detail-mode-review');
    const cancel=$('.sheet-footer .btn-cancel');
    if(cancel)/{cancel.textContent='取消';cancel.onclick=()=>window.cancelUpload?.();}
    window.__pendingReviewFooterMode=false;
  };
  function writeReviewText(stores){
    const input=$('manualOrderInput');if(!input)return;
    const ordered=[...stores.filter(item=>item?.needsReview===true),...stores.filter(item=>item?.isNew===true&&item?.needsReview!==true),...stores.filter(item=>item?.needsReview!==true&&item?.isNew!==true)];
    const lines=[`日期：${metaState.date||'未识别'}`,`线路：${metaState.route||routeContext()||'未识别'}`,`车辆：${metaState.vehicle||'未识别'}`,`门店：${stores.length}家`,`重量：${metaState.totalWeight||'未识别'}`,'',`【门店列表】`];
    ordered.forEach((store,index)=>{const mark=store?.isNew?'⚠️ 新增：':store?.needsReview?'⚠️ 待定：':'';lines.push(`${String(index+1).padStart(2,'0')}. ${mark}${String(store?.name||'').trim()}`);});
    input.value=lines.join('\n');
  }
  function extractDateFromText(text){const match=String(text||'').match(/(?:运输日期|运单日期|日期)\s*[:：]?\s*(20\d{2})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*日?/);return match?match[1]+'-'+String(match[2]).padStart(2,'0')+'-'+String(match[3]).padStart(2,'0'):'';}
  function syncParsed(data){const d=data||{};const user=typeof Auth!=='undefined'?(Auth.serverUser||{}):{};const bridge=window.__zspParseContext&&typeof window.__zspParseContext==='object'?window.__zspParseContext:{};const inputDate=extractDateFromText($('manualOrderInput')?.value||'');const bridgeStores=Array.isArray(bridge.stores)?bridge.stores:[];const incomingStores=Array.isArray(d.stores)&&d.stores.length?d.stores:bridgeStores;parsedState=incomingStores.map(item=>({...item}));const userId=String(d.userId||bridge.userId||user.id||user.username||user.account||'').trim();const route=String(d.route||bridge.route||routeContext()||'').trim();const parseContextId=String(d.parseContextId||bridge.parseContextId||'').trim();metaState={parseContextId,userId,route,date:d.date||bridge.date||inputDate||'',vehicle:d.vehicle||bridge.vehicle||'',totalWeight:String(d.totalWeight||bridge.totalWeight||''),rawOrderCount:Number(d.rawOrderCount)||0,recognizedCount:Number(d.recognizedCount)||parsedState.length,baseDatabaseAvailable:d.baseDatabaseAvailable!==false,source:d.source||'web-confirm'};renderReview(parsedState);}
  function weightFromText(text){const source=String(text||'').replace(/\s+/g,' ');const match=source.match(/总\s*重\s*量\s*[:：]?\s*([\d]+(?:\.[\d]+)?)\s*(kg|千克|公斤|吨|t)?/i)||source.match(/(?:总重|重量)\s*[:：]?\s*([\d]+(?:\.[\d]+)?)\s*(kg|千克|公斤|吨|t)?/i);return match?normalizeWeight(`${match[1]}${match[2]||''}`):'';}
  function normalizeWeight(value){if(value===null||value===undefined||value==='')return '';const text=String(value).trim().replace(/,/g,'');const match=text.match(/[\d]+(?:\.\d+)?/);if(!match)return '';const n=Number(match[0]);if(!Number.isFinite(n)||n<=0)return '';const hasKg=/kg|千克|公斤/i.test(text);const hasTon=/吨|\bt\b/i.test(text);const tons=hasTon?n:hasKg?n/1000:n>=1000?n/1000:n;return `${Math.round((tons+Number.EPSILON)*1000000)/1000000}t`;}
  window.onOrderParsed=syncParsed;
  function currentUserId(){const user=typeof Auth!=='undefined'?(Auth.serverUser||{}):{};return String(user.id||user.username||user.account||'').trim();}
  function assertParseContext(){const route=routeContext();const userId=currentUserId();const bridge=window.__zspParseContext&&typeof window.__zspParseContext==='object'?window.__zspParseContext:{};const lockedRoute=String(metaState.route||bridge.route||'').trim();const lockedUserId=String(metaState.userId||bridge.userId||'').trim();const parseContextId=String(metaState.parseContextId||bridge.parseContextId||'').trim();if(!lockedRoute)throw Error('解析上下文缺少线路，请重新处理运单');if(route!==lockedRoute)throw Error(`调度线路已从 ${lockedRoute} 切换为 ${route||'未选择'}，当前结果已失效，请重新处理运单`);if(lockedUserId&&userId&&lockedUserId!==userId)throw Error('登录账号已发生变化，当前解析结果已失效，请重新处理运单');if(!parseContextId)throw Error('当前解析批次已失效，请重新处理运单');metaState.route=lockedRoute;metaState.userId=lockedUserId;metaState.parseContextId=parseContextId;}
  async function reparseEditedText(){const text=String($('manualOrderInput')?.value||'').trim();if(!text)throw Error('请先输入或识别运单文字');const route=routeContext();if(!route)throw Error('未指定配送线路');if(metaState.route&&route!==metaState.route)throw Error(`调度线路已从 ${metaState.route} 切换为 ${route}，请重新处理运单当前运单`);if(typeof window.parseManualInput==='function'){const stores=await window.parseManualInput();if(!Array.isArray(stores)||!stores.length)throw Error('没有识别到有效门店');return{route:metaState.route||route,date:metaState.date||'',vehicle:metaState.vehicle||'',totalWeight:metaState.totalWeight||'',baseDatabaseAvailable:metaState.baseDatabaseAvailable,stores:parsedState};}const response=await fetch('/api/parse',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',cache:'no-store',body:JSON.stringify({text,route})});const data=await response.json().catch(()=>({}));if(!response.ok||!data.success)throw Error(data.error||`重新解析失败（${response.status}）`);syncParsed(data.data||{});return data.data||{};}
  async function saveConfirmedLearning(){
    const route=routeContext();
    if(!route||metaState.baseDatabaseAvailable===false)return {success:false,skipped:true};
    const items=[];
    for(const item of parsedState){
      if(!item||item.isNew===true)continue;
      if(item.matched!==true||item.needsReview===true)continue;
      const baseName=String(item.baseName||item.name||'').trim();
      const rawNames=Array.isArray(item.rawNames)?item.rawNames.map(v=>String(v||'').trim()).filter(Boolean):[];
      const fallback=String(item.rawName||'').trim();
      if(fallback&&!rawNames.includes(fallback))rawNames.push(fallback);
      for(const rawName of rawNames){
        if(!rawName||rawName===baseName)continue;
        items.push({rawName,baseName,baseCode:String(item.baseCode||'').trim(),storeId:String(item.storeId||'').trim()});
      }
    }
    const unique=new Map();
    for(const item of items){
      const key=`${item.rawName}\u0000${item.baseCode}\u0000${item.baseName}`;
      unique.set(key,item);
    }
    if(!unique.size)return {success:true,skipped:true};
    try{
      const response=await fetch('/api/store-learning',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        credentials:'same-origin',
        cache:'no-store',
        body:JSON.stringify({route,items:[...unique.values()]})
      });
      const data=await response.json().catch(()=>({}));
      if(!response.ok||!data.success){
        console.warn('门店学习库保存失败',data.error||response.status);
        return {success:false,error:data.error||`HTTP ${response.status}`};
      }
      return data;
    }catch(error){
      console.warn('门店学习库请求失败',error);
      return {success:false,error:error?.message||'学习库请求失败'};
    }
  }
  function createClientRequestId(){return `confirm-${Date.now()}-${Math.random().toString(36).slice(2,10)}`;}
  let confirmAbortController=null;
  let confirmInFlight=false;
  let confirmStartedAt=0;
  async function confirm(options={}){
    const autoConfirm=options?.auto===true;
    const input=$('manualOrderInput');
    if(confirmInFlight)return;
    confirmInFlight=true;
    confirmStartedAt=Date.now();
    let timer=null;
    const confirmRequestId=metaState.confirmRequestId||(metaState.confirmRequestId=createClientRequestId());
    window.renderUnifiedStatus?.('loading',88,'正在保存运单及修正记录…');
    try{
      if(!parsedState.length){
        if(!String(input?.value||'').trim())throw Error('请先完成运单处理');
        window.renderUnifiedStatus?.('loading',90,'正在应用修正并保存运单…');
        await reparseEditedText();
      }

      if(!Array.isArray(parsedState)||!parsedState.length){
        const bridge=window.__zspParseContext&&typeof window.__zspParseContext==='object'?window.__zspParseContext:{};
        if(Array.isArray(bridge.stores)&&bridge.stores.length) parsedState=bridge.stores.map(item=>({...item}));
      }
      if(!Array.isArray(parsedState)||!parsedState.length) throw Error('当前没有可确认的订单，请重新处理运单');

      assertParseContext();

      const pending=parsedState.filter(item=>item?.needsReview);
      if(pending.length&&!autoConfirm){
        window.renderUnifiedStatus?.('error',100,`还有 ${pending.length} 家门店待定`);
        return;
      }

      const route=routeContext();
      if(route!==String(metaState.route||'').trim())throw Error(`调度线路已从 ${metaState.route||'未选择'} 切换为 ${route||'未选择'}，当前结果已失效，请重新处理运单`);
      if(!route){
        window.renderUnifiedStatus?.('error',100,'未指定配送线路');
        return;
      }
      const currentText=String(input?.value||'');
      const totalWeight=metaState.totalWeight||weightFromText(currentText);
      const textDate=extractDateFromText(currentText);
      const date=metaState.date||textDate||'';
      if(date)metaState.date=date;
      confirmAbortController=new AbortController();
      timer=setTimeout(()=>confirmAbortController?.abort(),20000);

      const response=await fetch('/api/confirm',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        credentials:'same-origin',
        cache:'no-store',
        signal:confirmAbortController.signal,
        body:JSON.stringify({
          orders:parsedState,
          route,
          date,
          vehicle:metaState.vehicle||'',
          totalWeight,
          rawText:currentText,
          source:metaState.source||'web-confirm',
          recognizedCount:Number(metaState.recognizedCount)||parsedState.length,
          rawOrderCount:Number(metaState.rawOrderCount)||0,
          baseDatabaseAvailable:metaState.baseDatabaseAvailable!==false,
          confirmRequestId,
          autoConfirm
        })
      });

      const data=await response.json().catch(()=>({}));
      if(!response.ok||!data.success){
        if(data.code==='REVIEW_REQUIRED'){
          const error=Object.assign(new Error(data.error||`确认失败（${response.status}）`),{
            reviewRequired:Array.isArray(data.review)?data.review:[]
          });
          throw error;
        }
        throw Object.assign(new Error(data.error||`确认失败（${response.status}）`),{
          serverStage:data.stage||''
        });
      }

      const isDuplicate=data.duplicate===true;
      if(!isDuplicate){
        const learningResult=await saveConfirmedLearning();
        if(learningResult&&!learningResult.success&&!learningResult.skipped){
          console.warn('门店学习库更新失败，不影响运单保存',learningResult.error||'unknown');
        }
      }

      const savedDate=data.data?.date||date;
      const savedBatch=data.data?.orderBatchId||'';
      if(isDuplicate&&!savedBatch)throw Error('重复运单缺少原批次信息，请重试');


      window.renderUnifiedStatus?.('loading',98,'保存完成，正在打开当日数据…');
      document.body.classList.add('navigating-to-order');

      const handoffTitle=document.querySelector('.upload-sheet .sheet-title');
      if(handoffTitle)handoffTitle.textContent='正在打开当日数据…';

      const params=new URLSearchParams({route});
      if(savedDate)params.set('date',savedDate);
      if(savedBatch)params.set('orderBatchId',savedBatch);

      const targetUrl=`pages/order_detail.html?${params.toString()}`;
      window.location.assign(targetUrl);
    }catch(error){
      if(error?.name==='AbortError'){
        window.renderUnifiedStatus?.('error',100,'运单保存超时，请检查网络后重试');
      }else{
        const detail=error?.serverStage
          ?('录入失败：'+(error.message||'服务器错误')+'（'+error.serverStage+'）')
          :(error.message||'录入失败，请重试');
        window.renderUnifiedStatus?.('error',100,detail.replace(/^确认失败/, '保存失败').replace(/^录入失败/, '保存失败'));
        window.homeToast?.(detail,'error');
      }
      if(Array.isArray(error?.reviewRequired)&&error.reviewRequired.length){
        renderReview(error.reviewRequired);
      }
    }finally{
      if(timer)clearTimeout(timer);
      confirmAbortController=null;
      confirmInFlight=false;
      confirmStartedAt=0;
      if(button){
        button.disabled=false;
        button.textContent='';
        button.classList.remove('ready');
        button.hidden=true;
        button.setAttribute('aria-hidden','true');
      }
    }
  }
  window.cancelConfirm=()=>{if(confirmAbortController){try{confirmAbortController.abort();}catch(_){}}confirmInFlight=false;};
  window.submitManualOrder=confirm;
  window.renderReviewStores=renderReview;
})();
