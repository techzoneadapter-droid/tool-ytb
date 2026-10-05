import asyncio
import json
import os
from contextlib import asynccontextmanager
from contextlib import suppress
from urllib.parse import urlparse

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response
import uvicorn
from flow_automation import FlowAutomation, FlowError

session = FlowAutomation()
generation_lock = asyncio.Lock()
lock = generation_lock
restore_task: asyncio.Task | None = None
restore_error: FlowError | None = None


async def capture_restore_failure():
    if os.getenv("FLOW_DEBUG") != "1" or session.page is None:
        return
    try:
        await session._debug_snapshot("restore")
        if session.debug_directory:
            (session.debug_directory / "state.json").write_text(json.dumps(session.health(), ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception:
        pass


async def restore_in_background():
    global restore_error
    async with generation_lock:
        try:
            timeout = max(0.1, float(os.getenv("FLOW_RESTORE_TIMEOUT_MS", "180000")) / 1000)
            await asyncio.wait_for(session.restore_session(), timeout)
            if not session.generation_ready:
                await capture_restore_failure()
        except asyncio.CancelledError:
            await session.close()
            raise
        except Exception as cause:
            error = cause if isinstance(cause, FlowError) else FlowError(
                "FLOW_SESSION_RESTORE_FAILED", "Không khôi phục được phiên Flow.", stage=session.last_stage)
            await capture_restore_failure()
            await session.close()
            restore_error = error
            session.state = "login_required" if error.code in ("FLOW_COOKIE_EXPIRED", "FLOW_LOGIN_REQUIRED") else "error"
            session.last_error = f"[{error.code}] {error}"
            session.last_stage = error.stage


def ensure_restore_started():
    global restore_task, restore_error
    if restore_task is not None or session.generation_ready:
        return restore_task
    if not session.cookie_file.is_file():
        session.state = "disconnected"
        return None
    restore_error = None
    session.state = "restoring"
    session.last_stage = "FLOW_SESSION_RESTORE"
    restore_task = asyncio.create_task(restore_in_background(), name="flow-session-restore")
    return restore_task


async def cancel_restore():
    global restore_task, restore_error
    if restore_task is not None and not restore_task.done():
        restore_task.cancel()
        with suppress(asyncio.CancelledError):
            await restore_task
    restore_task = None
    restore_error = None


async def wait_until_generation_ready():
    task = ensure_restore_started()
    if task is not None and not task.done():
        timeout = max(0.1, float(os.getenv("FLOW_RESTORE_TIMEOUT_MS", "180000")) / 1000)
        try:
            await asyncio.wait_for(asyncio.shield(task), timeout)
        except asyncio.TimeoutError:
            raise FlowError("FLOW_SESSION_RESTORE_FAILED", "Hết thời gian chờ khôi phục phiên Flow.", stage=session.last_stage) from None
    if restore_error is not None:
        raise restore_error
    if session.generation_ready:
        return
    if session.state == "disconnected":
        raise FlowError("FLOW_LOGIN_REQUIRED", "Chưa có cookie để khôi phục phiên Flow.", stage="FLOW_SESSION_RESTORE")
    code = "FLOW_LOGIN_REQUIRED" if session.state in ("disconnected", "login_required") else "FLOW_PROJECT_INVALID" if session.state == "project_required" else "FLOW_COMPOSER_NOT_FOUND"
    if session.last_error.startswith("["):
        code = session.last_error.split("]", 1)[0][1:]
    raise FlowError(code, session.last_error or "Phiên Flow chưa sẵn sàng tạo ảnh.", stage=session.last_stage)


@asynccontextmanager
async def lifespan(app):
    ensure_restore_started()
    yield
    await cancel_restore()
    async with lock:
        await session.close()


app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)


@app.middleware("http")
async def local_only(request: Request, call_next):
    if request.headers.get("origin") or request.headers.get("sec-fetch-site") not in (None, "none"):
        return JSONResponse({"error": "Chỉ ứng dụng cục bộ được truy cập Flow Worker."}, status_code=403)
    return await call_next(request)


@app.exception_handler(FlowError)
async def flow_error(request, error):
    status = 401 if error.code in ("FLOW_COOKIE_EXPIRED", "FLOW_LOGIN_REQUIRED") else 400 if error.code.startswith("INVALID_") else 409
    return JSONResponse({"error": str(error), "message": str(error), "code": error.code, "stage": error.stage, "diagnostics": error.diagnostics, "requestId": getattr(request.state, "flow_request_id", None), "chapterId": getattr(request.state, "flow_chapter_id", None)}, status_code=status)


async def payload(request):
    # Stream limit, including chunked bodies; never log cookie payloads.
    raw = bytearray()
    async for part in request.stream():
        raw.extend(part)
        if len(raw) > 1200000:
            raise FlowError("INVALID_REQUEST", "Yêu cầu quá lớn.")
    try:
        value = json.loads(raw)
    except (ValueError, UnicodeError):
        raise FlowError("INVALID_REQUEST", "JSON yêu cầu không hợp lệ.") from None
    if not isinstance(value, dict):
        raise FlowError("INVALID_REQUEST", "Yêu cầu phải là đối tượng JSON.")
    return value


@app.get("/health")
async def health():
    result = session.health()
    result["backgroundRestore"] = True
    result["lastGeneration"] = {"requestId": getattr(session, "current_request_id", None), "networkGenerationCount": getattr(session, "generation_request_count", 0), "submitCount": len(session.flow_diagnostics.get("attempts", [])), "networkPosts": getattr(session, "network_posts", [])}
    result["lastErrorCode"] = restore_error.code if restore_error else (session.last_error.split("]", 1)[0][1:] if session.last_error.startswith("[") else None)
    return JSONResponse(result, headers={"Cache-Control": "no-store"})


@app.post("/session")
async def initialize(request: Request):
    data = await payload(request)
    await cancel_restore()
    async with lock:
        session.project_url = str(data.get("projectUrl") or os.getenv("FLOW_PROJECT_URL", ""))
        result = await session.initialize_session(data.get("cookieJson"))
    return JSONResponse(result, headers={"Cache-Control": "no-store"})


@app.post("/generate")
async def generate(request: Request):
    data = await payload(request)
    request.state.flow_request_id = data.get("requestId")
    request.state.flow_chapter_id = data.get("chapterId")
    if not session.project_url and restore_task is None:
        session.project_url = str(data.get("projectUrl") or "")
    await wait_until_generation_ready()
    async with lock:
        session.current_request_id = data.get("requestId")
        session.current_project_id = data.get("projectId")
        session.current_chapter_id = data.get("chapterId")
        if not session.generation_ready:
            raise FlowError("FLOW_LOGIN_REQUIRED", "Phiên Flow đã đóng trong lúc chờ generation.", stage=session.last_stage)
        content, mime = await session.generate_image(data.get("prompt"), data.get("aspect", "16:9"))
    return Response(content, media_type=mime, headers={"Cache-Control": "no-store", "X-StoryFlow-Model": session.observed_model or "project-current", "X-StoryFlow-Request": str(data.get("requestId") or ""), "X-StoryFlow-Chapter": str(data.get("chapterId") or ""), "X-StoryFlow-Generation-Count": str(getattr(session, "generation_request_count", 0)), "X-StoryFlow-Image-Count": str(getattr(session, "image_count", 0)), "X-StoryFlow-Submit-Count": str(len(session.flow_diagnostics.get("attempts", [])))})


@app.post("/disconnect")
async def disconnect():
    await cancel_restore()
    async with lock:
        try:
            session.cookie_file.unlink(missing_ok=True)
        except OSError:
            raise FlowError("COOKIE_FILE_DELETE", "Cannot remove the saved cookie file; disconnect was not completed.") from None
        await session.close()
    return session.health()


if __name__ == "__main__":
    port = urlparse(os.getenv("FLOW_BRIDGE_URL", "http://127.0.0.1:7865")).port or 7865
    uvicorn.run(app, host="127.0.0.1", port=port, access_log=False)
