/*
 * wled-mock.js — заглушка контроллеров WLED для проверки без железа.
 * light.htm?mock — страница работает с выдуманными контроллерами 192.168.1.50 (60 светодиодов)
 * и 192.168.1.51 (30); первый знает второго через /json/nodes.
 * В Node: require('./wled-mock.js').createMockFetch({hosts, leds: {ip: число}, effects: [...]}).
 * Ведёт себя как WLED в главном: сегменты по id (новый — в конец, stop 0 — удалить, номера
 * сдвигаются), "i" замораживает сегмент и заливает его чёрным, frz: false — размораживает.
 * mockFetch.view(ip) — что горит на ленте: hex или 'fx<номер>' (эффект) по каждому светодиоду.
 */
(function (root) {
  'use strict';
  const EFFECTS = ['Solid', 'Blink', 'Breathe', 'Wipe', 'Wipe Random', 'Random Colors', 'Sweep', 'Dynamic',
    'Colorloop', 'Rainbow', 'Scan', 'Scan Dual', 'Fade', 'Theater', 'Theater Rainbow', 'Running', 'Saw',
    'Twinkle', 'Dissolve', 'Dissolve Rnd', 'Sparkle', 'Sparkle Dark', 'Sparkle+', 'Strobe', 'Strobe Rainbow',
    'Strobe Mega', 'Blink Rainbow', 'Android', 'Chase', 'Chase Random', 'Chase Rainbow', 'Chase Flash',
    'Chase Flash Rnd', 'Rainbow Runner', 'Colorful', 'Traffic Light', 'Sweep Random', 'Chase 2', 'Aurora',
    'Stream', 'Scanner', 'Lighthouse', 'Fireworks', 'Rain', 'Tetrix', 'Fire Flicker', 'Gradient', 'Loading'];
  const hex = (c) => c.map((v) => Math.max(0, Math.min(255, v | 0)).toString(16).padStart(2, '0')).join('').toUpperCase();

  function createMockFetch(o) {
    o = o || {};
    const hosts = o.hosts || ['192.168.1.50'];
    const delay = o.delay == null ? 15 : o.delay;
    const effects = o.effects || EFFECTS;
    const log = [];
    const devices = {};
    hosts.forEach((ip, n) => {
      const count = (o.leds && o.leds[ip]) || 60;
      devices[ip] = {
        info: {
          ver: '0.15.0', vid: 2410270, name: n ? 'WLED-' + (n + 1) : 'WLED-заглушка',
          leds: { count, rgbw: false, cct: false, maxpwr: 850, pwr: 300, maxseg: o.maxseg || 32 },
          wifi: { signal: 76 }, arch: 'esp32', mac: '00000000000' + n, ip,
        },
        state: { on: true, bri: 128, transition: 7, ps: -1, pl: -1, seg: [newSeg(0, 0, count)] },
        pixels: new Array(count).fill('000000'),
        nodes: o.nodes ? (o.nodes[ip] || []) : hosts.filter((h) => h !== ip),
      };
      devices[ip].state.seg[0].sel = true;
    });
    function newSeg(id, start, stop) {
      return { id, start, stop, len: stop - start, grp: 1, spc: 0, of: 0, on: true, frz: false, bri: 255, cct: 127,
        n: '', col: [[255, 160, 80], [0, 0, 0], [0, 0, 0]], fx: 0, sx: 128, ix: 128, pal: 0, sel: false, rev: false, mi: false };
    }
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    function resp(obj) { return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(obj)) }; }

    function applySeg(d, s, el) {
      const n = d.info.leds.count;
      if (typeof el.start === 'number') s.start = Math.max(0, Math.min(n, el.start));
      if (typeof el.stop === 'number') s.stop = Math.max(0, Math.min(n, el.stop));
      s.len = s.stop - s.start;
      if (el.col) el.col.forEach((c, i) => { if (Array.isArray(c)) s.col[i] = c.slice(0, 3); });
      ['bri', 'fx', 'sx', 'ix', 'pal'].forEach((k) => { if (typeof el[k] === 'number') s[k] = el[k]; });
      if (typeof el.on === 'boolean') s.on = el.on;
      if (typeof el.n === 'string') s.n = el.n;
      if (typeof el.sel === 'boolean') s.sel = el.sel;
      if (el.frz === false) s.frz = false;
      if (Array.isArray(el.i)) {
        if (!s.frz) { s.frz = true; for (let g = s.start; g < s.stop; g++) d.pixels[g] = '000000'; }
        let nums = [], cur = 0;
        const put = (k, h) => { if (k >= 0 && k < s.len) d.pixels[s.start + k] = h; };
        el.i.forEach((x) => {
          if (typeof x === 'number') { nums.push(x); return; }
          const h = Array.isArray(x) ? hex(x) : String(x).toUpperCase();
          if (nums.length >= 2) { for (let k = nums[0]; k < nums[1]; k++) put(k, h); cur = nums[1]; }
          else if (nums.length === 1) { put(nums[0], h); cur = nums[0] + 1; } else { put(cur, h); cur++; }
          nums = [];
        });
      }
    }
    function apply(d, b) {
      const st = d.state;
      if (b.on === 't') st.on = !st.on; else if (typeof b.on === 'boolean') st.on = b.on;
      if (typeof b.bri === 'number') { st.bri = Math.max(0, Math.min(255, b.bri)); if (st.bri === 0) st.on = false; }
      if (b.seg && !Array.isArray(b.seg)) {
        const sel = st.seg.filter((s) => s.sel);
        (sel.length ? sel : [st.seg[0]]).forEach((s) => applySeg(d, s, b.seg));
      } else if (Array.isArray(b.seg)) {
        b.seg.forEach((el, k) => {
          const id = typeof el.id === 'number' ? el.id : k;
          if (id >= d.info.leds.maxseg) return;
          if (el.stop === 0) {
            if (id < st.seg.length && st.seg.length > 1) { st.seg.splice(id, 1); st.seg.forEach((s, j) => { s.id = j; }); }
            return;
          }
          let s = st.seg[id];
          if (!s) {
            if (!(el.stop > 0)) return;
            s = newSeg(st.seg.length, 0, d.info.leds.count);
            st.seg.push(s);
          }
          applySeg(d, s, el);
        });
      }
    }
    // что горит на ленте (сегмент с большим номером — поверх)
    function view(ip) {
      const d = devices[ip], n = d.info.leds.count, out = new Array(n).fill('000000');
      d.state.seg.forEach((s) => {
        for (let g = s.start; g < Math.min(n, s.stop); g++) {
          out[g] = !s.on ? '000000' : s.frz ? d.pixels[g] : s.fx ? 'fx' + s.fx : hex(s.col[0]);
        }
      });
      return out;
    }

    async function mockFetch(url, init) {
      init = init || {};
      const m = String(url).match(/^http:\/\/([^/]+)(\/.*)$/);
      const host = m && m[1], path = m && m[2];
      log.push({ url: String(url), host, path, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : undefined });
      if (!m || !devices[host] || devices[host].down) {
        // «нет устройства»: висим до таймаута, как настоящая сеть
        await new Promise((res, rej) => {
          if (init.signal) init.signal.addEventListener('abort', () => rej(new Error('abort')));
          setTimeout(() => rej(new Error('net')), 60000);
        });
      }
      await wait(delay);
      const d = devices[host], get = (init.method || 'GET') === 'GET';
      if (path === '/json/info') return resp(d.info);
      if (path === '/json/eff') return resp(effects);
      if (path === '/json/nodes') {
        return resp({ nodes: d.nodes.filter((h) => devices[h]).map((h) => ({ name: devices[h].info.name, type: 32, ip: h, age: 0, vid: 2410270 })) });
      }
      if (path === '/json/state' && get) return resp(d.state);
      if (path === '/json/state') {
        const b = JSON.parse(init.body || '{}');
        apply(d, b);
        return resp(b.v ? d.state : { success: true });
      }
      if (path === '/json/cfg' && !get) {
        const b = JSON.parse(init.body || '{}');
        if (b.id && typeof b.id.name === 'string') d.info.name = b.id.name;
        return resp({ success: true });
      }
      return { ok: false, status: 404, json: async () => ({}) };
    }
    mockFetch.log = log;
    mockFetch.devices = devices;
    mockFetch.state = devices[hosts[0]].state;
    mockFetch.view = view;
    return mockFetch;
  }
  const api = { createMockFetch, EFFECTS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.WledMock = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
