import os
from datetime import datetime, timedelta, timezone

import jwt
from passlib.context import CryptContext
from sanic import Sanic
from sanic.response import json as sanic_json

from db import create_pool, ensure_schema, seed_if_empty

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


def _lock_payload(row) -> dict | None:
    if row is None or row["locked_microstrain"] is None:
        return None
    return {
        "peak_microstrain": row["locked_microstrain"],
        "peak_at": _iso(row["locked_peak_at"]),
        "locked_by": row["locked_by"],
        "locked_at": _iso(row["locked_at"]),
    }


@app.get("/api/peaks")
async def list_peaks(request):
    """峰值墙：服务端按办结集合（status='done'）当场重算各跨段峰值。

    无办结读数的跨段不会出现在结果里，也不会被写出峰值。
    """
    if not _require_user(request):
        return sanic_json({"detail": "未登录"}, status=401)
    pool = request.app.ctx.pool
    async with pool.connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                SELECT p.span_code, p.peak_microstrain, p.peak_at,
                       l.peak_microstrain AS locked_microstrain,
                       l.peak_at AS locked_peak_at,
                       l.locked_by, l.locked_at
                FROM (
                    SELECT DISTINCT ON (span_code)
                           span_code,
                           microstrain AS peak_microstrain,
                           processed_at AS peak_at
                    FROM strain_readings
                    WHERE status = 'done'
                    ORDER BY span_code, microstrain DESC, processed_at ASC, id ASC
                ) p
                LEFT JOIN peak_locks l ON l.span_code = p.span_code
                ORDER BY p.span_code
                """
            )
            rows = await cur.fetchall()
    out = []
    for r in rows:
        out.append(
            {
                "span_code": r["span_code"],
                "peak_microstrain": r["peak_microstrain"],
                "peak_at": _iso(r["peak_at"]),
                "locked": _lock_payload(r),
            }
        )
    return sanic_json(out)


@app.post("/api/peaks/lock")
async def lock_peak(request):
    """锁定峰值只读副本：服务端当场按办结集合重算峰值并抄入锁区。

    客户端只上送跨段编号，峰值与出现时刻一律由后台重算，
    不接受请求体里的任何峰值；已锁定的跨段定格不可改。
    """
    user = _require_user(request)
    if not user:
        return sanic_json({"detail": "未登录"}, status=401)
    if user["role"] != "writer":
        return sanic_json({"detail": "仅测量员可锁定峰值，复核岗只读"}, status=403)
    body = request.json or {}
    span_code = str(body.get("span_code", "")).strip()
    if not span_code:
        return sanic_json({"detail": "跨段编号不能为空"}, status=400)

    pool = request.app.ctx.pool
    async with pool.connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                SELECT microstrain, processed_at
                FROM strain_readings
                WHERE status = 'done' AND span_code = %s
                ORDER BY microstrain DESC, processed_at ASC, id ASC
                LIMIT 1
                """,
                (span_code,),
            )
            peak = await cur.fetchone()
            if not peak:
                return sanic_json(
                    {"detail": "该跨段暂无办结读数，无峰值可锁"}, status=400
                )
            await cur.execute(
                """
                INSERT INTO peak_locks
                    (span_code, peak_microstrain, peak_at, locked_by, locked_at)
                VALUES (%s, %s, %s, %s, now())
                ON CONFLICT (span_code) DO NOTHING
                RETURNING span_code, peak_microstrain, peak_at, locked_by, locked_at
                """,
                (
                    span_code,
                    peak["microstrain"],
                    peak["processed_at"],
                    user["username"],
                ),
            )
            row = await cur.fetchone()
            if not row:
                return sanic_json(
                    {"detail": "该跨段已锁定，锁定副本只读不可改"}, status=409
                )
        await conn.commit()

    return sanic_json(
        {
            "span_code": row["span_code"],
            "locked": {
                "peak_microstrain": row["peak_microstrain"],
                "peak_at": _iso(row["peak_at"]),
                "locked_by": row["locked_by"],
                "locked_at": _iso(row["locked_at"]),
            },
            "message": "已锁定当前峰值只读副本",
        },
        status=201,
    )
