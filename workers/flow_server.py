import asyncio
import json
import os
from contextlib import asynccontextmanager
from urllib.parse import urlparse

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response
import uvicorn
from flow_automation import FlowAutomation, FlowError

session = FlowAutomation()
lock = asyncio.Lock()


@asynccontextmanager
async def lifespan(app):
    try:
        await session.restore_session()
    except FlowError as error:
        session.last_error = f"[{error.code}] {error}"
    yield
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
    status = 401 if error.code == "COOKIE_EXPIRED" else 400 if error.code.startswith("INVALID_") else 409
    return JSONResponse({"error": str(error), "code": error.code, "stage": error.stage, "diagnostics": error.diagnostics}, status_code=status)


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
    return JSONResponse(session.health(), headers={"Cache-Control": "no-store"})


@app.post("/session")
async def initialize(request: Request):
    data = await payload(request)
    async with lock:
        session.project_url = str(data.get("projectUrl") or os.getenv("FLOW_PROJECT_URL", ""))
        result = await session.initialize_session(data.get("cookieJson"))
    return JSONResponse(result, headers={"Cache-Control": "no-store"})


@app.post("/generate")
async def generate(request: Request):
    data = await payload(request)
    async with lock:
        if session.state == "disconnected":
            session.project_url = str(data.get("projectUrl") or session.project_url)
            await session.restore_session()
        content, mime = await session.generate_image(data.get("prompt"), data.get("aspect", "16:9"))
    return Response(content, media_type=mime, headers={"Cache-Control": "no-store", "X-StoryFlow-Model": session.model})


@app.post("/disconnect")
async def disconnect():
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
