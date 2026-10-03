import os
from datetime import datetime, timedelta, timezone

import jwt
from passlib.context import CryptContext
from sanic import Sanic
from sanic.response import json as sanic_json

from db import create_pool, ensure_schema, seed_if_empty

# 峰值墙只统计“已办结”集合中的读数
DONE_STATUS = "done"

SECRET = os.environ.get("JWT_SECRET", "bridge-strain-dev-secret")
pwd = CryptContext(schemes=["bcrypt"], deprecated="auto")

USERS = {
    "surveyor": {"role": "writer", "password_hash": pwd.hash("surv123456")},
    "reviewer": {"role": "reader", "password_hash": pwd.hash("rev123456")},
}

app = Sanic("bridge-strain-shift")


def _auth_header(request) -> str | None:
    auth = request.headers.get("Authorization", "")
    if auth.startswith("Bearer "):
        return auth[7:].strip()
    return None


def _decode_user(token: str | None) -> dict | None:
    if not token:
        return None
    try:
        payload = jwt.decode(token, SECRET, algorithms=["HS256"])
    except jwt.InvalidTokenError:
        return None
    sub = payload.get("sub")
    if sub not in USERS:
        return None
    return {"username": sub, "role": payload.get("role")}


def _require_user(request) -> dict:
    user = _decode_user(_auth_header(request))
    if not user:
        return None
    return user


def _iso(dt) -> str | None:
    if dt is None:
        return None
    return dt.isoformat()


@app.before_server_start
async def setup(_app, _loop):
    pool = await create_pool()
    _app.ctx.pool = pool
    await ensure_schema(pool)
    await seed_if_empty(pool)


@app.after_server_stop
async def teardown(_app, _loop):
    pool = _app.ctx.pool
    if pool:
        await pool.close()


@app.get("/api/health")
async def health(_request):
    return sanic_json({"status": "ok", "service": "bridge-strain-shift"})


@app.post("/api/auth/login")
async def login(request):
    body = request.json or {}
    username = str(body.get("username", "")).strip()
    password = str(body.get("password", ""))
    user = USERS.get(username)
    if not user or not pwd.verify(password, user["password_hash"]):
        return sanic_json({"detail": "用户名或密码错误"}, status=401)
    exp = datetime.now(timezone.utc) + timedelta(hours=8)
    token = jwt.encode(
        {"sub": username, "role": user["role"], "exp": exp},
        SECRET,
        algorithm="HS256",
    )
    return sanic_json(
        {"access_token": token, "username": username, "role": user["role"]}
    )


@app.get("/api/readings")
async def list_readings(request):
    if not _require_user(request):
        return sanic_json({"detail": "未登录"}, status=401)
    pool = request.app.ctx.pool
    async with pool.connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                SELECT id, span_code, microstrain, verdict, reason, status,
                       created_by, created_at, processed_at
                FROM strain_readings
                ORDER BY id DESC
                """
            )
            rows = await cur.fetchall()
    out = []
    for r in rows:
        out.append(
            {
                "id": r["id"],
                "span_code": r["span_code"],
                "microstrain": r["microstrain"],
                "verdict": r["verdict"],
                "reason": r["reason"],
                "status": r["status"],
                "created_by": r["created_by"],
                "created_at": _iso(r["created_at"]),
                "processed_at": _iso(r["processed_at"]),
            }
        )
    return sanic_json(out)


@app.post("/api/readings")
async def create_reading(request):
    user = _require_user(request)
    if not user:
        return sanic_json({"detail": "未登录"}, status=401)
    if user["role"] != "writer":
        return sanic_json({"detail": "仅测量员可提交应变读数"}, status=403)
    body = request.json or {}
    span_code = str(body.get("span_code", "")).strip()
    if not span_code:
        return sanic_json({"detail": "跨段编号不能为空"}, status=400)
    try:
        microstrain = float(body.get("microstrain"))
    except (TypeError, ValueError):
        return sanic_json({"detail": "微应变必须是数字"}, status=400)

    pool = request.app.ctx.pool
    async with pool.connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                INSERT INTO strain_readings (span_code, microstrain, status, created_by, created_at)
                VALUES (%s, %s, 'pending', %s, now())
                RETURNING id, span_code, microstrain, verdict, reason, status,
                          created_by, created_at, processed_at
                """,
                (span_code, microstrain, user["username"]),
            )
            row = await cur.fetchone()
        await conn.commit()

    return sanic_json(
        {
            "id": row["id"],
            "span_code": row["span_code"],
            "microstrain": row["microstrain"],
            "verdict": row["verdict"],
            "reason": row["reason"],
            "status": row["status"],
            "created_by": row["created_by"],
            "created_at": _iso(row["created_at"]),
            "processed_at": None,
            "message": "已入队，后台工人将认领并判定",
        },
        status=201,
    )


