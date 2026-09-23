'use strict';

// 业务判定模块：返场缺损替补放行。
// 只依赖 repository 的只读接口与 mutate 事务入口，不接触 HTTP 与文件。
// 所有判定先在内存中完成；条件不合直接抛 ApiError（409），
// 通过后才把全部变更打包成一个事务计划提交，任何片段都不会落盘。

const { randomUUID } = require('crypto');
const { titleFor } = require('./repository');
const { ApiError, badRequest, notFound, conflict } = require('./errors');

const BOX_RETURN_CHECK = '返场清点中';
const UNFINISHED_BOX_STATUSES = ['草稿', '已装箱', '巡演中', '返场清点中'];
const LOSS_PENDING_REVIEW = '待复核';
const LOSS_APPROVED = '修复中';
const LOSS_REJECTED = '复核驳回';
// 处于这些状态的缺损单仍占用替补件
const OCCUPYING_LOSS_STATUSES = [LOSS_PENDING_REVIEW, LOSS_APPROVED];
// 未办结的缺损单：同箱同件只允许一张
const OPEN_LOSS_STATUSES = ['待处理', LOSS_PENDING_REVIEW, LOSS_APPROVED];

const ITEM_TYPES = {
  puppetHeads: 'puppetHeads',
  puppethead: 'puppetHeads',
  head: 'puppetHeads',
  偶头: 'puppetHeads',
  木偶头: 'puppetHeads',
  偶: 'puppetHeads',
  accessories: 'accessories',
  accessory: 'accessories',
  acc: 'accessories',
  配件: 'accessories',
  服装配件: 'accessories'
};

function normalizeItemType(value) {
  if (!value) return null;
  return ITEM_TYPES[String(value).trim()] || null;
}

function itemNameOf(repo, itemType, record) {
  return titleFor(repo.getCollection(itemType), record);
}

function isUsable(itemType, record) {
  if (itemType === 'puppetHeads') {
    return record.status === '可演出' && record.currentUsable !== false;
  }
  return record.status === '在库';
}

class SubstitutionService {
  constructor(repo) {
    this.repo = repo;
  }

  _boxOrThrow(boxId) {
    const box = this.repo.get('tourBoxes', boxId);
    if (!box) throw notFound('巡演装箱单不存在: ' + boxId, 'BOX_NOT_FOUND');
    return box;
  }

  _normalizeInput(body) {
    const input = body || {};
    const itemType = normalizeItemType(input.itemType);
    if (!itemType) {
      throw badRequest('itemType 必须是 puppetHeads/偶头 或 accessories/配件', 'INVALID_ITEM_TYPE');
    }
    const missing = ['itemId', 'substituteId', 'problem', 'reporter']
      .filter((field) => input[field] === undefined || input[field] === null || input[field] === '');
    if (missing.length) {
      throw badRequest('缺少必填字段: ' + missing.join(', '), 'MISSING_FIELDS');
    }
    return {
      itemType,
      itemId: String(input.itemId),
      substituteId: String(input.substituteId),
      problem: String(input.problem),
      reporter: String(input.reporter),
      note: input.note ? String(input.note) : ''
    };
  }

