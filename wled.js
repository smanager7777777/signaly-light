/*
 * wled.js — модуль обмена с контроллером WLED (JSON API) и перевода цветов.
 * Без DOM: его можно перенести в другое приложение целиком.
 * Подключение: <script src="wled.js"></script> → window.Wled; в Node — require('./wled.js').
 *
 * Команды WLED (http://<IP>/json/…):
 *   GET  /json/info   — имя, версия, число светодиодов, Wi-Fi
 *   GET  /json/state  — on, bri (0–255), seg[0].col[0] = [r,g,b]
 *   POST /json/state  — изменения; "v": true → в ответе полное состояние
 */
(function (root) {
  'use strict';

  // ---------- адрес ----------
  function normHost(s) {
    return String(s || '').trim().replace(/^https?:\/\//i, '').replace(/[/?#].*$/, '');
  }

  // ---------- перевод цветов ----------
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  const byte = (x) => clamp(Math.round(x), 0, 255);

  function rgbToHex(rgb) {
    return '#' + rgb.map((v) => byte(v).toString(16).padStart(2, '0')).join('').toUpperCase();
  }
  function hexToRgb(hex) {
    let s = String(hex || '').trim().replace(/^#/, '');
    if (/^[0-9a-f]{3}$/i.test(s)) s = s.split('').map((c) => c + c).join('');
    if (!/^[0-9a-f]{6}$/i.test(s)) return null;
    return [0, 2, 4].map((i) => parseInt(s.substr(i, 2), 16));
  }
  // h 0–360, s,v 0–1
  function hsvToRgb(h, s, v) {
    h = ((h % 360) + 360) % 360;
    const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
    const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x]
      : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
    return [byte((r + m) * 255), byte((g + m) * 255), byte((b + m) * 255)];
  }
  function rgbToHsv(rgb) {
    const [r, g, b] = rgb.map((v) => v / 255);
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    let h = 0;
    if (d) {
      if (max === r) h = 60 * (((g - b) / d) % 6);
      else if (max === g) h = 60 * ((b - r) / d + 2);
      else h = 60 * ((r - g) / d + 4);
    }
    return { h: (h + 360) % 360, s: max ? d / max : 0, v: max };
  }
  // Цветовая температура (К) → RGB. У WS2812B нет белого канала: белый — смесь R, G, B.
  // Приближение Таннера Хелланда, 1000–40000 К.
  function kelvinToRgb(k) {
    const t = clamp(k, 1000, 40000) / 100;
    let r, g, b;
    if (t <= 66) {
      r = 255;
      g = 99.4708025861 * Math.log(t) - 161.1195681661;
      b = t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
    } else {
      r = 329.698727446 * Math.pow(t - 60, -0.1332047592);
      g = 288.1221695283 * Math.pow(t - 60, -0.0755148492);
      b = 255;
    }
    return [byte(r), byte(g), byte(b)];
  }

  // ---------- яркость: шаги ползунка ↔ 0–255 ----------
  // steps = 20 / 100 / 255; шаг k (0…steps) → bri (0…255)
  function briFromStep(k, steps) { return byte((clamp(k, 0, steps) * 255) / steps); }
  function stepFromBri(bri, steps) { return clamp(Math.round((clamp(bri, 0, 255) * steps) / 255), 0, steps); }

  // ---------- клиент одного контроллера ----------
  function createClient(host, opts) {
    opts = opts || {};
    const fetchFn = opts.fetch || ((u, o) => root.fetch(u, o));
    const timeout = opts.timeout || 3000;
    const minGap = opts.minGap == null ? 40 : opts.minGap; // мс между командами, чтобы не душить ESP
    const tt = opts.transition == null ? 1 : opts.transition; // плавность одной команды, ×100 мс
    const base = 'http://' + normHost(host);
    let sent = 0;

    async function req(path, body, t) {
      const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const tm = setTimeout(() => ctrl && ctrl.abort(), t || timeout);
      try {
        const init = body === undefined ? {} : {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        };
        if (ctrl) init.signal = ctrl.signal;
        const r = await fetchFn(base + path, init);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return await r.json();
      } finally { clearTimeout(tm); }
    }

    // Отправка «последняя команда выигрывает»: пока идёт запрос, новые изменения
    // склеиваются в одну команду. Ползунок не забивает контроллер очередью.
    let pending = null, waiters = [], busy = false;
    function merge(a, b) {
      const out = Object.assign({}, a, b);
      if (a.seg && b.seg) out.seg = Object.assign({}, a.seg, b.seg);
      return out;
    }
    function send(patch) {
      pending = merge(pending || {}, patch);
      return new Promise((res, rej) => { waiters.push({ res, rej }); pump(); });
    }
    async function pump() {
      if (busy || !pending) return;
      busy = true;
      const body = Object.assign({}, pending, { v: true });
      if (tt != null && body.tt == null) body.tt = tt;
      pending = null;
      const ws = waiters; waiters = [];
      try {
        sent++;
        const st = await req('/json/state', body);
        ws.forEach((w) => w.res(st));
      } catch (e) {
        ws.forEach((w) => w.rej(e));
      }
      if (minGap) await new Promise((r) => setTimeout(r, minGap));
      busy = false;
      pump();
    }

    return {
      host: normHost(host),
      get sentCount() { return sent; },
      get idle() { return !busy && !pending; },
      getInfo: (t) => req('/json/info', undefined, t),
      getState: () => req('/json/state'),
      send,
      setOn: (on) => send({ on: !!on }),
      toggle: () => send({ on: 't' }),
      setBri: (bri) => send({ on: true, bri: clamp(Math.round(bri), 1, 255) }),
      // fx: 0 — эффект «Solid», иначе цвет может не появиться поверх эффекта
      setColor: (rgb) => send({ on: true, seg: { col: [rgb.map(byte)], fx: 0 } }),
      setWhiteK: (k) => send({ on: true, seg: { col: [kelvinToRgb(k)], fx: 0 } }),
    };
  }

  // Ответ похож на WLED?
  function isWledInfo(j) { return !!(j && typeof j.ver === 'string' && j.leds && typeof j.leds.count === 'number'); }

  async function probe(host, opts) {
    try {
      const j = await createClient(host, opts).getInfo((opts && opts.timeout) || 1500);
      return isWledInfo(j) ? j : null;
    } catch (e) { return null; }
  }

  // Поиск: перебор адресов prefix.1…254 (например, "192.168.1"). Браузер не умеет
  // mDNS/UDP, поэтому только так. ~10–15 с на подсеть.
  async function scan(prefixes, opts) {
    opts = opts || {};
    const list = [];
    [].concat(prefixes).forEach((p) => {
      p = String(p).trim().replace(/\.$/, '');
      if (/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(p)) for (let i = 1; i < 255; i++) list.push(p + '.' + i);
      else if (p) list.push(p); // одиночный адрес или имя
    });
    const found = [];
    let idx = 0, done = 0;
    const conc = opts.concurrency || 32;
    async function worker() {
      while (idx < list.length) {
        if (opts.signal && opts.signal.aborted) return;
        const ip = list[idx++];
        const info = await probe(ip, { fetch: opts.fetch, timeout: opts.timeout || 1500 });
        done++;
        if (info) { const d = { ip, info }; found.push(d); opts.onFound && opts.onFound(d); }
        opts.onProgress && opts.onProgress(done, list.length);
      }
    }
    await Promise.all(Array.from({ length: Math.min(conc, list.length) }, worker));
    return found;
  }

  const Wled = {
    normHost, createClient, probe, scan, isWledInfo,
    color: { rgbToHex, hexToRgb, hsvToRgb, rgbToHsv, kelvinToRgb },
    briFromStep, stepFromBri,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = Wled;
  else root.Wled = Wled;
})(typeof globalThis !== 'undefined' ? globalThis : this);
