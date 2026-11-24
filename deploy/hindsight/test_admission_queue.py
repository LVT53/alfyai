"""The admission queue: its budget rule, its order, its bounds, and what leaving does.

Standard library only. The repository gate runs this file on the Mac with plain
`python3` (scripts/gates.mjs, step `python`), where nothing of the pinned Hindsight
image is installed.
"""
import asyncio
import unittest

from alfyai_admission_queue import (
    PRIORITIES,
    SOURCES,
    AdmissionQueue,
    AdmissionRefused,
    AdmissionSettings,
    Ticket,
    admission_limit,
    admission_settings,
    ticket_from_headers,
)

# A wall-clock instant in milliseconds, the way the app's activity endpoint stamps `observedAt`.
NOW_MS = 1_790_000_000_000
IDLE = {"idle": True, "active": False, "healthy": True, "observedAt": NOW_MS}
# Every reading the budget treats as unknown or busy (BudgetTests in test_admission.py had them all).
NOT_IDLE = (
    None,
    {},
    {"idle": True},
    {"idle": True, "active": False, "healthy": True, "observedAt": 0},
    {"idle": True, "active": False, "healthy": False, "observedAt": NOW_MS},
    {"idle": True, "active": "false"},
    {"idle": False, "active": False},
)
NATIVE = Ticket("background", "native", "native", 600.0)
TICK_S = 0.005


def app(lane, priority="background", wait_s=600.0):
    return Ticket(priority, "app", lane, wait_s)


class FakeClock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now


async def until(condition, timeout_s=1.0):
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout_s
    while not condition():
        if loop.time() > deadline:
            raise AssertionError("the queue did not get there in time")
        await asyncio.sleep(0.001)


async def settled(awaitable, timeout_s=1.0):
    """Await a call that must end soon: one the queue keeps fails the test instead of hanging it."""
    return await asyncio.wait_for(awaitable, timeout_s)


class Calls:
    """Calls into one queue, each recording its name when it is admitted."""

    def __init__(self, queue, tick_s=TICK_S):
        self.queue = queue
        self.tick_s = tick_s
        self.admitted = []

    async def start(self, name, ticket, **options):
        """Start a call; return its task once it waits, was admitted or was refused."""
        waiting = self.queue.status()["waiting"]
        task = asyncio.create_task(self._call(name, ticket, options))
        await until(
            lambda: task.done() or name in self.admitted or self.queue.status()["waiting"] > waiting
        )
        return task

    async def _call(self, name, ticket, options):
        await self.queue.acquire(ticket, tick_s=self.tick_s, **options)
        self.admitted.append(name)

    async def finish_one(self):
        """Release one admitted call and wait until the next one is admitted."""
        admitted = len(self.admitted)
        self.queue.release()
        await until(lambda: len(self.admitted) > admitted)


class BudgetRuleTests(unittest.TestCase):
    """Today's rule, kept as it was: six only for a fresh, healthy, idle, inactive reading."""

    def test_defaults_and_unknown_activity_are_one(self):
        for signal in (*NOT_IDLE, [], "idle"):
            with self.subTest(signal=signal):
                self.assertEqual(admission_limit(signal, NOW_MS), 1)

    def test_explicit_idle_is_six_and_foreground_is_one(self):
        self.assertEqual(admission_limit(IDLE, NOW_MS), 6)
        self.assertEqual(admission_limit({"idle": True, "active": True}, NOW_MS), 1)
        self.assertEqual(admission_limit({**IDLE, "active": True}, NOW_MS), 1)

    def test_a_reading_is_fresh_for_two_seconds_and_never_from_the_future(self):
        self.assertEqual(admission_limit(IDLE, NOW_MS + 2000), 6)
        self.assertEqual(admission_limit(IDLE, NOW_MS + 2000.5), 1)
        self.assertEqual(admission_limit(IDLE, NOW_MS - 1), 1)

    def test_every_field_must_be_exactly_its_json_value(self):
        for key, value in (
            ("healthy", 1),
            ("idle", "true"),
            ("active", 0),
            ("active", None),
            ("observedAt", str(NOW_MS)),
            ("observedAt", None),
            ("observedAt", float("nan")),
        ):
            with self.subTest(key=key, value=value):
                self.assertEqual(admission_limit({**IDLE, key: value}, NOW_MS), 1)
        # JSON `true` is not a time, even a second after the epoch.
        self.assertEqual(admission_limit({**IDLE, "observedAt": True}, 1000), 1)


