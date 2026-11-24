/*
 * wled.js — модуль обмена с контроллером WLED (JSON API) и перевода цветов.
 * Без DOM: его можно перенести в другое приложение целиком.
 * Подключение: <script src="wled.js"></script> → window.Wled; в Node — require('./wled.js').
 *
 * Команды WLED (http://<IP>/json/…):
 *   GET  /json/info   — имя, версия, число светодиодов (leds.count, leds.maxseg), Wi-Fi
 *   GET  /json/state  — on, bri (0–255), seg[] = {id, start, stop, on, bri, col, fx, sx, ix, frz, n}
 *   POST /json/state  — изменения; "v": true → в ответе полное состояние
 *   GET  /json/eff    — названия эффектов (номер в списке = fx)
 *   GET  /json/nodes  — соседние WLED в сети (нужно «Discovery» в Sync settings)
 *   POST /json/cfg    — настройки; {"id":{"name":…}} — имя контроллера
 * Сегмент (участок): seg[{id, start, stop (не включая)}]; удалить — {"id":N,"stop":0};
 * новый получает следующий номер; после удаления номера сдвигаются.
 * Отдельные светодиоды: seg[{id, "i":[номер, "RRGGBB", начало, конец, "RRGGBB", …]}],
 * номера — от начала сегмента. WLED при первой "i" «замораживает» сегмент (frz) и заливает
 * его чёрным, поэтому модуль всегда шлёт весь сегмент; обычный цвет и эффект — с "frz": false.
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
  // яркость отдельного светодиода: у WLED её нет — цвет умножается на bri/255
  function scaleRgb(rgb, bri) { return rgb.map((v) => byte((v * clamp(bri, 0, 255)) / 255)); }
  // плавный переход c1 → c2 на n светодиодов
  function gradient(n, c1, c2) {
    const out = [];
    for (let k = 0; k < n; k++) {
      const t = n > 1 ? k / (n - 1) : 0;
      out.push([0, 1, 2].map((j) => byte(c1[j] + (c2[j] - c1[j]) * t)));
    }
    return out;
  }

  // ---------- яркость: шаги ползунка ↔ 0–255 ----------
  // steps = 20 / 100 / 255; шаг k (0…steps) → bri (0…255)
  function briFromStep(k, steps) { return byte((clamp(k, 0, steps) * 255) / steps); }
  function stepFromBri(bri, steps) { return clamp(Math.round((clamp(bri, 0, 255) * steps) / 255), 0, steps); }

  // ---------- команда "i" ----------
  const hex6 = (rgb) => rgbToHex(rgb).slice(1);
  // colors — [r,g,b] по порядку от начала сегмента → записи [номер, hex] или [начало, конец, hex]
  function encodeEntries(colors) {
    const out = [];
    let i = 0;
    while (i < colors.length) {
      const h = hex6(colors[i]);
      let j = i + 1;
      while (j < colors.length && hex6(colors[j]) === h) j++;
      out.push(j - i === 1 ? [i, h] : [i, j, h]);
      i = j;
    }
    return out;
  }
  // записи → массивы "i" не длиннее maxEntries записей (чтобы не переполнить буфер JSON контроллера)
  function chunkI(entries, maxEntries) {
    const res = [];
    for (let k = 0; k < entries.length; k += maxEntries) res.push([].concat(...entries.slice(k, k + maxEntries)));
    return res;
  }
  function encodeI(colors) { return [].concat(...encodeEntries(colors)); }
  // массив "i" → hex по номерам (как читает WLED; для проверок и заглушки)
  function decodeI(arr, n, into) {
    const out = into || new Array(n).fill(null);
    let nums = [], cur = 0;
    const put = (k, h) => { if (k >= 0 && k < n) out[k] = h; };
    arr.forEach((x) => {
      if (typeof x === 'number') { nums.push(x); return; }
      const h = Array.isArray(x) ? hex6(x) : String(x).toUpperCase();
      if (nums.length >= 2) { for (let k = nums[0]; k < nums[1]; k++) put(k, h); cur = nums[1]; }
      else if (nums.length === 1) { put(nums[0], h); cur = nums[0] + 1; }
      else { put(cur, h); cur++; }
      nums = [];
    });
    return out;
  }

  // ---------- сегменты ----------
  function segsOf(st) { return (st && Array.isArray(st.seg) ? st.seg : []).filter((s) => s && s.stop > s.start); }
  // кому принадлежит каждый светодиод: сегмент с большим номером рисуется поверх (как в WLED)
  function ownerMap(st, n) {
    const own = new Array(n).fill(-1);
    segsOf(st).slice().sort((a, b) => a.id - b.id).forEach((s) => {
      for (let k = Math.max(0, s.start); k < Math.min(n, s.stop); k++) own[k] = s.id;
    });
    return own;
  }
  function segColor(s) { return (s && s.col && s.col[0] ? s.col[0] : [0, 0, 0]).slice(0, 3); }

  // ---------- склейка команд ----------
  // a, b — {seg: […]} (по id) или {seg: {…}} (к выбранным сегментам). Несовместимо → null.
  function mergePatch(a, b) {
    const out = Object.assign({}, a, b);
    if (a.seg && b.seg) {
      const aa = Array.isArray(a.seg), bb = Array.isArray(b.seg);
      if (aa !== bb) return null;
      if (!aa) out.seg = Object.assign({}, a.seg, b.seg);
      else {
        const seg = a.seg.map((x) => Object.assign({}, x));
        b.seg.forEach((x) => {
          const t = seg.find((y) => y.id === x.id);
          if (t) Object.assign(t, x); else seg.push(Object.assign({}, x));
        });
        out.seg = seg;
      }
    }
    return out;
  }

  // ---------- клиент одного контроллера ----------
  function createClient(host, opts) {
    opts = opts || {};
    const fetchFn = opts.fetch || ((u, o) => root.fetch(u, o));
    const timeout = opts.timeout || 3000;
    const minGap = opts.minGap == null ? 40 : opts.minGap; // мс между командами, чтобы не душить ESP
    const tt = opts.transition == null ? 1 : opts.transition; // плавность одной команды, ×100 мс
    const maxEntries = opts.maxEntries || 200; // записей "i" в одном запросе
    const base = 'http://' + normHost(host);
    let sent = 0, last = null, info = null;
    const fx = { solid: 0, blink: 1, gradient: 46 }; // номера по умолчанию; уточняются по /json/eff
    let leds = {}; // отдельные светодиоды: номер на ленте → {rgb, bri}

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
    function remember(st) { if (st && Array.isArray(st.seg)) last = st; return st; }
    const count = () => (info && info.leds && info.leds.count) || segsOf(last).reduce((m, s) => Math.max(m, s.stop), 0);

    // Очередь «последняя команда выигрывает»: пока идёт запрос, новые изменения склеиваются
    // с последней ждущей командой. Ползунок не забивает контроллер очередью.
    // Вид 'p' — обычная команда; 'l' — светодиоды сегментов {id: [rgb…]} (последняя заменяет).
    const queue = [];
    let busy = false;
    function enqueue(kind, data) {
      return new Promise((res, rej) => {
        const tail = queue[queue.length - 1];
        if (tail && tail.kind === kind) {
          const m = kind === 'p' ? mergePatch(tail.data, data) : Object.assign({}, tail.data, data);
          if (m) { tail.data = m; tail.ws.push({ res, rej }); return; }
        }
        queue.push({ kind, data, ws: [{ res, rej }] });
        pump();
      });
    }
    async function post(body) {
      body = Object.assign({}, body, { v: true });
      if (tt != null && body.tt == null) body.tt = tt;
      sent++;
      return remember(await req('/json/state', body));
    }
    async function pump() {
      if (busy || !queue.length) return;
      busy = true;
      const it = queue.shift();
      try {
        let st;
        if (it.kind === 'p') st = await post(it.data);
        else {
          for (const id of Object.keys(it.data)) {
            const chunks = chunkI(encodeEntries(it.data[id]), maxEntries);
            for (let c = 0; c < chunks.length; c++) {
              st = await post({ seg: [{ id: +id, fx: fx.solid, i: chunks[c] }] });
              if (minGap && c < chunks.length - 1) await new Promise((r) => setTimeout(r, minGap));
            }
          }
        }
        it.ws.forEach((w) => w.res(st));
      } catch (e) {
        it.ws.forEach((w) => w.rej(e));
      }
      if (minGap) await new Promise((r) => setTimeout(r, minGap));
      busy = false;
      pump();
    }
    function send(patch) { return enqueue('p', patch); }

    // команда к сегментам ids (не задано — ко всем известным); сегменты неизвестны — к выбранным в WLED
    function segPatch(ids, fields) {
      const all = segsOf(last).map((s) => s.id);
      const list = ids == null ? all : [].concat(ids);
      if (!list.length) return Object.assign({}, fields);
      return list.map((id) => Object.assign({ id }, fields));
    }
    // забыть отдельные светодиоды сегментов (их перекрывает обычный цвет или эффект)
    function dropLeds(ids) {
      const n = count(), own = ownerMap(last, n);
      const set = ids == null ? null : [].concat(ids);
      Object.keys(leds).forEach((k) => { if (!set || set.indexOf(own[k]) >= 0 || own[k] < 0) delete leds[k]; });
    }
    // полный набор цветов сегмента: заданные светодиоды + цвет сегмента
    function segLeds(s, own) {
      const out = [];
      for (let g = s.start; g < s.stop; g++) {
        const v = own[g] === s.id ? leds[g] : null;
        out.push(v ? scaleRgb(v.rgb, v.bri) : segColor(s));
      }
      return out;
    }
    // map: {номер на ленте (с 0): {rgb, bri} | [r,g,b] | null (убрать)}
    function setLeds(map) {
      const n = count(), own = ownerMap(last, n), touched = {};
      Object.keys(map).forEach((k) => {
        const g = +k, v = map[k];
        if (!(g >= 0 && g < n) || own[g] < 0) return;
        if (v == null) delete leds[g];
        else leds[g] = Array.isArray(v) ? { rgb: v.map(byte), bri: 255 } : { rgb: v.rgb.map(byte), bri: v.bri == null ? 255 : byte(v.bri) };
        touched[own[g]] = true;
      });
      const data = {};
      segsOf(last).forEach((s) => { if (touched[s.id]) data[s.id] = segLeds(s, own); });
      if (!Object.keys(data).length) return Promise.resolve(last);
      return enqueue('l', data);
    }
    // светодиоды, видимые на ленте: номер → hex цвета (с учётом яркости светодиода)
    function ledView() {
      const out = {};
      Object.keys(leds).forEach((k) => { out[k] = rgbToHex(scaleRgb(leds[k].rgb, leds[k].bri)); });
      return out;
    }

    async function loadEffects() {
      try {
        const names = await req('/json/eff');
        if (Array.isArray(names)) {
          const b = names.indexOf('Blink'), g = names.indexOf('Gradient');
          if (b >= 0) fx.blink = b;
          if (g >= 0) fx.gradient = g;
        }
      } catch (e) { /* старые номера */ }
      return Object.assign({}, fx);
    }
    // эффект: kind 'solid' | 'blink' | 'gradient'; o = {ids, c1, c2, speed 0–255, intensity}
    // градиент со скоростью 0 — неподвижный, считается здесь и уходит командой "i"
    function setEffect(kind, o) {
      o = o || {};
      const c1 = (o.c1 || [255, 255, 255]).map(byte), c2 = (o.c2 || [0, 0, 0]).map(byte);
      const speed = byte(o.speed == null ? 128 : o.speed);
      if (kind === 'gradient' && speed === 0) {
        const n = count(), own = ownerMap(last, n);
        const set = o.ids == null ? segsOf(last).map((s) => s.id) : [].concat(o.ids);
        const idx = [];
        for (let g = 0; g < n; g++) if (set.indexOf(own[g]) >= 0) idx.push(g);
        const cols = gradient(idx.length, c1, c2), map = {};
        idx.forEach((g, k) => { map[g] = { rgb: cols[k], bri: 255 }; });
        return send({ on: true, seg: segPatch(set, { col: [c1, c2], fx: fx.solid }) }).then(() => setLeds(map));
      }
      dropLeds(o.ids);
      const f = { frz: false, fx: fx[kind] == null ? 0 : fx[kind] };
      if (kind === 'solid') f.col = [c1];
      else { f.col = [c1, c2]; f.sx = speed; f.ix = byte(o.intensity == null ? 128 : o.intensity); }
      return send({ on: true, seg: segPatch(o.ids, f) });
    }

    return {
      host: normHost(host),
      get sentCount() { return sent; },
      get idle() { return !busy && !queue.length; },
      get state() { return last; },
      get info() { return info; },
      get effects() { return Object.assign({}, fx); },
      get count() { return count(); },
      async getInfo(t) { const j = await req('/json/info', undefined, t); if (isWledInfo(j)) info = j; return j; },
      async getState() { return remember(await req('/json/state')); },
      send,
      setOn: (on) => send({ on: !!on }),
      toggle: () => send({ on: 't' }),
      setBri: (bri) => send({ on: true, bri: clamp(Math.round(bri), 1, 255) }),
      // fx: 0 — эффект «Solid», frz: false — снять заморозку после отдельных светодиодов
      setColor(rgb, ids) { dropLeds(ids); return send({ on: true, seg: segPatch(ids, { col: [rgb.map(byte)], fx: fx.solid, frz: false }) }); },
      setWhiteK(k, ids) { return this.setColor(kelvinToRgb(k), ids); },
      // яркость сегмента 0–255; 0 — сегмент выключен
      setSegBri(id, bri) {
        bri = byte(bri);
        return send({ seg: [bri ? { id, on: true, bri } : { id, on: false }] });
      },
      // новый сегмент [start, stop) (номера с 0, stop не включается)
      addSegment(start, stop, o) {
        o = o || {};
        const n = count(), segs = segsOf(last);
        const max = (info && info.leds && info.leds.maxseg) || 16;
        start = clamp(Math.round(start), 0, n); stop = clamp(Math.round(stop), 0, n);
        if (!(stop > start)) return Promise.reject(new Error('пустой участок'));
        if (segs.length >= max) return Promise.reject(new Error('не больше ' + max + ' участков'));
        const id = segs.reduce((m, s) => Math.max(m, s.id + 1), 0);
        const el = { id, start, stop, on: true, bri: 255, col: [(o.rgb || [255, 255, 255]).map(byte)], fx: fx.solid, frz: false };
        if (o.name) el.n = String(o.name).slice(0, 32);
        for (let g = start; g < stop; g++) delete leds[g]; // новый участок рисуется поверх
        return send({ on: true, seg: [el] });
      },
      updateSegment(id, o) {
        const el = { id };
        const n = count();
        if (o.start != null) el.start = clamp(Math.round(o.start), 0, n);
        if (o.stop != null) el.stop = clamp(Math.round(o.stop), 0, n);
        if (el.start != null && el.stop != null && !(el.stop > el.start)) return Promise.reject(new Error('пустой участок'));
        if (o.name != null) el.n = String(o.name).slice(0, 32);
        if (el.start != null || el.stop != null) { dropLeds([id]); el.frz = false; }
        return send({ seg: [el] });
      },
      deleteSegment(id) {
        if (segsOf(last).length <= 1) return Promise.reject(new Error('последний участок не удаляется'));
        dropLeds([id]);
        return send({ seg: [{ id, stop: 0 }] });
      },
      setLeds,
      // заново отправить светодиоды участков ids (после смены яркости участка: WLED применяет её при записи)
      refreshLeds(ids) {
        const n = count(), own = ownerMap(last, n), set = ids == null ? null : [].concat(ids), data = {};
        segsOf(last).forEach((s) => {
          if (set && set.indexOf(s.id) < 0) return;
          if (Object.keys(leds).some((k) => own[k] === s.id)) data[s.id] = segLeds(s, own);
        });
        return Object.keys(data).length ? enqueue('l', data) : Promise.resolve(last);
      },
      // убрать отдельные светодиоды сегментов ids (все — без ids): лента снова в цвете сегмента
      clearLeds(ids) {
        dropLeds(ids);
        return send({ seg: segPatch(ids, { frz: false }) });
      },
      get leds() { return JSON.parse(JSON.stringify(leds)); },
      ledView,
      loadEffects,
      setEffect,
      async getNodes(t) {
        const j = await req('/json/nodes', undefined, t);
        return (j && Array.isArray(j.nodes) ? j.nodes : []).filter((x) => x && x.ip)
          .map((x) => ({ ip: String(x.ip), name: x.name || '', type: x.type, vid: x.vid }));
      },
      // имя контроллера (WLED: Config → User Interface → Server description); видно со всех телефонов
      async setName(name) {
        name = String(name || '').trim().slice(0, 32);
        await req('/json/cfg', { id: { name } });
        const j = await this.getInfo();
        return j && j.name === name;
      },
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
    color: { rgbToHex, hexToRgb, hsvToRgb, rgbToHsv, kelvinToRgb, scaleRgb, gradient },
    briFromStep, stepFromBri,
    i: { encode: encodeI, encodeEntries, chunk: chunkI, decode: decodeI },
    segsOf, ownerMap, segColor, mergePatch,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = Wled;
  else root.Wled = Wled;
})(typeof globalThis !== 'undefined' ? globalThis : this);
