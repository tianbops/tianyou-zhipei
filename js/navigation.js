/* 天友智配One - 统一返回导航 */
(function(){
'use strict';
const HOME='/home.html';
function sameOriginReferrer(){
  try{
    if(!document.referrer)return false;
    const ref=new URL(document.referrer,location.href);
    return ref.origin===location.origin;
  }catch(_){return false}
}
function goBack(fallback=HOME){
  try{
    if(sameOriginReferrer()&&window.history.length>1){
      window.history.back();
      return;
    }
  }catch(_){ }
  window.location.href=fallback;
}
window.Nav={goBack};
})();
