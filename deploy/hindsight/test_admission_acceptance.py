"""Acceptance: with the model held busy, 24 calls wait their turn and none is refused.

Standard library only; the repository gate runs it with test_admission_queue.py. The
queue runs under today's budget rule with no activity reading, so one call at a time,
as by day. Each admitted call holds the model for a short real sleep, as a busy local
model would. The waiters tick every few milliseconds with the gateway's two callbacks
(a reading, a check that the caller is still there), so those run all through the drain.
"""
import asyncio
import itertools
import time
import unittest

from alfyai_admission_queue import AdmissionQueue, Ticket, admission_limit

HOLD_S = 0.02
TICK_S = 0.005
# The waits the app declares (MEMORY_ADMISSION_WAIT_MS) and the gateway's native default.
NATIVE_WAIT_S = 600.0
BACKGROUND_WAIT_S = 600.0
LIVE_WAIT_S = 120.0
T1, T2, T3 = "1" * 32, "2" * 32, "3" * 32  # three accounts' lanes


def native():
    return Ticket("background", "native", "native", NATIVE_WAIT_S)


def background(lane):
    return Ticket("background", "app", lane, BACKGROUND_WAIT_S)


def live(lane):
    return Ticket("interactive", "app", lane, LIVE_WAIT_S)


# Queued behind the call that holds the model, in this order: Hindsight's own calls (N),
# three accounts' background calls (A, B, C) and their live calls (L).
FIRST = (
    ("N1", native()), ("A1", background(T1)), ("N2", native()), ("A2", background(T1)),
    ("B1", background(T2)), ("L1", live(T1)), ("N3", native()), ("A3", background(T1)),
    ("C1", background(T3)), ("N4", native()), ("B2", background(T2)), ("L2", live(T2)),
    ("N5", native()), ("A4", background(T1)), ("N6", native()), ("B3", background(T2)),
    ("C2", background(T3)), ("N7", native()), ("L3", live(T3)), ("N8", native()),
)
# Live calls a person starts while the model works through the queue: each arrives once
# this many calls have been admitted, while the last of them holds the model.
LATER = {5: ("L4", live(T1)), 9: ("L5", live(T2)), 13: ("L6", live(T1)), 17: ("L7", live(T3))}
TICKETS = dict(FIRST) | dict(LATER.values())


class HeldBusyTests(unittest.IsolatedAsyncioTestCase):
    async def test_twenty_four_calls_behind_a_busy_model_all_get_their_turn(self):
        queue = AdmissionQueue(max_waiting=32, limit=lambda: admission_limit(None, time.time() * 1000))
        clock = itertools.count()
        arrived, admitted, order, tasks = {}, {}, [], []
        callbacks = {"refresh": 0, "abandoned": 0}

        async def refresh():
            callbacks["refresh"] += 1

        async def abandoned():
            callbacks["abandoned"] += 1
            return False

        async def call(name):
            arrived[name] = next(clock)
            await queue.acquire(TICKETS[name], abandoned=abandoned, refresh=refresh, tick_s=TICK_S)
            admitted[name] = next(clock)
            order.append(name)
            if len(order) in LATER:
                tasks.append(asyncio.create_task(call(LATER[len(order)][0])))
            await asyncio.sleep(HOLD_S)  # the model at work
            queue.release(round(HOLD_S * 1000))

        await queue.acquire(native())  # the model is busy before anything queues
        for name, _ in FIRST:
            tasks.append(asyncio.create_task(call(name)))
            await self.until(lambda name=name: name in arrived and queue.status()["waiting"] == len(arrived))
        self.assertEqual(queue.status()["waiting"], 20)
        queue.release()
        await self.until(lambda: len(order) == len(TICKETS), timeout_s=10)
        await asyncio.wait_for(asyncio.gather(*tasks), 1)  # no call raised: none was refused

        status = queue.status()
        self.assertEqual(
            {key: status[key] for key in ("rejected", "refused_full", "refused_wait", "waiting", "active", "peak")},
            {"rejected": 0, "refused_full": 0, "refused_wait": 0, "waiting": 0, "active": 0, "peak": 1},
        )
        self.assertEqual((status["completed"], status["waited"]), (25, 24))
        self.assertGreater(callbacks["refresh"], 0)
        self.assertGreater(callbacks["abandoned"], 0)

        def waiting_when(name, moment):
            return arrived[name] < moment < admitted[name]

        live_calls = [name for name in order if TICKETS[name].priority == "interactive"]
        background_calls = [name for name in order if TICKETS[name].priority == "background"]
        # Every live call goes before every background call still waiting when it arrived.
        for live_call in live_calls:
            for waiting in background_calls:
                if waiting_when(waiting, arrived[live_call]):
                    self.assertLess(admitted[live_call], admitted[waiting], f"{waiting} went before {live_call}")
        # Hindsight's own calls and the app's take turns while both wait.
        for before, after in zip(background_calls, background_calls[1:]):
            other = "app" if TICKETS[before].source == "native" else "native"
            if any(TICKETS[name].source == other and waiting_when(name, admitted[after]) for name in background_calls):
                self.assertEqual(TICKETS[after].source, other, f"{before} then {after} while the other source waited")
        # The accounts take turns, each in its own order, and Hindsight's own calls keep theirs.
        app_background = [name for name in background_calls if TICKETS[name].source == "app"]
        self.assertEqual(app_background, ["A1", "B1", "C1", "A2", "B2", "C2", "A3", "B3", "A4"])
        self.assertEqual([name for name in background_calls if name.startswith("N")], [f"N{n}" for n in range(1, 9)])
        for lane in (T1, T2, T3):
            mine = [name for name in live_calls if TICKETS[name].lane == lane]
            self.assertEqual(mine, sorted(mine, key=lambda name: arrived[name]))

    async def until(self, condition, timeout_s=1.0):
        deadline = asyncio.get_running_loop().time() + timeout_s
        while not condition():
            if asyncio.get_running_loop().time() > deadline:
                self.fail("the queue did not get there in time")
            await asyncio.sleep(0.001)


if __name__ == "__main__":
    unittest.main()
