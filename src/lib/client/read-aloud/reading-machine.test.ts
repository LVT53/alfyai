import { describe, expect, it } from "vitest";
import {
	classifyBreak,
	initialReadingState,
	READING_TIMER_MS,
	type ReadingCommand,
	type ReadingEvent,
	type ReadingState,
	reduce,
} from "./reading-machine";

const CLEAR_ALL: ReadingCommand[] = [
	{ kind: "clearTimer", timer: "busy" },
	{ kind: "clearTimer", timer: "start" },
	{ kind: "clearTimer", timer: "failedSpeaker" },
	{ kind: "clearTimer", timer: "longPause" },
	{ kind: "clearTimer", timer: "finished" },
];
const CLOSE: ReadingCommand = { kind: "close" };

const press = (messageId = "m1", from = 0): ReadingEvent => ({
	type: "press",
	messageId,
	from,
});

function run(
	events: ReadingEvent[],
	state: ReadingState = initialReadingState,
): ReadingState {
	let next = state;
	for (const event of events) next = reduce(next, event).state;
	return next;
}

const opening = (messageId = "m1", from = 0) => run([press(messageId, from)]);
const playingAt = (sentence = 0) =>
	run([press("m1", sentence), { type: "firstAudio" }]);
const pausedAt = (sentence = 0) =>
	run([{ type: "toggle" }], playingAt(sentence));
const seekingAt = (sentence = 0) =>
	run([{ type: "seek", sentence }], playingAt(0));
const waitingAt = (sentence = 0) =>
	run([{ type: "broke", kind: "offline" }], playingAt(sentence));
const stoppedAt = (sentence = 0) =>
	run([{ type: "broke", kind: "voice" }], playingAt(sentence));
const finished = () => run([{ type: "done" }, { type: "ended" }], playingAt(3));
const startFailed = () => run([{ type: "startTimeout" }], opening());