class BudgetInTheQueueTests(unittest.IsolatedAsyncioTestCase):
    """BudgetTests' cases through the queue: where the budget refused, the call now waits."""

    async def test_unknown_activity_admits_one_and_the_next_waits_for_it(self):
        for signal in NOT_IDLE:
            with self.subTest(signal=signal):
                queue = AdmissionQueue(
                    max_waiting=4, limit=lambda signal=signal: admission_limit(signal, NOW_MS)
                )
                calls = Calls(queue)
                await calls.start("first", NATIVE)
                second = await calls.start("second", NATIVE)
                self.assertEqual(calls.admitted, ["first"])
                self.assertFalse(second.done())
                await calls.finish_one()
                self.assertEqual(calls.admitted, ["first", "second"])
                queue.release()
                self.assertEqual(queue.status()["rejected"], 0)

    async def test_explicit_idle_admits_six_then_foreground_downshifts_without_cancelling(self):
        signal = dict(IDLE)
        queue = AdmissionQueue(max_waiting=4, limit=lambda: admission_limit(signal, NOW_MS))
        calls = Calls(queue)
        for number in range(6):
            await calls.start(f"overnight-{number}", NATIVE)
        self.assertEqual(len(calls.admitted), 6)
        seventh = await calls.start("seventh", NATIVE)
        signal["active"] = True  # someone starts chatting
        for _ in range(5):
            queue.release()
            await asyncio.sleep(4 * TICK_S)
            self.assertFalse(seventh.done())
        await calls.finish_one()
        self.assertEqual(calls.admitted[-1], "seventh")
        status = queue.status()
        # The six already admitted finished on their own; none was cancelled.
        self.assertEqual((status["peak"], status["completed"], status["rejected"]), (6, 6, 0))


class LimitAtAdmissionTests(unittest.IsolatedAsyncioTestCase):
    """A waiter is admitted under the limit of the moment it is admitted, not the one it arrived with."""

    async def test_a_waiter_admitted_after_the_reading_went_stale_gets_the_daytime_limit(self):
        now_ms = [NOW_MS]
        queue = AdmissionQueue(max_waiting=4, limit=lambda: admission_limit(IDLE, now_ms[0]))
        calls = Calls(queue)
        for number in range(6):
            await calls.start(f"overnight-{number}", NATIVE)
        seventh = await calls.start("seventh", NATIVE)
        now_ms[0] = NOW_MS + 2001  # no fresh reading since: the budget is one again
        for _ in range(5):
            queue.release()
            await asyncio.sleep(4 * TICK_S)
            self.assertFalse(seventh.done())
        await calls.finish_one()
        self.assertEqual(calls.admitted[-1], "seventh")
        self.assertEqual(queue.status()["active"], 1)

    async def test_a_reading_taken_while_calls_wait_admits_them_at_their_next_tick(self):
        reading = [{"idle": True, "active": True}]
        taken = []

        async def refresh():
            if taken:
                reading[0] = taken[-1]

        # The queue's own admission order. The order the calls record themselves in is
        # not it: the waiter whose tick took the reading returns at once, and the
        # others wake later in whatever order the event loop runs them.
        names, dispatched = {}, []

        class RecordingQueue(AdmissionQueue):
            def _record_wait(self, waiter):
                super()._record_wait(waiter)
                dispatched.append(names[id(waiter.ticket)])

        queue = RecordingQueue(max_waiting=4, limit=lambda: admission_limit(reading[0], NOW_MS))
        calls = Calls(queue)
        await calls.start("live", app("aa", "interactive"))
        for name in ("n1", "n2", "n3"):
            ticket = Ticket("background", "native", "native", 600.0)  # one per call
            names[id(ticket)] = name
            await calls.start(name, ticket, refresh=refresh)
        self.assertEqual(calls.admitted, ["live"])
        taken.append(IDLE)  # the next reading says the household is idle
        await until(lambda: len(calls.admitted) == 4)  # no call finished in between
        self.assertEqual(dispatched, ["n1", "n2", "n3"])
        self.assertEqual(calls.admitted[0], "live")
        self.assertCountEqual(calls.admitted[1:], ["n1", "n2", "n3"])
        self.assertEqual(queue.status()["active"], 4)


