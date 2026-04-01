// ==UserScript==
// @name         稿定工具箱
// @namespace    local.gaoding.toolkit
// @version      1.2.0
// @description  自动拦截 risk_materials 请求，并从稿定设计页或离线页面直接保存预览图
// @match        *://www.gaoding.com/editor/design*
// @match        *://*.gaoding.com/editor/design*
// @match        file:///*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  if (location.protocol === 'file:' && !decodeURIComponent(location.pathname).includes('稿定')) {
    return;
  }

  const BUTTON_ID = 'gd-toolkit-save-button';
  const STYLE_ID = 'gd-toolkit-style';
  const BUTTON_MARKER = 'data-gd-toolkit';
  const EXPORT_PRIORITY = ['pdf', 'psd', 'png', 'jpg', 'jpeg', 'webp', 'avif'];
  const BLOCKED_ENDPOINTS = new Set([
    'https://www.gaoding.com/api/ccm/editors/risk_materials',
  ]);
  const BLOCKED_PATHNAMES = new Set([
    '/api/ccm/editors/risk_materials',
  ]);

  const fakePayload = {
    code: 0,
    data: [],
    msg: 'blocked by userscript',
  };

  let cachedMeta = null;
  let isSaving = false;
  let resetButtonTimer = 0;
  let activeCapture = null;
  const objectUrlToBlob = new Map();

  bootstrap();

  function bootstrap() {
    if (location.protocol !== 'file:') {
      patchFetch();
      patchXhr();
      patchSendBeacon();
    }
    patchCreateObjectUrl();
    patchAnchorClick();
    patchWindowOpen();
    patchCanvasExport();
    interceptDownloadClicks();
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', initUi, { once: true });
    } else {
      initUi();
    }
  }

  function initUi() {
    injectStyle();
    renderSaveButton();
  }

  function normalizeUrl(input) {
    try {
      const url = new URL(String(input), location.href);
      return `${url.origin}${url.pathname}`;
    } catch {
      return String(input || '');
    }
  }

  function extractUrl(input) {
    if (typeof input === 'string') {
      return input;
    }
    if (input && typeof input.url === 'string') {
      return input.url;
    }
    return '';
  }

  function isBlockedUrl(input) {
    const raw = extractUrl(input);
    const normalized = normalizeUrl(raw);
    if (BLOCKED_ENDPOINTS.has(normalized)) {
      return true;
    }
    try {
      const url = new URL(String(raw), location.href);
      return BLOCKED_PATHNAMES.has(url.pathname);
    } catch {
      return false;
    }
  }

  function logBlocked(type, url) {
    console.info('[Gaoding Toolkit][blocked]', type, extractUrl(url));
  }

  function buildResponseBody() {
    return JSON.stringify(fakePayload);
  }

  function buildFetchResponse() {
    return new Response(buildResponseBody(), {
      status: 200,
      statusText: 'OK',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
      },
    });
  }

  function emitEvent(target, type) {
    const event = new Event(type);
    if (typeof target.dispatchEvent === 'function') {
      target.dispatchEvent(event);
      return;
    }
    const handler = target[`on${type}`];
    if (typeof handler === 'function') {
      handler.call(target, event);
    }
  }

  function defineGetter(target, key, getter) {
    Object.defineProperty(target, key, {
      configurable: true,
      get: getter,
    });
  }

  function buildXhrResponse(xhr, url) {
    const body = buildResponseBody();

    defineGetter(xhr, 'readyState', () => 4);
    defineGetter(xhr, 'status', () => 200);
    defineGetter(xhr, 'statusText', () => 'OK');
    defineGetter(xhr, 'responseURL', () => extractUrl(url));
    defineGetter(xhr, 'responseText', () => body);
    defineGetter(xhr, 'responseXML', () => null);
    defineGetter(xhr, 'response', () => {
      switch (xhr.responseType) {
        case 'arraybuffer':
          return new TextEncoder().encode(body).buffer;
        case 'blob':
          return new Blob([body], { type: 'application/json' });
        case 'json':
          return fakePayload;
        default:
          return body;
      }
    });
  }

  function patchFetch() {
    if (typeof window.fetch !== 'function') {
      return;
    }

    const originalFetch = window.fetch;
    window.fetch = async function patchedFetch(...args) {
      const requestLike = args[0];
      if (isBlockedUrl(requestLike)) {
        logBlocked('fetch', requestLike);
        return Promise.resolve(buildFetchResponse());
      }
      const response = await originalFetch.apply(this, args);
      maybeCaptureFetchResponse(response);
      return response;
    };
  }

  function patchXhr() {
    if (!window.XMLHttpRequest) {
      return;
    }

    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function patchedOpen(method, url, ...rest) {
      this.__gaodingBlockedUrl = isBlockedUrl(url) ? extractUrl(url) : '';
      return originalOpen.call(this, method, url, ...rest);
    };

    XMLHttpRequest.prototype.send = function patchedSend(...args) {
      if (!this.__gaodingBlockedUrl) {
        this.addEventListener('load', () => {
          maybeCaptureXhrResponse(this);
        }, { once: true });
        return originalSend.apply(this, args);
      }

      logBlocked('xhr', this.__gaodingBlockedUrl);
      buildXhrResponse(this, this.__gaodingBlockedUrl);

      queueMicrotask(() => {
        emitEvent(this, 'readystatechange');
        emitEvent(this, 'load');
        emitEvent(this, 'loadend');
      });
      return undefined;
    };
  }

  function patchSendBeacon() {
    if (typeof navigator.sendBeacon !== 'function') {
      return;
    }

    const originalSendBeacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = function patchedSendBeacon(url, data) {
      if (isBlockedUrl(url)) {
        logBlocked('sendBeacon', url);
        return true;
      }
      return originalSendBeacon(url, data);
    };
  }

  function interceptDownloadClicks() {
    document.addEventListener(
      'click',
      (event) => {
        const target = event.target;
        if (!(target instanceof Element)) {
          return;
        }

        const actionNode = target.closest('button, a, [role="button"]');
        if (!actionNode) {
          return;
        }

        const text = normalizeText(actionNode.textContent || '');
        if (!looksLikeDownloadButton(text)) {
          return;
        }

        if (actionNode.hasAttribute(BUTTON_MARKER)) {
          event.preventDefault();
          event.stopImmediatePropagation();
          void directSave();
          return;
        }

        if (!activeCapture) {
          startNativeCapture(false);
        }
      },
      true
    );
  }

  function looksLikeDownloadButton(text) {
    if (!text) {
      return false;
    }
    return (
      text.includes('下载') ||
      text.includes('导出') ||
      text === '保存图片' ||
      text === '保存'
    );
  }

  function normalizeText(text) {
    return text.replace(/\s+/g, '');
  }

  function getTemplateMeta() {
    if (cachedMeta) {
      return cachedMeta;
    }

    const directTemplate = window.__SSR_TEMPLATE;
    if (directTemplate && directTemplate.preview && directTemplate.preview.url) {
      cachedMeta = {
        id: directTemplate.id || '',
        title: directTemplate.title || document.title || 'gaoding-preview',
        width: directTemplate.preview.width || 0,
        height: directTemplate.preview.height || 0,
        url: directTemplate.preview.url,
      };
      return cachedMeta;
    }

    const html = document.documentElement ? document.documentElement.innerHTML : '';
    const urlMatch = html.match(/"preview":\{[^{}]*"url":"([^"]+)"/);
    if (!urlMatch) {
      return null;
    }

    const titleMatch = html.match(/"title":"([^"]+)"/);
    const idMatch = html.match(/"id":(\d+)/);
    const widthMatch = html.match(/"preview":\{[^{}]*"width":(\d+)/);
    const heightMatch = html.match(/"preview":\{[^{}]*"height":(\d+)/);

    cachedMeta = {
      id: idMatch ? idMatch[1] : '',
      title: titleMatch ? decodeEscapedString(titleMatch[1]) : document.title || 'gaoding-preview',
      width: widthMatch ? Number(widthMatch[1]) : 0,
      height: heightMatch ? Number(heightMatch[1]) : 0,
      url: decodeEscapedString(urlMatch[1]),
    };
    return cachedMeta;
  }

  function decodeEscapedString(value) {
    return value
      .replace(/\\u([0-9a-fA-F]{4})/g, (_, code) => String.fromCharCode(parseInt(code, 16)))
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\')
      .replace(/\\\//g, '/');
  }

  async function directSave() {
    if (isSaving) {
      setButtonText('保存中...');
      return;
    }

    const meta = getTemplateMeta();
    if (!meta || !meta.url) {
      flashButtonText('无图片');
      return;
    }

    isSaving = true;
    setButtonText('保存中...');

    try {
      const captured = await tryNativeDownloadCapture();
      const finalCapture = captured || await captureCurrentArtboardImage(meta);
      const blob = finalCapture.blob;
      const extension = finalCapture.extension;
      const filename = buildFilename(meta, extension);
      triggerBlobDownload(blob, filename);
      flashButtonText('已开始下载');
    } catch (error) {
      console.error('[Gaoding Toolkit] save failed:', error);
      flashButtonText('已打开原图');
      window.open(meta.url, '_blank', 'noopener,noreferrer');
    } finally {
      isSaving = false;
    }
  }

  async function captureCurrentArtboardImage(meta) {
    try {
      const stageCapture = await tryCaptureStageCanvas(meta);
      if (stageCapture) {
        return stageCapture;
      }
    } catch (error) {
      console.warn('[Gaoding Toolkit] stage capture failed, fallback to preview url:', error);
    }

    const response = await fetch(meta.url, { credentials: 'omit' });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const blob = await response.blob();
    return {
      blob,
      extension: guessExtension(blob.type, meta.url),
    };
  }

  async function tryNativeDownloadCapture() {
    const nativeTrigger = findNativeDownloadTrigger();
    if (!nativeTrigger) {
      return null;
    }

    const capture = startNativeCapture(true);
    nativeTrigger.click();
    await choosePreferredDownloadFormatAndConfirm();
    return capture.promise;
  }

  function findNativeDownloadTrigger() {
    const candidates = Array.from(document.querySelectorAll('button, a, [role="button"], .gda-dropdown-menu-item'));
    const visible = candidates.filter((node) => {
      if (!(node instanceof HTMLElement)) {
        return false;
      }
      if (node.hasAttribute(BUTTON_MARKER)) {
        return false;
      }
      const text = normalizeText(node.textContent || '');
      if (!looksLikeDownloadButton(text)) {
        return false;
      }
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });

    if (!visible.length) {
      return null;
    }

    visible.sort((a, b) => {
      const aRect = a.getBoundingClientRect();
      const bRect = b.getBoundingClientRect();
      if (aRect.top !== bRect.top) {
        return aRect.top - bRect.top;
      }
      return bRect.left - aRect.left;
    });

    return visible[0];
  }

  function startNativeCapture(suppressNativeDownload) {
    if (activeCapture) {
      clearTimeout(activeCapture.timer);
      activeCapture.resolve(activeCapture.bestPayload || null);
    }

    let resolvePromise;
    const promise = new Promise((resolve) => {
      resolvePromise = resolve;
    });

    const capture = {
      suppressNativeDownload,
      promise,
      resolve: resolvePromise,
      bestPayload: null,
      timer: window.setTimeout(() => {
        if (activeCapture === capture) {
          activeCapture = null;
          resolvePromise(capture.bestPayload || null);
        }
      }, 12000),
    };

    activeCapture = capture;
    return capture;
  }

  function finishNativeCapture(payload) {
    if (!activeCapture) {
      return false;
    }
    if (!payload || !payload.blob) {
      return activeCapture.suppressNativeDownload;
    }

    const currentRank = activeCapture.bestPayload ? getExportPriority(activeCapture.bestPayload.extension) : -1;
    const nextRank = getExportPriority(payload.extension);
    if (!activeCapture.bestPayload || nextRank > currentRank) {
      activeCapture.bestPayload = payload;
    }

    if (nextRank <= 2) {
      const capture = activeCapture;
      activeCapture = null;
      clearTimeout(capture.timer);
      capture.resolve(capture.bestPayload);
      return capture.suppressNativeDownload;
    }

    return activeCapture.suppressNativeDownload;
  }

  async function tryCaptureStageCanvas(meta) {
    const stageCanvas = document.querySelector('canvas.infinite-canvas');
    if (!(stageCanvas instanceof HTMLCanvasElement) || !stageCanvas.width || !stageCanvas.height) {
      return null;
    }

    const stageRect = stageCanvas.getBoundingClientRect();
    if (!stageRect.width || !stageRect.height) {
      return null;
    }

    const artboardRect = getCurrentArtboardRect();
    if (!artboardRect) {
      return null;
    }

    const scaleX = stageCanvas.width / stageRect.width;
    const scaleY = stageCanvas.height / stageRect.height;
    const sx = Math.max(0, Math.round((artboardRect.left - stageRect.left) * scaleX));
    const sy = Math.max(0, Math.round((artboardRect.top - stageRect.top) * scaleY));
    const sw = Math.min(stageCanvas.width - sx, Math.round(artboardRect.width * scaleX));
    const sh = Math.min(stageCanvas.height - sy, Math.round(artboardRect.height * scaleY));

    if (sw <= 0 || sh <= 0) {
      return null;
    }

    const currentSize = getCurrentArtboardSize(meta, sw, sh);
    const exportCanvas = document.createElement('canvas');
    exportCanvas.width = currentSize.width;
    exportCanvas.height = currentSize.height;

    const context = exportCanvas.getContext('2d');
    if (!context) {
      return null;
    }

    context.drawImage(stageCanvas, sx, sy, sw, sh, 0, 0, exportCanvas.width, exportCanvas.height);

    const blob = await canvasToBlob(exportCanvas, 'image/png');
    if (!blob) {
      return null;
    }

    return {
      blob,
      extension: 'png',
    };
  }

  function getCurrentArtboardRect() {
    const candidates = [
      '.dc-watermark.editor-shell-slot-user-watermark',
      '.editor-resize-bar',
      '.ai-background-check .check-info',
    ];

    for (const selector of candidates) {
      const element = document.querySelector(selector);
      if (!(element instanceof HTMLElement)) {
        continue;
      }
      const rect = element.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        return rect;
      }
    }

    return null;
  }

  function getCurrentArtboardSize(meta, fallbackWidth, fallbackHeight) {
    const widthTip = parsePixelTip(document.querySelector('.editor-resize-bar__bar--right'));
    const heightTip = parsePixelTip(document.querySelector('.editor-resize-bar__bar--bottom'));

    return {
      width: widthTip || meta.width || fallbackWidth,
      height: heightTip || meta.height || fallbackHeight,
    };
  }

  function parsePixelTip(element) {
    if (!(element instanceof HTMLElement)) {
      return 0;
    }
    const raw = element.dataset.tip || '';
    const match = raw.match(/(\d+)/);
    return match ? Number(match[1]) : 0;
  }

  function canvasToBlob(canvas, type) {
    return new Promise((resolve, reject) => {
      try {
        canvas.toBlob((blob) => {
          resolve(blob);
        }, type);
      } catch (error) {
        reject(error);
      }
    });
  }

  function patchCreateObjectUrl() {
    if (!URL || typeof URL.createObjectURL !== 'function') {
      return;
    }

    const originalCreateObjectURL = URL.createObjectURL.bind(URL);
    URL.createObjectURL = function patchedCreateObjectURL(object) {
      const url = originalCreateObjectURL(object);
      if (object instanceof Blob) {
        objectUrlToBlob.set(url, object);
      }
      return url;
    };
  }

  function patchAnchorClick() {
    const originalClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function patchedAnchorClick() {
      if (activeCapture) {
        const href = this.href || this.getAttribute('href') || '';
        const payload = buildCapturedPayloadFromHref(href);
        if (payload) {
          const suppress = finishNativeCapture(payload);
          if (suppress) {
            return;
          }
        }
        if (/^https?:\/\//i.test(href) && looksLikeDownloadAsset(href)) {
          const suppress = activeCapture.suppressNativeDownload;
          fetchRemoteCapture(href).then((captured) => {
            finishNativeCapture(captured);
          }).catch(() => {});
          if (suppress) {
            return;
          }
        }
      }
      return originalClick.call(this);
    };
  }

  function patchWindowOpen() {
    const originalOpen = window.open;
    window.open = function patchedWindowOpen(url, target, features) {
      if (activeCapture) {
        const href = String(url || '');
        const payload = buildCapturedPayloadFromHref(href);
        if (payload) {
          const suppress = finishNativeCapture(payload);
          if (suppress) {
            return null;
          }
        }
        if (/^https?:\/\//i.test(href) && looksLikeDownloadAsset(href)) {
          const suppress = activeCapture.suppressNativeDownload;
          fetchRemoteCapture(href).then((captured) => {
            finishNativeCapture(captured);
          }).catch(() => {});
          if (suppress) {
            return null;
          }
        }
      }
      return originalOpen.call(this, url, target, features);
    };
  }

  function patchCanvasExport() {
    const originalToBlob = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function patchedToBlob(callback, type, quality) {
      if (!activeCapture) {
        return originalToBlob.call(this, callback, type, quality);
      }
      const wrapped = (blob) => {
        if (blob) {
          finishNativeCapture({
            blob,
            extension: guessExtension(blob.type, ''),
          });
        }
        if (typeof callback === 'function') {
          callback(blob);
        }
      };
      return originalToBlob.call(this, wrapped, type, quality);
    };

    const originalToDataURL = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function patchedToDataURL(type, quality) {
      const result = originalToDataURL.call(this, type, quality);
      if (activeCapture && typeof result === 'string' && result.startsWith('data:image/')) {
        finishNativeCapture({
          blob: dataUrlToBlob(result),
          extension: guessExtension(type || '', result),
        });
      }
      return result;
    };
  }

  function buildCapturedPayloadFromHref(href) {
    if (!href) {
      return null;
    }

    if (href.startsWith('blob:')) {
      const blob = objectUrlToBlob.get(href);
      if (!blob) {
        return null;
      }
      return {
        blob,
        extension: guessExtension(blob.type, href),
      };
    }

    if (href.startsWith('data:image/')) {
      return {
        blob: dataUrlToBlob(href),
        extension: guessExtension('', href),
      };
    }

    return null;
  }

  function dataUrlToBlob(dataUrl) {
    const parts = dataUrl.split(',');
    const mimeMatch = parts[0].match(/data:([^;]+)/);
    const mime = mimeMatch ? mimeMatch[1] : 'application/octet-stream';
    const binary = atob(parts[1] || '');
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new Blob([bytes], { type: mime });
  }

  async function choosePreferredDownloadFormatAndConfirm() {
    await waitFor(120);

    const formatNode = findPreferredFormatNode();
    if (formatNode) {
      formatNode.click();
      await waitFor(120);
    }

    const confirmNode = findDownloadConfirmNode(formatNode);
    if (confirmNode) {
      confirmNode.click();
    }
  }

  function findPreferredFormatNode() {
    const candidates = Array.from(document.querySelectorAll('button, a, label, [role="button"], [role="menuitem"], .gda-dropdown-menu-item'));
    const visible = candidates.filter((node) => {
      if (!(node instanceof HTMLElement)) {
        return false;
      }
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });

    let best = null;
    let bestRank = Number.POSITIVE_INFINITY;

    for (const node of visible) {
      const text = normalizeText(node.textContent || '').toLowerCase();
      const format = detectFormatFromText(text);
      if (!format) {
        continue;
      }
      const rank = getExportPriority(format);
      if (rank < bestRank) {
        best = node;
        bestRank = rank;
      }
    }

    return best;
  }

  function findDownloadConfirmNode(excludeNode) {
    const candidates = Array.from(document.querySelectorAll('button, a, [role="button"], [role="menuitem"], .gda-dropdown-menu-item'));
    const visible = candidates.filter((node) => {
      if (!(node instanceof HTMLElement) || node === excludeNode) {
        return false;
      }
      const rect = node.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        return false;
      }
      const text = normalizeText(node.textContent || '');
      return /下载|导出|确认|确定|立即下载/.test(text);
    });

    if (!visible.length) {
      return null;
    }

    visible.sort((a, b) => {
      const aText = normalizeText(a.textContent || '');
      const bText = normalizeText(b.textContent || '');
      const aScore = /下载|导出/.test(aText) ? 0 : 1;
      const bScore = /下载|导出/.test(bText) ? 0 : 1;
      if (aScore !== bScore) {
        return aScore - bScore;
      }
      const aRect = a.getBoundingClientRect();
      const bRect = b.getBoundingClientRect();
      return bRect.left - aRect.left;
    });

    return visible[0];
  }

  function detectFormatFromText(text) {
    if (!text) {
      return '';
    }
    if (text.includes('pdf')) {
      return 'pdf';
    }
    if (text.includes('psd')) {
      return 'psd';
    }
    if (text.includes('png')) {
      return 'png';
    }
    if (text.includes('jpeg')) {
      return 'jpeg';
    }
    if (text.includes('jpg')) {
      return 'jpg';
    }
    if (text.includes('webp')) {
      return 'webp';
    }
    if (text.includes('avif')) {
      return 'avif';
    }
    return '';
  }

  function getExportPriority(extension) {
    const normalized = String(extension || '').toLowerCase().replace(/^\./, '');
    const index = EXPORT_PRIORITY.indexOf(normalized);
    return index === -1 ? Number.POSITIVE_INFINITY : index;
  }

  function waitFor(ms) {
    return new Promise((resolve) => {
      window.setTimeout(resolve, ms);
    });
  }

  function maybeCaptureFetchResponse(response) {
    if (!activeCapture || !response) {
      return;
    }
    const contentType = response.headers.get('content-type') || '';
    const disposition = response.headers.get('content-disposition') || '';
    if (!isDownloadLikeResponse(contentType, disposition, response.url || '')) {
      return;
    }

    response.clone().blob().then((blob) => {
      if (!blob || !blob.size) {
        return;
      }
      finishNativeCapture({
        blob,
        extension: guessExtension(blob.type || contentType, response.url || ''),
      });
    }).catch(() => {});
  }

  function maybeCaptureXhrResponse(xhr) {
    if (!activeCapture || !xhr) {
      return;
    }

    const contentType = xhr.getResponseHeader('content-type') || '';
    const disposition = xhr.getResponseHeader('content-disposition') || '';
    const responseUrl = xhr.responseURL || '';
    if (!isDownloadLikeResponse(contentType, disposition, responseUrl)) {
      return;
    }

    if (xhr.response instanceof Blob) {
      finishNativeCapture({
        blob: xhr.response,
        extension: guessExtension(xhr.response.type || contentType, responseUrl),
      });
      return;
    }

    if (typeof xhr.response === 'string' && xhr.response.startsWith('data:image/')) {
      finishNativeCapture({
        blob: dataUrlToBlob(xhr.response),
        extension: guessExtension(contentType, responseUrl),
      });
    }
  }

  function isDownloadLikeResponse(contentType, disposition, url) {
    return (
      /image\/|application\/octet-stream|application\/pdf/i.test(contentType) ||
      /attachment/i.test(disposition) ||
      /(download|export|render|snapshot|preview|filems|\.png|\.jpg|\.jpeg|\.webp|\.avif|\.pdf)([?#]|$)/i.test(url)
    );
  }

  function guessExtension(contentType, url) {
    if (contentType === 'image/png') {
      return 'png';
    }
    if (contentType === 'image/webp') {
      return 'webp';
    }
    if (contentType === 'image/avif') {
      return 'avif';
    }
    const urlMatch = url.match(/\.([a-zA-Z0-9]+)(?:[?#]|$)/);
    if (urlMatch) {
      return urlMatch[1].toLowerCase();
    }
    return 'jpg';
  }

  function buildFilename(meta, extension) {
    const rawTitle = (meta.title || 'gaoding-preview').replace(/_设计页－稿定$/, '');
    const cleanTitle = rawTitle
      .replace(/[\\/:*?"<>|]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const suffix = meta.id ? `-${meta.id}` : '';
    return `${cleanTitle || 'gaoding-preview'}${suffix}.${extension}`;
  }

  function triggerBlobDownload(blob, filename) {
    const blobUrl = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = blobUrl;
    anchor.download = filename;
    anchor.setAttribute(BUTTON_MARKER, '1');
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    setTimeout(() => {
      URL.revokeObjectURL(blobUrl);
      anchor.remove();
    }, 1000);
  }

  function copyPreviewUrl() {
    const meta = getTemplateMeta();
    if (!meta || !meta.url) {
      flashButtonText('无图片');
      return;
    }

    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      navigator.clipboard.writeText(meta.url).then(() => {
        flashButtonText('已复制地址');
      }).catch(() => {
        fallbackCopy(meta.url);
      });
      return;
    }

    fallbackCopy(meta.url);
  }

  function fallbackCopy(value) {
    const input = document.createElement('textarea');
    input.value = value;
    input.setAttribute('readonly', 'readonly');
    input.style.position = 'fixed';
    input.style.top = '-9999px';
    document.body.appendChild(input);
    input.select();
    try {
      document.execCommand('copy');
      flashButtonText('已复制地址');
    } catch {
      flashButtonText('复制失败');
    }
    input.remove();
  }

  function renderSaveButton() {
    if (!document.body || document.getElementById(BUTTON_ID)) {
      return;
    }

    const meta = getTemplateMeta();
    const button = document.createElement('button');
    button.id = BUTTON_ID;
    button.type = 'button';
    button.setAttribute(BUTTON_MARKER, '1');
    button.textContent = meta && meta.url ? '保存图片' : '无图片';
    button.disabled = !(meta && meta.url);
    button.title = meta && meta.url
      ? `保存当前画布${meta.width && meta.height ? ` ${meta.width}x${meta.height}` : ''}，右键复制原图地址`
      : '未找到可保存图片';

    button.addEventListener('click', () => {
      void directSave();
    });

    button.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      copyPreviewUrl();
    });

    document.body.appendChild(button);
  }

  function setButtonText(text) {
    const node = document.getElementById(BUTTON_ID);
    if (node) {
      node.textContent = text;
    }
  }

  function flashButtonText(text) {
    clearTimeout(resetButtonTimer);
    setButtonText(text);
    resetButtonTimer = window.setTimeout(() => {
      setButtonText('保存图片');
    }, 1600);
  }

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) {
      return;
    }

    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      #${BUTTON_ID} {
        position: fixed;
        right: 12px;
        bottom: 12px;
        z-index: 2147483647;
        border: 0;
        border-radius: 999px;
        padding: 6px 10px;
        background: rgba(31, 35, 40, 0.52);
        color: rgba(255, 255, 255, 0.88);
        cursor: pointer;
        font: 12px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        letter-spacing: 0.01em;
        opacity: 0.38;
        backdrop-filter: blur(6px);
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.12);
        transition: opacity 0.18s ease, background-color 0.18s ease;
      }

      #${BUTTON_ID}:hover {
        opacity: 0.82;
        background: rgba(31, 35, 40, 0.74);
      }

      #${BUTTON_ID}:disabled {
        opacity: 0.22;
        cursor: not-allowed;
      }
    `;

    (document.head || document.documentElement).appendChild(style);
  }
})();