  // 替补资格判定。virtuals 是内存中的假设态（更正已通过单时先回滚其占用）：
  // { box, item, spare, itemType, excludedReportIds }
  _assertSubstitutionEligible(input, virtuals) {
    const { box, item, spare, itemType } = virtuals;

    // 报损件须确属该箱
    const memberList = itemType === 'puppetHeads' ? box.headIds : box.accessoryIds;
    if (!Array.isArray(memberList) || !memberList.includes(input.itemId)) {
      throw conflict('报损件不属于该装箱单: ' + input.itemId, 'ITEM_NOT_IN_BOX');
    }

    // 替补件不能就是报损件本身，且必须同类
    if (input.substituteId === input.itemId) {
      throw conflict('替补件不能与报损件为同一件', 'SUBSTITUTE_SAME_AS_ITEM');
    }
    if (spare.collection !== itemType) {
      throw conflict('替补件与报损件类型不一致', 'SUBSTITUTE_TYPE_MISMATCH');
    }

    // 同剧目同角色
    if (spare.play !== item.play || spare.role !== item.role) {
      throw conflict(
        `替补件须同剧目同角色（要求 ${item.play}/${item.role}，实际 ${spare.play}/${spare.role}）`,
        'SUBSTITUTE_PLAY_ROLE_MISMATCH'
      );
    }

    // 可演出
    if (!isUsable(itemType, spare)) {
      throw conflict('替补件当前不可演出: ' + input.substituteId, 'SUBSTITUTE_NOT_USABLE');
    }

    const allBoxes = this.repo.list('tourBoxes');
    for (const other of allBoxes) {
      if (other.id === box.id) continue;
      if (!UNFINISHED_BOX_STATUSES.includes(other.status)) continue;
      const held = itemType === 'puppetHeads' ? other.headIds : other.accessoryIds;
      if (Array.isArray(held) && held.includes(input.substituteId)) {
        throw conflict(
          `替补件已被未结束装箱单占用: ${other.id}（${other.status}）`,
          'SUBSTITUTE_HELD_BY_BOX'
        );
      }
    }
    // 当前装箱单的列表也要看（虚拟态，避免与本单已换入的件冲突）
    const currentHeld = itemType === 'puppetHeads' ? box.headIds : box.accessoryIds;
    if (Array.isArray(currentHeld) && currentHeld.includes(input.substituteId)) {
      throw conflict('替补件已在该装箱单中: ' + input.substituteId, 'SUBSTITUTE_ALREADY_IN_BOX');
    }

    // 未被待复核/已锁定的缺损单占用
    const excluded = new Set(virtuals.excludedReportIds || []);
    for (const report of this.repo.list('lossReports')) {
      if (excluded.has(report.id)) continue;
      if (!OCCUPYING_LOSS_STATUSES.includes(report.status)) continue;
      if (report.substituteId === input.substituteId) {
        throw conflict(
          `替补件已被缺损单 ${report.id}（${report.status}）占用`,
          'SUBSTITUTE_HELD_BY_LOSS'
        );
      }
    }
  }

  // 组装校验所需虚拟态（必要时先把既有通过结论回滚）
  _buildVirtuals(input, box, existing) {
    const records = {};
    let virtualBox = box;
    const excludedReportIds = [];

    if (existing) excludedReportIds.push(existing.id);

    if (existing && existing.status === LOSS_APPROVED && existing.preApprovalSnapshot) {
      const snapshot = existing.preApprovalSnapshot;
      virtualBox = {
        ...box,
        headIds: [...(snapshot.boxHeadIds || [])],
        accessoryIds: [...(snapshot.boxAccessoryIds || [])]
      };
      const restoreItem = this.repo.get(existing.itemType, existing.itemId);
      if (restoreItem) {
        records[existing.itemType + ':' + existing.itemId] = {
          ...restoreItem,
          status: snapshot.itemStatus,
          currentUsable: snapshot.itemUsable
        };
      }
      const restoreSpare = this.repo.get(existing.itemType, existing.substituteId);
      if (restoreSpare) {
        const released = {
          ...restoreSpare,
          status: snapshot.spareStatus
        };
        if ('spareUsable' in snapshot) released.currentUsable = snapshot.spareUsable;
        delete released.heldByTourBoxId;
        delete released.heldByLossReportId;
        delete released.lockedAt;
        records[existing.itemType + ':' + existing.substituteId] = released;
      }
    }

    const itemType = input.itemType;
    const itemRecord = this.repo.get(itemType, input.itemId);
    if (!itemRecord) throw notFound('报损件不存在: ' + input.itemId, 'ITEM_NOT_FOUND');
    const spareRecord = this.repo.get(itemType, input.substituteId);
    if (!spareRecord) throw notFound('替补件不存在: ' + input.substituteId, 'SUBSTITUTE_NOT_FOUND');

    const item = records[itemType + ':' + input.itemId] || itemRecord;
    const spare = records[itemType + ':' + input.substituteId] || spareRecord;

    return { box: virtualBox, item, spare, itemType, records, excludedReportIds };
  }

