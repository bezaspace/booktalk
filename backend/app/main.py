"""FastAPI app: PDF upload, per-page text extraction, Gemini ephemeral tokens."""
from __future__ import annotations

import datetime as dt
from typing import Optional

from fastapi import FastAPI, HTTPException, Query, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from google import genai
from google.genai import types as gtypes
from pydantic import BaseModel

from .config import get_settings
from .sessions import store


app = FastAPI(title="BookTalk", version="0.1.0")

settings = get_settings()

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------
class UploadResponse(BaseModel):
    session_id: str
    page_count: int


class PageResponse(BaseModel):
    page: int  # 1-based
    page_count: int
    text: str
    is_scanned: bool


class TokenResponse(BaseModel):
    token: str
    model: str
    expires_at: str  # ISO 8601


class OutlineItem(BaseModel):
    level: int  # 1 = top-level, nested deeper = higher number
    title: str
    page: int  # 1-based page number


class OutlineResponse(BaseModel):
    has_outline: bool
    items: list[OutlineItem]


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------
@app.get("/health")
async def health() -> dict:
    return {"ok": True}


@app.post("/upload", response_model=UploadResponse)
async def upload(file: UploadFile = File(...)) -> UploadResponse:
    """Accept a PDF, hold it in memory keyed by a session id."""
    if not file.filename or not file.filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Only PDF files are accepted.")

    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="Empty file.")

    try:
        session = store.add(data)
    except Exception as exc:  # PyMuPDF raises various errors on bad PDFs
        raise HTTPException(status_code=422, detail=f"Could not parse PDF: {exc}")

    return UploadResponse(session_id=session.session_id, page_count=session.page_count)


@app.get("/page", response_model=PageResponse)
async def get_page(
    session: str = Query(..., description="Session id from /upload"),
    page: int = Query(..., ge=1, description="1-based page number"),
) -> PageResponse:
    """Extract a single page's text with PyMuPDF.

    Empty/whitespace-only text signals a scanned or image-only page — the
    frontend will then render the canvas to JPEG and send it as a video frame
    to the Live session instead.
    """
    sess = store.get(session)
    if sess is None:
        raise HTTPException(status_code=404, detail="Unknown session.")

    if page > sess.page_count:
        raise HTTPException(status_code=400, detail="Page out of range.")

    # PyMuPDF is 0-indexed
    p = sess.doc.load_page(page - 1)
    text = p.get_text("text").strip()

    # Heuristic: a page with very little extractable text relative to its
    # area is almost certainly scanned/image-based. We also flag pure-empty
    # pages. The frontend uses is_scanned to decide text vs image injection.
    is_scanned = len(text) < 20

    return PageResponse(
        page=page,
        page_count=sess.page_count,
        text=text,
        is_scanned=is_scanned,
    )


@app.get("/outline", response_model=OutlineResponse)
async def get_outline(
    session: str = Query(..., description="Session id from /upload"),
) -> OutlineResponse:
    """Return the document's table of contents if present.

    Uses PyMuPDF's `doc.get_toc()` which parses the PDF's outline/bookmarks.
    Each entry is [level, title, page] where page is 1-based. If the PDF has
    no outline, returns `has_outline: false` and an empty list. The frontend
    falls back to the thumbnail strip in that case.
    """
    sess = store.get(session)
    if sess is None:
        raise HTTPException(status_code=404, detail="Unknown session.")

    try:
        raw_toc = sess.doc.get_toc(simple=True)  # list of [level, title, page, ...]
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Could not read outline: {exc}")

    items: list[OutlineItem] = []
    for entry in raw_toc:
        if len(entry) < 3:
            continue
        level, title, page = entry[0], entry[1], entry[2]
        # PyMuPDF levels are 1-based; ensure sane bounds.
        try:
            level_i = int(level)
            page_i = int(page)
            title_s = str(title).strip()
        except Exception:
            continue
        if not title_s:
            continue
        # Clamp page to valid range; outline pages are 1-based.
        page_i = max(1, min(page_i, sess.page_count))
        level_i = max(1, level_i)
        items.append(OutlineItem(level=level_i, title=title_s, page=page_i))

    return OutlineResponse(has_outline=len(items) > 0, items=items)


@app.get("/token", response_model=TokenResponse)
async def get_token() -> TokenResponse:
    """Mint and return a Gemini ephemeral token.

    The token is single-use (one Live session), expires in 30 minutes, and
    can only start a new session within `new_session_ttl_seconds` (default
    60s). The frontend uses it as the apiKey for `@google/genai` so the API
    key never reaches the browser.
    """
    if not settings.gemini_api_key:
        raise HTTPException(
            status_code=500,
            detail="GEMINI_API_KEY is not configured on the server.",
        )

    client = genai.Client(api_key=settings.gemini_api_key, http_options={"api_version": "v1alpha"})

    now = dt.datetime.now(dt.timezone.utc)
    expire_time = (now + dt.timedelta(seconds=settings.expire_ttl_seconds)).isoformat()
    new_session_expire_time = (
        now + dt.timedelta(seconds=settings.new_session_ttl_seconds)
    ).isoformat()

    # We do NOT lock the LiveConnectConfig here — the frontend supplies its
    # own config (audio modality, system instruction, transcription, context
    # compression, session resumption). The token just gates access.
    try:
        token = client.auth_tokens.create(
            config=gtypes.CreateAuthTokenConfig(
                uses=1,
                expire_time=expire_time,
                new_session_expire_time=new_session_expire_time,
            )
        )
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Token mint failed: {exc}")

    name: Optional[str] = getattr(token, "name", None)
    if not name:
        raise HTTPException(status_code=502, detail="Token response missing name.")

    return TokenResponse(
        token=name,
        model=settings.live_model,
        expires_at=expire_time,
    )
