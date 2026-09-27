/* Electron 实机冒烟测试：
 * 启动 electron（--db 自动打开真实库）→ 通过 CDP 连接 → 验证真实数据渲染 → 截图
 * 运行：node scripts/electron-smoke.js */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const ROOT = path.resolve(__dirname, '..');
const DB = path.join(ROOT, 'small_range.db');
// 可选参数 1：被测 exe（默认源码模式的 electron；CI/打包验证时传打包产物路径）
const EXE = process.argv[2] || path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const APP_ARG = process.argv[2] ? '.' : '.'; // 打包 exe 自带应用，无需传 "."
const OUT = path.join(ROOT, 'shots');
const PORT = 9223;

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  if (!fs.existsSync(EXE)) { console.error('未找到被测 exe: ' + EXE); process.exit(1); }
  fs.mkdirSync(OUT, { recursive: true });

  const spawnArgs = process.argv[2]
    ? [`--db=${DB}`, `--remote-debugging-port=${PORT}`]
    : ['.', `--db=${DB}`, `--remote-debugging-port=${PORT}`];
  const proc = spawn(EXE, spawnArgs, {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  proc.stderr.on('data', d => { stderr += d; });
  proc.on('exit', (c) => { if (c) console.error('electron 提前退出, code=', c, stderr.slice(0, 2000)); });

  try {
    // 等待 CDP 端口就绪
    let ok = false;
    for (let i = 0; i < 60 && !ok; i++) {
      await sleep(500);
      try {
        const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
        ok = res.ok;
      } catch (_) { /* not ready */ }
    }
    if (!ok) throw new Error('CDP 端口未就绪');
    console.log('✓ Electron 已启动，CDP 就绪');

    const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${PORT}`, defaultViewport: null });
    const pages = await browser.pages();
    const page = pages[0];
    await page.waitForSelector('#chart canvas', { timeout: 60000 });
    await sleep(1500);

    const state1 = await page.evaluate(() => ({
      file: document.querySelector('#file-name') ? document.querySelector('#file-name').textContent : '',
      rowInfo: document.querySelector('#row-info').textContent,
      chartMsg: document.querySelector('#chart-msg').textContent,
      confChips: document.querySelectorAll('.fgroup[data-col="conf"] .chip').length,
      monthChips: document.querySelectorAll('.fgroup[data-col="month"] .chip').length,
      yearKind: document.querySelector('.fgroup[data-col="year"] .hint').textContent,
      labelsLoaded: document.querySelector('#filter-form summary').textContent.includes('火点置信等级')
    }));
    console.log('真实应用状态:', JSON.stringify(state1, null, 1));
    await page.screenshot({ path: path.join(OUT, 'e1-real-line.png') });
    console.log('✓ e1-real-line.png（真实 db：逐年火点数量 折线图）');

    // 切到年份×海拔热力图
    await page.evaluate(() => {
      const sel = document.querySelector('#preset-select');
      const opt = [...sel.options].find(o => o.textContent.includes('年份×海拔 火点密度'));
      sel.value = opt.value;
      sel.dispatchEvent(new Event('change'));
    });
    await sleep(2500);
    const state2 = await page.evaluate(() => ({
      chartMsg: document.querySelector('#chart-msg').textContent,
      rowInfo: document.querySelector('#row-info').textContent
    }));
    console.log('热力图状态:', JSON.stringify(state2));
    await page.screenshot({ path: path.join(OUT, 'e2-real-heatmap.png') });
    console.log('✓ e2-real-heatmap.png（真实 db：年份×海拔 热力图）');

    const pass = state1.confChips === 5 && state1.monthChips === 12 &&
      state1.yearKind.includes('数值') && state1.rowInfo.includes('290,471') &&
      state1.labelsLoaded && state2.chartMsg.includes('热力图');
    console.log(pass ? '\nElectron 实机测试通过 ✅' : '\nElectron 实机测试未达标 ❌');
    await browser.disconnect();
    proc.kill();
    process.exit(pass ? 0 : 1);
  } catch (err) {
    console.error('测试异常:', err.message);
    console.error('stderr:', stderr.slice(0, 2000));
    proc.kill();
    process.exit(1);
  }
})();