  // POST /api/tourBoxes/:boxId/loss-reports/substitution
  submitSubstitution(boxId, body) {
    const input = this._normalizeInput(body);
    const box = this._boxOrThrow(boxId);
    if (box.status !== BOX_RETURN_CHECK) {
      throw conflict(
        `装箱单须处于“${BOX_RETURN_CHECK}”，当前为“${box.status}”`,
        'BOX_NOT_IN_RETURN_CHECK'
      );
    }

    const existing = this.repo
      .list('lossReports')
      .find(
        (report) =>
          report.tourBoxId === boxId &&
          report.itemType === input.itemType &&
          report.itemId === input.itemId &&
          OPEN_LOSS_STATUSES.includes(report.status)
      );

    // 再次投递、关键资料（同箱同件同替补同问题）完全一致：读回原单，不写任何片段
    if (
      existing &&
      existing.substituteId === input.substituteId &&
      existing.problem === input.problem
    ) {
      return { report: existing, created: false, idempotent: true };
    }

    let plans;
    let created = false;

    if (!existing) {
      const virtuals = this._buildVirtuals(input, box, existing);
      this._assertSubstitutionEligible(input, virtuals);
      const baseFields = this._baseFields(input, virtuals.item, virtuals.spare, boxId);
      plans = [
        {
          mode: 'create',
          collection: 'lossReports',
          data: {
            ...baseFields,
            reporter: input.reporter,
            note: input.note,
            reviewDecision: null,
            reviewer: null,
            reviewedAt: null,
            reviewNote: '',
            repairRecordId: null,
            preApprovalSnapshot: null
          },
          status: LOSS_PENDING_REVIEW,
          action: '返场缺损替补申请',
          actor: input.reporter,
          note: input.note
        }
      ];
      created = true;
    } else if (existing.substituteId !== input.substituteId) {
      // 关键资料更正（换替补件）：既有结论失效、释放误占，重新挂起待复核
      const virtuals = this._buildVirtuals(input, box, existing);
      this._assertSubstitutionEligible(input, virtuals);
      const baseFields = this._baseFields(input, virtuals.item, virtuals.spare, boxId);
      plans = this._correctionPlans(existing, input, baseFields, box, virtuals);
    } else {
      // 非关键资料更新（问题描述/备注）：替补未变，结论与锁定保持，不重跑资格判定
      const item = this.repo.get(input.itemType, input.itemId);
      const spare = this.repo.get(input.itemType, input.substituteId);
      const baseFields = this._baseFields(input, item, spare, boxId);
      const merged = {
        ...this._plainData(existing),
        ...baseFields,
        note: input.note !== '' ? input.note : existing.note || ''
      };
      plans = [
        {
          collection: 'lossReports',
          id: existing.id,
          data: merged,
          status: existing.status,
          action: '缺损单资料更新（替补未变，结论保持）',
          actor: input.reporter,
          note: input.note
        }
      ];
    }

    const results = this.repo.mutate(plans);
    if (created) {
      return { report: results[0], created: true, idempotent: false };
    }
    return {
      report: this.repo.get('lossReports', existing.id),
      created: false,
      idempotent: false
    };
  }

  _baseFields(input, item, spare, boxId) {
    return {
      tourBoxId: boxId,
      itemType: input.itemType,
      itemId: input.itemId,
      itemName: itemNameOf(this.repo, input.itemType, item),
      play: item.play,
      role: item.role,
      problem: input.problem,
      substituteId: input.substituteId,
      substituteName: itemNameOf(this.repo, input.itemType, spare)
    };
  }

