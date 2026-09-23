# 传统木偶戏班偶头与巡演装箱API

维护偶头、服装配件、修补流转、巡演装箱和返场缺损追踪。

## 启动

```bash
npm install
npm start
```

默认地址：http://localhost:3914

SQLite数据库文件会在首次启动时创建到`data/app.db`（通过 sql.js/WASM 内嵌引擎，提交时原子落盘）。

## 常用接口

- `GET /api/puppetHeads?play=火焰山&status=可演出`
- `POST /api/repairRecords`
- `POST /api/tourBoxes`
- `POST /api/lossReports`
- `GET /api/:collection/:id/timeline`

## 返场缺损替补放行

模块分三层，各自独立：

- 请求路由：`src/routes/lossReplacementRoutes.js`
- 业务判定：`src/domain/lossReplacement.js`（纯函数，不接触数据库）
- 持久化事务：`src/db/sqlite.js`、`src/db/recordStore.js`（单事务提交，失败整段回滚不落盘）

| 接口 | 说明 |
| --- | --- |
| `POST /api/tourBoxes/:boxId/lossReports` | 返场清点中登记缺损与替补，进入「待复核」。`requestId`（或 `X-Idempotency-Key` 头）用于再次投递读回原单 |
| `POST /api/lossReports/:id/review` | 保管员复核，`decision=approve|reject`；复核人不得是报损人 |
| `PATCH /api/lossReports/:id` | 更正缺损单；更正关键资料（装箱单/报损件类型/报损件/替补件）会使待复核或已放行结论失效并释放误占 |
| `GET /api/tourBoxes/:boxId/lossReports` | 装箱单视角的缺损单清单 |

业务规则：

1. 装箱单必须处于「返场清点中」；报损件必须确属该箱。
2. 同箱同件只能保留一张未办结缺损单（待处理/修复中/待复核）。
3. 替补件须与报损件同剧目同角色、当前可演出，且未被其他未结束装箱单或待复核/已放行缺损单占用。
4. 合不上条件一律返回 `409`，且任何片段都不保存（无新缺损单、无履历、无状态变更）。
5. 复核须由报损人之外的保管员完成；通过后原损件转「待修补/缺损」，替补件锁定为「已装箱」并换装入箱；驳回不锁定替补。
6. 再次投递凭 `requestId` 读回原单；关键资料更正使结论失效、释放误占并回到待复核；非关键资料（问题描述等）更正保留结论。
7. 装箱单、缺损单与各自履历（timeline）读取始终一致。

### 请求示例

```bash
# 登记（同一 requestId 重发即读回原单）
curl -X POST http://localhost:3914/api/tourBoxes/box-fcqd-1/lossReports \
  -H 'content-type: application/json' \
  -d '{"requestId":"req-001","itemType":"puppetHead","itemId":"head-ws-1",
       "replacementItemId":"head-ws-2","problem":"左颊掉彩","reporter":"王保管"}'

# 他人复核放行
curl -X POST http://localhost:3914/api/lossReports/<缺损单id>/review \
  -H 'content-type: application/json' \
  -d '{"decision":"approve","reviewer":"李保管","note":"同角替补可用"}'

# 关键资料更正（结论失效、误占释放、回到待复核）
curl -X PATCH http://localhost:3914/api/lossReports/<缺损单id> \
  -H 'content-type: application/json' \
  -d '{"replacementItemId":"head-ws-2","actor":"王保管"}'
```
