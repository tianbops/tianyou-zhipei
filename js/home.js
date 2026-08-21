// ============================================================
// 首页初始化
// ============================================================
document.addEventListener('DOMContentLoaded', function() {
  if (!Auth.checkAuth()) return;
  
  const route = Auth.getCurrentRoute();
  document.getElementById("menuRoute").textContent = route;
  document.getElementById("homeRoute").textContent = route;
  loadRouteData(route);
  updateStatusDot();
  
  const textarea = document.getElementById('manualOrderInput');
  const charCount = document.getElementById('charCount');
  if (textarea && charCount) {
    textarea.addEventListener('input', function() {
      charCount.textContent = this.value.length + ' 字符';
    });
  }
});

// ============================================================
// 加载线路数据
// ============================================================
async function loadRouteData(route) {
  try {
    let data = Auth.getCachedRouteData(route);
    if (!data) {
      const response = await fetch(`/api/route/${encodeURIComponent(route)}`);
      if (response.ok) data = await response.json();
    }
    
    const todayOrders = getTodayOrders();
    
    if (todayOrders && todayOrders.length > 0) {
      const count = todayOrders.length;
      let totalWeight = 0;
      todayOrders.forEach(order => {
        const weight = parseFloat(order.weight) || 0;
        totalWeight += weight;
      });
      document.getElementById("storeCount").textContent = count + ' 家门店';
      document.getElementById("totalWeight").textContent = totalWeight.toFixed(1) + ' kg';
    } else {
      document.getElementById("storeCount").textContent = '无数据';
      document.getElementById("totalWeight").textContent = '无数据';
    }
    
    updateStatusDot();
    
  } catch (error) { 
    console.error("加载数据失败:", error);
    document.getElementById("storeCount").textContent = '无数据';
    document.getElementById("totalWeight").textContent = '无数据';
    updateStatusDot();
  }
}

// ============================================================
// 今日运单数据管理
// ============================================================
function getTodayOrders() {
  try {
    const data = localStorage.getItem('today_orders');
    return data ? JSON.parse(data) : null;
  } catch {
    return null;
  }
}

function saveTodayOrders(orders) {
  localStorage.setItem('today_orders', JSON.stringify(orders));
  saveToHistory(orders);
  Auth.saveCurrentUserData();
  loadRouteData(Auth.getCurrentRoute());
}

function saveToHistory(orders) {
  const today = new Date().toISOString().split('T')[0];
  const route = Auth.getCurrentRoute();
  let history = JSON.parse(localStorage.getItem('delivery_history') || '[]');
  
  let totalWeight = 0;
  orders.forEach(order => {
    const weight = parseFloat(order.weight) || 0;
    totalWeight += weight;
  });
  
  const record = {
    date: today,
    route: route,
    vehicle: localStorage.getItem('today_vehicle') || '渝DK7692',
    count: orders.length,
    weight: totalWeight.toFixed(1) + ' kg',
    orders: orders
  };
  
  const index = history.findIndex(item => item.date === today);
  if (index >= 0) {
    history[index] = record;
  } else {
    history.unshift(record);
  }
  
  if (history.length > 100) history.length = 100;
  localStorage.setItem('delivery_history', JSON.stringify(history));
  Auth.saveCurrentUserData();
}

// ============================================================
// 状态点更新
// ============================================================
function updateStatusDot() {
  const dot = document.getElementById('statusDot');
  const todayOrders = getTodayOrders();
  if (todayOrders && todayOrders.length > 0) {
    dot.style.background = '#E74C3C';
  } else {
    dot.style.background = '#3498DB';
  }
}

// ============================================================
// 菜单控制
// ============================================================
function openHomeMenu() {
  const menu = document.getElementById("homeMenu");
  menu.style.display = menu.style.display === "block" ? "none" : "block";
}

document.addEventListener("click", function(e) {
  const menu = document.getElementById("homeMenu");
  const btn = document.querySelector(".menu-btn");
  if (menu && !menu.contains(e.target) && !btn?.contains(e.target)) {
    menu.style.display = "none";
  }
});

// ============================================================
// 页面跳转
// ============================================================
function goToRouteEdit() { window.location.href = "pages/route_edit.html"; }
function goToOrderDetail() { window.location.href = "pages/order_detail.html"; }
function goToHistory() { window.location.href = "pages/history.html"; }

// ============================================================
// 退出登录
// ============================================================
function logout() {
  if (confirm("确定退出登录吗？")) {
    Auth.logout();
  }
}

// ============================================================
// 上传弹窗控制
// ============================================================
function toggleUpload() {
  const overlay = document.getElementById("uploadOverlay");
  overlay.style.display = overlay.style.display === "block" ? "none" : "block";
  if (overlay.style.display === "block") {
    const textarea = document.getElementById('manualOrderInput');
    const charCount = document.getElementById('charCount');
    if (textarea && charCount) {
      charCount.textContent = textarea.value.length + ' 字符';
    }
  }
}

