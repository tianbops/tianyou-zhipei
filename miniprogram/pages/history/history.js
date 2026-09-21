const { request } = require('../../utils/api');
Page({
  data:{items:[]},
  async onShow(){try{const data=await request('/api/history');const list=Array.isArray(data)?data:(data?.items||data?.history||[]);this.setData({items:list.map(x=>({date:x.date||x.orderDate||'',count:x.storeCount??x.count??x.stores?.length??0,weight:(()=>{const raw=String(x.totalWeight??x.weight??'0kg').trim().replace(/,/g,'');const m=raw.match(/[0-9]+(?:\\.[0-9]+)?/);const n=m?Number(m[0]):NaN;const t=Number.isFinite(n)?(/kg|千克|公斤/i.test(raw)?n/1000:/吨|\\bt\\b/i.test(raw)?n:n>=1000?n/1000:n):NaN;return Number.isFinite(t)?`${(Math.round((t+Number.EPSILON)*100)/100).toFixed(2)}t`:'0.00t'})()}}))})}catch(e){if(/401|403|登录/.test(String(e.message)))wx.reLaunch({url:'/pages/login/login'})}}
});
