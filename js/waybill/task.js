// 智配One V3 · 前端唯一任务状态机
(function(){
  const STAGES=['IDLE','RECOGNIZING','EXTRACTING','MATCHING','PLANNING','SAVING','COMPLETED','FAILED','CANCELLED','TIMEOUT'];
  let task=null,controller=null;

  function create(input){
    return {
      id:(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(input?.taskId||''))?String(input.taskId):crypto.randomUUID()),
      image:input?.image||null,
      ocrText:'',
      waybill:input?.waybill||{},
      stores:[],
      matchedStores:[],
      plannedStores:[],
      result:null,
      stage:'IDLE',
      status:'idle',
      error:null
    };
  }

  function setStageFor(target,stage,extra={}){
    if(!target||task?.id!==target.id)return target;
    if(!STAGES.includes(stage))throw Error('未知任务阶段');
    task={...task,stage,status:['FAILED','CANCELLED','TIMEOUT'].includes(stage)?'error':stage==='COMPLETED'?'done':'running',...extra};
    window.dispatchEvent(new CustomEvent('zpei:v3-task',{detail:task}));
    return task;
  }

  async function run(input){
    if(controller)throw Error('运单正在处理');

    const target=create(input);
    const localController=new AbortController();
    task=target;
    controller=localController;

    try{
      setStageFor(target,'RECOGNIZING');

      const ocr=input.ocrText
        ? {text:input.ocrText}
        : await input.ocr();

      if(localController.signal.aborted)throw Object.assign(Error('已取消处理'),{code:'CANCELLED'});
      if(!ocr?.text)throw Object.assign(Error('运单识别失败'),{code:'OCR_INVALID'});

      target.ocrText=ocr.text;
      setStageFor(target,'EXTRACTING');
      setStageFor(target,'MATCHING');

      const r=await fetch('/api/auto-plan',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        credentials:'same-origin',
        signal:localController.signal,
        body:JSON.stringify({...input.waybill,text:ocr.text,taskId:target.id})
      });

      const data=await r.json().catch(()=>({}));
      if(!r.ok||!data.success){
        throw Object.assign(Error(data.message||'自动规划未完成'),{code:data.code,stage:data.stage});
      }

      setStageFor(target,'PLANNING',{result:data.result,plannedStores:data.result?.stores||[]});
      setStageFor(target,'SAVING');
      setStageFor(target,'COMPLETED',{result:data.result});
      return target;
    }catch(e){
      if(e?.name==='AbortError'||e?.code==='CANCELLED'){
        setStageFor(target,'CANCELLED');
        return target;
      }
      setStageFor(target,'FAILED',{error:{code:e?.code||'PLAN_FAILED',message:e?.message||'自动规划未完成'}});
      throw e;
    }finally{
      if(controller===localController)controller=null;
    }
  }

  function cancel(){
    controller?.abort();
  }

  function reset(){
    controller?.abort();
    controller=null;
    task=null;
    window.dispatchEvent(new CustomEvent('zpei:v3-task',{detail:null}));
  }

  window.WaybillPlanner={run,cancel,reset,getTask:()=>task};
})();
