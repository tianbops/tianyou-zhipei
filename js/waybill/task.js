// 天友智配One V3 · 前端唯一任务状态机
(function(){
  const STAGES=['IDLE','RECOGNIZING','EXTRACTING','MATCHING','PLANNING','SAVING','COMPLETED','FAILED','CANCELLED','TIMEOUT'];
  let task=null,controller=null;
  function create(input){return {id:crypto.randomUUID(),image:input?.image||null,ocrText:'',waybill:input?.waybill||{},stores:[],matchedStores:[],plannedStores:[],result:null,stage:'IDLE',status:'idle',error:null};}
  function setStage(stage,extra={}){
    if(!STAGES.includes(stage))throw Error('未知任务阶段');
    task={...task,stage,status:['FAILED','CANCELLED','TIMEOUT'].includes(stage)?'error':stage==='COMPLETED'?'done':'running',...extra};
    window.dispatchEvent(new CustomEvent('zpei:v3-task',{detail:task}));
    return task;
  }
  async function run(input){
    if(controller)throw Error('运单正在处理');
    task=create(input);controller=new AbortController();
    try{
      setStage('RECOGNIZING');
      const ocr=await input.ocr();
      if(!ocr?.text)throw Object.assign(Error('运单识别失败'),{code:'OCR_INVALID'});
      task.ocrText=ocr.text;setStage('EXTRACTING');setStage('MATCHING');
      const r=await fetch('/api/auto-plan',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',signal:controller.signal,body:JSON.stringify({...input.waybill,text:ocr.text})});
      const data=await r.json().catch(()=>({}));
      if(!r.ok||!data.success)throw Object.assign(Error(data.message||'自动规划未完成'),{code:data.code,stage:data.stage});
      setStage('PLANNING',{result:data.result,plannedStores:data.result?.stores||[]});
      setStage('SAVING');setStage('COMPLETED',{result:data.result});
      return task;
    }catch(e){
      if(e?.name==='AbortError'){setStage('CANCELLED');return task;}
      setStage('FAILED',{error:{code:e?.code||'PLAN_FAILED',message:e?.message||'自动规划未完成'}});throw e;
    }finally{controller=null;}
  }
  function cancel(){controller?.abort();}
  function reset(){controller?.abort();controller=null;task=null;window.dispatchEvent(new CustomEvent('zpei:v3-task',{detail:null}));}
  window.WaybillPlanner={run,cancel,reset,getTask:()=>task};
})();
