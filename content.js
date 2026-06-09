// content script, world: MAIN, document_start
// overrides fetch/XHR before page scripts run

(function () {
  'use strict';

  if (window.__aiUploadBlocker) return;
  window.__aiUploadBlocker = true;

  // capture native constructors before any page script can replace them
  const NativeFile      = File;
  const NativeBlob      = Blob;
  const NativeFormData  = FormData;

  const POLICY_MSG = 'File uploads to AI services are blocked by company policy.';
  const BANNER_ID  = '__ai-upload-block-banner';

  let lastPasteImageMs = 0;

  function showNotification() {
    const show = () => {
      let banner = document.getElementById(BANNER_ID);
      if (banner) {
        // force reflow to restart fade animation
        banner.style.opacity = '0';
        banner.getBoundingClientRect();
        banner.style.transition = 'none';
        banner.style.opacity = '1';
        banner.style.transition = 'opacity 0.3s ease';
        clearTimeout(banner.__hideTimer);
      } else {
        banner = document.createElement('div');
        banner.id = BANNER_ID;
        banner.style.cssText = [
          'position:fixed',
          'top:20px',
          'right:20px',
          'z-index:2147483647',
          'background:#c62828',
          'color:#fff',
          'padding:14px 18px',
          'border-radius:6px',
          'font:500 14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
          'box-shadow:0 4px 14px rgba(0,0,0,0.35)',
          'max-width:380px',
          'pointer-events:none',
          'transition:opacity 0.3s ease',
        ].join(';');
        banner.textContent = POLICY_MSG;
        document.body.appendChild(banner);
      }

      banner.__hideTimer = setTimeout(() => {
        if (banner) {
          banner.style.opacity = '0';
          setTimeout(() => banner.remove(), 350);
        }
      }, 5000);
    };

    if (document.body) {
      show();
    } else {
      document.addEventListener('DOMContentLoaded', show, { once: true });
    }
  }

  function formDataHasFiles(fd) {
    try {
      for (const val of fd.values()) {
        if (val instanceof NativeFile) return true;
      }
    } catch (_) {}
    return false;
  }

  function bodyHasFiles(body) {
    if (!body) return false;
    if (body instanceof NativeFile) return true;
    if (body instanceof NativeBlob) {
      // text/plain and application/json are telemetry payloads (e.g. Datadog RUM), not file uploads
      const t = (body.type || '').toLowerCase().split(';')[0].trim();
      if (!t || t === 'text/plain' || t === 'application/json') return false;
      return true;
    }
    if (body instanceof NativeFormData) return formDataHasFiles(body);
    return false;
  }

  const _fetch = window.fetch;
  window.fetch = function (input, init) {
    if (init && bodyHasFiles(init.body) && Date.now() - lastPasteImageMs > 5000) {
      showNotification();
      return Promise.reject(new DOMException('Blocked by policy', 'AbortError'));
    }
    return _fetch.apply(this, arguments);
  };

  const _xhrSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (body) {
    if (bodyHasFiles(body) && Date.now() - lastPasteImageMs > 5000) {
      showNotification();
      this.abort();
      return;
    }
    return _xhrSend.apply(this, arguments);
  };

  // intercept before file loses File identity - covers presigned-URL pattern (file read to ArrayBuffer, sent via XHR to S3)
  // also covers new Response(file).arrayBuffer() which bypasses Blob.prototype overrides
  const _NativeResponse = Response;
  window.Response = function Response(body, init) {
    if (body instanceof NativeFile && Date.now() - lastPasteImageMs > 5000) {
      showNotification();
      throw new DOMException('Blocked by policy', 'AbortError');
    }
    return Reflect.construct(_NativeResponse, [body, init], new.target || _NativeResponse);
  };
  window.Response.prototype = _NativeResponse.prototype;
  Object.setPrototypeOf(window.Response, _NativeResponse);

  const _blobArrayBuffer = NativeBlob.prototype.arrayBuffer;
  NativeBlob.prototype.arrayBuffer = function () {
    if (this instanceof NativeFile && Date.now() - lastPasteImageMs > 5000) {
      showNotification();
      return Promise.reject(new DOMException('Blocked by policy', 'AbortError'));
    }
    return _blobArrayBuffer.call(this);
  };

  const _blobText = NativeBlob.prototype.text;
  NativeBlob.prototype.text = function () {
    if (this instanceof NativeFile && Date.now() - lastPasteImageMs > 5000) {
      showNotification();
      return Promise.reject(new DOMException('Blocked by policy', 'AbortError'));
    }
    return _blobText.call(this);
  };

  const _blobStream = NativeBlob.prototype.stream;
  NativeBlob.prototype.stream = function () {
    if (this instanceof NativeFile && Date.now() - lastPasteImageMs > 5000) {
      showNotification();
      return new ReadableStream({ start(c) { c.error(new DOMException('Blocked by policy', 'AbortError')); } });
    }
    return _blobStream.call(this);
  };

  ['readAsArrayBuffer', 'readAsBinaryString', 'readAsDataURL', 'readAsText'].forEach(method => {
    const _orig = FileReader.prototype[method];
    FileReader.prototype[method] = function (blob) {
      if (blob instanceof NativeFile && Date.now() - lastPasteImageMs > 5000) {
        showNotification();
        const self = this;
        setTimeout(() => {
          self.dispatchEvent(new ProgressEvent('error'));
          self.dispatchEvent(new ProgressEvent('loadend'));
        }, 0);
        return;
      }
      return _orig.call(this, blob);
    };
  });

  function lockFileInput(el) {
    el.disabled = true;
    el.style.pointerEvents = 'none';
    el.setAttribute('data-ai-blocked', '1');
    el.addEventListener('click', e => { e.preventDefault(); e.stopImmediatePropagation(); showNotification(); }, true);
  }

  // catch programmatic .click() on file inputs (e.g. off-DOM inputs never seen by MutationObserver)
  const _inputClick = HTMLInputElement.prototype.click;
  HTMLInputElement.prototype.click = function () {
    if (this.type === 'file') {
      showNotification();
      return;
    }
    return _inputClick.call(this);
  };

  if ('showPicker' in HTMLInputElement.prototype) {
    const _showPicker = HTMLInputElement.prototype.showPicker;
    HTMLInputElement.prototype.showPicker = function () {
      if (this.type === 'file') { showNotification(); return; }
      return _showPicker.call(this);
    };
  }

  // lock file inputs at creation time before .type is set and .click() is called
  const _createElement = Document.prototype.createElement;
  Document.prototype.createElement = function (tagName) {
    const el = _createElement.apply(this, arguments);
    if (typeof tagName === 'string' && tagName.toLowerCase() === 'input') {
      const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'type');
      Object.defineProperty(el, 'type', {
        get() { return desc.get.call(this); },
        set(val) {
          desc.set.call(this, val);
          if (val === 'file') lockFileInput(this);
        },
        configurable: true,
      });
    }
    return el;
  };

  if ('showOpenFilePicker' in window) {
    window.showOpenFilePicker = function () {
      showNotification();
      return Promise.reject(new DOMException('Blocked by policy', 'AbortError'));
    };
  }

  function scanForFileInputs(root) {
    if (!root || typeof root.querySelectorAll !== 'function') return;
    root.querySelectorAll('input[type="file"]:not([data-ai-blocked])').forEach(lockFileInput);
  }

  // runs at document_start so <html> exists but body may not yet
  const observer = new MutationObserver(mutations => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.tagName === 'INPUT' && node.type === 'file') {
          lockFileInput(node);
        } else {
          scanForFileInputs(node);
          if (node.shadowRoot) attachShadowRoot(node.shadowRoot);
        }
      }
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  // reuse the same observer for shadow roots - MutationObserver.observe() can be called multiple times
  function attachShadowRoot(root) {
    scanForFileInputs(root);
    observer.observe(root, { childList: true, subtree: true });
    root.querySelectorAll('*').forEach(el => {
      if (el.shadowRoot) attachShadowRoot(el.shadowRoot);
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    scanForFileInputs(document.body);
    document.body.querySelectorAll('*').forEach(el => {
      if (el.shadowRoot) attachShadowRoot(el.shadowRoot);
    });
  }, { once: true });

  function hasFiles(dt) {
    return dt && dt.types && dt.types.includes('Files');
  }

  // block dragenter so the site's drop-zone UI never appears
  document.addEventListener('dragenter', function (e) {
    if (hasFiles(e.dataTransfer)) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }, true);

  // dragover must be cancelled so the drop event fires
  document.addEventListener('dragover', function (e) {
    if (hasFiles(e.dataTransfer)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      e.dataTransfer.dropEffect = 'none';
    }
  }, true);

  document.addEventListener('drop', function (e) {
    const dt = e.dataTransfer;
    if (dt && dt.files && dt.files.length > 0) {
      e.preventDefault();
      e.stopImmediatePropagation();
      showNotification();
      // dispatch dragleave so any drop-zone UI the site already rendered gets dismissed
      (e.target || document.body).dispatchEvent(
        new DragEvent('dragleave', { bubbles: true, cancelable: true })
      );
    }
  }, true);

  document.addEventListener('paste', function (e) {
    const cd = e.clipboardData;
    if (!cd || !cd.files || cd.files.length === 0) return;
    for (const file of cd.files) {
      if (!file.type.startsWith('image/')) {
        e.preventDefault();
        e.stopImmediatePropagation();
        showNotification();
        return;
      }
    }
    lastPasteImageMs = Date.now();
  }, true);

  document.addEventListener('submit', function (e) {
    const form = e.target;
    if (!form || typeof form.querySelectorAll !== 'function') return;
    for (const fi of form.querySelectorAll('input[type="file"]')) {
      if (fi.files && fi.files.length > 0) {
        e.preventDefault();
        e.stopImmediatePropagation();
        showNotification();
        return;
      }
    }
  }, true);

})();
