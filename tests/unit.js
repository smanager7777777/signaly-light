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
  assert.deepStrictEqual(last.seg, { col: [[10, 20, 30]], fx: 0 });
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
  console.log('unit: OK');
})().catch((e) => { console.error(e); process.exit(1); });
