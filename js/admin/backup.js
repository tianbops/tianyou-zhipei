// js/admin/backup.js
// 备份管理模块

// ============================================================
// 打开备份管理
// ============================================================
function openBackupManagement() {
  openDialog('backupDialog');
  renderBackups();
}

// ============================================================
// 渲染备份列表
// ============================================================
function renderBackups() {
  const backups = DB.get('backups', []);
  const container = document.getElementById('backupList');
  if (!backups.length) {
    container.innerHTML = '<div class="admin-empty">暂无备份</div>';
    return;
  }
  container.innerHTML = backups.map(b => `
    <div class="admin-list-item">
      <div class="info">
        <div class="name">${b.name}</div>
        <div class="sub">${b.time} · ${b.size}</div>
      </div>
      <div class="actions">
        <button class="edit-btn" onclick="restoreBackup(${b.id})">恢复</button>
        <button class="del-btn" onclick="deleteBackup(${b.id})">删除</button>
      </div>
    </div>
  `).join('');
}

// ============================================================
// 创建备份
// ============================================================
function createBackup() {
  const data = {
    users: DB.get('users', []),
    vehicles: DB.get('vehicles', []),
    ocr: DB.get('ocr', []),
    stores: JSON.parse(localStorage.getItem('base_data') || '[]')
  };
  const size = (JSON.stringify(data).length / 1024).toFixed(1) + 'KB';
  const backups = DB.get('backups', []);
  backups.unshift({
    id: Date.now(),
    name: `备份_${new Date().toISOString().split('T')[0]}`,
    time: new Date().toLocaleString(),
    size,
    data
  });
  if (backups.length > 20) backups.length = 20;
  DB.set('backups', backups);
  DB.addLog('备份创建', '创建数据备份');
  showToast('备份创建成功');
  renderBackups();
}

// ============================================================
// 恢复备份
// ============================================================
function restoreBackup(id) {
  if (!confirm('恢复备份将覆盖当前数据，确定继续？')) return;
  const backups = DB.get('backups', []);
  const backup = backups.find(b => b.id === id);
  if (!backup?.data) { showToast('备份数据无效', 'error'); return; }
  DB.set('users', backup.data.users || []);
  DB.set('vehicles', backup.data.vehicles || []);
  DB.set('ocr', backup.data.ocr || []);
  if (backup.data.stores) localStorage.setItem('base_data', JSON.stringify(backup.data.stores));
  DB.addLog('备份恢复', `恢复备份: ${backup.name}`);
  showToast('备份恢复成功');
  updateStats();
}

// ============================================================
// 删除备份
// ============================================================
function deleteBackup(id) {
  if (!confirm('确定删除该备份？')) return;
  let backups = DB.get('backups', []);
  backups = backups.filter(b => b.id !== id);
  DB.set('backups', backups);
  showToast('备份已删除', 'warning');
  renderBackups();
}

// ============================================================
// 导出全部数据
// ============================================================
function exportAllData() {
  const data = {
    users: DB.get('users', []),
    vehicles: DB.get('vehicles', []),
    ocr: DB.get('ocr', []),
    stores: JSON.parse(localStorage.getItem('base_data') || '[]'),
    logs: DB.get('logs', []),
    exportTime: new Date().toISOString()
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `full_backup_${new Date().toISOString().split('T')[0]}.json`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('数据导出成功');
}

// ============================================================
// 导入数据
// ============================================================
function importData(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function(e) {
    try {
      const data = JSON.parse(e.target.result);
      if (data.users) DB.set('users', data.users);
      if (data.vehicles) DB.set('vehicles', data.vehicles);
      if (data.ocr) DB.set('ocr', data.ocr);
      if (data.stores) localStorage.setItem('base_data', JSON.stringify(data.stores));
      if (data.logs) DB.set('logs', data.logs);
      DB.addLog('数据导入', '导入数据备份');
      showToast('数据导入成功');
      updateStats();
      renderBackups();
    } catch (err) {
      showToast('导入失败: ' + err.message, 'error');
    }
  };
  reader.readAsText(file);
  event.target.value = '';
}

// 暴露全局函数
window.openBackupManagement = openBackupManagement;
window.renderBackups = renderBackups;
window.createBackup = createBackup;
window.restoreBackup = restoreBackup;
window.deleteBackup = deleteBackup;
window.exportAllData = exportAllData;
window.importData = importData;