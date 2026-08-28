// js/admin/ocr_manage.js
// OCR优化管理模块：数据来自服务器管理数据 API，不使用浏览器持久化。

let currentOCRId = null;
let ocrFilter = 'pending';

function openOCRManagement() {
  openDialog('ocrDialog');
  renderOCR();
}

function switchOCRtab(tab, button) {
  ocrFilter = tab;
  document.querySelectorAll('.admin-tabs button').forEach(btn => btn.classList.remove('active'));
  if (button) button.classList.add('active');
  renderOCR();
}

function escapeHTML(value) {
  return String(value ?? '').replace(/[&<>'"]/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  })[ch]);
}

function renderOCR() {
  const ocrs = DB.get('ocr', []);
  const filtered = ocrs.filter(o => o.status === ocrFilter);
  const pending = document.getElementById('ocrPendingCount');
  const resolved = document.getElementById('ocrResolvedCount');
  const container = document.getElementById('ocrList');
  if (pending) pending.textContent = ocrs.filter(o => o.status === 'pending').length;
  if (resolved) resolved.textContent = ocrs.filter(o => o.status === 'resolved').length;
  if (!container) return;
  if (!filtered.length) {
    container.innerHTML = '<div class="admin-empty">暂无反馈记录</div>';
    return;
  }
  container.innerHTML = filtered.map(o => `
    <div class="admin-list-item" data-ocr-id="${escapeHTML(o.id)}" style="cursor:pointer;">
      <div class="info">
        <div class="name">${escapeHTML(o.image)}</div>
        <div class="sub">${escapeHTML(o.error)} → ${escapeHTML(o.correct)}</div>
      </div>
      <div style="font-size:12px;color:#7F8B98;">${escapeHTML(o.time)}</div>
    </div>
  `).join('');
  container.querySelectorAll('[data-ocr-id]').forEach(el => {
    el.addEventListener('click', () => viewOCRDetail(el.dataset.ocrId));
  });
}

function viewOCRDetail(id) {
  const ocrs = DB.get('ocr', []);
  const ocr = ocrs.find(o => String(o.id) === String(id));
  if (!ocr) return;
  currentOCRId = ocr.id;
  const content = document.getElementById('ocrDetailContent');
  if (!content) return;
  content.innerHTML = `
    <div style="background:#05070A;padding:16px;border-radius:12px;margin-bottom:12px;">
      <div><strong>图片：</strong>${escapeHTML(ocr.image)}</div>
      <div><strong>错误识别：</strong><span style="color:#E74C3C;">${escapeHTML(ocr.error)}</span></div>
      <div><strong>正确值：</strong><span style="color:#27AE60;">${escapeHTML(ocr.correct)}</span></div>
      <div><strong>状态：</strong>${ocr.status === 'pending' ? '⏳ 待处理' : '✅ 已解决'}</div>
      <div><strong>时间：</strong>${escapeHTML(ocr.time)}</div>
    </div>
  `;
  openDialog('ocrDetailDialog');
}

function resolveOCR() {
  if (currentOCRId === null || !confirm('标记该反馈为已解决？')) return;
  const ocrs = DB.get('ocr', []).map(o => String(o.id) === String(currentOCRId) ? { ...o, status: 'resolved' } : o);
  DB.set('ocr', ocrs);
  DB.addLog('OCR处理', '解决OCR反馈');
  showToast('已标记为已解决');
  closeDialog('ocrDetailDialog');
  renderOCR();
}

function exportOCRData() {
  const ocrs = DB.get('ocr', []);
  if (!ocrs.length) { showToast('暂无数据', 'warning'); return; }
  const blob = new Blob([JSON.stringify(ocrs, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `ocr_feedback_${new Date().toISOString().split('T')[0]}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast('导出成功');
}

window.openOCRManagement = openOCRManagement;
window.switchOCRtab = switchOCRtab;
window.renderOCR = renderOCR;
window.viewOCRDetail = viewOCRDetail;
window.resolveOCR = resolveOCR;
window.exportOCRData = exportOCRData;
