const express = require('express');
const { randomUUID } = require('crypto');
const config = require('./project.config');
const sqlite = require('./src/db/sqlite');
const recordStore = require('./src/db/recordStore');
const { buildLossReplacementRouter } = require('./src/routes/lossReplacementRoutes');

const app = express();
const PORT = process.env.PORT || config.port;

app.use(express.json({ limit: '2mb' }));

function now() {
  return new Date().toISOString();
}

function validate(collectionConfig, data) {
  const missing = (collectionConfig.required || []).filter((field) => data[field] === undefined || data[field] === '');
  if (missing.length) {
    const error = new Error('missing required fields: ' + missing.join(', '));
    error.status = 400;
    throw error;
  }
}

function applyQuery(records, query) {
  return records.filter((record) => {
    if (query.status && record.status !== query.status) return false;
    if (query.search) {
      const haystack = JSON.stringify(record).toLowerCase();
      if (!haystack.includes(String(query.search).toLowerCase())) return false;
    }
    for (const [key, value] of Object.entries(query)) {
      if (['status', 'search', 'limit'].includes(key)) continue;
      if (record[key] === undefined) return false;
      if (!String(record[key]).toLowerCase().includes(String(value).toLowerCase())) return false;
    }
    return true;
  });
}

// 返场缺损替补放行专用路由（须注册在通用 /api/:collection 路由之前）
app.use('/api', buildLossReplacementRouter());

// 初始化数据库（建表 + 首次播种在单事务内完成）
async function start() {
  await sqlite.init();
  recordStore.initialize();

app.get('/health', (req, res) => {
  res.json({ ok: true, service: config.title, port: PORT });
});

app.get('/api/meta', (req, res) => {
  res.json({
    title: config.title,
    description: config.description,
    collections: config.collections,
    examples: config.examples || []
  });
});

app.get('/api/:collection', (req, res, next) => {
  try {
    recordStore.findCollection(req.params.collection);
    const filtered = applyQuery(recordStore.list(req.params.collection), req.query);
    const limit = Number(req.query.limit || 0);
    res.json(limit > 0 ? filtered.slice(0, limit) : filtered);
  } catch (error) {
    next(error);
  }
});

app.post('/api/:collection', (req, res, next) => {
  try {
    const collectionConfig = recordStore.findCollection(req.params.collection);
    const data = { ...collectionConfig.defaults, ...req.body };
    const status = data.status || collectionConfig.defaultStatus || '';
    data.status = status;
    validate(collectionConfig, data);
    const id = randomUUID();
    recordStore.applyEffects({
      changes: [
        { op: 'insert', id, collection: req.params.collection, status, data }
      ],
      events: [
        {
          recordId: id,
          collection: req.params.collection,
          action: req.body.action || '创建',
          status,
          actor: req.body.actor || '',
          note: req.body.note || '',
          data
        }
      ]
    });
    res.status(201).json(recordStore.load(req.params.collection, id));
  } catch (error) {
    next(error);
  }
});

app.get('/api/:collection/:id', (req, res, next) => {
  try {
    recordStore.findCollection(req.params.collection);
    const record = recordStore.load(req.params.collection, req.params.id);
    if (!record) return res.status(404).json({ error: 'not found' });
    res.json(record);
  } catch (error) {
    next(error);
  }
});

app.patch('/api/:collection/:id', (req, res, next) => {
  try {
    recordStore.findCollection(req.params.collection);
    const record = recordStore.load(req.params.collection, req.params.id);
    if (!record) return res.status(404).json({ error: 'not found' });
    const nextData = { ...record, ...req.body };
    delete nextData.id;
    delete nextData.collection;
    delete nextData.createdAt;
    delete nextData.updatedAt;
    const status = nextData.status || record.status;
    nextData.status = status;
    recordStore.applyEffects({
      changes: [
        { op: 'update', collection: req.params.collection, id: req.params.id, status, data: nextData }
      ],
      events: [
        {
          recordId: req.params.id,
          collection: req.params.collection,
          action: req.body.action || '更新',
          status,
          actor: req.body.actor || '',
          note: req.body.note || '',
          data: req.body
        }
      ]
    });
    res.json(recordStore.load(req.params.collection, req.params.id));
  } catch (error) {
    next(error);
  }
});

app.post('/api/:collection/:id/events', (req, res, next) => {
  try {
    const collectionConfig = recordStore.findCollection(req.params.collection);
    const record = recordStore.load(req.params.collection, req.params.id);
    if (!record) return res.status(404).json({ error: 'not found' });
    const status = req.body.status || record.status;
    if (collectionConfig.statuses && !collectionConfig.statuses.includes(status)) {
      return res.status(400).json({ error: 'invalid status: ' + status });
    }
    const nextData = { ...record, ...(req.body.fields || {}), status };
    delete nextData.id;
    delete nextData.collection;
    delete nextData.createdAt;
    delete nextData.updatedAt;
    recordStore.applyEffects({
      changes: [
        { op: 'update', collection: req.params.collection, id: req.params.id, status, data: nextData }
      ],
      events: [
        {
          recordId: req.params.id,
          collection: req.params.collection,
          action: req.body.action || status || '记录',
          status,
          actor: req.body.actor || '',
          note: req.body.note || '',
          data: req.body
        }
      ]
    });
    res.json(recordStore.load(req.params.collection, req.params.id));
  } catch (error) {
    next(error);
  }
});

app.get('/api/:collection/:id/timeline', (req, res, next) => {
  try {
    recordStore.findCollection(req.params.collection);
    const record = recordStore.load(req.params.collection, req.params.id);
    if (!record) return res.status(404).json({ error: 'not found' });
    res.json({ record, events: recordStore.events(req.params.id) });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/:collection/:id', (req, res, next) => {
  try {
    recordStore.findCollection(req.params.collection);
    sqlite.transaction(() => recordStore.remove(req.params.collection, req.params.id));
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.use((error, req, res, next) => {
  res.status(error.status || 500).json({ error: error.message || 'server error' });
});

app.listen(PORT, () => {
  console.log(config.title + ' API running at http://localhost:' + PORT);
});
}

start().catch((error) => {
  console.error('failed to start service:', error);
  process.exit(1);
});
