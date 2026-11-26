"""A bounded, fair queue for the memory model's calls. Standard library only.

Hindsight's own model calls and the app's memory calls reach the one private model
through the admission gateway (alfyai_admission.py), which asks this queue first. A
call within the budget goes on at once. A call over it waits here until a slot frees,
and leaves when its wait runs out, when its caller gives up, or at once when the queue
is already full.

Order: every interactive waiter goes before any background one. Within a priority, the
sources with waiters take turns (Hindsight's own calls, "native", and the app's, "app").
Within a source, the lanes take turns: one lane per account, and all of Hindsight's own
calls share the lane "native". One lane keeps its order. A lane that gets its first
waiter joins the end of its turn. A source that gets its first waiter goes before every
source that had a turn since its own last one, so a source whose calls come one at a
time (Hindsight's: its next call waits for its last) still gets every other turn.

Nothing is persisted: the queue lives in the memory of the one Hindsight process and is
lost with it. One event loop owns a queue; it is not thread-safe.
"""
import asyncio
import re
import time
from collections import OrderedDict, deque
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass

PRIORITIES = ("interactive", "background")
SOURCES = ("native", "app")
REFUSAL_REASONS = ("queue_full", "wait_exceeded")

PRIORITY_HEADER = "X-AlfyAI-Admission-Priority"
LANE_HEADER = "X-AlfyAI-Admission-Lane"
WAIT_HEADER = "X-AlfyAI-Admission-Wait-Ms"

DAYTIME_LIMIT = 1
OVERNIGHT_LIMIT = 6
FRESH_READING_MS = 2000

_LANE = re.compile(r"[0-9a-f]{1,64}")
# Longer than this is a wait far over any cap, so it is capped like one.
_WAIT_MS = re.compile(r"[0-9]{1,18}")
_WHOLE = re.compile(r"[0-9]{1,9}")


def admission_limit(signal, now_ms):
    """How many calls may run at once under an activity reading, at wall-clock `now_ms`.

    Six only for a reading taken at most two seconds before `now_ms` that is healthy,
    idle and inactive, each field exactly its JSON value. One for anything else, an
    unknown, failed or stale reading included.
    """
    if not isinstance(signal, dict):
        return DAYTIME_LIMIT
    observed = signal.get("observedAt")
    fresh = (
        isinstance(observed, (int, float))
        and not isinstance(observed, bool)
        and 0 <= now_ms - observed <= FRESH_READING_MS
    )
    if (
        fresh
        and signal.get("healthy") is True
        and signal.get("idle") is True
        and signal.get("active") is False
    ):
        return OVERNIGHT_LIMIT
    return DAYTIME_LIMIT


class AdmissionRefused(Exception):
    """A call the queue will not admit: `reason` is "queue_full" or "wait_exceeded"."""

    def __init__(self, reason):
        if reason not in REFUSAL_REASONS:
            raise ValueError(f"unknown refusal reason {reason!r}")
        super().__init__(reason)
        self.reason = reason


@dataclass(frozen=True)
class Ticket:
    """What a call declared: its priority, its source, its lane and its longest wait."""

    priority: str
    source: str
    lane: str
    max_wait_s: float

    def __post_init__(self):
        if self.priority not in PRIORITIES or self.source not in SOURCES:
            raise ValueError("unknown admission priority or source")
        if not isinstance(self.lane, str) or not self.lane:
            raise ValueError("an admission lane is a name")
        if (
            isinstance(self.max_wait_s, bool)
            or not isinstance(self.max_wait_s, (int, float))
            or not self.max_wait_s >= 0
        ):
            raise ValueError("an admission wait is zero or more seconds")


def ticket_from_headers(headers: Mapping[str, str], *, native_wait_s: float, max_wait_s: float) -> Ticket:
    """The ticket a call declares in its headers, whose names may come in any case.

    A call without the priority header is Hindsight's own: background, source and lane
    "native", waiting at most `native_wait_s`. Any other call is the app's: an unknown
    priority is background, a lane that is not 1 to 64 lowercase hex characters is the
    shared lane "app", and a wait that is not a whole number of milliseconds is the
    longest. No wait is longer than `max_wait_s`.
    """
    declared = {}
    for name, value in headers.items():
        declared.setdefault(name.lower(), value)
    priority = declared.get(PRIORITY_HEADER.lower())
    if priority is None:
        return Ticket("background", "native", "native", min(native_wait_s, max_wait_s))
    if priority not in PRIORITIES:
        priority = "background"
    lane = declared.get(LANE_HEADER.lower())
    if lane is None or not _LANE.fullmatch(lane):
        lane = "app"
    wait = declared.get(WAIT_HEADER.lower())
    wait_s = int(wait) / 1000 if wait is not None and _WAIT_MS.fullmatch(wait) else max_wait_s
    return Ticket(priority, "app", lane, min(wait_s, max_wait_s))


