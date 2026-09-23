'use strict';

// 请求路由模块（通用集合 CRUD / 事件 / 时间线），不含业务判定。

const express = require('express');
const { badRequest, notFound } = require('./errors');

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

function stripMeta(data) {
  const next = { ...data };
  delete next.id;
  delete next.collection;
  delete next.createdAt;
  delete next.updatedAt;
  return next;
}

function buildGenericRouter(repo, config) {
  const router = express.Router();

  router.get('/:collection', (req, res, next) => {
    try {
      repo.requireCollection(req.params.collection);
      const filtered = applyQuery(repo.list(req.params.collection), req.query);
      const limit = Number(req.query.limit || 0);
      res.json(limit > 0 ? filtered.slice(0, limit) : filtered);
    } catch (error) {
      next(error);
    }
  });

  router.post('/:collection', (req, res, next) => {
    try {
      const collectionConfig = repo.requireCollection(req.params.collection);
      const data = { ...collectionConfig.defaults, ...req.body };
      const status = data.status || collectionConfig.defaultStatus || '';
      if (collectionConfig.statuses && !collectionConfig.statuses.includes(status)) {
        throw badRequest('invalid status: ' + status, 'INVALID_STATUS');
      }
      data.status = status;
      const missing = (collectionConfig.required || []).filter(
        (field) => data[field] === undefined || data[field] === ''
      );
      if (missing.length) {
        throw badRequest('missing required fields: ' + missing.join(', '), 'MISSING_FIELDS');
      }
      const record = repo.create(req.params.collection, data, status, {
        action: req.body.action || '创建',
        actor: req.body.actor || '',
        note: req.body.note || ''
      });
      res.status(201).json(record);
    } catch (error) {
      next(error);
    }
  });

  router.get('/:collection/:id', (req, res, next) => {
    try {
      repo.requireCollection(req.params.collection);
      const record = repo.get(req.params.collection, req.params.id);
      if (!record) throw notFound();
      res.json(record);
    } catch (error) {
      next(error);
    }
  });

  router.patch('/:collection/:id', (req, res, next) => {
    try {
      const collectionConfig = repo.requireCollection(req.params.collection);
      const record = repo.getOrThrow(req.params.collection, req.params.id);
      const nextData = stripMeta({ ...record, ...req.body });
      const status = nextData.status || record.status;
      if (collectionConfig.statuses && !collectionConfig.statuses.includes(status)) {
        throw badRequest('invalid status: ' + status, 'INVALID_STATUS');
      }
      nextData.status = status;
      repo.mutate([
        {
          collection: req.params.collection,
          id: req.params.id,
          data: nextData,
          status,
          action: req.body.action || '更新',
          actor: req.body.actor || '',
          note: req.body.note || '',
          eventData: req.body
        }
      ]);
      res.json(repo.get(req.params.collection, req.params.id));
    } catch (error) {
      next(error);
    }
  });

  router.post('/:collection/:id/events', (req, res, next) => {
    try {
      const collectionConfig = repo.requireCollection(req.params.collection);
      const record = repo.getOrThrow(req.params.collection, req.params.id);
      const status = req.body.status || record.status;
      if (collectionConfig.statuses && !collectionConfig.statuses.includes(status)) {
        throw badRequest('invalid status: ' + status, 'INVALID_STATUS');
      }
      const nextData = stripMeta({ ...record, ...(req.body.fields || {}), status });
      repo.mutate([
        {
          collection: req.params.collection,
          id: req.params.id,
          data: nextData,
          status,
          action: req.body.action || status || '记录',
          actor: req.body.actor || '',
          note: req.body.note || '',
          eventData: req.body
        }
      ]);
      res.json(repo.get(req.params.collection, req.params.id));
    } catch (error) {
      next(error);
    }
  });

  router.get('/:collection/:id/timeline', (req, res, next) => {
    try {
      repo.requireCollection(req.params.collection);
      const record = repo.getOrThrow(req.params.collection, req.params.id);
      res.json({ record, events: repo.events(req.params.id) });
    } catch (error) {
      next(error);
    }
  });

  router.delete('/:collection/:id', (req, res, next) => {
    try {
      repo.requireCollection(req.params.collection);
      repo.delete(req.params.collection, req.params.id);
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  return router;
}

module.exports = { buildGenericRouter };
