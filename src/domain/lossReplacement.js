'use strict';

// 返场缺损替补放行 · 业务判定（纯函数模块）。
// 只读取仓储组装好的 state，输出 HTTP 语义结果 { status, body }，不接触任何数据库代码。
const { randomUUID } = require('crypto');

const COLLECTION = {
  head: 'puppetHeads',
  accessory: 'accessories'
};

const BOX_COUNTING_STATUS = '返场清点中';
const BOX_FINISHED_STATUS = '已闭环';
const HEAD_USABLE_STATUS = '可演出';
const ACCESSORY_USABLE_STATUS = '在库';
const HEAD_DAMAGED_STATUS = '待修补';
const ACCESSORY_DAMAGED_STATUS = '缺损';
const LOCKED_STATUS = '已装箱';

// 缺损单进入待复核后的全部状态（同箱同件只允许一张）
const PENDING_REVIEW_STATUS = '待复核';
const APPROVED_STATUS = '已放行';
const REJECTED_STATUS = '已驳回';
const OPEN_LOSS_STATUSES = ['待处理', '修复中', PENDING_REVIEW_STATUS];

// 更正后会让待复核/放行结论失效的关键资料
const KEY_FIELDS = ['tourBoxId', 'itemType', 'itemId', 'replacementItemId'];

function conflict(code, message, extra = {}) {
  return { status: 409, body: { error: code, message, ...extra } };
}

function badRequest(message) {
  return { status: 400, body: { error: 'bad_request', message } };
}

function notFound(message) {
  return { status: 404, body: { error: 'not_found', message } };
}

function normalizeItemType(value) {
  if (value === 'puppetHead' || value === 'puppetHeads' || value === 'head' || value === '偶头') return 'head';
  if (value === 'accessory' || value === 'accessories' || value === '配件') return 'accessory';
  return null;
}

function itemCollection(itemType) {
  return COLLECTION[itemType];
}

function itemName(itemType, item) {
  if (!item) return '';
  return itemType === 'head'
    ? [item.role, item.play].filter(Boolean).join('/')
    : [item.name, item.role].filter(Boolean).join('/');
}

function stripMeta(record) {
  const data = { ...record };
  delete data.id;
  delete data.collection;
  delete data.status;
  delete data.createdAt;
  delete data.updatedAt;
  return data;
}

function isUsable(itemType, item) {
  if (!item) return false;
  if (itemType === 'head') {
    return item.status === HEAD_USABLE_STATUS && item.currentUsable !== false;
  }
  return item.status === ACCESSORY_USABLE_STATUS;
}

// 替补件是否与报损件同剧目同角色
function matchesRole(itemType, damaged, replacement) {
  if (!damaged || !replacement) return false;
  if (itemType === 'head') {
    return replacement.play === damaged.play && replacement.role === damaged.role;
  }
  return replacement.play === damaged.play && replacement.role === damaged.role && !!replacement.name;
}

// 装箱单是否仍未结束（替补件不得被未结束装箱单占用）
function boxUnfinished(box) {
  return !!box && box.status !== BOX_FINISHED_STATUS;
}

function boxContains(box, itemType, itemId) {
  if (!box) return false;
  const list = itemType === 'head' ? box.headIds || [] : box.accessoryIds || [];
  return list.includes(itemId);
}

// 占用判定：被未结束装箱单列入，或已被缺损替补流程锁定
function occupiedBy(state, itemType, itemId, { exceptLossId = null, exceptBoxId = null } = {}) {
  for (const box of state.tourBoxes) {
    if (box.id === exceptBoxId || !boxUnfinished(box)) continue;
    if (boxContains(box, itemType, itemId)) {
      return { kind: 'tourBox', id: box.id, name: box.showName };
    }
  }
  for (const report of state.lossReports) {
    if (report.id === exceptLossId) continue;
    if (report.status !== PENDING_REVIEW_STATUS && report.status !== APPROVED_STATUS) continue;
    if (report.replacementItemId === itemId && report.itemType === itemType) {
      return { kind: 'lossReport', id: report.id, name: report.itemName };
    }
  }
  const collection = itemCollection(itemType);
  const item = (state[collection] || []).find((entry) => entry.id === itemId);
  if (item && item.lockedForLossReportId && item.lockedForLossReportId !== exceptLossId) {
    return { kind: 'lock', id: item.lockedForLossReportId };
  }
  return null;
}

