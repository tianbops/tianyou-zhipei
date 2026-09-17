const { request } = require('../../utils/api');
Page({
  data:{items:[]},
  async onShow(){try{const data=await request('/api/history');const list=Array.isArray(data)?data:(data?.items||data?.history||[]);this.setData({items:list.map(x=>({date:x.date||x.orderDate||'',count:x.storeCount??x.count??x.stores?.length??0,weight:String(x.totalWeight??x.weight??'0kg')}))})}catch(e){if(/401|403|登录/.test(String(e.message)))wx.reLaunch({url:'/pages/login/login'})}}
});
