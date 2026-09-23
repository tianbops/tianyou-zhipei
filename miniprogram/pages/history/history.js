const { request } = require('../../utils/api');
const app = getApp();
Page({
  data:{items:[],dispatchRoute:''},
  async onShow(){
    const user=app.globalData.user||wx.getStorageSync('zhipei_user')||{};
    const route=String(app.globalData.dispatchRoute||wx.getStorageSync('zhipei_dispatch_route')||user.boundRouteId||user.route||'').trim();
    this.setData({dispatchRoute:route});
    try{
      const url=route?'/api/history?route='+encodeURIComponent(route):'/api/history';
      const data=await request(url);
      const source=Array.isArray(data)?data:(data?.items||data?.history||data?.data||[]);
      const list=source.flatMap(group=>Array.isArray(group?.records)?group.records.map(record=>({...record,date:record?.date||group.date})): [group]);
      this.setData({items:list.map(x=>({
        date:x.date||x.orderDate||'',
        count:x.uniqueStoreCount??x.storeCount??x.count??x.orders?.length??x.stores?.length??0,
        weight:(()=>{
          const raw=String(x.totalWeight??x.weight??'0kg').trim().replace(/,/g,'');
          const m=raw.match(/[0-9]+(?:\\.[0-9]+)?/);
          const n=m?Number(m[0]):NaN;
          const t=Number.isFinite(n)?(/kg|千克|公斤/i.test(raw)?n/1000:/吨|\\bt\\b/i.test(raw)?n:n>=1000?n/1000:n):NaN;
          return Number.isFinite(t)?((Math.round((t+Number.EPSILON)*100)/100).toFixed(2)+'t'):'0.00t';
        })()
      }))});
    }catch(e){
      if(/401|403|登录/.test(String(e.message)))wx.reLaunch({url:'/pages/login/login'});
    }
  }
});