function findOpenLossFor(state, boxId, itemType, itemId, { exceptLossId = null } = {}) {
  return state.lossReports.find((report) =>
    report.id !== exceptLossId &&
    report.tourBoxId === boxId &&
    report.itemType === itemType &&
    report.itemId === itemId &&
    OPEN_LOSS_STATUSES.includes(report.status)
  ) || null;
}

function findByIdempotencyKey(state, key) {
  return state.lossReports.find((report) => report.idempotencyKey === key) || null;
}

function findItem(state, itemType, itemId) {
  const collection = itemCollection(itemType);
  return (state[collection] || []).find((entry) => entry.id === itemId) || null;
}

function itemIdentity(item) {
  return { id: item.id, play: item.play, role: item.role };
}

// 校验替补件：同剧目同角色、可演出、未被占用
function evaluateReplacement(state, itemType, damaged, replacementId, except) {
  if (!replacementId) return { ok: false, code: 'replacement_required', message: '缺少替补件' };
  const replacement = findItem(state, itemType, replacementId);
  if (!replacement || replacement.id === damaged.id) {
    return { ok: false, code: 'replacement_not_found', message: '替补件不存在或与报损件相同' };
  }
  if (!matchesRole(itemType, damaged, replacement)) {
    return {
      ok: false,
      code: 'replacement_role_mismatch',
      message: '替补件须与报损件同剧目同角色',
      damaged: itemIdentity(damaged),
      replacement: itemIdentity(replacement)
    };
  }
  if (!isUsable(itemType, replacement)) {
    return { ok: false, code: 'replacement_not_usable', message: '替补件当前不可演出' };
  }
  const occupant = occupiedBy(state, itemType, replacementId, except);
  if (occupant) {
    return {
      ok: false,
      code: 'replacement_occupied',
      message: '替补件已被未结束装箱单或待复核缺损单占用',
      occupiedBy: occupant
    };
  }
  return { ok: true, item: replacement };
}

// 共同前置：装箱单处于返场清点中、报损件确属该箱
function locateLossContext(state, input) {
  const box = state.tourBoxes.find((entry) => entry.id === input.tourBoxId) || null;
  if (!box) return { error: notFound('装箱单不存在: ' + input.tourBoxId) };
  if (box.status !== BOX_COUNTING_STATUS) {
    return {
      error: conflict('box_not_counting', '装箱单不处于返场清点中，不能登记缺损替补', {
        boxId: box.id,
        status: box.status
      })
    };
  }
  const itemType = normalizeItemType(input.itemType);
  if (!itemType) return { error: badRequest('itemType 取值须为 puppetHead/accessory') };
  const damaged = findItem(state, itemType, input.itemId);
  if (!damaged) {
    return { error: conflict('item_not_found', '报损件不存在', { itemType, itemId: input.itemId }) };
  }
  if (!boxContains(box, itemType, damaged.id)) {
    return {
      error: conflict('item_not_in_box', '报损件须确属该装箱单', {
        boxId: box.id,
        itemType,
        itemId: damaged.id
      })
    };
  }
  return { box, itemType, damaged };
}

function newEvent(recordId, collection, fields) {
  return { recordId, collection, ...fields };
}