@dataclass(frozen=True)
class AdmissionSettings:
    """The queue's bounds: how many calls may wait, and for how long."""

    max_waiting: int = 32
    max_wait_s: float = 900
    native_wait_s: float = 600


def admission_settings(config: Mapping[str, object]) -> AdmissionSettings:
    """The bounds from the extension config (environment `HINDSIGHT_API_HTTP_<KEY>`).

    `admission_max_waiting`: calls that may wait, 0 to 1024; at 0 a call over the budget
    is refused at once. `admission_max_wait_s`: the longest any call waits, whatever it
    declares, 1 to 86400 seconds. `admission_native_wait_s`: how long Hindsight's own
    calls wait, 1 to 86400 seconds. Unset or empty is the default; any other value that
    is not a whole number in range raises ValueError.
    """
    default = AdmissionSettings()
    return AdmissionSettings(
        max_waiting=_whole_number(config, "admission_max_waiting", default.max_waiting, 0, 1024),
        max_wait_s=_whole_number(config, "admission_max_wait_s", default.max_wait_s, 1, 86400),
        native_wait_s=_whole_number(config, "admission_native_wait_s", default.native_wait_s, 1, 86400),
    )


def _whole_number(config, key, default, low, high):
    value = config.get(key)
    if isinstance(value, str):
        value = value.strip()
        if not value:
            return default
        value = int(value) if _WHOLE.fullmatch(value) else None
    elif value is None:
        return default
    if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
        raise ValueError(f"HINDSIGHT_API_HTTP_{key.upper()} must be a whole number from {low} to {high}")
    return value


class _Waiter:
    __slots__ = ("ticket", "future", "joined")

    def __init__(self, ticket, future, joined):
        self.ticket = ticket
        self.future = future
        self.joined = joined


