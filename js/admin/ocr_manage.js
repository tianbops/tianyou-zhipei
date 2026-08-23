// js/admin/ocr_manage.js
// OCR优化管理模块

let currentOCRId = null;
let ocrFilter = 'pending';

// ============================================================
// 打开OCR管理
// ============================================================
function openOCRManagement() {
  openDialog('ocrDialog');
  renderOCR();
}

// ============================================================
// 切换标签
// ============================================================
function switchOCRtab(tab) {
  ocrFilter = tab;
  document.querySelectorAll('.admin-tabs button').forEach(btn => btn.classList.remove('active'));
  event.target.classList.add('active');
  renderOCR();
}

// ============================================================
// 渲染OCR列表
// ============================================================
function renderOCR() {
  let ocrs = DB.get('ocr', []);
  let filtered = ocrs.filter(o => o.status === ocrFilter);
  document.getElementById('ocrPendingCount').textContent = ocrs.filter(o => o.status === 'pending').length;
  document.getElementById('ocrResolvedCount').textContent = ocrs.filter(o => o.status === 'resolved').length;
  const container = document.getElementById('ocrList');
  if (!filtered.length) {
    container.innerHTML = '<div class="admin-empty">暂无反馈记录</div>';
    return;
  }
  container.innerHTML = filtered.map(o => `
    <div class="admin-list-item" onclick="viewOCRDetail(${o.id})" style="cursor:pointer;">
      <div class="info">
        <div class="name">${o.image}</div>
        <div class="sub">${o.error} → ${o.correct}</div>
      </div>
      <div style="font-size:12px;color:#7F8B98;">${o.time}</div>
    </div>
  `).join('');
}

// ============================================================
// 查看详情
// ============================================================
function viewOCRDetail(id) {
  const ocrs = DB.get('ocr', []);
  const ocr = ocrs.find(o => o.id === id);
  if (!ocr) return;
  currentOCRId = id;
  document.getElementById('ocrDetailContent').innerHTML = `
    <div style="background:#05070A;padding:16px;border-radius:12px;margin-bottom:12px;">
      <div><strong>图片：</strong>${ocr.image}</div>
      <div><strong>错误识别：</strong><span style="color:#E74C3C;">${ocr.error}</span></div>
      <div><strong>正确值：</strong><span style="color:#27AE60;">${ocr.correct}</span></div>
      <div><strong>状态：</strong>${ocr.status === 'pending' ? '⏳ 待处理' : '✅ 已解决'}</div>
      <div><strong>时间：</strong>${ocr.time}</div>
    </div>
  `;
  openDialog('ocrDetailDialog');
}

// ============================================================
// 标记已解决
// ============================================================
function resolveOCR() {
  if (!currentOCRId || !confirm('标记该反馈为已解决？')) return;
  let ocrs = DB.get('ocr', []);
  const idx = ocrs.findIndex(o => o.id === currentOCRId);
  if (idx !== -1) {
    ocrs[idx].status = 'resolved';
    DB.set('ocr', ocrs);
    DB.addLog('OCR处理', '解决OCR反馈');
    showToast('已标记为已解决');
    closeDialog('ocrDetailDialog');
    renderOCR();
  }
}

// ============================================================
// 导出反馈
// ============================================================
function exportOCRData() {
  const ocrs = DB.get('ocr', []);
  if (!ocrs.length) { showToast('暂无数据', 'warning'); return; }
  const blob = new Blob([JSON.stringify(ocrs, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `ocr_feedback_${new Date().toISOString().split('T')[0]}.json`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('导出成功');
}

// 暴露全局函数
window.openOCRManagement = openOCRManagement;
window.switchOCRtab = switchOCRtab;
window.renderOCR = renderOCR;
window.viewOCRDetail = viewOCRDetail;
window.resolveOCR = resolveOCR;
window.exportOCRData = exportOCRData;