describe("the reading machine", () => {
	it("opens a reading and plays on first audio", () => {
		const opened = reduce(initialReadingState, press("m1", 2));
		expect(opened.state).toEqual({
			...initialReadingState,
			status: "opening",
			messageId: "m1",
			sentence: 2,
		});
		expect(opened.commands).toEqual([
			{ kind: "open", messageId: "m1", from: 2 },
			{ kind: "startTimer", timer: "busy" },
			{ kind: "startTimer", timer: "start" },
		]);
		const first = reduce(opened.state, { type: "firstAudio" });
		expect(first.state).toMatchObject({
			status: "playing",
			messageId: "m1",
			sentence: 2,
			busy: false,
		});
		expect(first.commands).toEqual([
			{ kind: "clearTimer", timer: "busy" },
			{ kind: "clearTimer", timer: "start" },
		]);
	});

	it("shows the busy note after 2.5 s", () => {
		expect(READING_TIMER_MS.busy).toBe(2500);
		const busy = reduce(opening(), { type: "busyTimeout" });
		expect(busy.state).toMatchObject({ status: "opening", busy: true });
		expect(busy.commands).toEqual([]);
		expect(reduce(busy.state, { type: "firstAudio" }).state.busy).toBe(false);
		const playing = playingAt();
		expect(reduce(playing, { type: "busyTimeout" }).state).toBe(playing);
	});

	it("fails to start after 20 s or when the service refuses, and the speaker settles after 3 s", () => {
		expect(READING_TIMER_MS.start).toBe(20_000);
		expect(READING_TIMER_MS.failedSpeaker).toBe(3000);
		const busyOpening = run([{ type: "busyTimeout" }], opening());
		const failures: ReadingEvent[] = [
			{ type: "startTimeout" },
			{ type: "sessionFailed", kind: "voice" },
			{ type: "sessionFailed", kind: "offline" },
		];
		for (const failure of failures) {
			const failed = reduce(busyOpening, failure);
			expect(failed.state).toMatchObject({
				status: "startFailed",
				busy: false,
			});
			expect(failed.commands).toEqual([
				CLOSE,
				{ kind: "startTimer", timer: "failedSpeaker" },
			]);
			const settled = reduce(failed.state, { type: "startFailedTimeout" });
			expect(settled.state).toEqual(initialReadingState);
			expect(settled.commands).toEqual(CLEAR_ALL);
		}
	});

	it("pauses and resumes in the same session", () => {
		const paused = reduce(playingAt(1), { type: "toggle" });
		expect(paused.state).toMatchObject({
			status: "paused",
			sentence: 1,
			restartOnResume: false,
		});
		expect(paused.commands).toEqual([
			{ kind: "pause" },
			{ kind: "startTimer", timer: "longPause" },
		]);
		// The speaker of the reply being read pauses and resumes it too, wherever it was pressed from.
		expect(reduce(playingAt(1), press("m1", 0)).commands).toEqual(
			paused.commands,
		);
		const resumed = reduce(paused.state, press("m1", 0));
		expect(resumed.state).toMatchObject({ status: "playing", sentence: 1 });
		expect(resumed.commands).toEqual([
			{ kind: "play" },
			{ kind: "clearTimer", timer: "longPause" },
		]);
	});

	it("an interruption pauses the way the browser did", () => {
		const interrupted = reduce(playingAt(1), { type: "interrupted" });
		expect(interrupted.state).toMatchObject({
			status: "paused",
			restartOnResume: false,
		});
		expect(interrupted.commands).toEqual([
			{ kind: "startTimer", timer: "longPause" },
		]);
	});

	it("a pause longer than 30 s restarts at the sentence start", () => {
		expect(READING_TIMER_MS.longPause).toBe(30_000);
		const paused = run(
			[{ type: "progress", sentence: 3, word: 2 }, { type: "toggle" }],
			playingAt(0),
		);
		const timedOut = reduce(paused, { type: "longPause" });
		expect(timedOut.state).toMatchObject({
			status: "paused",
			restartOnResume: true,
			sentence: 3,
		});
		expect(timedOut.commands).toEqual([CLOSE]);
		const resumed = reduce(timedOut.state, { type: "toggle" });
		expect(resumed.state).toMatchObject({
			status: "seeking",
			sentence: 3,
			word: null,
			restartOnResume: false,
		});
		expect(resumed.commands).toEqual([
			{ kind: "open", messageId: "m1", from: 3 },
			{ kind: "startTimer", timer: "start" },
		]);
	});

	it("a hidden page pauses, and play restarts at the sentence start", () => {
		for (const state of [playingAt(2), seekingAt(2)]) {
			const hidden = reduce(state, { type: "hidden" });
			expect(hidden.state).toMatchObject({
				status: "paused",
				restartOnResume: true,
				sentence: 2,
			});
			expect(hidden.commands).toEqual([CLOSE]);
			expect(reduce(hidden.state, press("m1", 0)).commands).toEqual([
				{ kind: "open", messageId: "m1", from: 2 },
				{ kind: "startTimer", timer: "start" },
			]);
		}
		// Before the player shows, a hidden page gives the start up.
		expect(reduce(opening(), { type: "hidden" })).toEqual({
			state: initialReadingState,
			commands: [CLOSE, ...CLEAR_ALL],
		});
		// While waiting, nothing is open: leaving `waiting` ends the recovery watch.
		const waiting = waitingAt(2);
		expect(reduce(waiting, { type: "hidden" })).toEqual({
			state: { ...waiting, status: "paused", restartOnResume: true },
			commands: [],
		});
	});

	it("a paused reading whose page is hidden restarts at its sentence when play comes (early review R14)", () => {
		// A call or unplugged headphones pause and keep the session; then the phone locks.
		const interrupted = run([{ type: "interrupted" }], playingAt(2));
		expect(interrupted).toMatchObject({
			status: "paused",
			restartOnResume: false,
		});
		const hidden = reduce(interrupted, { type: "hidden" });
		expect(hidden.state).toMatchObject({
			status: "paused",
			restartOnResume: true,
			sentence: 2,
			drag: null,
		});
		// The session goes with the page, and the long-pause timer has nothing left to close.
		expect(hidden.commands).toEqual([
			CLOSE,
			{ kind: "clearTimer", timer: "longPause" },
		]);
		expect(reduce(hidden.state, { type: "toggle" }).commands).toEqual([
			{ kind: "open", messageId: "m1", from: 2 },
			{ kind: "startTimer", timer: "start" },
		]);
		// A pause the person made is the same: the page left, and the stream with it.
		expect(reduce(pausedAt(3), { type: "hidden" }).state).toMatchObject({
			status: "paused",
			restartOnResume: true,
			sentence: 3,
		});
		// Already restarting on play (a long pause, an earlier hidden page): nothing to close again.
		expect(reduce(hidden.state, { type: "hidden" })).toEqual({
			state: hidden.state,
			commands: [],
		});
		const parked = run(
			[{ type: "seek", sentence: 4 }],
			pausedAt(1),
		);
		expect(reduce(parked, { type: "hidden" }).commands).toEqual([]);
	});

	it("the voice stopping shows Try again, which restarts at that sentence", () => {
		const broke = reduce(playingAt(4), { type: "broke", kind: "voice" });
		expect(broke.state).toMatchObject({
			status: "stopped",
			failure: "voice",
			sentence: 4,
		});
		expect(broke.commands).toEqual([CLOSE]);
		const reopen = [
			{ kind: "open", messageId: "m1", from: 4 },
			{ kind: "startTimer", timer: "start" },
		];
		for (const event of [
			{ type: "retry" },
			{ type: "toggle" },
			press("m1", 0),
		] as ReadingEvent[]) {
			const retried = reduce(broke.state, event);
			expect(retried.state).toMatchObject({
				status: "seeking",
				sentence: 4,
				failure: null,
			});
			expect(retried.commands).toEqual(reopen);
		}
		// A jump that never gets audio stops the same way, and so does a session the service refuses.
		const retried = reduce(broke.state, { type: "retry" }).state;
		expect(reduce(retried, { type: "startTimeout" })).toEqual({
			state: { ...retried, status: "stopped", failure: "voice" },
			commands: [CLOSE],
		});
		expect(
			reduce(retried, { type: "sessionFailed", kind: "voice" }).state,
		).toMatchObject({
			status: "stopped",
			failure: "voice",
		});
	});

	it("offline waits, and resumes by itself", () => {
		const waiting = reduce(playingAt(1), { type: "broke", kind: "offline" });
		expect(waiting.state).toMatchObject({
			status: "waiting",
			failure: "offline",
			sentence: 1,
		});
		expect(waiting.commands).toEqual([
			CLOSE,
			{ kind: "awaitRecovery", from: "offline" },
		]);
		const back = reduce(waiting.state, { type: "recovered" });
		expect(back.state).toMatchObject({
			status: "seeking",
			failure: null,
			sentence: 1,
			word: null,
		});
		expect(back.commands).toEqual([
			{ kind: "open", messageId: "m1", from: 1 },
			{ kind: "startTimer", timer: "start" },
		]);
		expect(reduce(back.state, { type: "firstAudio" }).state.status).toBe(
			"playing",
		);
	});

	it("an update waits, and resumes when the server is back", () => {
		const waiting = reduce(playingAt(2), { type: "broke", kind: "updating" });
		expect(waiting.state).toMatchObject({
			status: "waiting",
			failure: "updating",
		});
		expect(waiting.commands).toEqual([
			CLOSE,
			{ kind: "awaitRecovery", from: "updating" },
		]);
		// A new session that cannot open while the server restarts waits again.
		const reopening = reduce(waiting.state, { type: "recovered" }).state;
		const again = reduce(reopening, {
			type: "sessionFailed",
			kind: "updating",
		});
		expect(again.state).toMatchObject({
			status: "waiting",
			failure: "updating",
			sentence: 2,
		});
		expect(again.commands).toEqual([
			CLOSE,
			{ kind: "awaitRecovery", from: "updating" },
		]);
	});

	it("an update that never ends stops the reading when the watch gives up", () => {
		const waiting = reduce(playingAt(2), {
			type: "broke",
			kind: "updating",
		}).state;
		const given = reduce(waiting, { type: "broke", kind: "voice" });
		// Nothing is open while waiting, so there is nothing to close.
		expect(given).toEqual({
			state: { ...waiting, status: "stopped", failure: "voice" },
			commands: [],
		});
		expect(reduce(waiting, { type: "broke", kind: "offline" }).state).toBe(
			waiting,
		);
	});

	it("another reply switches without closing the player", () => {
		for (const state of [
			playingAt(3),
			pausedAt(3),
			seekingAt(3),
			waitingAt(3),
			stoppedAt(3),
		]) {
			const switched = reduce(state, press("m2", 0));
			expect(switched.state).toMatchObject({
				status: "seeking",
				messageId: "m2",
				sentence: 0,
				word: null,
				failure: null,
				restartOnResume: false,
				doneReceived: false,
			});
			expect(switched.commands).toEqual([
				{ kind: "open", messageId: "m2", from: 0 },
				{ kind: "startTimer", timer: "start" },
			]);
		}
		// Before the player shows, another reply restarts the opening and its timers.
		const moved = reduce(
			run([{ type: "busyTimeout" }], opening("m1")),
			press("m2", 0),
		);
		expect(moved.state).toMatchObject({
			status: "opening",
			messageId: "m2",
			busy: false,
		});
		expect(moved.commands).toEqual([
			{ kind: "open", messageId: "m2", from: 0 },
			{ kind: "startTimer", timer: "busy" },
			{ kind: "startTimer", timer: "start" },
		]);
		// The same reply's speaker cancels an opening.
		expect(reduce(opening("m1"), press("m1"))).toEqual({
			state: initialReadingState,
			commands: [CLOSE, ...CLEAR_ALL],
		});
		expect(reduce(opening("m1"), { type: "toggle" })).toEqual({
			state: initialReadingState,
			commands: [CLOSE, ...CLEAR_ALL],
		});
	});

	it("Read from here jumps within the reply being read, whatever its state", () => {
		const readFrom: ReadingEvent = {
			type: "readFrom",
			messageId: "m1",
			from: 5,
		};
		for (const state of [
			playingAt(1),
			pausedAt(1),
			seekingAt(1),
			waitingAt(1),
			stoppedAt(1),
		]) {
			const jumped = reduce(state, readFrom);
			expect(jumped.state).toMatchObject({
				status: "seeking",
				messageId: "m1",
				sentence: 5,
				failure: null,
			});
			expect(jumped.commands).toEqual([
				{ kind: "open", messageId: "m1", from: 5 },
				{ kind: "startTimer", timer: "start" },
			]);
		}
		for (const state of [
			initialReadingState,
			opening("m1"),
			finished(),
			startFailed(),
		]) {
			const opened = reduce(state, readFrom);
			expect(opened.state).toMatchObject({
				status: "opening",
				messageId: "m1",
				sentence: 5,
			});
			expect(opened.commands).toEqual([
				{ kind: "open", messageId: "m1", from: 5 },
				{ kind: "startTimer", timer: "busy" },
				{ kind: "startTimer", timer: "start" },
			]);
		}
	});

	it("reports the position when the sentence changes", () => {
		const sameSentence = reduce(playingAt(0), {
			type: "progress",
			sentence: 0,
			word: 3,
		});
		expect(sameSentence.state).toMatchObject({ sentence: 0, word: 3 });
		expect(sameSentence.commands).toEqual([]);
		const next = reduce(sameSentence.state, {
			type: "progress",
			sentence: 1,
			word: null,
		});
		expect(next.state).toMatchObject({ sentence: 1, word: null });
		expect(next.commands).toEqual([{ kind: "report", sentence: 1 }]);
		expect(
			reduce(next.state, { type: "progress", sentence: 1, word: null }).state,
		).toBe(next.state);
		const paused = pausedAt(0);
		expect(
			reduce(paused, { type: "progress", sentence: 4, word: 0 }).state,
		).toBe(paused);
	});

	it("after done a new sentence reports nothing: every sentence is made", () => {
		const done = reduce(playingAt(3), { type: "done" }).state;
		const next = reduce(done, { type: "progress", sentence: 4, word: null });
		expect(next.state).toMatchObject({ sentence: 4 });
		expect(next.commands).toEqual([]);
	});

	it("a jump reads from the chosen sentence, and a jump while paused stays paused", () => {
		const jumped = reduce(playingAt(0), { type: "seek", sentence: 6 });
		expect(jumped.state).toMatchObject({
			status: "seeking",
			sentence: 6,
			word: null,
		});
		expect(jumped.commands).toEqual([
			{ kind: "open", messageId: "m1", from: 6 },
			{ kind: "startTimer", timer: "start" },
		]);
		const parked = reduce(pausedAt(0), { type: "seek", sentence: 6 });
		expect(parked.state).toMatchObject({
			status: "paused",
			sentence: 6,
			word: null,
			restartOnResume: true,
		});
		expect(parked.commands).toEqual([CLOSE]);
		expect(reduce(parked.state, { type: "toggle" }).commands[0]).toEqual({
			kind: "open",
			messageId: "m1",
			from: 6,
		});
	});

	it("dragging pauses, and the release reads from the chosen sentence", () => {
		const started = reduce(playingAt(1), { type: "dragStart" });
		expect(started.state).toMatchObject({
			status: "playing",
			drag: { target: 1, wasPlaying: true },
		});
		expect(started.commands).toEqual([{ kind: "pause" }]);
		const moved = reduce(started.state, { type: "dragMove", sentence: 6 });
		expect(moved.state.drag).toEqual({ target: 6, wasPlaying: true });
		expect(moved.commands).toEqual([]);
		const released = reduce(moved.state, { type: "dragEnd", sentence: 5 });
		expect(released.state).toMatchObject({
			status: "seeking",
			sentence: 5,
			word: null,
			drag: null,
		});
		expect(released.commands).toEqual([
			{ kind: "open", messageId: "m1", from: 5 },
			{ kind: "startTimer", timer: "start" },
		]);
		// From a pause the release lands paused at the chosen sentence.
		const pausedDrag = reduce(pausedAt(1), { type: "dragStart" });
		expect(pausedDrag.state.drag).toEqual({ target: 1, wasPlaying: false });
		expect(pausedDrag.commands).toEqual([]);
		const parked = reduce(pausedDrag.state, { type: "dragEnd", sentence: 3 });
		expect(parked.state).toMatchObject({
			status: "paused",
			sentence: 3,
			restartOnResume: true,
			drag: null,
		});
		expect(parked.commands).toEqual([CLOSE]);
		// From a stop the release reads from the chosen sentence.
		const stoppedDrag = run([{ type: "dragStart" }], stoppedAt(4));
		expect(
			reduce(stoppedDrag, { type: "dragEnd", sentence: 2 }).state,
		).toMatchObject({
			status: "seeking",
			sentence: 2,
			failure: null,
		});
		// No drag, no move and no release.
		const playing = playingAt(1);
		expect(reduce(playing, { type: "dragEnd", sentence: 3 }).state).toBe(
			playing,
		);
		expect(reduce(playing, { type: "dragMove", sentence: 3 }).state).toBe(
			playing,
		);
	});

	it("the end shows Finished for 1.1 s", () => {
		expect(READING_TIMER_MS.finished).toBe(1100);
		const done = reduce(playingAt(4), { type: "done" });
		expect(done.state.doneReceived).toBe(true);
		// `done` means synthesis finished, not playback: it never closes the session.
		expect(done.commands).toEqual([]);
		const ended = reduce(done.state, { type: "ended" });
		expect(ended.state.status).toBe("finished");
		expect(ended.commands).toEqual([{ kind: "startTimer", timer: "finished" }]);
		const gone = reduce(ended.state, { type: "finishedTimeout" });
		expect(gone.state).toEqual(initialReadingState);
		// The server closed the session once this browser had all its audio (its
		// rule): closing here sends no DELETE, which could only answer 404.
		expect(gone.commands).toEqual([
			{ kind: "close", ended: true },
			...CLEAR_ALL,
		]);
		// Pressing during Finished reads the reply again.
		expect(reduce(ended.state, press("m1", 0)).state).toMatchObject({
			status: "opening",
			sentence: 0,
		});
	});

	it("a replaced reading ends quietly", () => {
		const states = [
			opening(),
			playingAt(2),
			pausedAt(2),
			seekingAt(2),
			waitingAt(2),
			stoppedAt(2),
			finished(),
			startFailed(),
		];
		for (const state of states) {
			const replaced = reduce(state, { type: "replaced" });
			expect(replaced.state).toEqual(initialReadingState);
			expect(replaced.state.failure).toBeNull();
			// The server closed the session when it replaced it: a DELETE would be a 404.
			expect(replaced.commands).toEqual([
				{ kind: "close", ended: true },
				...CLEAR_ALL,
			]);
		}
		expect(reduce(initialReadingState, { type: "replaced" })).toEqual({
			state: initialReadingState,
			commands: [],
		});
	});

	it("✕ stops from every state", () => {
		const states = [
			opening(),
			playingAt(2),
			pausedAt(2),
			seekingAt(2),
			waitingAt(2),
			stoppedAt(2),
			finished(),
			startFailed(),
		];
		for (const state of states) {
			expect(reduce(state, { type: "stop" })).toEqual({
				state: initialReadingState,
				commands: [CLOSE, ...CLEAR_ALL],
			});
		}
		const dragging = run([{ type: "dragStart" }], playingAt(1));
		expect(reduce(dragging, { type: "stop" }).state.drag).toBeNull();
		expect(reduce(initialReadingState, { type: "stop" })).toEqual({
			state: initialReadingState,
			commands: [],
		});
	});

	it("changes the speed at once in any state, and keeps it for the reading", () => {
		const faster = reduce(playingAt(1), { type: "speed", value: 1.5 });
		expect(faster.state.speed).toBe(1.5);
		expect(faster.commands).toEqual([{ kind: "speed", value: 1.5 }]);
		expect(
			run([{ type: "seek", sentence: 4 }, { type: "firstAudio" }], faster.state)
				.speed,
		).toBe(1.5);
		expect(
			reduce(initialReadingState, { type: "speed", value: 2 }).commands,
		).toEqual([{ kind: "speed", value: 2 }]);
	});

	it("leaves any pair the table does not list alone", () => {
		const unlisted: Array<[ReadingState, ReadingEvent]> = [
			[initialReadingState, { type: "firstAudio" }],
			[initialReadingState, { type: "toggle" }],
			[playingAt(1), { type: "recovered" }],
			[playingAt(1), { type: "retry" }],
			[playingAt(1), { type: "longPause" }],
			[seekingAt(1), press("m1", 0)],
			[waitingAt(1), { type: "toggle" }],
			[seekingAt(1), { type: "dragStart" }],
			[finished(), { type: "done" }],
			[opening(), { type: "broke", kind: "voice" }],
		];
		for (const [state, event] of unlisted) {
			expect(reduce(state, event)).toEqual({ state, commands: [] });
			expect(reduce(state, event).state).toBe(state);
		}
	});
});

describe("classifyBreak", () => {
	it("classifies breaks", () => {
		expect(
			classifyBreak({ serviceError: true, online: false, health: "draining" }),
		).toBe("voice");
		expect(
			classifyBreak({ serviceError: false, online: false, health: null }),
		).toBe("offline");
		expect(
			classifyBreak({ serviceError: false, online: true, health: "draining" }),
		).toBe("updating");
		expect(
			classifyBreak({
				serviceError: false,
				online: true,
				health: "proxy_down",
			}),
		).toBe("updating");
		expect(
			classifyBreak({ serviceError: false, online: true, health: "up" }),
		).toBe("voice");
		expect(
			classifyBreak({
				serviceError: false,
				online: true,
				health: "unreachable",
			}),
		).toBe("voice");
		expect(
			classifyBreak({ serviceError: false, online: true, health: null }),
		).toBe("voice");
	});
});
