/* 天友智配One - 浏览器本地 PaddleOCR
 * 只负责：图片 → 原始文字。
 * 图片不上传服务器、不保存原图、不参与门店匹配。
 */
import { PaddleOCR } from 'https://esm.unpkg.com/@paddleocr/paddleocr-js@0.4.2';

(() => {
  'use strict';

  const MAX_SIDE = 2600;
  const JPEG_QUALITY = 0.92;
  const OCR_SCORE = 0.35;
  let enginePromise = null;
  let busy = false;
  const $ = (id) => document.getElementById(id);

  function normalizeText(value) {
    return String(value ?? '')
      .replace(/\r\n?/g, '\n')
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .join('\n')
      .trim();
  }

  function setStatus(text, progress = 0, done = false, error = false) {
    $('parseStatus')?.classList.add('active');
    if ($('statusIcon')) $('statusIcon').textContent = error ? '⚠️' : done ? '✅' : '⏳';
    if ($('statusText')) $('statusText').textContent = text;
    if ($('progressBar')) $('progressBar').style.width = `${Math.max(0, Math.min(100, progress))}%`;
    if ($('statusCount') && !done) $('statusCount').textContent = '';
  }

  function notify(message) {
    if (typeof window.homeToast === 'function') window.homeToast(message, 'warning');
    else if (typeof window.showError === 'function') window.showError(message);
    else alert(message);
  }

  function isPlaceholder(text) {
    const value = normalizeText(text).replace(/[“”"'`]/g, '').replace(/\s+/g, '');
    if (!value) return true;
    return [
      '这里放整张图片的完整文字', '这里放整张图片的完整原始文字',
      '请提供您需要识别的图片', '请上传您需要识别的图片',
      '请上传需要识别的图片', '请提供图片', '请上传图片',
      '图片无法读取', '请重新上传图片'
    ].some((item) => value === item || value.includes(item));
  }

  async function loadEngine() {
    if (enginePromise) return enginePromise;
    setStatus('正在加载中文OCR模型，首次使用需要一点时间…', 10);

    enginePromise = PaddleOCR.create({
      lang: 'ch',
      ocrVersion: 'PP-OCRv5',
      worker: true,
      textDetectionBatchSize: 1,
      textRecognitionBatchSize: 6,
      ortOptions: {
        backend: 'wasm',
        wasmPaths: 'https://cdn.jsdelivr.net/npm/onnxruntime-web/dist/',
        numThreads: 2,
        simd: true
      }
    }).catch((error) => {
      enginePromise = null;
      throw error;
    });

    return enginePromise;
  }

  async function readImage(file) {
    if (typeof createImageBitmap === 'function') {
      try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch (_) {}
    }
    const url = URL.createObjectURL(file);
    try {
      return await new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error('图片读取失败'));
        image.src = url;
      });
    } finally { URL.revokeObjectURL(url); }
  }

  async function prepareImage(file) {
    const image = await readImage(file);
    const width = image.width || image.naturalWidth;
    const height = image.height || image.naturalHeight;
    if (!width || !height) throw new Error('无法读取图片尺寸');

    const scale = Math.min(1, MAX_SIDE / Math.max(width, height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));

    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('浏览器不支持图片处理');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    image.close?.();

    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('图片处理失败')), 'image/jpeg', JPEG_QUALITY);
    });
  }

  function sortItems(items) {
    return [...items].sort((a, b) => {
      const box = (item) => {
        const poly = Array.isArray(item?.poly) ? item.poly : [];
        return {
          x: poly.length ? Math.min(...poly.map((p) => Number(p?.[0] ?? 0))) : 0,
          y: poly.length ? Math.min(...poly.map((p) => Number(p?.[1] ?? 0))) : 0
        };
      };
      const A = box(a), B = box(b);
      return Math.abs(A.y - B.y) <= 24 ? A.x - B.x : A.y - B.y;
    });
  }

  function resultToText(result) {
    const items = Array.isArray(result?.items) ? sortItems(result.items) : [];
    return normalizeText(items.filter((item) => String(item?.text ?? '').trim()).map((item) => item.text).join('\n'));
  }

  function putText(text) {
    const input = $('manualOrderInput');
    if (!input) return;
    input.value = text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.scrollTop = 0;
    if ($('charCount')) $('charCount').textContent = String(text.length);
  }

  async function process(file) {
    if (busy) return;
    busy = true;
    try {
      if (!file || !String(file.type).startsWith('image/')) throw new Error('请选择有效的运单图片');

      setStatus('正在准备运单图片…', 15);
      const blob = await prepareImage(file);
      setStatus('正在启动本地 PaddleOCR…', 25);
      const ocr = await loadEngine();
      setStatus('正在本地识别运单文字…', 45);

      const [result] = await ocr.predict(blob, { textRecScoreThresh: OCR_SCORE });
      const text = resultToText(result);
      if (!text || isPlaceholder(text)) throw new Error('没有识别到有效文字，请重新拍摄清晰、完整的运单图片');

      putText(text);
      const count = Array.isArray(result?.items) ? result.items.length : 0;
      setStatus(`本地OCR识别完成，共识别 ${count} 行文字`, 100, true);
      window.homeToast?.('运单文字已在本机完成识别，请核对后再开始解析');
      return { rawText: text, source: 'paddleocr-browser', itemCount: count, metrics: result?.metrics || null };
    } catch (error) {
      console.error('[PaddleOCR]', error);
      setStatus(error?.message || 'OCR识别失败', 100, false, true);
      notify(error?.message || '运单图片识别失败');
      throw error;
    } finally { busy = false; }
  }

  window.callOCR = process;

  window.triggerUpload = function(type) {
    if (busy) return;
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    if (type === 'camera') input.capture = 'environment';
    input.style.display = 'none';
    input.onchange = () => {
      const file = input.files?.[0];
      if (file) process(file).catch(() => {});
    };
    document.body.appendChild(input);
    input.click();
    setTimeout(() => input.remove(), 2000);
  };

  window.triggerCameraUpload = () => window.triggerUpload('camera');
})();