class WaitingTests(unittest.IsolatedAsyncioTestCase):
    async def test_a_call_over_the_budget_waits_for_the_slot_instead_of_being_refused(self):
        clock = FakeClock()
        queue = AdmissionQueue(max_waiting=4, limit=lambda: 1, clock=clock)
        calls = Calls(queue)
        await calls.start("busy", NATIVE)
        waiter = await calls.start("waiter", app("ab"))
        await asyncio.sleep(4 * TICK_S)
        self.assertFalse(waiter.done())
        self.assertEqual(queue.status()["waiting"], 1)
        clock.now += 3
        queue.release(2500)
        await settled(waiter)
        self.assertEqual(calls.admitted, ["busy", "waiter"])
        self.assertEqual(
            queue.status(),
            {
                "active": 1,
                "peak": 1,
                "waiting": 0,
                "completed": 1,
                "duration_ms": 2500,
                "rejected": 0,
                "refused_full": 0,
                "refused_wait": 0,
                "waited": 1,
                "wait_ms": 3000,
                "max_wait_ms": 3000,
                "abandoned": 0,
            },
        )

    async def test_a_live_call_goes_before_background_calls_that_waited_longer(self):
        queue = AdmissionQueue(max_waiting=8, limit=lambda: 1)
        calls = Calls(queue)
        await calls.start("busy", NATIVE)
        await calls.start("native", NATIVE)
        await calls.start("curation", app("aa"))
        await calls.start("live", app("bb", "interactive"))
        for _ in range(3):
            await calls.finish_one()
        self.assertEqual(calls.admitted, ["busy", "live", "native", "curation"])


class FairOrderTests(unittest.IsolatedAsyncioTestCase):
    async def drained(self, names):
        """The admission order of `names`, queued in that order behind one busy call."""
        queue = AdmissionQueue(max_waiting=16, limit=lambda: 1)
        calls = Calls(queue)
        await calls.start("busy", NATIVE)
        for name, ticket in names:
            await calls.start(name, ticket)
        for _ in names:
            await calls.finish_one()
        return calls.admitted[1:]

    async def test_hindsights_calls_and_the_apps_take_turns(self):
        order = await self.drained(
            [("n1", NATIVE), ("n2", NATIVE), ("n3", NATIVE), ("a1", app("aa")), ("a2", app("aa")), ("a3", app("aa"))]
        )
        self.assertEqual(order, ["n1", "a1", "n2", "a2", "n3", "a3"])

    async def test_two_accounts_take_turns_within_the_apps_calls(self):
        order = await self.drained([("A1", app("aa")), ("A2", app("aa")), ("A3", app("aa")), ("B1", app("bb"))])
        self.assertEqual(order, ["A1", "B1", "A2", "A3"])

    async def test_a_lane_keeps_its_order_and_a_new_lane_joins_the_end_of_the_turn(self):
        queue = AdmissionQueue(max_waiting=16, limit=lambda: 1)
        calls = Calls(queue)
        await calls.start("busy", NATIVE)
        for name, lane in (("A1", "aa"), ("A2", "aa"), ("B1", "bb"), ("B2", "bb")):
            await calls.start(name, app(lane))
        await calls.finish_one()  # A1; the turn is B, then A
        await calls.start("C1", app("cc"))  # C joins after A
        for _ in range(4):
            await calls.finish_one()
        self.assertEqual(calls.admitted[1:], ["A1", "B1", "A2", "C1", "B2"])

    async def test_live_calls_take_the_same_turns_among_themselves(self):
        order = await self.drained(
            [
                ("bg", app("aa")),
                ("A1", app("aa", "interactive")),
                ("A2", app("aa", "interactive")),
                ("B1", app("bb", "interactive")),
            ]
        )
        self.assertEqual(order, ["A1", "B1", "A2", "bg"])