  // 关键资料更正：失效既有结论、释放误占，再挂上新的待复核申请
  _correctionPlans(existing, input, baseFields, box, virtuals) {
    const plans = [];

    if (existing.status === LOSS_APPROVED && existing.preApprovalSnapshot) {
      // 通过结论失效：原损件退出待修补、替补解锁退出装箱单、删除因此单建立的修补记录
      const snapshot = existing.preApprovalSnapshot;
      const restoredItem = {
        ...virtuals.item,
        status: snapshot.itemStatus
      };
      if ('itemUsable' in snapshot) restoredItem.currentUsable = snapshot.itemUsable;
      plans.push({
        collection: existing.itemType,
        id: existing.itemId,
        data: restoredItem,
        status: snapshot.itemStatus,
        action: '替补结论失效·恢复原损件',
        actor: input.reporter
      });
      const restoredSpare = { ...virtuals.spare, status: snapshot.spareStatus };
      if ('spareUsable' in snapshot) restoredSpare.currentUsable = snapshot.spareUsable;
      delete restoredSpare.heldByTourBoxId;
      delete restoredSpare.heldByLossReportId;
      delete restoredSpare.lockedAt;
      plans.push({
        collection: existing.itemType,
        id: existing.substituteId,
        data: restoredSpare,
        status: snapshot.spareStatus,
        action: '替补结论失效·释放误占替补件',
        actor: input.reporter
      });
      plans.push({
        collection: 'tourBoxes',
        id: box.id,
        data: {
          ...virtuals.box,
          headIds: [...(snapshot.boxHeadIds || [])],
          accessoryIds: [...(snapshot.boxAccessoryIds || [])]
        },
        status: box.status,
        action: '替补结论失效·装箱清单回退',
        actor: input.reporter
      });
      if (existing.repairRecordId) {
        plans.push({ mode: 'delete', collection: 'repairRecords', id: existing.repairRecordId });
      }
    }

    const updatedReport = {
      ...existing,
      ...baseFields,
      status: LOSS_PENDING_REVIEW,
      reviewDecision: null,
      reviewer: null,
      reviewedAt: null,
      reviewNote: '',
      repairRecordId: null,
      preApprovalSnapshot: null,
      note: input.note || existing.note || ''
    };
    delete updatedReport.id;
    delete updatedReport.collection;
    delete updatedReport.createdAt;
    delete updatedReport.updatedAt;
    plans.push({
      collection: 'lossReports',
      id: existing.id,
      data: updatedReport,
      status: LOSS_PENDING_REVIEW,
      action: '关键资料更正·待复核结论失效',
      actor: input.reporter,
      note: input.note
    });
    return plans;
  }

