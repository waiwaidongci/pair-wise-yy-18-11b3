'use strict';

// 持久化事务模块：零依赖 JSON 文档存储。
// - 集合模型与原 records/events 两表保持一致；
// - transaction(mutator) 同步执行，mutator 内只改内存草稿，
//   正常返回后才原子落盘（临时文件 + rename）；
//   mutator 抛错则草稿整体丢弃，任何片段都不会保存。

const fs = require('fs');
const path = require('path');

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

class JsonStore {
  constructor(file) {
    this.file = file;
    this.state = { records: [], events: [] };
    this._load();
  }

  _load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      this.state = {
        records: Array.isArray(parsed.records) ? parsed.records : [],
        events: Array.isArray(parsed.events) ? parsed.events : []
      };
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
  }

  _persist() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp.' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(this.state), 'utf8');
    fs.renameSync(tmp, this.file);
  }

  readRecords(collection) {
    const rows = collection
      ? this.state.records.filter((row) => row.collection === collection)
      : this.state.records;
    return clone(rows);
  }

  readRecord(collection, id) {
    const row = this.state.records.find(
      (item) => item.collection === collection && item.id === id
    );
    return clone(row);
  }

  readEvents(recordId) {
    const rows = recordId
      ? this.state.events.filter((event) => event.record_id === recordId)
      : this.state.events;
    return clone(rows);
  }

  // mutator(tx) 必须同步；返回值会在提交后回传给调用方。
  transaction(mutator) {
    const draft = clone(this.state);

    const tx = {
      insertRecord(row) {
        draft.records.push(clone(row));
      },
      updateRecord(collection, id, patch) {
        const row = draft.records.find(
          (item) => item.collection === collection && item.id === id
        );
        if (!row) return false;
        Object.assign(row, clone(patch));
        return true;
      },
      deleteRecord(collection, id) {
        const index = draft.records.findIndex(
          (item) => item.collection === collection && item.id === id
        );
        if (index === -1) return false;
        draft.records.splice(index, 1);
        return true;
      },
      insertEvent(event) {
        draft.events.push(clone(event));
      },
      deleteEvents(recordId) {
        draft.events = draft.events.filter((event) => event.record_id !== recordId);
      },
      getRecord(collectionName, recordId) {
        const row = draft.records.find(
          (item) => item.collection === collectionName && item.id === recordId
        );
        return clone(row);
      },
      listRecords(collectionName) {
        return clone(
          draft.records.filter((item) => item.collection === collectionName)
        );
      },
      listAllRecords() {
        return clone(draft.records);
      }
    };

    const result = mutator(tx);
    this.state = draft;
    this._persist();
    return clone(result);
  }
}

module.exports = { JsonStore };