class BoundTests(unittest.IsolatedAsyncioTestCase):
    async def test_a_waiter_is_refused_when_its_wait_runs_out_and_never_admitted_after(self):
        clock = FakeClock()
        queue = AdmissionQueue(max_waiting=4, limit=lambda: 1, clock=clock)
        calls = Calls(queue)
        await calls.start("busy", NATIVE)
        joined = clock.now
        late = await calls.start("late", app("aa", wait_s=5.0))
        clock.now = joined + 4.99
        await asyncio.sleep(4 * TICK_S)
        self.assertFalse(late.done())
        clock.now = joined + 5  # five seconds after it joined
        with self.assertRaises(AdmissionRefused) as refused:
            await settled(late)
        self.assertEqual(refused.exception.reason, "wait_exceeded")
        queue.release()
        await asyncio.sleep(4 * TICK_S)
        self.assertEqual(calls.admitted, ["busy"])
        status = queue.status()
        self.assertEqual(
            {key: status[key] for key in ("active", "waiting", "refused_wait", "rejected", "waited", "wait_ms")},
            {"active": 0, "waiting": 0, "refused_wait": 1, "rejected": 1, "waited": 1, "wait_ms": 5000},
        )

    async def test_a_full_queue_refuses_at_once_and_status_counts_both_refusals(self):
        clock = FakeClock()
        queue = AdmissionQueue(max_waiting=2, limit=lambda: 1, clock=clock)
        calls = Calls(queue)
        await calls.start("busy", NATIVE)
        await calls.start("patient", NATIVE)
        hurried = await calls.start("hurried", app("aa", wait_s=5.0))
        with self.assertRaises(AdmissionRefused) as refused:
            await settled(queue.acquire(app("bb"), tick_s=TICK_S))
        self.assertEqual(refused.exception.reason, "queue_full")
        self.assertEqual(queue.status()["waiting"], 2)
        clock.now += 5
        with self.assertRaises(AdmissionRefused):
            await settled(hurried)
        await calls.finish_one()
        self.assertEqual(calls.admitted, ["busy", "patient"])
        status = queue.status()
        self.assertEqual(
            {key: status[key] for key in ("refused_full", "refused_wait", "rejected", "waiting")},
            {"refused_full": 1, "refused_wait": 1, "rejected": 2, "waiting": 0},
        )

    async def test_no_waiting_room_refuses_every_call_over_the_budget_at_once(self):
        queue = AdmissionQueue(max_waiting=0, limit=lambda: 1)
        await settled(queue.acquire(NATIVE))
        with self.assertRaises(AdmissionRefused) as refused:
            await settled(queue.acquire(NATIVE))
        self.assertEqual(refused.exception.reason, "queue_full")


