/* 智配One · Android-style shared dialog primitives */
(function(){
  'use strict';
  if(window.OneModal)return;
  const css=`
.one-shared-dialog{position:fixed;inset:0;z-index:30000;display:flex;align-items:center;justify-content:center;padding:18px;background:rgba(0,0,0,.70);backdrop-filter:blur(5px);-webkit-backdrop-filter:blur(5px)}
.one-shared-dialog[hidden]{display:none!important}
.one-shared-dialog__box{width:min(100%,380px);max-height:88vh;overflow:auto;background:#151D26;border:1px solid rgba(255,255,255,.075);border-radius:18px;padding:20px;box-shadow:0 18px 50px rgba(0,0,0,.50);color:#F2F5F7}
.one-shared-dialog__head{position:relative;min-height:24px;padding:0 30px 0 0}
.one-shared-dialog__title{font-size:16px;line-height:24px;font-weight:700;text-align:center}
.one-shared-dialog__close{position:absolute;top:-8px;right:-8px;width:32px;height:32px;border:0;background:transparent;color:#B8C2CC;font-size:24px;line-height:32px;padding:0;cursor:pointer;border-radius:50%}
.one-shared-dialog__close:active{background:rgba(255,255,255,.08);color:#fff}
.one-shared-dialog__message{margin-top:10px;color:#D5DCE2;font-size:14px;line-height:1.6;text-align:center;white-space:pre-line}
.one-shared-dialog__input{width:100%;height:46px;margin-top:14px;padding:0 12px;box-sizing:border-box;border:1px solid rgba(255,255,255,.10);border-radius:12px;background:#10161D;color:#F2F5F7;outline:none;font-size:14px}
.one-shared-dialog__input:focus{border-color:rgba(208,215,220,.35);box-shadow:0 0 0 2px rgba(208,215,220,.08)}
.one-shared-dialog__actions{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:18px}
.one-shared-dialog__actions.single{grid-template-columns:1fr}
.one-shared-dialog__actions button{height:46px;border-radius:12px;border:1px solid rgba(255,255,255,.075);font-size:14px;font-weight:600;cursor:pointer}
.one-shared-dialog__secondary{background:#202A34;color:#E3E8ED}
.one-shared-dialog__primary{background:#B8C1C8;color:#0B1015}
.one-shared-dialog__danger{background:#B64B4B;color:#fff;border-color:#B64B4B!important}
@media(max-width:430px){.one-shared-dialog{padding:14px}.one-shared-dialog__box{width:100%}}
`;
  const style=document.createElement('style');style.textContent=css;document.head.appendChild(style);
  function open({title='',message='',confirmText='确定',cancelText='取消',danger=false,input=false,password=false,placeholder='',single=false}){
    return new Promise(resolve=>{
      const overlay=document.createElement('div');overlay.className='one-shared-dialog';overlay.setAttribute('role','dialog');overlay.setAttribute('aria-modal','true');
      const box=document.createElement('section');box.className='one-shared-dialog__box';
      box.innerHTML='<div class="one-shared-dialog__head"><div class="one-shared-dialog__title"></div><button type="button" class="one-shared-dialog__close" aria-label="关闭">×</button></div><div class="one-shared-dialog__message"></div>';
      box.querySelector('.one-shared-dialog__title').textContent=title;
      box.querySelector('.one-shared-dialog__message').textContent=message;
      box.querySelector('.one-shared-dialog__close').addEventListener('click',()=>finish(null));
      let field=null;
      if(input){field=document.createElement('input');field.className='one-shared-dialog__input';field.type=password?'password':'text';field.placeholder=placeholder;field.autocomplete=password?'new-password':'off';box.appendChild(field)}
      const actions=document.createElement('div');actions.className='one-shared-dialog__actions'+(single?' single':'');
      if(!single){
        const cancel=document.createElement('button');cancel.type='button';cancel.className='one-shared-dialog__secondary';cancel.textContent=cancelText;actions.appendChild(cancel);
        cancel.addEventListener('click',()=>finish(null));
      }
      const confirm=document.createElement('button');confirm.type='button';confirm.className=danger?'one-shared-dialog__danger':'one-shared-dialog__primary';confirm.textContent=confirmText;actions.appendChild(confirm);
      confirm.addEventListener('click',()=>finish(input?(field?.value||''):true));
      // 关键：将操作按钮容器加入弹窗，否则标题/正文/X 会显示而取消、确认按钮不会出现在页面。
      box.appendChild(actions);
      overlay.appendChild(box);document.body.appendChild(overlay);
      let closed=false;
      const finish=value=>{if(closed)return;closed=true;document.removeEventListener('keydown',onKey);overlay.remove();resolve(value)};
      const onKey=e=>{if(e.key==='Escape'){finish(null)}else if(e.key==='Enter'&&(!field||document.activeElement===field)){e.preventDefault();confirm.click()}};
      document.addEventListener('keydown',onKey);
      if(field){field.focus()}else{confirm.focus()}
    });
  }
  window.OneModal={
    confirm:(message,options={})=>open({message,...options}),
    notice:(message,options={})=>open({message,...options,single:true,confirmText:options.confirmText||'知道了'}),
    prompt:(message,options={})=>open({message,...options,input:true,confirmText:options.confirmText||'确定'})
  };
})();