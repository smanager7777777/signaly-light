/*
 * wled-mock.js — заглушка контроллера WLED для проверки без железа.
 * light.htm?mock — страница работает с выдуманным контроллером 192.168.1.50.
 * В Node: require('./wled-mock.js').createMockFetch({...}).
 */
(function (root) {
  'use strict';
  function createMockFetch(o) {
    o = o || {};
    const hosts = o.hosts || ['192.168.1.50'];
    const delay = o.delay == null ? 15 : o.delay;
    const log = [];
    const state = {
      on: true, bri: 128, transition: 7, ps: -1, pl: -1,
      seg: [{ id: 0, start: 0, stop: 60, len: 60, on: true, bri: 255, fx: 0, sx: 128, ix: 128,
        col: [[255, 160, 80], [0, 0, 0], [0, 0, 0]] }],
    };
    const info = {
      ver: '0.15.0', vid: 2410270, name: 'WLED-заглушка',
      leds: { count: 60, rgbw: false, cct: false, maxpwr: 850, pwr: 300 },
      wifi: { signal: 76 }, arch: 'esp32', mac: '000000000000', ip: hosts[0],
    };
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    function resp(obj) { return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(obj)) }; }
    function apply(b) {
      if (b.on === 't') state.on = !state.on; else if (typeof b.on === 'boolean') state.on = b.on;
      if (typeof b.bri === 'number') { state.bri = Math.max(0, Math.min(255, b.bri)); if (state.bri === 0) state.on = false; }
      if (b.seg && !Array.isArray(b.seg)) {
        if (b.seg.col) b.seg.col.forEach((c, i) => { state.seg[0].col[i] = c.slice(0, 3); });
        if (typeof b.seg.fx === 'number') state.seg[0].fx = b.seg.fx;
      }
    }
    async function mockFetch(url, init) {
      init = init || {};
      const m = String(url).match(/^http:\/\/([^/]+)(\/.*)$/);
      const host = m && m[1], path = m && m[2];
      log.push({ url: String(url), method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : undefined });
      if (!m || hosts.indexOf(host) < 0) {
        // «нет устройства»: висим до таймаута, как настоящая сеть
        await new Promise((res, rej) => {
          if (init.signal) init.signal.addEventListener('abort', () => rej(new Error('abort')));
          setTimeout(() => rej(new Error('net')), 60000);
        });
      }
      await wait(delay);
      if (path === '/json/info') return resp(info);
      if (path === '/json/state' && (init.method || 'GET') === 'GET') return resp(state);
      if (path === '/json/state') {
        const b = JSON.parse(init.body || '{}');
        apply(b);
        return resp(b.v ? state : { success: true });
      }
      return { ok: false, status: 404, json: async () => ({}) };
    }
    mockFetch.log = log;
    mockFetch.state = state;
    return mockFetch;
  }
  const api = { createMockFetch };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.WledMock = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
