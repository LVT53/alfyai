"""What the service may say about an error in its logs: no reply text, ever."""

from __future__ import annotations

import traceback
from pathlib import PurePath


def describe(error: BaseException) -> str:
    """What to log of an error: its type and where it was raised. Never its message, which may
    quote the reply, nor its traceback."""
    frames = traceback.extract_tb(error.__traceback__)
    where = f" at {PurePath(frames[-1].filename).name}:{frames[-1].lineno}" if frames else ""
    return f"{type(error).__name__}{where}"
