"""In-memory PDF session store.

A "session" here is just a short opaque id mapped to the bytes of an uploaded
PDF plus its page count. No persistence, no auth — this is an MVP for a single
user. The PDF is held in memory so per-page text extraction can happen on
demand without re-parsing the file each request.
"""
from __future__ import annotations

import threading
import uuid
from dataclasses import dataclass
from typing import Dict, Optional

import pymupdf  # PyMuPDF


@dataclass
class PdfSession:
    session_id: str
    doc: pymupdf.Document
    page_count: int


class SessionStore:
    """Thread-safe in-memory map of session_id -> PdfSession."""

    def __init__(self) -> None:
        self._sessions: Dict[str, PdfSession] = {}
        self._lock = threading.Lock()

    def add(self, data: bytes) -> PdfSession:
        """Parse PDF bytes, store under a fresh session id, and return it."""
        session_id = uuid.uuid4().hex
        doc = pymupdf.open(stream=data, filetype="pdf")
        session = PdfSession(
            session_id=session_id,
            doc=doc,
            page_count=doc.page_count,
        )
        with self._lock:
            self._sessions[session_id] = session
        return session

    def get(self, session_id: str) -> Optional[PdfSession]:
        with self._lock:
            return self._sessions.get(session_id)

    def remove(self, session_id: str) -> None:
        with self._lock:
            session = self._sessions.pop(session_id, None)
        if session is not None:
            session.doc.close()


# Module-level singleton — FastAPI dependency-free, single process.
store = SessionStore()
