# 传统木偶戏班偶头与巡演装箱API

维护偶头、服装配件、修补流转、巡演装箱和返场缺损追踪。

## 启动

```bash
npm install
npm start
```

默认地址：http://localhost:3914

数据持久化在 `data/app.json`（首次启动自动创建并写入种子数据）。

## 常用接口

- `GET /api/puppetHeads?play=火焰山&status=可演出`
- `POST /api/repairRecords`
- `POST /api/tourBoxes`
- `POST /api/lossReports`
- `GET /api/:collection/:id/timeline`

## 返场缺损替补放行

仅当装箱单处于 **返场清点中** 时可投递：

```
POST /api/tourBoxes/:boxId/loss-reports/substitution
{
  "itemType": "puppetHeads | 偶头 | accessories | 配件",
  "itemId": "报损件ID（须确属该箱 headIds/accessoryIds）",
  "substituteId": "替补件ID（同剧目同角色且可演出/在库）",
  "problem": "缺损情况",
  "reporter": "报损保管员",
  "note": "可选备注"
}
```

规则：

- 同箱同件同时只保留一张未办结缺损单；
- 替补件不得被其他未结束装箱单（草稿/已装箱/巡演中/返场清点中）或
  待复核、已放行缺损单占用；
- 任一条件不合返回 `409`（错误体带 `code`），整笔不写入任何片段；
- 同箱同件同替补同问题再次投递直接读回原单（幂等）；
- 关键资料更正（更换替补件）会使已放行结论失效、释放误占、
  回退装箱清单与修补记录，缺损单重新进入待复核。

复核（须为报损人之外的保管员，否则 `403`）：

```
POST /api/lossReports/:id/review
{ "decision": "通过 | 驳回", "reviewer": "另一名保管员", "note": "可选" }
```

通过后同一事务内完成：原损偶头转 **待修补**（配件转 **缺损**）、
建立修补记录、替补件锁定为 **已装箱** 并换入装箱单，缺损单进入 **修复中**；
驳回则替补保持释放，缺损单进入 **复核驳回**。装箱单离开返场清点后复核关闭。

## 模块划分

- `src/store.js`：持久化事务（JSON 文档存储，快照草稿 + 原子落盘，异常整体丢弃）
- `src/repository.js`：集合仓库（记录/事件读写、多计划同事务提交）
- `src/substitution-service.js`：返场缺损替补业务判定
- `src/substitution-routes.js` / `src/generic-routes.js`：请求路由
- `server.js`：装配入口
