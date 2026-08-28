// js/admin/admin.js
// 管理中心主入口
// 用户真实数据以服务器为准；localStorage 只作为界面缓存。

const DB = {
  get(key, defaultVal) {
    try { const data = localStorage.getItem(`admin_${key}`); return data ? JSON.parse(data) : defaultVal; }
    catch { return defaultVal; }
  },
  set(key, val) {
    localStorage.setItem(`admin_${key}`, JSON.stringify(val));
    updateStats();
    if (key === 'users') syncUsersToUpstash(val);
  },
  addLog(action, detail) {
    const logs = this.get('logs', []);
    logs.unshift({ id: Date.now(), time: new Date().toLocaleString(), action, detail, user: Auth.getCurrentRoute() });
    if (logs.length > 100) logs.length = 100;
    this.set('logs', logs);
  }
};

function authHeaders() { return Auth.getAuthHeaders ? Auth.getAuthHeaders() : {}; }

async function syncUsersToUpstash(users) {
  try {
    const response = await fetch('/api/users', {
      method: 'POST', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ users })
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    console.log('用户数据已保存到服务器');
  } catch (e) {
    console.error('服务器用户数据保存失败', e);
    showToast('服务器保存失败，请联网后重试', 'error');
  }
}

// 管理员统一修改全部普通用户密码；服务器执行，不修改管理员密码。
async function updateUnifiedPassword(password) {
  const value = String(password || '').trim();
  if (value.length < 6) throw new Error('统一密码至少需要6位');
  const response = await fetch('/api/users-unified-password', {
    method: 'POST', cache: 'no-store',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ password: value })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.success) throw new Error(data.error || '统一密码更新失败');
  localStorage.removeItem('unified_password');
  showToast(data.message || `已更新 ${data.updated || 0} 个普通用户密码`, 'success');
  return data;
}

// 旧页面可能仍调用此名称；密码绝不从浏览器返回。
function getUnifiedPassword() { return ''; }

function formatRouteCode(input) {
  if (!input) return '';
  const num = parseInt(String(input).trim());
  if (isNaN(num) || num < 1) return '';
  return String(num).padStart(2, '0') + '号线';
}

async function isRouteRegistered(route) {
  const user = await Auth.findUserByRoute(route);
  return user !== null;
}

function openDialog(id) { document.getElementById(id).classList.add('active'); }
function closeDialog(id) { document.getElementById(id).classList.remove('active'); }

function showToast(msg, type = 'success') {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = msg;
  toast.className = 'toast show ' + type;
  setTimeout(() => toast.classList.remove('show'), 3000);
}

function updateStats() {
  const users = DB.get('users', []), vehicles = DB.get('vehicles', []), logs = DB.get('logs', []);
  let stores = [];
  try { stores = JSON.parse(localStorage.getItem('base_data') || '[]'); } catch {}
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

async function initAdmin() {
  if (!Auth.checkAuth()) return;
  try {
    const users = await Auth.fetchUsersFromUpstash();
    if (!Array.isArray(users)) throw new Error('服务器未返回用户数据');
    localStorage.setItem('admin_users', JSON.stringify(users));
  } catch (e) {
    console.error(e);
    showToast('用户信息加载失败，请联网后重试', 'error');
  }
  if (!localStorage.getItem('admin_vehicles')) localStorage.setItem('admin_vehicles', JSON.stringify([{ id: 1, plate: '渝DK7692', route: '17号线', status: 'active' }]));
  if (!localStorage.getItem('admin_ocr')) localStorage.setItem('admin_ocr', JSON.stringify([{ id: 1, image: '运单_001.jpg', error: '门店名称识别错误', correct: '江北胡汪洋经销商', status: 'pending', time: new Date().toLocaleString() }]));
  if (!localStorage.getItem('admin_backups')) localStorage.setItem('admin_backups', JSON.stringify([]));
  if (!localStorage.getItem('admin_logs')) localStorage.setItem('admin_logs', JSON.stringify([{ id: 1, time: new Date().toLocaleString(), action: '系统初始化', detail: '管理中心已启动', user: 'system' }]));
  updateStats();
}

function logout() { if (confirm('确定退出登录吗？')) Auth.logout(); }

function openRouteSelectDialog() { document.getElementById('routeSelectInput').value = ''; openDialog('routeSelectDialog'); }

async function confirmRouteSelect() {
  const rawInput = document.getElementById('routeSelectInput').value.trim();
  if (!rawInput) { showToast('请输入线路编号', 'error'); return; }
  const route = formatRouteCode(rawInput);
  if (!route) { showToast('请输入有效数字 (如 1, 17, 105)', 'error'); return; }
  try {
    if (!await isRouteRegistered(route)) { showToast('该线路未开通', 'error'); return; }
    closeDialog('routeSelectDialog');
    window.location.href = `pages/route_edit.html?route=${encodeURIComponent(route)}&from=admin`;
  } catch { showToast('线路信息读取失败，请联网后重试', 'error'); }
}

document.addEventListener('keydown', function(e) {
  if (e.key !== 'Enter') return;
  const dialog = document.getElementById('routeSelectDialog');
  if (dialog && dialog.classList.contains('active')) confirmRouteSelect();
});

document.addEventListener('DOMContentLoaded', initAdmin);

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
window.updateUnifiedPassword = updateUnifiedPassword;
window.DB = DB;
