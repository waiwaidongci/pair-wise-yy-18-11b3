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
      // 替补放行流程状态：待复核 -> 修复中（复核通过、替补锁定）/ 复核驳回（终态）
      statuses: ['待处理', '待复核', '修复中', '已补齐', '复核驳回', '确认为遗失'],
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
    // —— 返场清点装箱单及替补判定演示数据 ——
    {
      collection: 'puppetHeads',
      id: 'head-return-damage',
      status: '已装箱',
      data: {
        role: '孙悟空',
        play: '火焰山',
        paintStatus: '完好',
        mechanism: '转眼机关失灵',
        boxNo: '木箱甲-01',
        currentUsable: true
      },
      note: '巡演用头，返场发现机关失灵'
    },
    {
      collection: 'puppetHeads',
      id: 'head-return-spare',
      status: '可演出',
      data: {
        role: '孙悟空',
        play: '火焰山',
        paintStatus: '完好',
        mechanism: '正常',
        boxNo: '木箱甲-03',
        currentUsable: true
      },
      note: '同剧目同角色可演出替补头'
    },
    {
      collection: 'puppetHeads',
      id: 'head-other-role',
      status: '可演出',
      data: {
        role: '猪八戒',
        play: '火焰山',
        paintStatus: '完好',
        mechanism: '正常',
        boxNo: '木箱甲-03',
        currentUsable: true
      },
      note: '角色不符，不能替补'
    },
    {
      collection: 'accessories',
      id: 'acc-return-damage',
      status: '已装箱',
      data: {
        name: '虎皮裙',
        role: '孙悟空',
        play: '火焰山',
        boxNo: '配件箱-01'
      },
      note: '巡演配件，返场发现撕裂'
    },
    {
      collection: 'accessories',
      id: 'acc-return-spare',
      status: '在库',
      data: {
        name: '虎皮裙（备）',
        role: '孙悟空',
        play: '火焰山',
        boxNo: '配件箱-02'
      },
      note: '同剧目同角色在库替补配件'
    },
    {
      collection: 'tourBoxes',
      id: 'box-returning',
      status: '返场清点中',
      data: {
        showName: '甲辰秋巡演',
        venue: '泉州文庙戏台',
        play: '火焰山',
        headIds: ['head-return-damage'],
        accessoryIds: ['acc-return-damage'],
        showDate: '2026-09-20'
      },
      note: '返场清点中，可登记缺损替补'
    },
    {
      collection: 'tourBoxes',
      id: 'box-on-tour',
      status: '巡演中',
      data: {
        showName: '甲辰秋巡演·加场',
        venue: '漳州古城戏台',
        play: '火焰山',
        headIds: [],
        accessoryIds: [],
        showDate: '2026-09-25'
      },
      note: '仍在巡演，会占用替补件'
    }
  ],
  examples: [
    'GET /api/puppetHeads?play=火焰山&status=可演出 查询某剧目可用偶头',
    'POST /api/tourBoxes 创建巡演装箱单',
    'POST /api/lossReports 登记返场缺损或遗失',
    'POST /api/tourBoxes/:id/loss-reports/substitution 返场缺损替补放行',
    'POST /api/lossReports/:id/review 保管员复核替补申请'
  ]
};