# ---------------------------------------------------------------------------
# 历史峰值墙
#
# 不变式（峰值只允许由后台重算，浏览器只负责渲染）：
#   1. 峰值来自 strain_readings 中 status='done' 的办结集合，按读数降序取首条；
#   2. 跨段没有任何办结读数时，peak_microstrain / peak_at 一律为 null，
#      前端据此显示“—”，任何地方都不得写出一个具体峰值数字；
#   3. 锁定只是把“锁定那一刻”的后台重算结果原样抄进 peak_locks 锁区，
#      锁定接口不接受客户端传入的峰值/时刻，新办结不再改动锁区。
# ---------------------------------------------------------------------------

_PEAK_SELECT = """
SELECT s.span_code,
       p.peak_microstrain,
       p.peak_at,
       l.peak_microstrain AS locked_microstrain,
       l.peak_at           AS locked_peak_at,
       l.locked_by,
       l.locked_at
FROM (
    SELECT DISTINCT span_code FROM strain_readings
) s
LEFT JOIN LATERAL (
    SELECT microstrain AS peak_microstrain, processed_at AS peak_at
    FROM strain_readings r
    WHERE r.span_code = s.span_code AND r.status = %s
    ORDER BY r.microstrain DESC, r.processed_at ASC NULLS LAST, r.id ASC
    LIMIT 1
) p ON TRUE
LEFT JOIN peak_locks l ON l.span_code = s.span_code
ORDER BY s.span_code
"""


def _serialize_peak_row(r) -> dict:
    lock = None
    if r["locked_microstrain"] is not None:
        lock = {
            "peak_microstrain": r["locked_microstrain"],
            "peak_at": _iso(r["locked_peak_at"]),
            "locked_by": r["locked_by"],
            "locked_at": _iso(r["locked_at"]),
        }
    return {
        "span_code": r["span_code"],
        # 无办结读数时两项均为 None：调用方/前端不得据此写出峰值
        "peak_microstrain": r["peak_microstrain"],
        "peak_at": _iso(r["peak_at"]),
        "locked": lock is not None,
        "lock": lock,
    }


@app.get("/api/peak-wall")
async def peak_wall(request):
    if not _require_user(request):
        return sanic_json({"detail": "未登录"}, status=401)
    pool = request.app.ctx.pool
    async with pool.connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(_PEAK_SELECT, (DONE_STATUS,))
            rows = await cur.fetchall()
    return sanic_json([_serialize_peak_row(r) for r in rows])


@app.post("/api/peak-wall/locks")
async def lock_peak(request):
    user = _require_user(request)
    if not user:
        return sanic_json({"detail": "未登录"}, status=401)
    if user["role"] != "writer":
        # 复核岗只读，只看不能锁
        return sanic_json({"detail": "仅测量员可锁定峰值"}, status=403)

    body = request.json or {}
    span_code = str(body.get("span_code", "")).strip()
    if not span_code:
        return sanic_json({"detail": "跨段编号不能为空"}, status=400)

    pool = request.app.ctx.pool
    async with pool.connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                "SELECT 1 FROM peak_locks WHERE span_code = %s", (span_code,)
            )
            if await cur.fetchone():
                return sanic_json(
                    {"detail": "该跨段峰值已锁定，锁区数字定格不可更改"},
                    status=409,
                )

            # 用后台重算结果落锁：INSERT ... SELECT，峰值与时刻完全取自办结集合，
            # 请求体里即使伪造 peak_microstrain / peak_at 也会被忽略。
            await cur.execute(
                """
                INSERT INTO peak_locks
                    (span_code, peak_microstrain, peak_at, locked_by, locked_at)
                SELECT %s, r.microstrain, r.processed_at, %s, now()
                FROM strain_readings r
                WHERE r.span_code = %s AND r.status = %s
                ORDER BY r.microstrain DESC, r.processed_at ASC NULLS LAST, r.id ASC
                LIMIT 1
                ON CONFLICT (span_code) DO NOTHING
                RETURNING span_code, peak_microstrain, peak_at, locked_by, locked_at
                """,
                (span_code, user["username"], span_code, DONE_STATUS),
            )
            row = await cur.fetchone()
            if row is None:
                # 无办结集合可算，或并发下已被他人抢先锁定
                await cur.execute(
                    "SELECT 1 FROM peak_locks WHERE span_code = %s", (span_code,)
                )
                raced = await cur.fetchone()
                if raced:
                    return sanic_json(
                        {"detail": "该跨段峰值已被锁定"}, status=409
                    )
                return sanic_json(
                    {"detail": "该跨段尚无办结读数，不得锁定峰值"}, status=400
                )
        await conn.commit()

    return sanic_json(
        {
            "span_code": row["span_code"],
            "lock": {
                "peak_microstrain": row["peak_microstrain"],
                "peak_at": _iso(row["peak_at"]),
                "locked_by": row["locked_by"],
                "locked_at": _iso(row["locked_at"]),
            },
        },
        status=201,
    )
