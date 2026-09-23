'use strict';

// 返场缺损替补放行 · 请求路由模块。
// 只编排 HTTP 入参、仓储取数、领域判定、事务落库；业务条件全部在 domain 内判定。
const express = require('express');
const domain = require('../domain/lossReplacement');
const recordStore = require('../db/recordStore');

function loadState() {
  return {
    tourBoxes: recordStore.list('tourBoxes'),
    lossReports: recordStore.list('lossReports'),
    puppetHeads: recordStore.list('puppetHeads'),
    accessories: recordStore.list('accessories')
  };
}

function send(result, res) {
  if (!result.effects || (!result.effects.changes.length && !result.effects.events.length)) {
    return res.status(result.status).json(result.body);
  }
  recordStore.applyEffects(result.effects);
  const persisted = result.body && result.body.id
    ? recordStore.load(result.body.collection || guessCollection(result), result.body.id)
    : null;
  res.status(result.status).json(persisted || result.body);
}

function guessCollection(result) {
  const firstChange = (result.effects.changes || [])[0];
  return firstChange ? firstChange.collection : 'lossReports';
}

function buildLossReplacementRouter() {
  const router = express.Router();

  // 登记返场缺损 + 替补；同一 requestId 再次投递直接读回原单
  router.post('/tourBoxes/:boxId/lossReports', (req, res, next) => {
    try {
      const body = req.body || {};
      const result = domain.submitLossReport(loadState(), {
        requestId: body.requestId || req.header('X-Idempotency-Key'),
        tourBoxId: req.params.boxId,
        itemType: body.itemType,
        itemId: body.itemId,
        replacementItemId: body.replacementItemId,
        problem: body.problem,
        reporter: body.reporter
      });
      if (result.status >= 400) return res.status(result.status).json(result.body);
      send(result, res);
    } catch (error) {
      next(error);
    }
  });

  // 保管员复核（approve/reject）
  router.post('/lossReports/:id/review', (req, res, next) => {
    try {
      const body = req.body || {};
      const result = domain.reviewLossReport(loadState(), req.params.id, {
        decision: body.decision,
        reviewer: body.reviewer,
        note: body.note
      });
      if (result.status >= 400) return res.status(result.status).json(result.body);
      send(result, res);
    } catch (error) {
      next(error);
    }
  });

  // 更正缺损单；关键资料更正自动失效待复核/放行结论并释放误占
  router.patch('/lossReports/:id', (req, res, next) => {
    try {
      const body = req.body || {};
      const result = domain.amendLossReport(loadState(), req.params.id, body);
      if (result.status >= 400) return res.status(result.status).json(result.body);
      send(result, res);
    } catch (error) {
      next(error);
    }
  });

  // 装箱单视角的缺损单清单（与缺损单集合读取一致）
  router.get('/tourBoxes/:boxId/lossReports', (req, res, next) => {
    try {
      const box = recordStore.load('tourBoxes', req.params.boxId);
      if (!box) return res.status(404).json({ error: 'not_found', message: '装箱单不存在' });
      const reports = recordStore
        .list('lossReports')
        .filter((report) => report.tourBoxId === req.params.boxId);
      res.json(reports);
    } catch (error) {
      next(error);
    }
  });

  return router;
}

module.exports = { buildLossReplacementRouter };