class CancelTests(unittest.IsolatedAsyncioTestCase):
    """A cancelled caller (Hindsight's own timeout, the app's abort) leaves nothing behind."""

    async def test_a_cancelled_waiter_leaves_and_is_never_admitted(self):
        queue = AdmissionQueue(max_waiting=4, limit=lambda: 1)
        calls = Calls(queue, tick_s=10)
        await calls.start("busy", NATIVE)
        cancelled = await calls.start("cancelled", NATIVE)
        await calls.start("next", NATIVE)
        cancelled.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await settled(cancelled)
        self.assertEqual(queue.status()["waiting"], 1)
        await calls.finish_one()
        queue.release()
        await asyncio.sleep(0.02)
        self.assertEqual(calls.admitted, ["busy", "next"])
        self.assertEqual(queue.status()["active"], 0)

    async def test_a_waiter_cancelled_right_after_its_admission_gives_the_slot_back(self):
        queue = AdmissionQueue(max_waiting=4, limit=lambda: 1)
        calls = Calls(queue, tick_s=10)
        await calls.start("busy", NATIVE)
        cancelled = await calls.start("cancelled", NATIVE)
        await calls.start("next", NATIVE)
        queue.release()  # admits "cancelled": its slot is taken, its task has not run yet
        cancelled.cancel()  # and its caller goes before it could use the slot
        with self.assertRaises(asyncio.CancelledError):
            await settled(cancelled)
        await until(lambda: "next" in calls.admitted)
        self.assertNotIn("cancelled", calls.admitted)
        status = queue.status()
        # One call holds the slot, and only the call that really ran counts as completed.
        self.assertEqual((status["active"], status["waiting"], status["completed"]), (1, 0, 1))

    async def test_a_waiter_admitted_in_the_tick_its_caller_left_gives_the_slot_to_the_next(self):
        limit = [1]
        leaving = []

        async def refresh():
            if leaving:
                limit[0] = 2  # a reading in the same tick frees a second slot

        async def abandoned():
            return bool(leaving)

        queue = AdmissionQueue(max_waiting=4, limit=lambda: limit[0])
        calls = Calls(queue)
        await calls.start("busy", NATIVE)
        gone = await calls.start("gone", NATIVE, refresh=refresh, abandoned=abandoned)
        await calls.start("next", NATIVE)
        leaving.append(True)
        with self.assertRaises(asyncio.CancelledError):
            await settled(gone)
        await until(lambda: "next" in calls.admitted)
        self.assertEqual(calls.admitted, ["busy", "next"])
        self.assertEqual(queue.status()["active"], 2)


