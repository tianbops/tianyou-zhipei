/* Zhipei One - 首页状态提示统一显示 */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  function setError(message) {
    const text = String(message || '').trim();
    const row = $('statusError');
    if (!row) return;
    row.textContent = text ? `⚠️ ${text}` : '';
    row.classList.toggle('active', !!text);
  }

  function clearError() {
    setError('');
  }

  window.setHomeStatusError = setError;
  window.clearHomeStatusError = clearError;

  function observeToast() {
    const sync = () => {
      const toast = $('homeToast');
      if (!toast) return;
      const message = String(toast.textContent || '').trim();
      const visible = toast.classList.contains('show');
      if (visible && message) setError(message);
      toast.classList.remove('show');
    };

    const bodyObserver = new MutationObserver(sync);
    bodyObserver.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    sync();
  }

  function observePageError() {
    const box = $('error-box');
    if (!box) return;
    const observer = new MutationObserver(() => {
      const message = String(box.textContent || '').replace(/^页面错误：/, '').trim();
      if (message) {
        setError(message);
        box.classList.remove('show');
      }
    });
    observer.observe(box, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['class'] });
  }

  document.addEventListener('DOMContentLoaded', () => {
    observeToast();
    observePageError();
  }, { once: true });
})();