// ============================================================
// 三种上传方式
// ============================================================
function triggerUpload(type) {
  const input = document.createElement("input");
  input.type = "file";
  if (type === 'camera') { 
    input.accept = "image/*"; 
    input.capture = "environment"; 
  } else if (type === 'album') { 
    input.accept = "image/*"; 
  } else { 
    input.accept = ".jpg,.png,.jpeg,.pdf,.xls,.xlsx,.csv"; 
  }
  input.click();
  input.onchange = function() {
    if (input.files && input.files[0]) {
      const fileName = input.files[0].name;
      const fileSize = (input.files[0].size / 1024).toFixed(1);
      alert(`✅ 文件已选择: ${fileName}\n大小: ${fileSize} KB`);
      Auth.addLog('文件上传', `上传文件: ${fileName}`);
      const textarea = document.getElementById('manualOrderInput');
      if (textarea) {
        textarea.value += (textarea.value ? '\n' : '') + `📎 ${fileName} | 待解析 | 请手动编辑`;
        const charCount = document.getElementById('charCount');
        if (charCount) charCount.textContent = textarea.value.length + ' 字符';
      }
    }
    toggleUpload();
  };
}

// ============================================================
// 手动录入功能
// ============================================================
async function pasteFromClipboard() {
  try {
    const text = await navigator.clipboard.readText();
    const textarea = document.getElementById('manualOrderInput');
    if (textarea) {
      textarea.value = text;
      const charCount = document.getElementById('charCount');
      if (charCount) charCount.textContent = text.length + ' 字符';
      showToast('✅ 已粘贴剪贴板内容');
    }
  } catch (err) {
    alert('⚠️ 无法读取剪贴板，请手动 Ctrl+V 粘贴');
  }
}

function clearManualInput() {
  if (confirm('确定清空输入内容吗？')) {
    const textarea = document.getElementById('manualOrderInput');
    textarea.value = '';
    const charCount = document.getElementById('charCount');
    if (charCount) charCount.textContent = '0 字符';
    showToast('已清空', 'warning');
  }
}

function loadExampleData() {
  const example = `江北胡汪洋经销商 | 12.5 | 已送达
渝北中景隆贸易有限公司 | 8.3 | 配送中
江北重庆兴农融资担保集团 | 15.6 | 待配送
渝北Q312重庆沁园松石北路店 | 6.2 | 已送达
特渠部重庆明德商业保理有限公司 | 9.8 | 待配送`;
  const textarea = document.getElementById('manualOrderInput');
  textarea.value = example;
  const charCount = document.getElementById('charCount');
  if (charCount) charCount.textContent = example.length + ' 字符';
  showToast('📝 示例数据已加载');
}

function showToast(msg, type = 'success') {
  const toast = document.getElementById('toast');
  if (!toast) {
    const div = document.createElement('div');
    div.id = 'toast';
    div.style.cssText = 'position:fixed;bottom:30px;left:50%;transform:translateX(-50%);background:#18212B;color:#fff;padding:12px 24px;border-radius:12px;z-index:9999;font-size:14px;max-width:90%;text-align:center;border-left:4px solid #27AE60;';
    document.body.appendChild(div);
    div.textContent = msg;
    setTimeout(() => div.remove(), 3000);
    return;
  }
  toast.textContent = msg;
  toast.style.display = 'block';
  toast.className = 'toast show ' + type;
  setTimeout(() => { toast.style.display = 'none'; }, 3000);
}

// ============================================================
// 提交手动录入
// ============================================================
function submitManualOrder() {
  const textarea = document.getElementById('manualOrderInput');
  const rawText = textarea.value.trim();
  
  if (!rawText) {
    alert('⚠️ 请先录入运单数据');
    return;
  }

  const lines = rawText.split('\n').filter(line => line.trim());
  const orders = [];
  
  lines.forEach((line, index) => {
    let parts = line.split(/[|\t]/).map(s => s.trim()).filter(s => s);
    if (parts.length < 2) {
      parts = line.split(/[，,、；;]/).map(s => s.trim()).filter(s => s);
    }
    
    if (parts.length >= 2) {
      const name = parts[0] || `门店_${index + 1}`;
      const weight = parseFloat(parts[1]) || 0;
      const note = parts[2] || '';
      orders.push({ id: Date.now() + index, name, weight, note, status: '待配送' });
    } else if (parts.length === 1) {
      orders.push({ id: Date.now() + index, name: parts[0], weight: 0, note: '', status: '待配送' });
    }
  });

  if (orders.length === 0) {
    alert('⚠️ 未能解析有效数据，请检查格式\n格式示例：门店名称 | 重量(kg) | 备注');
    return;
  }

  saveTodayOrders(orders);
  
  const count = orders.length;
  let totalWeight = 0;
  orders.forEach(order => { totalWeight += order.weight || 0; });
  document.getElementById("storeCount").textContent = count + ' 家门店';
  document.getElementById("totalWeight").textContent = totalWeight.toFixed(1) + ' kg';
  
  updateStatusDot();
  Auth.addLog('运单录入', `录入 ${count} 条运单数据，总重量 ${totalWeight.toFixed(1)} kg`);
  
  toggleUpload();
  alert(`✅ 运单录入成功！\n共录入 ${count} 家门店\n总重量：${totalWeight.toFixed(1)} kg`);
  
  textarea.value = '';
  const charCount = document.getElementById('charCount');
  if (charCount) charCount.textContent = '0 字符';
}

document.getElementById('uploadOverlay').addEventListener('click', function(e) {
  if (e.target === this) {
    toggleUpload();
  }
});

// ============================================================
// 兼容原有函数
// ============================================================
function openTodayRoute() {
  window.location.href = "pages/order_detail.html";
}

function openHistory() {
  window.location.href = "pages/history.html";
}