// 再次投递：按幂等键读回原单
function submitLossReport(state, input, options = {}) {
  const uuid = options.uuid || randomUUID;
  const idempotencyKey = input.requestId;
  if (!idempotencyKey) return badRequest('缺少 requestId（再次投递请使用同一 requestId 读回原单）');

  const existing = findByIdempotencyKey(state, idempotencyKey);
  if (existing) {
    return {
      status: 200,
      body: existing,
      effects: { changes: [], events: [] },
      resubmitted: true
    };
  }

  for (const field of ['tourBoxId', 'itemType', 'itemId', 'reporter']) {
    if (input[field] === undefined || input[field] === null || input[field] === '') {
      return badRequest('缺少必填字段: ' + field);
    }
  }

  const context = locateLossContext(state, input);
  if (context.error) return context.error;
  const { box, itemType, damaged } = context;

  const duplicate = findOpenLossFor(state, box.id, itemType, damaged.id);
  if (duplicate) {
    return conflict('open_loss_exists', '同箱同件已存在未办结的缺损单，只能保留一张', {
      existingLossReportId: duplicate.id,
      status: duplicate.status
    });
  }

  const replacementCheck = evaluateReplacement(state, itemType, damaged, input.replacementItemId, {});
  if (!replacementCheck.ok) return conflict(replacementCheck.code, replacementCheck.message, replacementCheck);

  const nowIso = options.now ? options.now() : new Date().toISOString();
  const reportId = uuid();
  const status = PENDING_REVIEW_STATUS;
  const data = {
    idempotencyKey,
    tourBoxId: box.id,
    showName: box.showName,
    itemType,
    itemId: damaged.id,
    itemName: itemName(itemType, damaged),
    problem: input.problem || '',
    reporter: input.reporter,
    replacementItemId: replacementCheck.item.id,
    replacementName: itemName(itemType, replacementCheck.item),
    review: null,
    status
  };

  return {
    status: 201,
    body: { id: reportId, ...data, createdAt: nowIso, updatedAt: nowIso },
    effects: {
      changes: [
        { op: 'insert', id: reportId, collection: 'lossReports', status, data, createdAt: nowIso }
      ],
      events: [
        newEvent(reportId, 'lossReports', {
          action: '缺损替补登记',
          status,
          actor: input.reporter,
          note: '返场清点登记，等待保管员复核',
          data: {
            tourBoxId: box.id,
            itemType,
            itemId: damaged.id,
            replacementItemId: replacementCheck.item.id,
            problem: input.problem || ''
          }
        })
      ]
    }
  };
}

// 保管员复核：通过/驳回
function reviewLossReport(state, reportId, input) {
  const report = state.lossReports.find((entry) => entry.id === reportId);
  if (!report) return notFound('缺损单不存在: ' + reportId);
  if (report.status !== PENDING_REVIEW_STATUS) {
    return conflict('not_pending_review', '缺损单不处于待复核状态，不能再复核', {
      lossReportId: report.id,
      status: report.status
    });
  }
  const decision = input.decision;
  if (decision !== 'approve' && decision !== 'reject') {
    return badRequest('decision 取值须为 approve/reject');
  }
  if (!input.reviewer) return badRequest('缺少复核保管员 reviewer');
  if (input.reviewer === report.reporter) {
    return conflict('self_review_forbidden', '替补须由报损人之外的保管员复核', {
      reporter: report.reporter,
      reviewer: input.reviewer
    });
  }

  const box = state.tourBoxes.find((entry) => entry.id === report.tourBoxId);
  if (!box || box.status !== BOX_COUNTING_STATUS) {
    return conflict('box_not_counting', '装箱单已不在返场清点中，复核中止', {
      boxId: report.tourBoxId,
      status: box ? box.status : null
    });
  }

  const itemType = report.itemType;
  const damaged = findItem(state, itemType, report.itemId);
  if (!damaged || !boxContains(box, itemType, damaged.id)) {
    return conflict('item_not_in_box', '报损件已不属于该装箱单', { itemType, itemId: report.itemId });
  }

  const nowIso = new Date().toISOString();
  const reviewInfo = {
    decision: decision === 'approve' ? 'approved' : 'rejected',
    reviewer: input.reviewer,
    reviewedAt: nowIso,
    note: input.note || ''
  };

  if (decision === 'reject') {
    const status = REJECTED_STATUS;
    const data = { ...stripMeta(report), status, review: { ...report.review, ...reviewInfo } };
    return {
      status: 200,
      body: { id: report.id, ...data },
      effects: {
        changes: [{ op: 'update', id: report.id, collection: 'lossReports', status, data }],
        events: [
          newEvent(report.id, 'lossReports', {
            action: '替补复核驳回',
            status,
            actor: input.reviewer,
            note: input.note || '复核未通过，替补占用释放',
            data: reviewInfo
          })
        ]
      }
    };
  }

  // 复核通过前重新验证替补件，防止登记后条件变化
  const replacementCheck = evaluateReplacement(state, itemType, damaged, report.replacementItemId, {
    exceptLossId: report.id
  });
  if (!replacementCheck.ok) return conflict(replacementCheck.code, replacementCheck.message, replacementCheck);
  const replacement = replacementCheck.item;

  const damagedStatus = itemType === 'head' ? HEAD_DAMAGED_STATUS : ACCESSORY_DAMAGED_STATUS;
  const damagedData = {
    ...stripMeta(damaged),
    status: damagedStatus,
    ...(itemType === 'head' ? { currentUsable: false } : {}),
    damagedFromLossReportId: report.id
  };
  const replacementData = {
    ...stripMeta(replacement),
    status: LOCKED_STATUS,
    lockedForLossReportId: report.id,
    lockedAt: nowIso
  };
  const boxData = (() => {
    const ids = itemType === 'head' ? [...(box.headIds || [])] : [...(box.accessoryIds || [])];
    const index = ids.indexOf(damaged.id);
    if (index >= 0) ids[index] = replacement.id;
    else if (!ids.includes(replacement.id)) ids.push(replacement.id);
    return itemType === 'head'
      ? { ...stripMeta(box), headIds: ids }
      : { ...stripMeta(box), accessoryIds: ids };
  })();

  const status = APPROVED_STATUS;
  const data = {
    ...stripMeta(report),
    status,
    review: {
      ...reviewInfo,
      approvedAt: nowIso,
      damagedSnapshot: {
        status: damaged.status,
        currentUsable: damaged.currentUsable,
        damagedFromLossReportId: damaged.damagedFromLossReportId || null
      },
      replacementSnapshot: {
        status: replacement.status,
        currentUsable: replacement.currentUsable,
        lockedForLossReportId: replacement.lockedForLossReportId || null,
        lockedAt: replacement.lockedAt || null
      },
      boxSnapshot: itemType === 'head' ? { headIds: box.headIds || [] } : { accessoryIds: box.accessoryIds || [] }
    }
  };

  return {
    status: 200,
    body: { id: report.id, ...data },
    effects: {
      changes: [
        { op: 'update', id: report.id, collection: 'lossReports', status, data },
        { op: 'update', id: damaged.id, collection: itemCollection(itemType), status: damagedStatus, data: damagedData },
        { op: 'update', id: replacement.id, collection: itemCollection(itemType), status: LOCKED_STATUS, data: replacementData },
        { op: 'update', id: box.id, collection: 'tourBoxes', status: box.status, data: boxData }
      ],
      events: [
        newEvent(report.id, 'lossReports', {
          action: '替补复核放行',
          status,
          actor: input.reviewer,
          note: input.note || '复核通过：原损件转待修补，替补件锁定',
          data: {
            damagedItemId: damaged.id,
            replacementItemId: replacement.id,
            tourBoxId: box.id
          }
        }),
        newEvent(damaged.id, itemCollection(itemType), {
          action: '报损转待修补',
          status: damagedStatus,
          actor: input.reviewer,
          note: '缺损替补复核通过',
          data: { lossReportId: report.id }
        }),
        newEvent(replacement.id, itemCollection(itemType), {
          action: '替补件锁定',
          status: LOCKED_STATUS,
          actor: input.reviewer,
          note: '作为缺损替补锁定并随箱',
          data: { lossReportId: report.id, tourBoxId: box.id }
        }),
        newEvent(box.id, 'tourBoxes', {
          action: '替补件换装入箱',
          status: box.status,
          actor: input.reviewer,
          note: input.note || '',
          data: { itemType, removedItemId: damaged.id, addedItemId: replacement.id, lossReportId: report.id }
        })
      ]
    }
  };
}