  // POST /api/lossReports/:id/review  body: { decision, reviewer, note }
  reviewLossReport(reportId, body) {
    const report = this.repo.getOrThrow('lossReports', reportId);
    const decision = String((body || {}).decision || '').trim();
    const reviewer = (body || {}).reviewer;
    const reviewNote = (body || {}).note ? String(body.note) : '';
    if (!decision) throw badRequest('缺少 decision（通过/驳回）', 'MISSING_DECISION');
    const normalizedDecision = ['通过', 'approved', 'approve', 'true', '1', 'pass'].includes(decision)
      ? '通过'
      : ['驳回', 'rejected', 'reject', 'false', '0', 'deny'].includes(decision)
        ? '驳回'
        : null;
    if (!normalizedDecision) throw badRequest('decision 必须是 通过 或 驳回', 'INVALID_DECISION');
    if (!reviewer) throw badRequest('缺少复核保管员 reviewer', 'MISSING_REVIEWER');
    if (String(reviewer) === String(report.reporter)) {
      throw new ApiError(403, '替补须由报损人之外的保管员复核', 'REVIEWER_MUST_DIFFER');
    }
    if (report.status !== LOSS_PENDING_REVIEW) {
      throw conflict(
        `缺损单当前状态为“${report.status}”，不可复核`,
        'LOSS_NOT_PENDING_REVIEW'
      );
    }

    const box = this._boxOrThrow(report.tourBoxId);
    if (box.status !== BOX_RETURN_CHECK) {
      throw conflict(
        `装箱单已不在“${BOX_RETURN_CHECK}”（当前“${box.status}”），替补复核已关闭`,
        'BOX_NOT_IN_RETURN_CHECK'
      );
    }
    const input = {
      itemType: report.itemType,
      itemId: report.itemId,
      substituteId: report.substituteId,
      problem: report.problem,
      reporter: report.reporter
    };

    if (normalizedDecision === '驳回') {
      const rejected = {
        ...this._plainData(report),
        status: LOSS_REJECTED,
        reviewDecision: '驳回',
        reviewer: String(reviewer),
        reviewedAt: new Date().toISOString(),
        reviewNote
      };
      this.repo.mutate([
        {
          collection: 'lossReports',
          id: report.id,
          data: rejected,
          status: LOSS_REJECTED,
          action: '替补复核驳回·替补释放',
          actor: String(reviewer),
          note: reviewNote
        }
      ]);
      return { report: this.repo.get('lossReports', report.id), approved: false };
    }

    // 复核通过前，全部条件重新判定一遍
    const virtuals = this._buildVirtuals(input, box, report);
    this._assertSubstitutionEligible(input, virtuals);

    const itemType = report.itemType;
    const item = this.repo.get(itemType, report.itemId);
    const spare = this.repo.get(itemType, report.substituteId);
    const reviewedAt = new Date().toISOString();

    const nextItemStatus = itemType === 'puppetHeads' ? '待修补' : '缺损';
    const nextSpareStatus = '已装箱';

    const snapshot = {
      itemStatus: item.status,
      itemUsable: item.currentUsable,
      spareStatus: spare.status,
      spareUsable: spare.currentUsable,
      boxHeadIds: [...(box.headIds || [])],
      boxAccessoryIds: [...(box.accessoryIds || [])]
    };

    const updatedItem = {
      ...item,
      status: nextItemStatus
    };
    delete updatedItem.id;
    delete updatedItem.collection;
    delete updatedItem.createdAt;
    delete updatedItem.updatedAt;
    if (itemType === 'puppetHeads') updatedItem.currentUsable = false;

    const updatedSpare = {
      ...spare,
      status: nextSpareStatus,
      heldByTourBoxId: box.id,
      heldByLossReportId: report.id,
      lockedAt: reviewedAt
    };
    delete updatedSpare.id;
    delete updatedSpare.collection;
    delete updatedSpare.createdAt;
    delete updatedSpare.updatedAt;

    const listKey = itemType === 'puppetHeads' ? 'headIds' : 'accessoryIds';
    const updatedBox = {
      ...box,
      [listKey]: [
        ...(box[listKey] || []).filter((id) => id !== report.itemId),
        report.substituteId
      ]
    };
    delete updatedBox.id;
    delete updatedBox.collection;
    delete updatedBox.createdAt;
    delete updatedBox.updatedAt;

    const plans = [
      {
        collection: itemType,
        id: report.itemId,
        data: updatedItem,
        status: nextItemStatus,
        action: itemType === 'puppetHeads' ? '复核通过·原损件转待修补' : '复核通过·配件标记缺损',
        actor: String(reviewer),
        note: reviewNote
      },
      {
        collection: itemType,
        id: report.substituteId,
        data: updatedSpare,
        status: nextSpareStatus,
        action: '复核通过·锁定替补件',
        actor: String(reviewer),
        note: reviewNote
      },
      {
        collection: 'tourBoxes',
        id: box.id,
        data: updatedBox,
        status: box.status,
        action: '复核通过·装箱单换入替补件',
        actor: String(reviewer),
        note: reviewNote
      }
    ];

    let repairRecordId = null;
    if (itemType === 'puppetHeads') {
      repairRecordId = randomUUID();
      plans.push({
        mode: 'create',
        collection: 'repairRecords',
        data: {
          id: repairRecordId,
          puppetHeadId: report.itemId,
          repairType: report.problem,
          handler: String(reviewer),
          sourceTourBoxId: box.id,
          sourceLossReportId: report.id
        },
        status: '待处理',
        action: '替补放行·建立修补记录',
        actor: String(reviewer),
        note: reviewNote
      });
    }

    const approvedReport = {
      ...this._plainData(report),
      status: LOSS_APPROVED,
      reviewDecision: '通过',
      reviewer: String(reviewer),
      reviewedAt,
      reviewNote,
      repairRecordId,
      preApprovalSnapshot: snapshot
    };
    plans.push({
      collection: 'lossReports',
      id: report.id,
      data: approvedReport,
      status: LOSS_APPROVED,
      action: '替补复核通过',
      actor: String(reviewer),
      note: reviewNote
    });

    this.repo.mutate(plans);
    return { report: this.repo.get('lossReports', report.id), approved: true };
  }

  _plainData(record) {
    const data = { ...record };
    delete data.id;
    delete data.collection;
    delete data.createdAt;
    delete data.updatedAt;
    return data;
  }
}

module.exports = { SubstitutionService, constants: {
  BOX_RETURN_CHECK,
  LOSS_PENDING_REVIEW,
  LOSS_APPROVED,
  LOSS_REJECTED,
  OPEN_LOSS_STATUSES,
  OCCUPYING_LOSS_STATUSES
} };
