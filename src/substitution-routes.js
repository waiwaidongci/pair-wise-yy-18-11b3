'use strict';

// 请求路由模块：返场缺损替补放行与保管员复核。
// 仅负责 HTTP 入参/响应，条件判定全部交给 SubstitutionService。

const express = require('express');

function buildSubstitutionRouter(service) {
  const router = express.Router();

  // 返场清点装箱单上投递缺损替补申请（幂等：同箱同件同替补再次投递读回原单）
  router.post('/tourBoxes/:boxId/loss-reports/substitution', (req, res, next) => {
    try {
      const result = service.submitSubstitution(req.params.boxId, req.body || {});
      res.status(result.created ? 201 : 200).json(result.report);
    } catch (error) {
      next(error);
    }
  });

  // 报损人之外的保管员复核：通过后原损件转待修补并锁定替补件
  router.post('/lossReports/:id/review', (req, res, next) => {
    try {
      const result = service.reviewLossReport(req.params.id, req.body || {});
      res.json(result.report);
    } catch (error) {
      next(error);
    }
  });

  return router;
}

module.exports = { buildSubstitutionRouter };
