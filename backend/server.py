"""HTTP server: WebRTC signalling for calls, REST for the dashboard, SSE for live updates.

Run:  python server.py   (serves the built dashboard too, if frontend/dist exists)
"""

from __future__ import annotations

import asyncio
import os
from contextlib import asynccontextmanager
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).parent / ".env", override=True)

import uvicorn  # noqa: E402
from fastapi import BackgroundTasks, FastAPI  # noqa: E402
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402
from fastapi.responses import StreamingResponse  # noqa: E402
from fastapi.staticfiles import StaticFiles  # noqa: E402
from loguru import logger  # noqa: E402
from pipecat.transports.smallwebrtc.connection import SmallWebRTCConnection  # noqa: E402
from pipecat.transports.smallwebrtc.request_handler import (  # noqa: E402
    SmallWebRTCPatchRequest,
    SmallWebRTCRequest,
    SmallWebRTCRequestHandler,
)

import store  # noqa: E402
from bot import run_bot  # noqa: E402
from events import bus  # noqa: E402

webrtc = SmallWebRTCRequestHandler()


@asynccontextmanager
async def lifespan(app: FastAPI):
    store.init_db(reset=not store.DB_PATH.exists())
    llm_key = "GROQ_API_KEY" if os.getenv("LLM_PROVIDER", "google").lower() == "groq" else "GOOGLE_API_KEY"
    missing = [k for k in ("ELEVENLABS_API_KEY", llm_key) if not os.getenv(k)]
    if missing:
        logger.warning(f"Missing {', '.join(missing)} in backend/.env; calls will fail until set.")
    yield
    await webrtc.close()


app = FastAPI(title="Larkspur voice desk", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


# ------------------------------------------------------------------ calls


@app.post("/api/offer")
async def offer(request: SmallWebRTCRequest, background_tasks: BackgroundTasks):
    """Browser sends an SDP offer; we answer and start a bot on that peer connection."""

    async def on_connection(connection: SmallWebRTCConnection):
        background_tasks.add_task(run_bot, connection)

    return await webrtc.handle_web_request(request=request, webrtc_connection_callback=on_connection)


@app.patch("/api/offer")
async def ice_candidate(request: SmallWebRTCPatchRequest):
    await webrtc.handle_patch_request(request)
    return {"status": "ok"}


# ------------------------------------------------------------------ dashboard data


@app.get("/api/doctors")
def doctors():
    return store.doctors_with_slots()


@app.get("/api/appointments")
def appointments():
    return store.list_appointments()


@app.post("/api/reset")
def reset():
    """Restore demo data (handy before recording)."""
    store.init_db(reset=True)
    bus.publish("reset", {})
    return {"ok": True}


@app.get("/api/events")
async def events():
    """Server-sent events: appointment_booked, appointment_cancelled, tool, reset."""
    q = bus.subscribe()

    async def stream():
        try:
            yield "retry: 2000\n\n"
            while True:
                try:
                    msg = await asyncio.wait_for(q.get(), timeout=15)
                    yield f"data: {msg}\n\n"
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
        finally:
            bus.unsubscribe(q)

    return StreamingResponse(
        stream(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}
    )


# Serve the built dashboard from the same origin when it exists.
DIST = Path(__file__).parent.parent / "frontend" / "dist"
if DIST.exists():
    app.mount("/", StaticFiles(directory=DIST, html=True), name="dashboard")


if __name__ == "__main__":
    uvicorn.run(app, host=os.getenv("HOST", "localhost"), port=int(os.getenv("PORT", "7860")))