class AdmissionQueue:
    """Lets up to `limit()` calls run at once; the others wait in fair order.

    `limit` is asked whenever a call could be admitted, so a waiter admitted later runs
    under the limit of that moment. `clock` measures waits and deadlines, in seconds.
    """

    def __init__(
        self,
        *,
        max_waiting: int,
        limit: Callable[[], int],
        clock: Callable[[], float] = time.monotonic,
    ):
        if isinstance(max_waiting, bool) or not isinstance(max_waiting, int) or max_waiting < 0:
            raise ValueError("max_waiting is a whole number of calls")
        self._max_waiting = max_waiting
        self._limit = limit
        self._clock = clock
        # Per priority, the sources that have waiters, in turn order.
        self._turns = {priority: deque() for priority in PRIORITIES}
        # Per priority, the turn each source last had, counted across the queue.
        self._last_turn = {priority: {} for priority in PRIORITIES}
        self._turns_taken = 0
        # Per priority and source, the lanes that have waiters, in turn order; each lane in arrival order.
        self._lanes = {(priority, source): OrderedDict() for priority in PRIORITIES for source in SOURCES}
        self._waiting = 0
        self._active = 0
        self._peak = 0
        self._completed = 0
        self._duration_ms = 0
        self._refused_full = 0
        self._refused_wait = 0
        self._waited = 0
        self._wait_ms = 0
        self._max_wait_ms = 0
        self._abandoned = 0

    async def acquire(
        self,
        ticket: Ticket,
        *,
        abandoned: Callable[[], Awaitable[bool]] | None = None,
        refresh: Callable[[], Awaitable[None]] | None = None,
        tick_s: float = 1.0,
    ) -> None:
        """Return once the call may run; it then holds a slot until `release()`.

        Raises AdmissionRefused("queue_full") at once when `max_waiting` calls already
        wait, and AdmissionRefused("wait_exceeded") once the call has waited
        `ticket.max_wait_s`. While it waits, every `tick_s` it awaits `refresh()`, admits
        whoever the limit now allows, then asks `abandoned()`: True means its caller is
        gone, and it leaves with asyncio.CancelledError. A waiter is also asked once more
        when it is admitted, so a caller that left between two ticks never gets the slot.
        A waiter that leaves for any reason (refused, abandoned, cancelled, a callback that
        raised) is never admitted later; one admitted in the moment it left gives its slot
        to the next.
        """
        if not isinstance(ticket, Ticket):
            raise TypeError("acquire takes a Ticket")
        if not tick_s > 0:
            raise ValueError("tick_s is a positive number of seconds")
        # A limit that rose since the last tick goes to the calls already waiting, in order.
        self.dispatch()
        if self._waiting == 0 and self._active < self._limit():
            self._take_slot()
            return
        if self._waiting >= self._max_waiting:
            self._refused_full += 1
            raise AdmissionRefused("queue_full")
        waiter = _Waiter(ticket, asyncio.get_running_loop().create_future(), self._clock())
        self._join(waiter)
        deadline = waiter.joined + ticket.max_wait_s
        admitted = False
        try:
            while True:
                remaining = deadline - self._clock()
                try:
                    await asyncio.wait_for(
                        asyncio.shield(waiter.future), timeout=max(0.0, min(tick_s, remaining))
                    )
                except TimeoutError:
                    pass
                if waiter.future.done():
                    # Admitted while it slept: its caller may have left since the last tick.
                    await self._still_wanted(abandoned)
                    admitted = True
                    return
                if refresh is not None:
                    await refresh()
                self.dispatch()
                await self._still_wanted(abandoned)
                if waiter.future.done():
                    admitted = True
                    return
                if self._clock() >= deadline:
                    self._refused_wait += 1
                    raise AdmissionRefused("wait_exceeded")
        finally:
            if not admitted:
                self._leave(waiter)

    async def _still_wanted(self, abandoned):
        """Leaves with asyncio.CancelledError when the caller is gone, counting it."""
        if abandoned is not None and await abandoned():
            self._abandoned += 1
            raise asyncio.CancelledError()

    def release(self, elapsed_ms: int = 0) -> None:
        """Give back the slot of an admitted call that ran `elapsed_ms`; the next waiter goes on."""
        if self._active <= 0:
            raise RuntimeError("release without an admitted call")
        self._active -= 1
        self._completed += 1
        self._duration_ms += elapsed_ms
        self.dispatch()

    def dispatch(self) -> None:
        """Admit waiters in fair order while fewer than `limit()` calls run."""
        while self._waiting and self._active < self._limit():
            waiter = self._next()
            if waiter.future.done():
                continue  # never admitted: its future was cancelled under it
            self._record_wait(waiter)
            self._take_slot()
            waiter.future.set_result(None)

    def status(self) -> dict:
        """Counters since the process started; `rejected` is both refusals together.

        `abandoned` counts the callers that left before their call went on: while they
        waited, or as they were admitted. Not a refusal, but a sign that a caller's own
        timeout is shorter than the wait it was given.
        """
        return {
            "active": self._active,
            "peak": self._peak,
            "waiting": self._waiting,
            "completed": self._completed,
            "duration_ms": self._duration_ms,
            "rejected": self._refused_full + self._refused_wait,
            "refused_full": self._refused_full,
            "refused_wait": self._refused_wait,
            "waited": self._waited,
            "wait_ms": self._wait_ms,
            "max_wait_ms": self._max_wait_ms,
            "abandoned": self._abandoned,
        }

    def _take_slot(self):
        self._active += 1
        self._peak = max(self._peak, self._active)

    def _record_wait(self, waiter):
        wait_ms = max(0, round((self._clock() - waiter.joined) * 1000))
        self._waited += 1
        self._wait_ms += wait_ms
        self._max_wait_ms = max(self._max_wait_ms, wait_ms)

    def _join(self, waiter):
        ticket = waiter.ticket
        lanes = self._lanes[ticket.priority, ticket.source]
        if not lanes:
            # Before every source that had a turn since this one last had one.
            turns = self._turns[ticket.priority]
            last_turn = self._last_turn[ticket.priority]
            own = last_turn.get(ticket.source, 0)
            place = next(
                (index for index, other in enumerate(turns) if last_turn.get(other, 0) > own),
                len(turns),
            )
            turns.insert(place, ticket.source)
        lane = lanes.get(ticket.lane)
        if lane is None:
            lane = lanes[ticket.lane] = deque()
        lane.append(waiter)
        self._waiting += 1

    def _next(self):
        """Take the waiter whose turn it is out of the queue."""
        for priority in PRIORITIES:
            turns = self._turns[priority]
            if not turns:
                continue
            source = turns.popleft()
            self._turns_taken += 1
            self._last_turn[priority][source] = self._turns_taken
            lanes = self._lanes[priority, source]
            name, lane = next(iter(lanes.items()))
            waiter = lane.popleft()
            if lane:
                lanes.move_to_end(name)
            else:
                del lanes[name]
            if lanes:
                turns.append(source)
            self._waiting -= 1
            return waiter
        raise RuntimeError("no waiter to take")

    def _remove(self, waiter):
        ticket = waiter.ticket
        lanes = self._lanes[ticket.priority, ticket.source]
        lane = lanes.get(ticket.lane)
        if lane is None or waiter not in lane:
            return False
        lane.remove(waiter)
        self._waiting -= 1
        if not lane:
            del lanes[ticket.lane]
            if not lanes:
                self._turns[ticket.priority].remove(ticket.source)
        return True

    def _leave(self, waiter):
        """A waiter that will not run: out of the queue, or its slot to the next if it was just admitted."""
        if self._remove(waiter):
            self._record_wait(waiter)
        elif waiter.future.done() and not waiter.future.cancelled():
            self._active -= 1
            self.dispatch()
