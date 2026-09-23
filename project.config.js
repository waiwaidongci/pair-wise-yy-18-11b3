module.exports = {
  port: 3914,
  title: '传统木偶戏班偶头与巡演装箱API',
  description: '维护偶头、服装配件、修补流转、巡演装箱和返场缺损追踪。',
  collections: {
    puppetHeads: {
      label: '偶头档案',
      defaultStatus: '可演出',
      statuses: ['可演出', '待修补', '修补中', '试演中', '不可演出', '已装箱'],
      required: ['role', 'play', 'paintStatus', 'mechanism', 'boxNo'],
      titleFields: ['role', 'play'],
      defaults: { currentUsable: true }
    },
    accessories: {
      label: '服装配件',
      defaultStatus: '在库',
      statuses: ['在库', '已装箱', '缺损', '遗失'],
      required: ['name', 'role', 'play', 'boxNo'],
      titleFields: ['name', 'role']
    },
    repairRecords: {
      label: '修补记录',
      defaultStatus: '待处理',
      statuses: ['待处理', '补漆中', '换线中', '修机关中', '换眼珠中', '试演中', '已完成'],
      required: ['puppetHeadId', 'repairType', 'handler'],
      titleFields: ['repairType', 'handler']
    },
    tourBoxes: {
      label: '巡演装箱单',
      defaultStatus: '草稿',
      statuses: ['草稿', '已装箱', '巡演中', '返场清点中', '已闭环'],
      required: ['showName', 'venue', 'play', 'headIds', 'accessoryIds'],
      titleFields: ['showName', 'play']
    },
    lossReports: {
      label: '缺损追踪',
      defaultStatus: '待处理',
      statuses: ['待处理', '修复中', '已补齐', '确认为遗失', '待复核', '已放行', '已驳回'],
      required: ['tourBoxId', 'itemType', 'itemName', 'problem'],
      titleFields: ['itemName', 'problem']
    }
  },
  seed: [
    {
      collection: 'puppetHeads',
      id: 'head-seed-1',
      status: '待修补',
      data: {
        role: '武生',
        play: '火焰山',
        paintStatus: '左颊掉彩',
        mechanism: '开口机关偏紧',
        accessories: ['红缨冠', '短靠'],
        boxNo: '木箱乙-04',
        currentUsable: false
      },
      note: '返场发现掉彩'
    },
    {
      collection: 'puppetHeads',
      id: 'head-ws-1',
      status: '已装箱',
      data: {
        role: '武生',
        play: '火焰山',
        paintStatus: '完好',
        mechanism: '正常',
        boxNo: '木箱甲-01'
      },
      note: '随箱返场清点的报损候选'
    },
    {
      collection: 'puppetHeads',
      id: 'head-ws-2',
      status: '可演出',
      data: {
        role: '武生',
        play: '火焰山',
        paintStatus: '完好',
        mechanism: '正常',
        boxNo: '木箱丙-07'
      },
      note: '空闲同剧目同角色替补候选'
    },
    {
      collection: 'puppetHeads',
      id: 'head-hd-1',
      status: '可演出',
      data: {
        role: '花旦',
        play: '西厢记',
        paintStatus: '完好',
        mechanism: '正常',
        boxNo: '木箱丙-08'
      },
      note: '角色不符的替补候选'
    },
    {
      collection: 'puppetHeads',
      id: 'head-ws-3',
      status: '已装箱',
      data: {
        role: '武生',
        play: '火焰山',
        paintStatus: '完好',
        mechanism: '正常',
        boxNo: '木箱甲-03'
      },
      note: '在另一场未结束巡演中，不可作替补'
    },
    {
      collection: 'accessories',
      id: 'accessory-seed-1',
      status: '在库',
      data: {
        name: '红缨冠',
        role: '武生',
        play: '火焰山',
        boxNo: '配件箱-02'
      }
    },
    {
      collection: 'accessories',
      id: 'acc-hg-1',
      status: '已装箱',
      data: {
        name: '红缨冠',
        role: '武生',
        play: '火焰山',
        boxNo: '配件箱-01'
      },
      note: '随箱返场清点的报损候选'
    },
    {
      collection: 'accessories',
      id: 'acc-hg-2',
      status: '在库',
      data: {
        name: '红缨冠',
        role: '武生',
        play: '火焰山',
        boxNo: '配件箱-03'
      },
      note: '空闲替补候选'
    },
    {
      collection: 'tourBoxes',
      id: 'box-fcqd-1',
      status: '返场清点中',
      data: {
        showName: '杭城返场场',
        venue: '杭州',
        play: '火焰山',
        headIds: ['head-ws-1'],
        accessoryIds: ['acc-hg-1']
      },
      note: '返场清点中的装箱单'
    },
    {
      collection: 'tourBoxes',
      id: 'box-xy-2',
      status: '巡演中',
      data: {
        showName: '姑苏巡演场',
        venue: '苏州',
        play: '火焰山',
        headIds: ['head-ws-3'],
        accessoryIds: []
      },
      note: '未结束的巡演装箱单'
    }
  ],
  examples: [
    'GET /api/puppetHeads?play=火焰山&status=可演出 查询某剧目可用偶头',
    'POST /api/tourBoxes 创建巡演装箱单',
    'POST /api/lossReports 登记返场缺损或遗失',
    'POST /api/tourBoxes/:boxId/lossReports 返场清点登记缺损替补（带 requestId）',
    'POST /api/lossReports/:id/review 保管员复核放行/驳回',
    'PATCH /api/lossReports/:id 更正缺损单（关键资料更正自动失效结论并释放误占）'
  ]
};