// 更正重判用的虚拟视图：若缺损单已放行，先在内存里撤销它自身的放行效果
// （原损件归箱、替补解锁、装箱清单复原），再据此重跑全部条件。
function viewWithoutApproval(state, report) {
  if (report.status !== APPROVED_STATUS || !report.review) return state;
  const snap = report.review || {};
  const restoreRecord = (item) => {
    if (!item) return item;
    if (item.id !== report.itemId && item.id !== report.replacementItemId) return item;
    const snapshot = item.id === report.itemId ? snap.damagedSnapshot : snap.replacementSnapshot;
    const restored = stripMeta(item);
    if (snapshot) {
      if (snapshot.status !== undefined) restored.status = snapshot.status;
      if (snapshot.currentUsable !== undefined) restored.currentUsable = snapshot.currentUsable;
      if ('lockedForLossReportId' in snapshot) restored.lockedForLossReportId = snapshot.lockedForLossReportId;
      if ('lockedAt' in snapshot) restored.lockedAt = snapshot.lockedAt;
      if ('damagedFromLossReportId' in snapshot) restored.damagedFromLossReportId = snapshot.damagedFromLossReportId;
    }
    return { id: item.id, collection: item.collection, createdAt: item.createdAt, updatedAt: item.updatedAt, ...restored };
  };
  const restoreBox = (box) => {
    if (box.id !== report.tourBoxId || !snap.boxSnapshot) return box;
    return {
      ...box,
      ...(report.itemType === 'head'
        ? { headIds: snap.boxSnapshot.headIds || [] }
        : { accessoryIds: snap.boxSnapshot.accessoryIds || [] })
    };
  };
  return {
    ...state,
    tourBoxes: state.tourBoxes.map(restoreBox),
    puppetHeads: state.puppetHeads.map(restoreRecord),
    accessories: state.accessories.map(restoreRecord)
  };
}

