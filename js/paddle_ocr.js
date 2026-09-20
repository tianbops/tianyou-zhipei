/* Zhipei One - 浏览器本地 PaddleOCR
 * 只负责：图片 → 原始文字。
 * 图片不上传服务器、不保存原图、不参与门店匹配。
 */
(() => {
  'use strict';

  const MAX_SIDE = 3000;
  const JPEG_QUALITY = 0.95;
  const OCR_SCORE = 0.25;
  // P0测试：OCR单次提取最多等待2分钟，用于验证完整识别能力。
  const OCR_TIMEOUT_MS = 120000;
  const OCR_SDK_URL = 'https://cdn.jsdelivr.net/npm/@paddleocr/paddleocr-js@0.4.2/+esm';
  const OCR_WORKER_URL = '/api/paddleocr-worker';

  let enginePromise = null;
  let sdkPromise = null;
  let engineInstance = null;
  let busy = false;
  let cancelRequested = false;
  let operationId = 0;
  let warmingUp = false;
  const $ = (id) => document.getElementById(id);

  function normalizeText(value) {
    return String(value ?? '')
      .replace(/\r\n?/g, '\n')
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)
      .join('\n')
      .trim();
  }
  function setStatus(text, progress = 0, done = false, error = false, cancelled = false) {
    window.renderUnifiedStatus?.(cancelled ? 'cancelled' : error ? 'error' : done ? 'success' : 'loading', progress, text);
  }

  function isPlaceholder(text) {
    const value = normalizeText(text).replace(/[“”\"'\`]/g, '').replace(/\s+/g, '');
    if (!value) return true;
    return [
      '这里放整张图片的完整文字', '这里放整张图片的完整原始文字',
      '请提供您需要识别的图片', '请上传您需要识别的图片',
      '请上传需要识别的图片', '请提供图片', '请上传图片',
      '图片无法读取', '请重新上传图片'
    ].some(item => value === item || value.includes(item));
  }

  async function loadSdk() {
    if (sdkPromise) return sdkPromise;
    if (!warmingUp) setStatus('正在准备识别功能…', 28);
    sdkPromise = import(OCR_SDK_URL).then(module => {
      if (!module?.PaddleOCR) throw new Error('识别功能加载失败，请检查网络后重试');
      return module.PaddleOCR;
    }).catch(error => {
      sdkPromise = null;
      throw error;
    });
    return sdkPromise;
  }

  async function loadEngine() {
    if (enginePromise) return enginePromise;
    const PaddleOCR = await loadSdk();
    if (!warmingUp) setStatus('正在准备文字识别…', 35);
    enginePromise = PaddleOCR.create({
      lang: 'ch',
      ocrVersion: 'PP-OCRv5',
      // 手机端正式稳定模式：OCR直接在主线程运行，避免自定义Module Worker
      // 在部分Android WebView/浏览器中出现 Failed to fetch。
      // 先保证模型稳定加载和识别，再由后续维护阶段做运行时优化。
      worker: false,
      textDetectionBatchSize: 1,
      textRecognitionBatchSize: 4,
      ortOptions: {
        backend: 'wasm',
        wasmPaths: 'https://cdn.jsdelivr.net/npm/onnxruntime-web/dist/',
        numThreads: 1,
        simd: true,
        proxy: false
      }
    }).then(engine => {
      engineInstance = engine;
      return engine;
    }).catch(error => {
      enginePromise = null;
      engineInstance = null;
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
    } finally {
      URL.revokeObjectURL(url);
    }
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
      canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('图片处理失败')), 'image/jpeg', JPEG_QUALITY);
    });
  }

  function boxInfo(item) {
    const poly = Array.isArray(item?.poly) ? item.poly : [];
    if (!poly.length) return { x: 0, y: 0, h: 20 };
    const xs = poly.map(p => Number(p?.[0] ?? 0));
    const ys = poly.map(p => Number(p?.[1] ?? 0));
    return { x: Math.min(...xs), y: Math.min(...ys), h: Math.max(8, Math.max(...ys) - Math.min(...ys)) };
  }

  function sortItems(items) {
    const prepared = items.map((item, index) => ({ item, index, box: boxInfo(item) }));
    const heights = prepared.map(x => x.box.h).sort((a, b) => a - b);
    const medianHeight = heights.length ? heights[Math.floor(heights.length / 2)] : 20;
    const rowTolerance = Math.max(10, Math.min(80, medianHeight * 0.65));
    prepared.sort((a, b) => {
      const ay = a.box.y;
      const by = b.box.y;
      if (Math.abs(ay - by) <= rowTolerance) return a.box.x - b.box.x || a.index - b.index;
      return ay - by || a.index - b.index;
    });
    return prepared.map(x => x.item);
  }

  function resultToText(result) {
    const items = Array.isArray(result?.items) ? sortItems(result.items) : [];
    return normalizeText(items.filter(item => String(item?.text ?? '').trim()).map(item => item.text).join('\n'));
  }

  function putText(text) {
    const input = $('manualOrderInput');
    if (!input) return;
    input.value = text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.scrollTop = 0;
  }

  async function process(file, options = {}) {
    if (busy) return;
    busy = true;
    cancelRequested = false;
    const currentOperation = ++operationId;
    const deadline = Date.now() + OCR_TIMEOUT_MS;

    const run = async () => {
      if (!file || !String(file.type).startsWith('image/')) throw new Error('请选择有效的运单图片');
      setStatus(options.batch ? ('正在读取第 ' + options.index + '/' + options.total + ' 张运单…') : '正在准备运单图片…', 15);
      const blob = await prepareImage(file);
      setStatus(options.batch ? ('正在识别第 ' + options.index + '/' + options.total + ' 张运单…') : '正在准备文字识别…', 25);
      const ocr = await loadEngine();
      setStatus(options.batch ? ('正在读取第 ' + options.index + '/' + options.total + ' 张运单…') : '正在读取运单文字…', 55);

      const remaining = Math.max(1, deadline - Date.now());
      const [result] = await Promise.race([
        ocr.predict(blob, { textRecScoreThresh: OCR_SCORE }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('读取运单时间较长，请重新尝试')), remaining))
      ]);
      if (currentOperation !== operationId || cancelRequested) throw new Error('已取消');
      const text = resultToText(result);
      if (!text || isPlaceholder(text)) throw new Error('没有识别到有效文字，请重新拍摄清晰、完整的运单图片');
      const count = Array.isArray(result?.items) ? result.items.length : 0;
      if (!options.batch) {
        putText(text);
        setStatus('已读取运单文字' + (count ? '，共 ' + count + ' 行' : ''), 100, true);
      }
      return { rawText: text, source: 'paddleocr-browser', itemCount: count, metrics: result?.metrics || null };
    };

    try {
      return await Promise.race([
        run(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('OCR读取/识别超过2分钟，请检查图片质量或OCR处理链路')), OCR_TIMEOUT_MS))
      ]);
    } catch (error) {
      if (/OCR识别已取消/.test(String(error?.message || ''))) {
        ++operationId; disposeEngine().catch(() => {});
      } else if (/读取运单时间较长/.test(String(error?.message || ''))) {
        cancelRequested = true; ++operationId; disposeEngine().catch(() => {});
      }
      console.error('[PaddleOCR]', error);
      if (!options.batch) setStatus(error?.message || 'OCR识别失败', 100, false, true);
      throw error;
    } finally {
      busy = false;
      cancelRequested = false;
    }
  }

  async function processFiles(files) {
    const list = Array.from(files || [])
      .filter(file => file && String(file.type).startsWith('image/'))
      .filter((file, index, arr) => arr.findIndex(other => other.name === file.name && other.size === file.size && other.lastModified === file.lastModified) === index);
    if (!list.length) throw new Error('请选择有效的运单图片');
    const MAX_BATCH_FILES = 12;
    if (list.length > MAX_BATCH_FILES) throw new Error('一次最多导入12张运单图片，请分批导入');
    const results = [], failed = [];
    for (let index = 0; index < list.length; index += 1) {
      if (cancelRequested) throw Object.assign(new Error('已取消'), { code: 'OCR_CANCELLED' });
      try {
        const result = await process(list[index], { batch: list.length > 1, index: index + 1, total: list.length });
        if (result?.rawText) results.push(result);
      } catch (error) {
        if (/已取消/.test(String(error?.message || ''))) throw Object.assign(new Error('已取消'), { code: 'OCR_CANCELLED' });
        failed.push({ file: list[index], error });
        if (list.length > 1) {
          window.renderUnifiedStatus?.('loading', Math.min(95, Math.round(((index + 1) / list.length) * 90)), '第 ' + (index + 1) + '/' + list.length + ' 张未成功，继续读取下一张…');
        }
      }
    }
    if (!results.length) throw failed[0]?.error || new Error('没有识别到有效文字，请重新拍摄清晰、完整的运单图片');
    const combined = results.map(item => item.rawText).filter(Boolean).join('\\n\\n');
    putText(combined);
    const totalLines = results.reduce((sum, item) => sum + (Number(item.itemCount) || 0), 0);
    if (list.length > 1) {
      const message = failed.length ? ('已读取 ' + results.length + '/' + list.length + ' 张运单，' + failed.length + ' 张未成功') : ('已读取 ' + results.length + ' 张运单');
      setStatus(message, 100, true);
    }
    return { rawText: combined, source: 'paddleocr-browser-batch', itemCount: totalLines, fileCount: list.length, successCount: results.length, failedCount: failed.length, failedFiles: failed.map(item => item.file?.name || '未命名图片') };
  }

  async function disposeEngine() {
    const engine = engineInstance;
    engineInstance = null;
    enginePromise = null;
    if (engine?.dispose) {
      try { await engine.dispose(); } catch (_) {}
    }
  }

  window.cancelOCR = async function() {
    if (!busy) return false;
    cancelRequested = true;
    ++operationId;
    await disposeEngine();
    busy = false;
    setStatus('已取消', 100, false, false, true);
    return true;
  };

  window.callOCR = process;

  // 正式版启动后后台预热 OCR：把 SDK/模型首次加载从“上传时等待”前移，
  // 预热失败不阻断页面操作，用户上传时仍会再次尝试。
  // 首页脚本加载完成后立即后台预热 OCR，不再等待用户打开上传面板。
  // 预热过程不显示错误、不阻塞首页；用户真正上传图片时直接复用已完成的引擎。
  warmingUp = true;
  loadEngine().catch(() => {}).finally(() => { warmingUp = false; });

  window.openFileManager = async function() {
    window.closeUploadSource?.();
    if (busy) return;
    try {
      if (typeof window.showOpenFilePicker === 'function') {
        const handles = await window.showOpenFilePicker({
          multiple: true,
          excludeAcceptAllOption: true,
          types: [{
            description: '运单图片',
            accept: { 'image/jpeg': ['.jpg', '.jpeg'], 'image/png': ['.png'], 'image/webp': ['.webp'] }
          }]
        });
        const files = [];
        for (const handle of handles) files.push(await handle.getFile());
        if (files.length) await processFiles(files);
        return;
      }
    } catch (error) {
      if (error?.name === 'AbortError') return;
      console.warn('[PaddleOCR file picker]', error);
    }
    const input = $('ocrFileInput');
    if (input) input.click();
  };

  function bindUploadInput(id, type) {
    const input = $(id);
    if (!input) return;
    input.addEventListener('change', () => {
      window.closeUploadSource?.();
      const files = Array.from(input.files || []);
      if (!files.length) return;
      processFiles(files).catch(error => {
        if (error?.code !== 'OCR_CANCELLED') {
          console.error('[PaddleOCR batch]', error);
          setStatus(error?.message || '图片读取失败，请重试', 100, false, true);
        }
      }).finally(() => {
        input.value = '';
      });
    });
  }

  bindUploadInput('ocrCameraInput', 'camera');
  bindUploadInput('ocrAlbumInput', 'album');
  bindUploadInput('ocrFileInput', 'file');

})();