class LeavingTests(unittest.IsolatedAsyncioTestCase):
    async def test_a_waiter_whose_caller_left_goes_at_its_next_tick_and_is_never_admitted(self):
        queue = AdmissionQueue(max_waiting=4, limit=lambda: 1)
        calls = Calls(queue)
        left = []

        async def abandoned():
            return bool(left)

        await calls.start("busy", NATIVE)
        gone = await calls.start("gone", NATIVE, abandoned=abandoned)
        await calls.start("next", NATIVE)
        left.append(True)
        with self.assertRaises(asyncio.CancelledError):
            await settled(gone)
        self.assertEqual(queue.status()["waiting"], 1)
        await calls.finish_one()
        queue.release()
        await asyncio.sleep(4 * TICK_S)
        self.assertEqual(calls.admitted, ["busy", "next"])
        status = queue.status()
        # Leaving is not a refusal; both waits are counted.
        self.assertEqual(
            (status["active"], status["waiting"], status["rejected"], status["waited"]), (0, 0, 0, 2)
        )

    async def test_a_waiter_whose_caller_left_is_not_admitted_when_the_slot_frees_before_its_next_tick(self):
        # A long tick: the slot frees while the waiter sleeps, after its caller left.
        queue = AdmissionQueue(max_waiting=4, limit=lambda: 1)
        calls = Calls(queue, tick_s=10.0)
        left = []

        async def abandoned():
            return bool(left)

        await calls.start("busy", NATIVE)
        gone = await calls.start("gone", NATIVE, abandoned=abandoned)
        waiting_next = await calls.start("next", NATIVE)
        left.append(True)
        queue.release()  # the slot frees before "gone" looks at its caller again
        with self.assertRaises(asyncio.CancelledError):
            await settled(gone)
        # The slot went on to the next caller, never to the one who left.
        await until(lambda: "next" in calls.admitted)
        self.assertEqual(calls.admitted, ["busy", "next"])
        status = queue.status()
        self.assertEqual((status["active"], status["waiting"]), (1, 0))
        self.assertEqual(status["abandoned"], 1)
        queue.release()
        await settled(waiting_next)

    async def test_status_counts_every_caller_that_left_while_it_waited(self):
        queue = AdmissionQueue(max_waiting=4, limit=lambda: 1)
        calls = Calls(queue)
        left = []

        async def abandoned():
            return bool(left)

        await calls.start("busy", NATIVE)
        gone = await calls.start("gone", NATIVE, abandoned=abandoned)
        left.append(True)
        with self.assertRaises(asyncio.CancelledError):
            await settled(gone)
        self.assertEqual(queue.status()["abandoned"], 1)
        self.assertEqual(queue.status()["rejected"], 0)

    async def test_a_failing_refresh_takes_its_waiter_out_of_the_queue(self):
        async def refresh():
            raise RuntimeError("synthetic reading failure")

        queue = AdmissionQueue(max_waiting=4, limit=lambda: 1)
        calls = Calls(queue)
        await calls.start("busy", NATIVE)
        failing = await calls.start("failing", NATIVE, refresh=refresh)
        with self.assertRaises(RuntimeError):
            await settled(failing)
        self.assertEqual(queue.status()["waiting"], 0)
        queue.release()
        self.assertEqual(queue.status()["active"], 0)


class TicketTests(unittest.TestCase):
    def ticket(self, headers, native_wait_s=600, max_wait_s=900):
        return ticket_from_headers(headers, native_wait_s=native_wait_s, max_wait_s=max_wait_s)

    def test_a_call_without_the_priority_header_is_hindsights_own(self):
        self.assertEqual(self.ticket({}), Ticket("background", "native", "native", 600))
        # The lane and wait headers alone do not make a call the app's.
        self.assertEqual(
            self.ticket({"X-AlfyAI-Admission-Lane": "ab", "X-AlfyAI-Admission-Wait-Ms": "1000"}),
            Ticket("background", "native", "native", 600),
        )
        self.assertEqual(self.ticket({}, native_wait_s=1200).max_wait_s, 900)

    def test_the_app_declares_priority_lane_and_wait_in_any_header_case(self):
        lane = "0123456789abcdef" * 2
        headers = {
            "x-alfyai-admission-priority": "interactive",
            "X-ALFYAI-ADMISSION-LANE": lane,
            "X-AlfyAI-Admission-Wait-Ms": "120000",
        }
        self.assertEqual(self.ticket(headers), Ticket("interactive", "app", lane, 120.0))
        self.assertEqual(
            self.ticket({"X-AlfyAI-Admission-Priority": "background"}), Ticket("background", "app", "app", 900)
        )

    def test_an_unknown_priority_is_background(self):
        for value in ("", "urgent", "Interactive", "INTERACTIVE", " interactive", "native"):
            with self.subTest(value=value):
                ticket = self.ticket({"X-AlfyAI-Admission-Priority": value})
                self.assertEqual((ticket.priority, ticket.source), ("background", "app"))

    def test_a_lane_must_be_lowercase_hex_up_to_64_characters_or_it_is_the_shared_app_lane(self):
        priority = {"X-AlfyAI-Admission-Priority": "background"}
        for lane in ("a", "deadbeef", "0" * 64):
            with self.subTest(lane=lane):
                self.assertEqual(self.ticket({**priority, "X-AlfyAI-Admission-Lane": lane}).lane, lane)
        for lane in ("", "A1", "g", "0" * 65, "ab cd", "ab\n", "native", "app", "../ab", "ab-cd"):
            with self.subTest(lane=lane):
                self.assertEqual(self.ticket({**priority, "X-AlfyAI-Admission-Lane": lane}).lane, "app")
        self.assertEqual(self.ticket(priority).lane, "app")

    def test_a_missing_or_malformed_wait_is_the_longest_and_any_wait_is_capped(self):
        priority = {"X-AlfyAI-Admission-Priority": "background"}
        for declared, wait_s in (("0", 0.0), ("1500", 1.5), ("900000", 900), ("900001", 900), ("9" * 40, 900)):
            with self.subTest(declared=declared):
                self.assertEqual(self.ticket({**priority, "X-AlfyAI-Admission-Wait-Ms": declared}).max_wait_s, wait_s)
        for declared in ("", "-1", "1.5", "1e3", " 10", "+10", "0x10", "٣"):
            with self.subTest(declared=declared):
                self.assertEqual(self.ticket({**priority, "X-AlfyAI-Admission-Wait-Ms": declared}).max_wait_s, 900)
        self.assertEqual(self.ticket(priority).max_wait_s, 900)

    def test_a_ticket_names_a_known_priority_and_source_and_a_wait_of_zero_or_more(self):
        self.assertEqual(PRIORITIES, ("interactive", "background"))
        self.assertEqual(SOURCES, ("native", "app"))
        for fields in (("urgent", "app", "app", 1.0), ("background", "other", "app", 1.0), ("background", "app", "", 1.0), ("background", "app", "app", -1.0)):
            with self.subTest(fields=fields), self.assertRaises(ValueError):
                Ticket(*fields)


