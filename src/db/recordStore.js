'use strict';

// 记录仓储：通用 records/events 表的读写、建表播种，以及缺损替补业务效果的事务化落库。
const { randomUUID } = require('crypto');
const sqlite = require('./sqlite');
const config = require('../../project.config');

function now() {
  return new Date().toISOString();
}

function findCollection(name) {
  const collection = config.collections[name];
  if (!collection) {
    const error = new Error('unknown collection: ' + name);
    error.status = 404;
    throw error;
  }
  return collection;
}

function titleFor(collectionConfig, data) {
  return (collectionConfig.titleFields || [])
    .map((field) => data[field])
    .filter(Boolean)
    .join(' / ') || data.name || data.title || data.code || '';
}

function toRecord(sqlRow) {
  const data = JSON.parse(sqlRow.data || '{}');
  return {
    id: sqlRow.id,
    collection: sqlRow.collection,
    status: sqlRow.status,
    createdAt: sqlRow.created_at,
    updatedAt: sqlRow.updated_at,
    ...data
  };
}

function initSchema() {
  sqlite.exec(`
CREATE TABLE IF NOT EXISTS records (
  id TEXT PRIMARY KEY,
  collection TEXT NOT NULL,
  status TEXT NOT NULL,
  title TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_records_collection ON records(collection);
CREATE INDEX IF NOT EXISTS idx_records_status ON records(status);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  record_id TEXT NOT NULL,
  collection TEXT NOT NULL,
  action TEXT NOT NULL,
  status TEXT,
  actor TEXT,
  note TEXT,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_record ON events(record_id);
  `);
}

function insertRecord({ id, collection, status, data, createdAt }) {
  const collectionConfig = findCollection(collection);
  const payload = { ...data, status };
  sqlite.db().run(
    'INSERT INTO records (id, collection, status, title, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?);',
    [id, collection, status, titleFor(collectionConfig, payload), JSON.stringify(payload), createdAt, createdAt]
  );
}

function insertEvent({ recordId, collection, action, status, actor, note, data, createdAt }) {
  sqlite.db().run(
    'INSERT INTO events (id, record_id, collection, action, status, actor, note, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);',
    [randomUUID(), recordId, collection, action || '记录', status || '', actor || '', note || '', JSON.stringify(data || {}), createdAt]
  );
}

function seedIfEmpty() {
  const countRow = sqlite.row('SELECT COUNT(*) AS count FROM records;');
  if (countRow.count > 0) return;
  for (const seed of config.seed || []) {
    const collectionConfig = findCollection(seed.collection);
    const id = seed.id || randomUUID();
    const createdAt = seed.createdAt || now();
    const status = seed.status || collectionConfig.defaultStatus || '';
    const data = { ...seed.data, status };
    insertRecord({ id, collection: seed.collection, status, data, createdAt });
    insertEvent({
      recordId: id,
      collection: seed.collection,
      action: seed.eventAction || '创建',
      status,
      actor: seed.actor || 'system',
      note: seed.note || '',
      data,
      createdAt
    });
  }
}

function initialize() {
  initSchema();
  sqlite.transaction(() => seedIfEmpty());
}

function load(collection, id) {
  const sqlRow = sqlite.row(
    'SELECT * FROM records WHERE collection = ? AND id = ? LIMIT 1;',
    [collection, id]
  );
  return sqlRow ? toRecord(sqlRow) : null;
}

function list(collection) {
  return sqlite
    .rows('SELECT * FROM records WHERE collection = ? ORDER BY updated_at DESC;', [collection])
    .map(toRecord);
}

function save(collection, id, data, status) {
  const collectionConfig = findCollection(collection);
  const payload = { ...data, status };
  sqlite.db().run(
    'UPDATE records SET status = ?, title = ?, data = ?, updated_at = ? WHERE collection = ? AND id = ?;',
    [status, titleFor(collectionConfig, payload), JSON.stringify(payload), now(), collection, id]
  );
}

function remove(collection, id) {
  sqlite.db().run('DELETE FROM records WHERE collection = ? AND id = ?;', [collection, id]);
  sqlite.db().run('DELETE FROM events WHERE record_id = ?;', [id]);
}

function events(recordId) {
  return sqlite
    .rows('SELECT * FROM events WHERE record_id = ? ORDER BY created_at ASC, rowid ASC;', [recordId])
    .map((event) => ({
      id: event.id,
      action: event.action,
      status: event.status,
      actor: event.actor,
      note: event.note,
      data: JSON.parse(event.data || '{}'),
      createdAt: event.created_at
    }));
}

// 把领域层给出的效果（新建/更新记录 + 履历事件）在一个事务里落库。任何片段失败则整体不保存。
function applyEffects(effects) {
  return sqlite.transaction(() => {
    const stamp = now();
    for (const change of effects.changes || []) {
      if (change.op === 'insert') {
        insertRecord({
          id: change.id,
          collection: change.collection,
          status: change.status,
          data: change.data,
          createdAt: change.createdAt || stamp
        });
      } else if (change.op === 'update') {
        save(change.collection, change.id, change.data, change.status);
      }
    }
    for (const event of effects.events || []) {
      insertEvent({ ...event, createdAt: event.createdAt || stamp });
    }
    return stamp;
  });
}

module.exports = {
  initialize,
  findCollection,
  titleFor,
  toRecord,
  load,
  list,
  save,
  remove,
  events,
  applyEffects,
  insertEvent,
  now
};