// 更正缺损单：关键资料更正会让结论失效并释放误占
function amendLossReport(state, reportId, input) {
  const report = state.lossReports.find((entry) => entry.id === reportId);
  if (!report) return notFound('缺损单不存在: ' + reportId);
  if (![PENDING_REVIEW_STATUS, APPROVED_STATUS].includes(report.status)) {
    return conflict('not_amendable', '只有待复核或已放行的缺损单可以更正', {
      lossReportId: report.id,
      status: report.status
    });
  }

  const wasApproved = report.status === APPROVED_STATUS;
  const actor = input.actor || report.reporter;
  const patch = {
    tourBoxId: input.tourBoxId !== undefined ? input.tourBoxId : report.tourBoxId,
    itemType: normalizeItemType(input.itemType !== undefined ? input.itemType : report.itemType),
    itemId: input.itemId !== undefined ? input.itemId : report.itemId,
    replacementItemId: input.replacementItemId !== undefined ? input.replacementItemId : report.replacementItemId
  };
  if (!patch.itemType) return badRequest('itemType 取值须为 puppetHead/accessory');

  // 已放行单：在“已撤销自身放行”的虚拟视图上重判，模拟先释放误占、再校验
  const effectiveState = wasApproved ? viewWithoutApproval(state, report) : state;

  // 用更正后的关键资料重跑全部业务条件
  const context = locateLossContext(effectiveState, {
    tourBoxId: patch.tourBoxId,
    itemType: patch.itemType,
    itemId: patch.itemId
  });
  if (context.error) return context.error;
  const { box, itemType, damaged } = context;

  const duplicate = findOpenLossFor(effectiveState, box.id, itemType, damaged.id, { exceptLossId: report.id });
  if (duplicate) {
    return conflict('open_loss_exists', '同箱同件已存在另一张未办结缺损单', {
      existingLossReportId: duplicate.id,
      status: duplicate.status
    });
  }

  const replacementCheck = evaluateReplacement(effectiveState, itemType, damaged, patch.replacementItemId, {
    exceptLossId: report.id
  });
  if (!replacementCheck.ok) return conflict(replacementCheck.code, replacementCheck.message, replacementCheck);

  const changedKeys = KEY_FIELDS.filter((key) => {
    if (key === 'itemType') return report.itemType !== itemType;
    return String(report[key]) !== String(patch[key]);
  });
  const keyChanged = changedKeys.length > 0;
  const nowIso = new Date().toISOString();
  const changes = [];
  const events = [];

  // 已放行后更正：先撤销放行效果，释放误占
  if (wasApproved) {
    const oldItemType = report.itemType;
    const oldDamaged = findItem(state, oldItemType, report.itemId);
    const oldReplacement = findItem(state, oldItemType, report.replacementItemId);
    const oldBox = state.tourBoxes.find((entry) => entry.id === report.tourBoxId);
    const snap = report.review || {};

    if (oldDamaged) {
      const restored = {
        ...stripMeta(oldDamaged),
        status: (snap.damagedSnapshot && snap.damagedSnapshot.status) ||
          (oldItemType === 'head' ? HEAD_USABLE_STATUS : ACCESSORY_USABLE_STATUS),
        damagedFromLossReportId: (snap.damagedSnapshot && snap.damagedSnapshot.damagedFromLossReportId) || null
      };
      if (snap.damagedSnapshot && snap.damagedSnapshot.currentUsable !== undefined) {
        restored.currentUsable = snap.damagedSnapshot.currentUsable;
      } else {
        delete restored.currentUsable;
      }
      changes.push({
        op: 'update',
        id: oldDamaged.id,
        collection: itemCollection(oldItemType),
        status: restored.status,
        data: restored
      });
      events.push(newEvent(oldDamaged.id, itemCollection(oldItemType), {
        action: '放行结论失效-原损件释放',
        status: restored.status,
        actor,
        note: '关键资料更正，原放行结论失效',
        data: { lossReportId: report.id }
      }));
    }

    if (oldReplacement) {
      const restoredReplacement = {
        ...stripMeta(oldReplacement),
        status: (snap.replacementSnapshot && snap.replacementSnapshot.status) ||
          (oldItemType === 'head' ? HEAD_USABLE_STATUS : ACCESSORY_USABLE_STATUS),
        lockedForLossReportId: (snap.replacementSnapshot && snap.replacementSnapshot.lockedForLossReportId) || null,
        lockedAt: (snap.replacementSnapshot && snap.replacementSnapshot.lockedAt) || null
      };
      if (snap.replacementSnapshot && snap.replacementSnapshot.currentUsable !== undefined) {
        restoredReplacement.currentUsable = snap.replacementSnapshot.currentUsable;
      }
      changes.push({
        op: 'update',
        id: oldReplacement.id,
        collection: itemCollection(oldItemType),
        status: restoredReplacement.status,
        data: restoredReplacement
      });
      events.push(newEvent(oldReplacement.id, itemCollection(oldItemType), {
        action: '放行结论失效-替补解锁',
        status: restoredReplacement.status,
        actor,
        note: '关键资料更正，误占替补释放',
        data: { lossReportId: report.id }
      }));
    }

    if (oldBox && snap.boxSnapshot) {
      const restoredBox = {
        ...stripMeta(oldBox),
        ...(oldItemType === 'head' ? { headIds: snap.boxSnapshot.headIds || [] } : { accessoryIds: snap.boxSnapshot.accessoryIds || [] })
      };
      changes.push({
        op: 'update',
        id: oldBox.id,
        collection: 'tourBoxes',
        status: oldBox.status,
        data: restoredBox
      });
      events.push(newEvent(oldBox.id, 'tourBoxes', {
        action: '放行结论失效-装箱复原',
        status: oldBox.status,
        actor,
        note: '关键资料更正，装箱清单复原',
        data: { lossReportId: report.id }
      }));
    }
  }

  const nextStatus = keyChanged ? PENDING_REVIEW_STATUS : report.status;
  const nextData = {
    ...stripMeta(report),
    tourBoxId: box.id,
    showName: box.showName,
    itemType,
    itemId: damaged.id,
    itemName: itemName(itemType, damaged),
    replacementItemId: replacementCheck.item.id,
    replacementName: itemName(itemType, replacementCheck.item),
    problem: input.problem !== undefined ? input.problem : report.problem,
    note: input.note !== undefined ? input.note : report.note,
    status: nextStatus,
    ...(keyChanged
      ? {
          review: null,
          invalidatedAt: wasApproved ? nowIso : (report.invalidatedAt || null),
          invalidatedReason: wasApproved ? '关键资料更正，放行结论失效并释放误占' : (report.invalidatedReason || null)
        }
      : {})
  };

  changes.push({ op: 'update', id: report.id, collection: 'lossReports', status: nextStatus, data: nextData });
  events.push(newEvent(report.id, 'lossReports', {
    action: keyChanged ? '关键资料更正-待复核结论失效' : '缺损单资料更正',
    status: nextStatus,
    actor,
    note: keyChanged
      ? '关键资料变更: ' + changedKeys.join(', ') + (wasApproved ? '；已释放误占，重新等待复核' : '；重新等待复核')
      : (input.note || '资料更正'),
    data: { changedKeys, patch, releasedOccupancy: wasApproved && keyChanged }
  }));

  return {
    status: 200,
    body: { id: report.id, ...nextData },
    effects: { changes, events },
    keyChanged
  };
}

module.exports = {
  COLLECTION,
  STATUSES: {
    BOX_COUNTING_STATUS,
    BOX_FINISHED_STATUS,
    HEAD_USABLE_STATUS,
    ACCESSORY_USABLE_STATUS,
    HEAD_DAMAGED_STATUS,
    ACCESSORY_DAMAGED_STATUS,
    LOCKED_STATUS,
    PENDING_REVIEW_STATUS,
    APPROVED_STATUS,
    REJECTED_STATUS,
    OPEN_LOSS_STATUSES
  },
  KEY_FIELDS,
  normalizeItemType,
  itemCollection,
  isUsable,
  matchesRole,
  occupiedBy,
  findOpenLossFor,
  submitLossReport,
  reviewLossReport,
  amendLossReport,
  badRequest,
  notFound,
  conflict
};
