const { request } = require('../../utils/api');
const app = getApp();
Page({
  data:{user:{},stores:[]},
  onShow(){this.load()},
  async load(){
    const user=app.globalData.user||wx.getStorageSync('zhipei_user')||{}; this.setData({user});
    try{const data=await request('/api/orders');const order=data?.order||data||{};this.setData({stores:Array.isArray(order.stores)?order.stores:(order.orders||[])})}
    catch(e){if(/401|403|登录/.test(String(e.message)))wx.reLaunch({url:'/pages/login/login'})}
  }
});
