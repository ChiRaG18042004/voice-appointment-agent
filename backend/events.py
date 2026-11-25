"""Tiny in-process pub/sub so the dashboard sees bookings the moment they happen.

Tool handlers call `bus.publish(...)`; every open `/api/events` SSE stream
gets its own queue.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any


class EventBus:
    def __init__(self) -> None:
        self._subscribers: set[asyncio.Queue[str]] = set()

    def subscribe(self) -> asyncio.Queue[str]:
        q: asyncio.Queue[str] = asyncio.Queue(maxsize=100)
        self._subscribers.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue[str]) -> None:
        self._subscribers.discard(q)

    def publish(self, event: str, data: dict[str, Any]) -> None:
        payload = json.dumps({"type": event, "data": data})
        for q in list(self._subscribers):
            try:
                q.put_nowait(payload)
            except asyncio.QueueFull:
                pass  # a stalled browser tab shouldn't block the call


bus = EventBus()
