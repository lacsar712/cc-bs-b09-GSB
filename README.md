# 桥梁应变班交台

测量员上报跨段编号与微应变读数，后台工人用 `FOR UPDATE SKIP LOCKED` 认领待处理队列，按 **80～220 με** 判定 **合格** 或 **越界**。

## 技术栈

| 层 | 选型 |
|----|------|
| 接口 | Python Sanic + psycopg（异步连接池） |
| 工人 | `worker.py`（psycopg 同步，`FOR UPDATE SKIP LOCKED`） |
| 页面 | Mithril.js + Vite，nginx 反代 `/api` |
| 数据库 | PostgreSQL 16 |

## 端口

| 服务 | 地址 |
|------|------|
| 页面 | http://localhost:3198 |
| 接口 | http://localhost:8198 |
| PostgreSQL | localhost:54398（库名 `bridgestrain`） |

## 账号

| 用户 | 密码 | 权限 |
|------|------|------|
| surveyor | surv123456 | 测量员，可提交读数 |
| reviewer | rev123456 | 复核员，只读列表 |

## 启动

```bash
cd projects/19-bridge-strain-shift
docker compose up --build
```

健康检查：`GET http://localhost:8198/api/health` → `{"status":"ok","service":"bridge-strain-shift"}`

## 种子数据

| 跨段 | 微应变 | 结论 |
|------|--------|------|
| 跨中S1 | 150 με | 合格 |
| 支座S2 | 40 με | 越界 |

## 历史峰值墙

顶栏点「峰值墙」进入专页：左侧为跨段列表，右侧展示该跨段的**当前峰值与出现时刻**，以及锁定后的**锁区只读副本**，页面下挂自动刷新（3 秒轮询，另有「刷新」按钮）。

规则（强约束）：

- **峰值一律由后台按办结集合重算**：接口仅统计 `strain_readings` 中 `status='done'` 的读数，按微应变降序取首条；浏览器只渲染接口结果，不做任何 `Math.max` 之类的比较。
- **无办结不写峰值**：跨段只有待处理/处理中读数时，峰值与出现时刻返回 `null`，页面显示「—」，且不允许锁定。
- **锁定即定格**：测量员点「锁定当前峰值」后，后台把**锁定那一刻**重算出的峰值与出现时刻原样抄入 `peak_locks` 锁区；此后新办结只更新未锁栏（当前峰值），锁区数字永久不变。再次锁定返回 `409`。
- **权限**：测量员（surveyor/writer）可锁定；复核员（reviewer/reader）只能查看，锁定返回 `403`。
- 锁定接口只接收 `span_code`，峰值/时刻由后台 `INSERT ... SELECT` 自行重算，请求体伪造 `peak_microstrain`/`peak_at` 一律被忽略。

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/peak-wall` | 服务端重算各跨段峰值（无办结为 `null`）及锁区副本 |
| POST | `/api/peak-wall/locks` | 测量员锁定某跨段当前峰值；`400` 无办结 / `403` 非测量员 / `409` 已锁定 |

`GET /api/peak-wall` 返回示例：

```json
{
  "span_code": "跨中S1",
  "peak_microstrain": 300.0,
  "peak_at": "2026-10-03T13:20:22.066525+00:00",
  "locked": true,
  "lock": {
    "peak_microstrain": 150.0,
    "peak_at": "2026-10-03T13:18:16.535846+00:00",
    "locked_by": "surveyor",
    "locked_at": "2026-10-03T13:20:21.469913+00:00"
  }
}
```

## 本地开发（可选）

```bash
cd backend && pip install -r requirements.txt
python -m sanic api.app --host=0.0.0.0 --port=8000 --single-process
python worker.py
cd frontend && npm install && npm run dev
```

接口进程默认监听容器内 **8000**，对外映射 **8198**。
