'use strict';

// 持久化仓库：面向集合（collection）的记录读写与事件流水。
// 所有写操作都包在 store.transaction 中，业务校验与多记录联动在同一事务内完成。

const { randomUUID } = require('crypto');
const { JsonStore } = require('./store');
const { notFound } = require('./errors');

function now() {
  return new Date().toISOString();
}

function toRecord(row) {
  const data = JSON.parse(row.data || '{}');
  return {
    id: row.id,
    collection: row.collection,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...data
  };
}

function titleFor(collectionConfig, data) {
  return (
    (collectionConfig.titleFields || [])
      .map((field) => data[field])
      .filter(Boolean)
      .join(' / ') ||
    data.name ||
    data.title ||
    data.code ||
    ''
  );
}

class Repository {
  constructor(config, dbFile) {
    this.config = config;
    this.store = new JsonStore(dbFile);
  }

  requireCollection(name) {
    const collection = this.config.collections[name];
    if (!collection) throw notFound('unknown collection: ' + name, 'UNKNOWN_COLLECTION');
    return collection;
  }

  getCollection(name) {
    return this.config.collections[name] || null;
  }

  list(collection) {
    return this.store
      .readRecords(collection)
      .map(toRecord)
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  }

  findRaw(collection, id) {
    return this.store.readRecord(collection, id) || null;
  }

  get(collection, id) {
    const row = this.findRaw(collection, id);
    return row ? toRecord(row) : null;
  }

  getOrThrow(collection, id) {
    this.requireCollection(collection);
    const record = this.get(collection, id);
    if (!record) throw notFound(collection + '/' + id + ' 不存在', 'RECORD_NOT_FOUND');
    return record;
  }

  events(recordId) {
    return this.store
      .readEvents(recordId)
      .map((event) => ({
        id: event.id,
        action: event.action,
        status: event.status,
        actor: event.actor,
        note: event.note,
        data: JSON.parse(event.data || '{}'),
        createdAt: event.created_at
      }))
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  }

  create(collection, data, status, { action, actor, note, eventData } = {}) {
    const collectionConfig = this.requireCollection(collection);
    const id = data.id || randomUUID();
    const createdAt = now();
    const row = {
      id,
      collection,
      status,
      title: titleFor(collectionConfig, data),
      data: JSON.stringify({ ...data, id: undefined, status }),
      created_at: createdAt,
      updated_at: createdAt
    };
    const event = {
      id: randomUUID(),
      record_id: id,
      collection,
      action: action || '创建',
      status,
      actor: actor || '',
      note: note || '',
      data: JSON.stringify(eventData || data),
      created_at: createdAt
    };
    this.store.transaction((tx) => {
      tx.insertRecord(row);
      tx.insertEvent(event);
    });
    return this.get(collection, id);
  }

  // plan:
  //   { mode: 'create', collection, data, status, action, actor, note, eventData }
  //   { collection, id, data, status, action, actor, note, eventData }  // 更新
  //   { mode: 'delete', collection, id }
  // 多个 plan 在同一事务内提交，任一抛出则整体回滚。
  mutate(plans) {
    const timestamp = now();
    const created = [];
    const normalized = plans.map((plan) => {
      const collectionConfig = this.requireCollection(plan.collection);
      return { ...plan, collectionConfig };
    });
    this.store.transaction((tx) => {
      for (const plan of normalized) {
        if (plan.mode === 'delete') {
          tx.deleteRecord(plan.collection, plan.id);
          tx.deleteEvents(plan.id);
          continue;
        }
        if (plan.mode === 'create') {
          const id = plan.data.id || randomUUID();
          const data = { ...plan.data };
          delete data.id;
          data.status = plan.status;
          tx.insertRecord({
            id,
            collection: plan.collection,
            status: plan.status,
            title: titleFor(plan.collectionConfig, data),
            data: JSON.stringify(data),
            created_at: timestamp,
            updated_at: timestamp
          });
          tx.insertEvent({
            id: randomUUID(),
            record_id: id,
            collection: plan.collection,
            action: plan.action || '创建',
            status: plan.status,
            actor: plan.actor || '',
            note: plan.note || '',
            data: JSON.stringify(plan.eventData || data),
            created_at: timestamp
          });
          created.push({ collection: plan.collection, id });
          continue;
        }
        const exists = tx.getRecord(plan.collection, plan.id);
        if (!exists) {
          throw notFound(plan.collection + '/' + plan.id + ' 不存在', 'RECORD_NOT_FOUND');
        }
        tx.updateRecord(plan.collection, plan.id, {
          status: plan.status,
          title: titleFor(plan.collectionConfig, plan.data),
          data: JSON.stringify(plan.data),
          updated_at: timestamp
        });
        if (plan.action !== false) {
          tx.insertEvent({
            id: randomUUID(),
            record_id: plan.id,
            collection: plan.collection,
            action: plan.action || '更新',
            status: plan.status,
            actor: plan.actor || '',
            note: plan.note || '',
            data: JSON.stringify(plan.eventData || plan.data),
            created_at: timestamp
          });
        }
      }
    });
    let createCursor = 0;
    return normalized.map((plan) => {
      if (plan.mode === 'create') {
        const made = created[createCursor++];
        return this.get(plan.collection, made.id);
      }
      if (plan.mode === 'delete') return null;
      return this.get(plan.collection, plan.id);
    });
  }

  delete(collection, id) {
    this.requireCollection(collection);
    this.store.transaction((tx) => {
      tx.deleteRecord(collection, id);
      tx.deleteEvents(id);
    });
  }

  init() {
    if (this.store.readRecords().length > 0) return;
    for (const seed of this.config.seed || []) {
      const collectionConfig = this.requireCollection(seed.collection);
      const id = seed.id || randomUUID();
      const createdAt = seed.createdAt || now();
      const status = seed.status || collectionConfig.defaultStatus || '';
      const data = { ...seed.data, status };
      this.store.transaction((tx) => {
        tx.insertRecord({
          id,
          collection: seed.collection,
          status,
          title: titleFor(collectionConfig, data),
          data: JSON.stringify(data),
          created_at: createdAt,
          updated_at: seed.updatedAt || createdAt
        });
        tx.insertEvent({
          id: randomUUID(),
          record_id: id,
          collection: seed.collection,
          action: seed.eventAction || '创建',
          status,
          actor: seed.actor || 'system',
          note: seed.note || '',
          data: JSON.stringify(data),
          created_at: createdAt
        });
      });
    }
  }
}

module.exports = { Repository, toRecord, titleFor, now };
