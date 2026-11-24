// Страница в Chrome без железа (light.htm?mock): node tests/ui-smoke.mjs [путь к Chrome]
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';
const require = createRequire(import.meta.url);
let pw; try { pw = require('playwright'); } catch { pw = require('/opt/npm-tools/node_modules/playwright'); }
const dir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const exe = process.argv[2] || '/usr/bin/google-chrome';
const browser = await pw.chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 400, height: 900 } });
const errs = []; page.on('pageerror', (e) => errs.push(String(e)));
const fail = (m) => { console.error('ui: FAIL —', m); process.exitCode = 1; };
await page.goto('file://' + dir + '/light.htm?mock');
await page.waitForFunction(() => document.getElementById('dot').classList.contains('ok'), null, { timeout: 5000 });
const S = () => page.evaluate(() => window.__mockFetch.state);
// вкл/выкл
await page.click('#power'); await page.waitForFunction(() => window.__mockFetch.state.on === false);
await page.click('#power'); await page.waitForFunction(() => window.__mockFetch.state.on === true);
// шаги 20 и кнопки −/+
await page.selectOption('#steps', '20');
await page.evaluate(() => { const r = document.getElementById('bri'); r.value = 10; r.dispatchEvent(new Event('input')); });
await page.waitForFunction(() => window.__mockFetch.state.bri === 128);
await page.click('#briPlus'); await page.waitForFunction(() => window.__mockFetch.state.bri === 140);
await page.click('#briMinus'); await page.click('#briMinus'); await page.waitForFunction(() => window.__mockFetch.state.bri === 115);
// HEX
await page.fill('#hex', '#00FF80'); await page.waitForFunction(() => window.__mockFetch.state.seg[0].col[0].join() === '0,255,128');
// круг: щелчок в правый край → красный
const box = await page.locator('#wheel').boundingBox();
await page.mouse.click(box.x + box.width - 3, box.y + box.height / 2);
await page.waitForFunction(() => { const c = window.__mockFetch.state.seg[0].col[0]; return c[0] === 255 && c[1] < 30 && c[2] < 30; });
// избранное сохраняется после перезагрузки
await page.click('#favAdd');
await page.reload(); await page.waitForFunction(() => document.getElementById('dot').classList.contains('ok'));
if (await page.locator('#favs .fav').count() !== 1) fail('избранное не сохранилось');
if (await page.inputValue('#steps') !== '20') fail('число шагов не сохранилось');
// белый
await page.click('.presets button[data-k="2700"]');
await page.waitForFunction(() => { const c = window.__mockFetch.state.seg[0].col[0]; return c[0] === 255 && c[2] < 200; });
// поиск находит заглушку
await page.click('#scanBox summary'); await page.fill('#prefix', '192.168.1');
await page.click('#scan');
await page.waitForFunction(() => /Найдено: 2/.test(document.getElementById('scanProg').textContent), null, { timeout: 60000 });
// ---------- этап 2 ----------
const D = (ip, fn) => page.waitForFunction(([ip, f]) => new Function('d', 'v', 'return ' + f)(window.__mockFetch.devices[ip], window.__mockFetch.view(ip)), [ip, fn]);
const A = '192.168.1.50', B = '192.168.1.51';
// соседи из WLED → второе устройство
await page.click('#nodes');
await page.click('#found button[data-ip="' + B + '"]');
await page.waitForSelector('.dev[data-ip="' + B + '"] .dot.ok');
// оба отмечены: вкл/выкл и яркость — на оба
await page.click('#power');
await D(A, '!d.state.on'); await D(B, '!d.state.on');
await page.click('#power');
await D(A, 'd.state.on'); await D(B, 'd.state.on');
await page.evaluate(() => { const r = document.getElementById('bri'); r.value = 5; r.dispatchEvent(new Event('input')); });
await D(A, 'd.state.bri === 64'); await D(B, 'd.state.bri === 64');
// имя второго — в контроллер
await page.click('.dev[data-ip="' + B + '"] .ren');
await page.fill('.dev[data-ip="' + B + '"] .ren-in', 'Сцена');
await page.click('.dev[data-ip="' + B + '"] .ren-ok');
await D(B, 'd.info.name === "Сцена"');
// участки у первого: изменить 1-й, добавить 2-й
if (!(await page.isVisible('#segDev'))) fail('нет выбора устройства для участков');
await page.selectOption('#segDev', A);
await page.click('.seg[data-id="0"] .sed');
await page.fill('#segFrom', '1'); await page.fill('#segTo', '20'); await page.click('#segAdd');
await D(A, 'd.state.seg[0].stop === 20');
await page.fill('#segFrom', '21'); await page.fill('#segTo', '40'); await page.fill('#segName', 'середина'); await page.click('#segAdd');
await D(A, 'd.state.seg.length === 2 && d.state.seg[1].start === 20 && d.state.seg[1].n === "середина"');
// свой цвет и яркость участка
await page.click('#targets button[data-t="seg:1"]');
await page.fill('#hex', '#0000FF');
await D(A, 'v[25] === "0000FF" && v[0] !== "0000FF"');
await page.waitForSelector('.seg[data-id="1"] .sbri');
await page.evaluate(() => { const r = document.querySelector('.seg[data-id="1"] .sbri'); r.value = 50; r.dispatchEvent(new Event('input')); });
await D(A, 'd.state.seg[1].bri === 128');
// отдельные светодиоды: диапазон полями, цвет, яркость
await page.fill('#ledFrom', '3'); await page.fill('#ledTo', '5'); await page.click('#ledPick');
await page.fill('#hex', '#FF0000');
await D(A, 'v[2] === "FF0000" && v[4] === "FF0000" && v[5] !== "FF0000" && v[1] !== "FF0000"');
await page.evaluate(() => { const r = document.getElementById('ledBri'); r.value = 50; r.dispatchEvent(new Event('input')); });
await D(A, 'v[2] === "800000" && v[4] === "800000"');
// диапазон — проведя пальцем по ленте
await page.locator('#ledGrid').scrollIntoViewIfNeeded();
const c10 = await page.locator('#ledGrid .led').nth(10).boundingBox(), c12 = await page.locator('#ledGrid .led').nth(12).boundingBox();
await page.mouse.move(c10.x + 4, c10.y + 4); await page.mouse.down();
await page.mouse.move(c12.x + 4, c12.y + 4, { steps: 4 }); await page.mouse.up();
await page.waitForFunction(() => /Выбрано: 3 \(11–13\)/.test(document.getElementById('ledInfo').textContent));
await page.click('#ledReset');
await D(A, 'v[2] !== "800000" && !d.state.seg.some((s) => s.frz)');
// удалить участок
await page.click('.seg[data-id="1"] .sdel');
await D(A, 'd.state.seg.length === 1');
// эффекты на обе ленты
await page.click('#targets button[data-t="all"]');
await page.evaluate(() => { const r = document.getElementById('fxSpeed'); r.value = 200; r.dispatchEvent(new Event('input')); });
await page.click('#fxBlink');
await D(A, 'd.state.seg[0].fx === 1 && d.state.seg[0].sx === 200'); await D(B, 'd.state.seg[0].fx === 1');
await page.click('#fxGrad');
await D(A, 'd.state.seg[0].fx === 46'); await D(B, 'd.state.seg[0].fx === 46 && d.state.seg[0].sx === 200');
await page.evaluate(() => { const r = document.getElementById('fxSpeed'); r.value = 0; r.dispatchEvent(new Event('input')); });
await D(A, 'v[0] !== v[59] && !v.some((x) => /^fx/.test(x))'); await D(B, 'v[0] !== v[29]');
await page.waitForFunction(() => document.getElementById('fxGrad').classList.contains('cur'));
await page.evaluate(() => { const r = document.getElementById('fxSpeed'); r.value = 60; r.dispatchEvent(new Event('input')); });
await D(A, 'd.state.seg[0].fx === 46 && d.state.seg[0].sx === 60 && !d.state.seg[0].frz');
await page.screenshot({ path: '/tmp/light-ui.png', fullPage: true });
// после перезагрузки: оба устройства и имя
await page.reload(); await page.waitForSelector('.dev[data-ip="' + B + '"] .dot.ok');
if (await page.locator('.dev').count() !== 2) fail('список устройств не сохранился');
if ((await page.textContent('.dev[data-ip="' + B + '"] b')) !== 'Сцена') fail('имя не сохранилось');
await page.click('.dev[data-ip="' + B + '"] .del');
if (await page.locator('.dev').count() !== 1) fail('устройство не убрано');
if (errs.length) fail(errs.join('\n'));
if (!process.exitCode) console.log('ui: OK');
await browser.close();
