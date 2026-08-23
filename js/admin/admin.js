// js/admin/admin.js
// 管理中心主入口

// ============================================================
// 数据库操作（保留在全局）
// ============================================================
const DB = {
  get(key, defaultVal) {
    try {
      const data = localStorage.getItem(`admin_${key}`);
      return data ? JSON.parse(data) : defaultVal;
    } catch { return defaultVal; }
  },
  set(key, val) {
    localStorage.setItem(`admin_${key}`, JSON.stringify(val));
    updateStats();
    if (key === 'users') {
      syncUsersToUpstash(val);
    }
  },
  addLog(action, detail) {
    const logs = this.get('logs', []);
    logs.unshift({
      id: Date.now(),
      time: new Date().toLocaleString(),
      action,
      detail,
      user: Auth.getCurrentRoute()
    });
    if (logs.length > 100) logs.length = 100;
    this.set('logs', logs);
  }
};

// ============================================================
// 同步用户数据到 Upstash
// ============================================================
function syncUsersToUpstash(users) {
  fetch('/api/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ users })
  }).then(res => {
    if (res.ok) console.log('用户数据已同步到 Upstash');
  }).catch(e => console.log('Upstash 同步失败，数据已保存在本地'));
}

// ============================================================
// 获取统一密码
// ============================================================
function getUnifiedPassword() {
  return localStorage.getItem('unified_password') || 'tianyou2024';
}

// ============================================================
// 线路格式转换
// ============================================================
function formatRouteCode(input) {
  if (!input) return '';
  const num = parseInt(input.trim());
  if (isNaN(num) || num < 1) return '';
  return String(num).padStart(2, '0') + '号线';
}

// ============================================================
// 检查线路是否已注册
// ============================================================
async function isRouteRegistered(route) {
  const user = await Auth.findUserByRoute(route);
  return user !== null;
}

// ============================================================
// 通用弹窗控制
// ============================================================
function openDialog(id) {
  document.getElementById(id).classList.add('active');
}
function closeDialog(id) {
  document.getElementById(id).classList.remove('active');
}

// ============================================================
// Toast提示
// ============================================================
function showToast(msg, type = 'success') {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.className = 'toast show ' + type;
  setTimeout(() => toast.classList.remove('show'), 3000);
}

// ============================================================
// 更新统计
// ============================================================
function updateStats() {
  const users = DB.get('users', []);
  const vehicles = DB.get('vehicles', []);
  const logs = DB.get('logs', []);
  const stores = JSON.parse(localStorage.getItem('base_data') || '[]');

  document.getElementById('statUsers').textContent = users.length;
  document.getElementById('statVehicles').textContent = vehicles.filter(v => v.status === 'active').length;
  document.getElementById('statStores').textContent = stores.length;
  document.getElementById('statLogs').textContent = logs.length;
  document.getElementById('userBadge').textContent = users.length;
  document.getElementById('vehicleBadge').textContent = vehicles.filter(v => v.status === 'active').length;

  const ocr = DB.get('ocr', []);
  document.getElementById('ocrBadge').textContent = ocr.filter(o => o.status === 'pending').length;
  document.getElementById('logBadge').textContent = logs.length;
}

// ============================================================
// 初始化
// ============================================================
async function initAdmin() {
  if (!Auth.checkAuth()) return;

  // 先尝试从 Upstash 加载用户数据
  const users = await Auth.fetchUsersFromUpstash();
  if (users && users.length > 0) {
    DB.set('users', users);
  }

  // 初始化默认数据
  if (!localStorage.getItem('admin_vehicles')) {
    DB.set('vehicles', [{ id: 1, plate: '渝DK7692', route: '17号线', status: 'active' }]);
  }
  if (!localStorage.getItem('admin_ocr')) {
    DB.set('ocr', [{
      id: 1,
      image: '运单_001.jpg',
      error: '门店名称识别错误',
      correct: '江北胡汪洋经销商',
      status: 'pending',
      time: new Date().toLocaleString()
    }]);
  }
  if (!localStorage.getItem('admin_backups')) {
    DB.set('backups', []);
  }
  if (!localStorage.getItem('admin_logs') || DB.get('logs', []).length === 0) {
    DB.set('logs', [{
      id: 1,
      time: new Date().toLocaleString(),
      action: '系统初始化',
      detail: '管理中心已启动',
      user: 'system'
    }]);
  }

  updateStats();
}

// ============================================================
// 退出登录
// ============================================================
function logout() {
  if (confirm('确定退出登录吗？')) {
    Auth.logout();
  }
}

// ============================================================
// 原始数据 - 选择线路
// ============================================================
function openRouteSelectDialog() {
  document.getElementById('routeSelectInput').value = '';
  openDialog('routeSelectDialog');
}

async function confirmRouteSelect() {
  const rawInput = document.getElementById('routeSelectInput').value.trim();
  if (!rawInput) { showToast('请输入线路编号', 'error'); return; }
  const route = formatRouteCode(rawInput);
  if (!route) { showToast('请输入有效数字 (如 1, 17, 105)', 'error'); return; }
  const registered = await isRouteRegistered(route);
  if (!registered) { showToast('该线路未开通', 'error'); return; }
  closeDialog('routeSelectDialog');
  window.location.href = `pages/route_edit.html?route=${encodeURIComponent(route)}&from=admin`;
}

// 回车触发线路选择确认
document.addEventListener('keydown', function(e) {
  if (e.key === 'Enter') {
    const dialog = document.getElementById('routeSelectDialog');
    if (dialog.classList.contains('active')) {
      confirmRouteSelect();
    }
  }
});

// ============================================================
// 页面初始化
// ============================================================
document.addEventListener('DOMContentLoaded', initAdmin);

// 暴露全局函数
window.openDialog = openDialog;
window.closeDialog = closeDialog;
window.showToast = showToast;
window.updateStats = updateStats;
window.logout = logout;
window.openRouteSelectDialog = openRouteSelectDialog;
window.confirmRouteSelect = confirmRouteSelect;
window.formatRouteCode = formatRouteCode;
window.isRouteRegistered = isRouteRegistered;
window.getUnifiedPassword = getUnifiedPassword;
window.DB = DB;