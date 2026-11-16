"""`python -m speech_service`: the speech service, on the loopback address its settings name.

This is the one place that reads the environment (`Settings.from_env`). Nothing here, or in the
log it starts, ever holds a reply's text.
"""

from __future__ import annotations

import logging
import os

import httpx
import uvicorn

from speech_service.aligner import make_aligner
from speech_service.app import create_app
from speech_service.config import Settings
from speech_service.zonos import ZonosClient

# uvicorn waits for every open response to end before it stops the app, and a reading's streams
# stay open for as long as it is read: minutes. After this many seconds the ones still open are
# cut, which detaches their readers; then the app ends and cancels every session.
SHUTDOWN_GRACE_SECONDS = 5


def main() -> None:
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s"
    )
    logging.getLogger("httpx").setLevel(logging.WARNING)  # one line for each sentence Zonos speaks

    try:
        settings = Settings.from_env(os.environ)
    except ValueError as error:  # a setting that is wrong: say which, and stop
        raise SystemExit(f"speech-service: {error}") from None
    # The aligner loads now, before anything is served (the Python one takes a few seconds).
    aligner = make_aligner(settings)
    # Zonos is on loopback: whatever HTTP(S)_PROXY says, it is not reached through a proxy.
    http = httpx.AsyncClient(trust_env=False)
    app = create_app(settings, ZonosClient(settings.zonos_url, http), aligner)
    # "asyncio", not uvloop, which uvicorn picks when it is installed: the tests run on stock
    # asyncio, and uvloop fails differently on a dead pipe. Production runs the loop they exercised.
    uvicorn.run(
        app,
        host=settings.host,
        port=settings.port,
        loop="asyncio",
        timeout_graceful_shutdown=SHUTDOWN_GRACE_SECONDS,
    )


if __name__ == "__main__":
    main()
