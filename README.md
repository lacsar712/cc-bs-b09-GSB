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

顶栏「峰值墙」进入专页：左侧跨段列表，右侧当前峰值与出现时刻，下方挂刷新按钮，测量员可锁定只读副本。

- `GET /api/peaks`：服务端按办结集合（`status='done'`）当场重算各跨段峰值（最高微应变及其办结时刻），并带出已锁副本；**无办结读数的跨段不写出峰值**；登录即可看（测量员、复核岗均可）。
- `POST /api/peaks/lock`：仅测量员可锁（复核岗 403）。请求体只收 `span_code`，峰值与出现时刻由服务端当场重算后抄入 `peak_locks` 锁区，**客户端上送的任何峰值一律不被采纳**；已锁跨段重复锁定返回 409，锁区定格不可改。
- 锁定后新到的办结读数只影响未锁栏（下次 `GET /api/peaks` 重算），已锁栏数字定格不动。
- 前端峰值墙只渲染接口返回值，不在浏览器里自行比较大小。

## 本地开发（可选）

```bash
cd backend && pip install -r requirements.txt
python -m sanic api.app --host=0.0.0.0 --port=8000 --single-process
python worker.py
cd frontend && npm install && npm run dev
```

接口进程默认监听容器内 **8000**，对外映射 **8198**。
