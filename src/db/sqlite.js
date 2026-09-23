'use strict';

// 持久化基座：sql.js（WASM SQLite）。
// 进程启动时把数据文件读入内存，所有写操作在显式事务内完成，提交后原子落盘。
const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'app.db');

let database = null;
let sqlModule = null;

function loadWasmBinary() {
  const wasmPath = path.join(__dirname, '..', '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');
  return fs.readFileSync(wasmPath);
}

function persist() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const bytes = database.export();
  const tmpFile = DB_FILE + '.tmp';
  fs.writeFileSync(tmpFile, Buffer.from(bytes));
  fs.renameSync(tmpFile, DB_FILE);
}

async function init() {
  if (database) return database;
  if (!sqlModule) {
    sqlModule = await initSqlJs({ wasmBinary: loadWasmBinary() });
  }
  if (fs.existsSync(DB_FILE)) {
    database = new sqlModule.Database(fs.readFileSync(DB_FILE));
  } else {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    database = new sqlModule.Database();
  }
  database.run('PRAGMA foreign_keys = ON;');
  return database;
}

function db() {
  if (!database) throw new Error('database not initialized');
  return database;
}

function rows(sql, params = []) {
  const stmt = db().prepare(sql);
  stmt.bind(params);
  const result = [];
  while (stmt.step()) result.push(stmt.getAsObject());
  stmt.free();
  return result;
}

function row(sql, params = []) {
  return rows(sql, params)[0] || null;
}

function exec(sql) {
  db().run(sql);
}

// 在单个数据库事务里执行 worker；worker 抛错则整体回滚，已提交时把内存库落盘。
function transaction(worker) {
  exec('BEGIN IMMEDIATE;');
  try {
    const result = worker();
    exec('COMMIT;');
    persist();
    return result;
  } catch (error) {
    try {
      exec('ROLLBACK;');
    } catch (rollbackError) {
      // 回滚失败时保留原始错误
    }
    throw error;
  }
}

module.exports = { init, db, rows, row, exec, transaction, persist };
