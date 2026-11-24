// Проверки модуля wled.js на заглушке: node tests/unit.js
'use strict';
const assert = require('assert');
const W = require('../wled.js');
const { createMockFetch } = require('../wled-mock.js');
const C = W.color;
(async () => {
  // цвета
  assert.deepStrictEqual(C.hexToRgb('#ff8000'), [255, 128, 0]);
  assert.deepStrictEqual(C.hexToRgb('f80'), [255, 136, 0]);
  assert.strictEqual(C.hexToRgb('#zz0000'), null);
  assert.strictEqual(C.rgbToHex([255, 128, 0]), '#FF8000');
  for (const h of [0, 60, 120, 200, 300]) {
    const back = C.rgbToHsv(C.hsvToRgb(h, 1, 1));
    assert(Math.abs(back.h - h) < 1.5, 'hsv ' + h);
  }
  const warm = C.kelvinToRgb(2200), cold = C.kelvinToRgb(7500), n = C.kelvinToRgb(6600);
  assert(warm[0] === 255 && warm[2] < 120, 'тёплый: мало синего ' + warm);
  assert(cold[2] === 255 && cold[0] < 255, 'холодный: синий максимум ' + cold);
  assert(n.every((v) => v > 240), '6600 К ≈ белый ' + n);
  // яркость
  for (const s of [20, 100, 255]) {
    assert.strictEqual(W.briFromStep(s, s), 255);
    assert.strictEqual(W.briFromStep(0, s), 0);
    for (let k = 0; k <= s; k++) assert.strictEqual(W.stepFromBri(W.briFromStep(k, s), s), k, 'шаг ' + k + '/' + s);
  }
  assert.strictEqual(W.briFromStep(1, 20), 13);
  assert.strictEqual(W.normHost(' http://192.168.1.5/json '), '192.168.1.5');
  // клиент
  const f = createMockFetch({ delay: 5 });
  const cl = W.createClient('192.168.1.50', { fetch: f, minGap: 0 });
  const info = await cl.getInfo();
  assert(W.isWledInfo(info));
  let st = await cl.setOn(false); assert.strictEqual(st.on, false);
  st = await cl.toggle(); assert.strictEqual(st.on, true);
  st = await cl.setColor([10, 20, 30]);
  assert.deepStrictEqual(st.seg[0].col[0], [10, 20, 30]);
  const last = f.log[f.log.length - 1].body;
  assert.deepStrictEqual(last.seg, [{ id: 0, col: [[10, 20, 30]], fx: 0, frz: false }]);
  assert.strictEqual(last.v, true);
  // «последняя выигрывает»: 50 движений ползунка → 2 запроса, итог верный
  const before = cl.sentCount;
  const ps = []; for (let b = 1; b <= 50; b++) ps.push(cl.setBri(b * 5));
  await Promise.all(ps);
  assert(cl.sentCount - before <= 2, 'склейка команд: ' + (cl.sentCount - before));
  assert.strictEqual(f.state.bri, 250);
  st = await cl.setWhiteK(2700); assert.deepStrictEqual(st.seg[0].col[0], C.kelvinToRgb(2700));
  // поиск: подсеть + одиночный адрес
  const f2 = createMockFetch({ hosts: ['192.168.1.50', '4.3.2.1'], delay: 1 });
  const found = await W.scan(['192.168.1', '4.3.2.1'], { fetch: f2, timeout: 60, concurrency: 64 });
  assert.deepStrictEqual(found.map((d) => d.ip).sort(), ['192.168.1.50', '4.3.2.1']);
  // нет устройства
  assert.strictEqual(await W.probe('10.0.0.9', { fetch: f2, timeout: 50 }), null);
  // ---------- этап 2 ----------
  // "i": кодирование диапазонами, разбиение, обратное чтение
  const cols = [[255, 0, 0], [255, 0, 0], [255, 0, 0], [0, 255, 0], [0, 0, 255], [0, 0, 255]];
  assert.deepStrictEqual(W.i.encode(cols), [0, 3, 'FF0000', 3, '00FF00', 4, 6, '0000FF']);
  assert.deepStrictEqual(W.i.decode(W.i.encode(cols), 6), ['FF0000', 'FF0000', 'FF0000', '00FF00', '0000FF', '0000FF']);
  assert.deepStrictEqual(W.i.decode(['AA0000', 'BB0000', 4, 'CC0000'], 6), ['AA0000', 'BB0000', null, null, 'CC0000', null]);
  const many = Array.from({ length: 50 }, (_, k) => [k, 0, 0]);
  const ch = W.i.chunk(W.i.encodeEntries(many), 20);
  assert.strictEqual(ch.length, 3);
  const back = new Array(50).fill(null); ch.forEach((c) => W.i.decode(c, 50, back));
  assert(back.every((h, k) => h === C.rgbToHex([k, 0, 0]).slice(1)), 'куски "i"');
  assert.deepStrictEqual(C.scaleRgb([200, 100, 0], 128), [100, 50, 0]);
  assert.deepStrictEqual(C.gradient(3, [0, 0, 0], [255, 100, 10]), [[0, 0, 0], [128, 50, 5], [255, 100, 10]]);
  // склейка: сегменты по id, разные формы не склеиваются
  assert.deepStrictEqual(W.mergePatch({ seg: [{ id: 0, bri: 1 }] }, { seg: [{ id: 0, col: [[1, 2, 3]] }, { id: 1, on: false }] }).seg,
    [{ id: 0, bri: 1, col: [[1, 2, 3]] }, { id: 1, on: false }]);
  assert.strictEqual(W.mergePatch({ seg: { fx: 0 } }, { seg: [{ id: 0 }] }), null);

  // несколько контроллеров, соседи, имя, эффекты
  const f3 = createMockFetch({ hosts: ['192.168.1.50', '192.168.1.51'], leds: { '192.168.1.51': 30 }, delay: 1,
    effects: ['Solid', 'Blink'].concat(Array.from({ length: 48 }, (_, k) => 'X' + k), ['Gradient']) });
  const a = W.createClient('192.168.1.50', { fetch: f3, minGap: 0, maxEntries: 8 });
  const b = W.createClient('192.168.1.51', { fetch: f3, minGap: 0 });
  await a.getInfo(); await b.getInfo(); await a.getState(); await b.getState();
  assert.strictEqual(b.count, 30);
  assert.deepStrictEqual((await a.getNodes()).map((x) => x.ip), ['192.168.1.51']);
  assert.deepStrictEqual(await a.loadEffects(), { solid: 0, blink: 1, gradient: 50 }, 'номер эффекта — по названию');
  assert.strictEqual(await b.setName('Сцена'), true);
  assert.strictEqual(f3.devices['192.168.1.51'].info.name, 'Сцена');
  await Promise.all([a.setOn(false), b.setOn(false)]);
  assert(!f3.devices['192.168.1.50'].state.on && !f3.devices['192.168.1.51'].state.on, 'оба выключены');

  // сегменты: создать, изменить, удалить; у каждого свой цвет и яркость
  const view = () => f3.view('192.168.1.50');
  await a.updateSegment(0, { start: 0, stop: 20 });
  st = await a.addSegment(20, 40, { rgb: [0, 0, 255], name: 'середина' });
  st = await a.addSegment(40, 60, { rgb: [0, 255, 0] });
  assert.deepStrictEqual(st.seg.map((s) => [s.id, s.start, s.stop]), [[0, 0, 20], [1, 20, 40], [2, 40, 60]]);
  assert.strictEqual(st.seg[1].n, 'середина');
  await a.setColor([255, 0, 0], [0]);
  let v = view();
  assert(v[0] === 'FF0000' && v[25] === '0000FF' && v[59] === '00FF00', 'цвета участков ' + [v[0], v[25], v[59]]);
  await a.setSegBri(1, 60); assert.strictEqual(f3.state.seg[1].bri, 60);
  await a.setSegBri(2, 0); assert.strictEqual(f3.state.seg[2].on, false);
  await a.setSegBri(2, 255);
  await assert.rejects(a.addSegment(5, 5), /пустой/);
  // отдельные светодиоды: весь сегмент уходит в "i" (WLED заливает его чёрным), куски ≤ 8 записей
  const n0 = f3.log.length;
  const map = {}; for (let g = 21; g < 39; g += 2) map[g] = { rgb: [255, 255, 255], bri: 128 };
  st = await a.setLeds(map);
  v = view();
  assert.strictEqual(v[21], '808080', 'светодиод 22 — белый на половине яркости');
  assert.strictEqual(v[22], '0000FF', 'соседний — цвет участка, а не чёрный');
  assert.strictEqual(v[0], 'FF0000', 'другой участок не тронут');
  const iReq = f3.log.slice(n0).filter((r) => r.body && r.body.seg && r.body.seg[0].i);
  assert(iReq.length >= 2 && iReq.every((r) => r.body.seg[0].id === 1 && r.body.seg[0].i.length <= 8 * 3), 'разбиение "i"');
  assert.strictEqual(a.ledView()[21], '#808080');
  // обычный цвет участка снимает заморозку и забывает светодиоды
  await a.setColor([0, 255, 255], [1]);
  assert.strictEqual(view()[21], '00FFFF'); assert.deepStrictEqual(a.leds, {});
  // эффекты: мигание и градиент со скоростью; неподвижный градиент — через "i"
  st = await a.setEffect('blink', { ids: [2], c1: [255, 0, 0], c2: [0, 0, 0], speed: 200 });
  assert.strictEqual(st.seg[2].fx, 1); assert.strictEqual(st.seg[2].sx, 200);
  assert.deepStrictEqual(st.seg[2].col.slice(0, 2), [[255, 0, 0], [0, 0, 0]]);
  st = await a.setEffect('gradient', { c1: [255, 0, 0], c2: [0, 0, 255], speed: 90 });
  assert(st.seg.every((s) => s.fx === 50 && s.sx === 90), 'градиент на всех участках');
  await a.setEffect('gradient', { ids: [1], c1: [255, 0, 0], c2: [0, 0, 255], speed: 0 });
  v = view();
  assert(v[20] === 'FF0000' && v[39] === '0000FF' && v[30] !== v[20], 'неподвижный градиент ' + [v[20], v[30], v[39]]);
  assert.strictEqual(v[0], 'fx50', 'участок 1 — дальше в эффекте');
  await a.setEffect('solid', { ids: [0], c1: [1, 2, 3] });
  assert.strictEqual(view()[0], '010203');
  // удаление: номера сдвигаются, последний не удаляется
  st = await a.deleteSegment(1);
  assert.deepStrictEqual(st.seg.map((s) => [s.id, s.start]), [[0, 0], [1, 40]]);
  await a.deleteSegment(1);
  await assert.rejects(a.deleteSegment(0), /последний/);
  console.log('unit: OK');
})().catch((e) => { console.error(e); process.exit(1); });
