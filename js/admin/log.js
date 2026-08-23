// js/admin/log.js
// 日志管理模块

// ============================================================
// 打开日志管理
// ============================================================
function openLogManagement() {
  openDialog('logDialog');
  renderLogs();
}

// ============================================================
// 渲染日志列表
// ============================================================
function renderLogs(filter = '') {
  let logs = DB.get('logs', []);
  if (filter) logs = logs.filter(l => l.action.includes(filter) || l.detail.includes(filter) || l.user.includes(filter));
  const container = document.getElementById('logList');
  if (!logs.length) {
    container.innerHTML = '<div class="admin-empty">暂无日志</div>';
    return;
  }
  container.innerHTML = logs.map(l => `
    <div class="admin-list-item">
      <div class="info">
        <div class="name">${l.action}</div>
        <div class="sub">${l.detail} · ${l.user}</div>
      </div>
      <div style="font-size:12px;color:#7F8B98;">${l.time}</div>
    </div>
  `).join('');
}

function filterLogs() {
  renderLogs(document.getElementById('logSearch').value.trim());
}

// ============================================================
// 清空日志
// ============================================================
function clearLogs() {
  if (!confirm('确定清空所有日志吗？')) return;
  DB.set('logs', []);
  showToast('日志已清空', 'warning');
  renderLogs();
}

// ============================================================
// 导出日志
// ============================================================
function exportLogs() {
  const logs = DB.get('logs', []);
  if (!logs.length) { showToast('暂无日志', 'warning'); return; }
  const blob = new Blob([JSON.stringify(logs, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `logs_${new Date().toISOString().split('T')[0]}.json`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('日志导出成功');
}

// 暴露全局函数
window.openLogManagement = openLogManagement;
window.renderLogs = renderLogs;
window.filterLogs = filterLogs;
window.clearLogs = clearLogs;
window.exportLogs = exportLogs;