class QueueContractTests(unittest.IsolatedAsyncioTestCase):
    async def test_a_release_without_an_admitted_call_is_refused(self):
        queue = AdmissionQueue(max_waiting=4, limit=lambda: 1)
        with self.assertRaises(RuntimeError):
            queue.release()
        self.assertEqual(queue.status()["active"], 0)

    async def test_the_waiting_room_is_a_whole_number_of_calls(self):
        for max_waiting in (-1, 1.5, True, "4"):
            with self.subTest(max_waiting=max_waiting), self.assertRaises(ValueError):
                AdmissionQueue(max_waiting=max_waiting, limit=lambda: 1)


class SettingsTests(unittest.TestCase):
    def test_defaults(self):
        self.assertEqual(admission_settings({}), AdmissionSettings(max_waiting=32, max_wait_s=900, native_wait_s=600))
        self.assertEqual(
            admission_settings({"admission_max_waiting": "", "admission_max_wait_s": " "}),
            AdmissionSettings(max_waiting=32, max_wait_s=900, native_wait_s=600),
        )

    def test_values_from_the_extension_config(self):
        self.assertEqual(
            admission_settings(
                {"admission_max_waiting": "0", "admission_max_wait_s": "1200", "admission_native_wait_s": " 300 "}
            ),
            AdmissionSettings(max_waiting=0, max_wait_s=1200, native_wait_s=300),
        )
        self.assertEqual(admission_settings({"admission_max_waiting": 8}).max_waiting, 8)

    def test_invalid_values_stop_the_installation(self):
        for key, value in (
            ("admission_max_waiting", "-1"),
            ("admission_max_waiting", "1025"),
            ("admission_max_waiting", "4.5"),
            ("admission_max_waiting", "many"),
            ("admission_max_waiting", True),
            ("admission_max_wait_s", "0"),
            ("admission_max_wait_s", "86401"),
            ("admission_max_wait_s", "15m"),
            ("admission_native_wait_s", "0"),
            ("admission_native_wait_s", "-600"),
            ("admission_native_wait_s", "6e2"),
        ):
            with self.subTest(key=key, value=value), self.assertRaises(ValueError):
                admission_settings({key: value})


if __name__ == "__main__":
    unittest.main()
