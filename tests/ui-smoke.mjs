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
await page.waitForFunction(() => /Найдено: 1/.test(document.getElementById('scanProg').textContent), null, { timeout: 60000 });
await page.screenshot({ path: '/tmp/light-ui.png', fullPage: true });
if (errs.length) fail(errs.join('\n'));
if (!process.exitCode) console.log('ui: OK');
await browser.close();
