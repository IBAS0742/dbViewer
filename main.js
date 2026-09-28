const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');
const { createEngine, qAll, qOne, quoteIdent, inferSchema, buildWhere, sampleQuery, csvCell } = require('./lib/sqlite-core');
const QueryView = require('./lib/query-view');

const engine = createEngine();
const getDb = (p) => engine.getDb(p);

/* ------------------------------------------------------------------ */
/* IPC                                                                 */
/* ------------------------------------------------------------------ */
let win = null;

function registerIpc() {
  ipcMain.handle('dialog:pick-db', async () => {
    const res = await dialog.showOpenDialog(win, {
      title: '选择 SQLite 数据库文件',
      defaultPath: app.getAppPath(),
      properties: ['openFile'],
      filters: [
        { name: 'SQLite 数据库', extensions: ['db', 'sqlite', 'sqlite3', 'db3'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    });
    if (res.canceled || !res.filePaths.length) return { canceled: true };
    return { canceled: false, path: res.filePaths[0] };
  });

  ipcMain.handle('db:list-tables', async (e, filePath) => {
    const db = await getDb(filePath);
    const tables = qAll(db, `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`);
    const out = tables.map(t => ({
      name: t.name,
      rows: qOne(db, `SELECT COUNT(*) AS c FROM ${quoteIdent(t.name)}`).c
    }));
    return { tables: out };
  });

  ipcMain.handle('db:get-schema', async (e, { path: p, table }) => {
    const db = await getDb(p);
    return inferSchema(db, table);
  });

  ipcMain.handle('db:query', async (e, args) => {
    const db = await getDb(args.path);
    return sampleQuery(db, args.table, args.filters, args.limit);
  });

  /* ---------------- 查询视图（导入式过滤 SQL） ---------------- */

  // 只允许单条只读查询；sql.js 在内存中操作数据副本，且文件永不回写，双保险
  function checkViewSql(sql) {
    if (!QueryView.isReadOnlySelect(sql)) throw new Error('查询视图只允许 SELECT（或 WITH...SELECT）查询语句');
    if (QueryView.hasMultipleStatements(sql)) throw new Error('查询视图只允许单条查询语句');
  }

  ipcMain.handle('view:pick-file', async () => {
    const res = await dialog.showOpenDialog(win, {
      title: '导入查询视图（.view.json）',
      defaultPath: app.getAppPath(),
      properties: ['openFile'],
      filters: [
        { name: '查询视图 (JSON)', extensions: ['json'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    });
    if (res.canceled || !res.filePaths.length) return { canceled: true };
    const p = res.filePaths[0];
    try {
      return { canceled: false, path: p, content: fs.readFileSync(p, 'utf8') };
    } catch (err) {
      return { canceled: false, path: p, error: '读取文件失败: ' + err.message };
    }
  });

  // 运行视图：命名参数 -> ? 位置绑定；行数上限与常规查询一致
  ipcMain.handle('db:run-view', async (e, args) => {
    const db = await getDb(args.path);
    try {
      checkViewSql(args.sql);
      const built = QueryView.buildViewSql(args.sql, args.params || {});
      const cap = Math.min(Math.max(Number(args.limit) || 20000, 1), 100000);
      const lsql = QueryView.appendLimit(built.sql, cap);
      const total = qOne(db, QueryView.countWrap(built.sql), built.params).c;
      const rows = qAll(db, lsql, built.params);
      let columns = rows[0] ? Object.keys(rows[0]) : [];
      const stmt = db.prepare(lsql);
      try {
        if (stmt.getColumnNames) columns = stmt.getColumnNames();
      } catch (_) { /* 用首行 key 兜底 */ } finally {
        stmt.free();
      }
      return { total, rows, columns, limited: total > rows.length };
    } catch (err) {
      return { error: err.message };
    }
  });

  // 完整数据导出（在主进程查询全部符合条件的行，不受绘图采样上限影响）
  ipcMain.handle('db:export', async (e, args) => {
    const db = await getDb(args.path);
    const t = quoteIdent(args.table);
    const { where, params } = buildWhere(args.filters);
    const cols = qAll(db, `PRAGMA table_info(${t})`).map(c => c.name).filter(Boolean);
    const format = args.format === 'csv' ? 'csv' : 'xlsx';
    const stmt = db.prepare(`SELECT * FROM ${t} ${where}`);
    return writeStmtToFile({
      stmt, bindParams: params, cols,
      headers: args.headers || {},
      format,
      defaultName: args.defaultName || `${args.table}_导出.${format}`,
      sheetName: String(args.table || '数据')
    });
  });

  // 导出视图查询结果（重跑完整 SQL，不受绘图上限影响；列默认取视图展示列）
  ipcMain.handle('db:export-view', async (e, args) => {
    const db = await getDb(args.path);
    try {
      checkViewSql(args.sql);
      const built = QueryView.buildViewSql(args.sql, args.params || {});
      const format = args.format === 'csv' ? 'csv' : 'xlsx';
      const stmt = db.prepare(built.sql);
      let cols = Array.isArray(args.columns) && args.columns.length ? args.columns : null;
      if (!cols) {
        try { cols = stmt.getColumnNames(); } catch (_) { cols = []; }
      }
      return await writeStmtToFile({
        stmt, bindParams: built.params, cols,
        headers: args.headers || {},
        format,
        defaultName: args.defaultName || `视图结果.${format}`,
        sheetName: '视图结果'
      });
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // 把一条已 prepare 的查询结果写出为 Excel/CSV（完整导出，不受绘图上限影响）
  async function writeStmtToFile({ stmt, bindParams, cols, headers, format, defaultName, sheetName }) {
    const headRow = cols.map(c => headers[c] || c);
    const res = await dialog.showSaveDialog(win, {
      title: '导出数据',
      defaultPath: defaultName,
      filters: [{ name: format.toUpperCase(), extensions: [format] }]
    });
    if (res.canceled || !res.filePath) { stmt.free(); return { ok: false, canceled: true }; }
    try {
      stmt.bind(bindParams || []);
      let count = 0;
      if (format === 'csv') {
        const stream = fs.createWriteStream(res.filePath, { encoding: 'utf8' });
        stream.write('\ufeff' + headRow.map(csvCell).join(',') + '\r\n');
        let batch = [];
        while (stmt.step()) {
          const row = stmt.getAsObject();
          batch.push(cols.map(c => csvCell(row[c])).join(','));
          count++;
          if (batch.length >= 5000) { stream.write(batch.join('\r\n') + '\r\n'); batch = []; }
        }
        if (batch.length) stream.write(batch.join('\r\n') + '\r\n');
        await new Promise((resolve, reject) => {
          stream.end(err => (err ? reject(err) : resolve()));
        });
      } else {
        const aoa = [headRow];
        while (stmt.step()) {
          const row = stmt.getAsObject();
          aoa.push(cols.map(c => (row[c] === undefined ? null : row[c])));
          count++;
        }
        const ws = XLSX.utils.aoa_to_sheet(aoa, { dense: true });
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, String(sheetName || '数据').slice(0, 31));
        XLSX.writeFile(wb, res.filePath, { dense: true });
      }
      return { ok: true, filePath: res.filePath, count };
    } finally {
      stmt.free();
    }
  }

  // 把图表配置（查询视图 JSON）另存为文件，便于分享/备份
  ipcMain.handle('view:save-file', async (e, args) => {
    try {
      const res = await dialog.showSaveDialog(win, {
        title: '导出图表配置',
        defaultPath: args.defaultName || '图表配置.view.json',
        filters: [{ name: '查询视图 (JSON)', extensions: ['json'] }]
      });
      if (res.canceled || !res.filePath) return { ok: false, canceled: true };
      fs.writeFileSync(res.filePath, String(args.content || ''), 'utf8');
      return { ok: true, filePath: res.filePath };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // 渲染进程已算好的数据（如图表聚合结果）写成 Excel
  ipcMain.handle('export:sheets', async (e, args) => {
    const wb = XLSX.utils.book_new();
    for (const sh of args.sheets || []) {
      const head = sh.columns.map(c => c.label || c.key);
      const aoa = [head];
      for (const r of sh.rows) aoa.push(sh.columns.map(c => (r[c.key] === undefined ? null : r[c.key])));
      const ws = XLSX.utils.aoa_to_sheet(aoa, { dense: true });
      ws['!cols'] = sh.columns.map(c => ({
        wch: Math.max(10, Math.min(28, String(c.label || c.key).length * 2 + 2))
      }));
      XLSX.utils.book_append_sheet(wb, ws, String(sh.name || 'Sheet').slice(0, 31));
    }
    const res = await dialog.showSaveDialog(win, {
      title: '导出图表数据',
      defaultPath: args.defaultName || '图表数据.xlsx',
      filters: [{ name: 'Excel', extensions: ['xlsx'] }]
    });
    if (res.canceled || !res.filePath) return { ok: false, canceled: true };
    XLSX.writeFile(wb, res.filePath, { dense: true });
    const total = (args.sheets || []).reduce((s, x) => s + (x.rows ? x.rows.length : 0), 0);
    return { ok: true, filePath: res.filePath, count: total };
  });

  ipcMain.handle('app:load-config', () => loadConfig());

  // 导出图表截图（渲染进程 ECharts getDataURL 的结果写为 PNG 文件）
  ipcMain.handle('export:image', async (e, args) => {
    try {
      const m = /^data:image\/(\w+);base64,(.+)$/.exec(String(args.dataUrl || ''));
      if (!m) return { ok: false, error: '图片数据无效' };
      const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
      const res = await dialog.showSaveDialog(win, {
        title: '导出图表图片',
        defaultPath: args.defaultName || `图表.${ext}`,
        filters: [{ name: ext.toUpperCase(), extensions: [ext] }]
      });
      if (res.canceled || !res.filePath) return { ok: false, canceled: true };
      fs.writeFileSync(res.filePath, Buffer.from(m[2], 'base64'));
      return { ok: true, filePath: res.filePath, width: args.width, height: args.height };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
}

let configCache = null;
function loadConfig() {
  if (configCache) return configCache;
  // 依次查找：exe 同级目录（便携版可放一份覆盖）→ 安装目录 resources（打包内置，
  // extraResources 复制）→ 应用资源目录（asar 内，开发模式）
  const candidates = [];
  try { candidates.push(path.join(path.dirname(app.getPath('exe')), 'config.json')); } catch (_) { /* ignore */ }
  try { if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, 'config.json')); } catch (_) { /* ignore */ }
  candidates.push(path.join(app.getAppPath(), 'config.json'));

  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        configCache = JSON.parse(fs.readFileSync(p, 'utf8'));
        return configCache;
      }
    } catch (err) {
      console.error('读取配置失败:', p, err.message);
    }
  }
  configCache = { fieldLabels: {}, chartPresets: [] };
  return configCache;
}

/* ------------------------------------------------------------------ */
/* 窗口                                                                */
/* ------------------------------------------------------------------ */
function createWindow() {
  win = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    backgroundColor: '#f1f5f9',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  const dbArg = process.argv.find(a => a.startsWith('--db='));
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'),
    dbArg ? { query: { db: dbArg.slice('--db='.length) } } : undefined);

  win.once('ready-to-show', () => win.show());
  win.webContents.on('before-input-event', (e, input) => {
    if (input.key === 'F12' && input.type === 'keyDown') {
      win.webContents.toggleDevTools();
      e.preventDefault();
    }
  });
  win.on('closed', () => { win = null; });
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  registerIpc();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  app.quit();
});
