/* 天友智配One - OCR桥接兼容层
 * 服务器端 /api/orders 负责保存真实订单数据。
 * 旧版本这里会拦截 /api/ocr 并再次写入 /api/ocr-batch，造成同一次OCR被保存两次，
 * 并可能用错误的手机当前日期覆盖运单业务日期。现在保留文件以兼容旧页面引用，
 * 但不再拦截 fetch、不再写入订单、不再修改本地缓存。
 */
(function(){
  'use strict';
  // 刻意不重写 window.fetch。
  // 正式数据链路：/api/ocr -> 首页 /api/orders POST -> Upstash -> /api/orders GET。
})();
