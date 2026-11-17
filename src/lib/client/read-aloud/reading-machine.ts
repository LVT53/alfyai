/**
 * The reading machine: a pure reducer that owns every state of a reading and
 * every failure of spec §4.8. It decides; the controller (`controller.ts`)
 * carries out its commands (the audio, the session, the timers) and turns what
 * happens back into events. Any event a state does not list leaves that state
 * as it is (the same object) and sends no command.
 */

export type ReadingStatus =
	| "idle"
	/** The first start: the player is not shown yet and the speaker spins. */
	| "opening"
	| "playing"
	| "paused"
	/** A new session inside an open player: its play button spins and the speaker keeps its ring. */
	| "seeking"
	/** Offline, or the server updating: reading goes on by itself when it is back. */
	| "waiting"
	/** The voice stopped answering: the player shows Try again. */
	| "stopped"
	| "finished"
	/** The first start failed: the crossed speaker and its note. */
	| "startFailed";

export type BreakKind = "offline" | "updating" | "voice";

export type ReadingState = {
	status: ReadingStatus;
	messageId: string | null;
	/** Index of the sentence in the speech script: where the reading is, or starts. */
	sentence: number;
	word: number | null;
	speed: number;
	/** The busy note shows. */
	busy: boolean;
	failure: BreakKind | null;
	/** Play opens a new session at `sentence` instead of resuming the audio (after a long pause, a hidden page, a jump while paused). */
	restartOnResume: boolean;
	/** The service said `done`: synthesis finished (not playback), so the audio's end is the reading's end. */
	doneReceived: boolean;
	drag: { target: number; wasPlaying: boolean } | null;
};

export const initialReadingState: ReadingState = {
	status: "idle",
	messageId: null,
	sentence: 0,
	word: null,
	speed: 1,
	busy: false,
	failure: null,
	restartOnResume: false,
	doneReceived: false,
	drag: null,
};

export type ReadingTimer =
	| "busy"
	| "start"
	| "failedSpeaker"
	| "longPause"
	| "finished";

export const READING_TIMER_MS = {
	busy: 2500,
	start: 20_000,
	failedSpeaker: 3000,
	longPause: 30_000,
	finished: 1100,
} as const satisfies Record<ReadingTimer, number>;

const ALL_TIMERS: readonly ReadingTimer[] = [
	"busy",
	"start",
	"failedSpeaker",
	"longPause",
	"finished",
];

export type ReadingEvent =
	/** A speaker: starts its reply, or pauses and resumes the reply being read. */
	| { type: "press"; messageId: string; from: number }
	/** Read from here: always reads from `from`, the reply being read included. */
	| { type: "readFrom"; messageId: string; from: number }
	| { type: "toggle" }
	| { type: "firstAudio" }
	| { type: "busyTimeout" }
	| { type: "startTimeout" }
	| { type: "sessionFailed"; kind: BreakKind }
	| { type: "startFailedTimeout" }
	| { type: "longPause" }
	| { type: "hidden" }
	| { type: "interrupted" }
	| { type: "progress"; sentence: number; word: number | null }
	| { type: "broke"; kind: BreakKind }
	| { type: "recovered" }
	| { type: "retry" }
	| { type: "seek"; sentence: number }
	| { type: "dragStart" }
	| { type: "dragMove"; sentence: number }
	| { type: "dragEnd"; sentence: number }
	| { type: "done" }
	| { type: "ended" }
	| { type: "finishedTimeout" }
	| { type: "speed"; value: number }
	| { type: "replaced" }
	| { type: "stop" };

export type ReadingCommand =
	/** Tear down any session, then open one for `messageId` from sentence `from`. */
	| { kind: "open"; messageId: string; from: number }
	| { kind: "close" }
	| { kind: "play" }
	| { kind: "pause" }
	| { kind: "report"; sentence: number }
	| { kind: "speed"; value: number }
	/** Starts the timer, or starts it again when it runs. */
	| { kind: "startTimer"; timer: ReadingTimer }
	| { kind: "clearTimer"; timer: ReadingTimer }
	| { kind: "awaitRecovery"; from: "offline" | "updating" };

export type ReadingStep = { state: ReadingState; commands: ReadingCommand[] };

const ACTIVE = new Set<ReadingStatus>([
	"opening",
	"playing",
	"paused",
	"seeking",
	"waiting",
	"stopped",
]);

function stay(state: ReadingState): ReadingStep {
	return { state, commands: [] };
}

/** Every move to idle clears all timers; the speed is the reading's own and stays until the next one sets it. */
function toIdle(state: ReadingState, commands: ReadingCommand[]): ReadingStep {
	return {
		state: { ...initialReadingState, speed: state.speed },
		commands: [
			...commands,
			...ALL_TIMERS.map(
				(timer): ReadingCommand => ({ kind: "clearTimer", timer }),
			),
		],
	};
}

/** Every `open` starts a fresh session: no word, no busy note, no `done`, no failure, and a start that times out. */
function open(
	state: ReadingState,
	status: "opening" | "seeking",
	messageId: string,
	from: number,
): ReadingStep {
	const commands: ReadingCommand[] = [{ kind: "open", messageId, from }];
	if (status === "opening")
		commands.push({ kind: "startTimer", timer: "busy" });
	commands.push({ kind: "startTimer", timer: "start" });
	return {
		state: {
			...state,
			status,
			messageId,
			sentence: from,
			word: null,
			busy: false,
			doneReceived: false,
			failure: null,
			restartOnResume: false,
			drag: null,
		},
		commands,
	};
}

/** Opens the reading's own message again, from `from`. */
function reopen(state: ReadingState, from: number): ReadingStep {
	return state.messageId === null
		? stay(state)
		: open(state, "seeking", state.messageId, from);
}

function pause(state: ReadingState): ReadingStep {
	return {
		state: { ...state, status: "paused", restartOnResume: false, drag: null },
		commands: [{ kind: "pause" }, { kind: "startTimer", timer: "longPause" }],
	};
}

function resume(state: ReadingState): ReadingStep {
	if (state.restartOnResume) return reopen(state, state.sentence);
	return {
		state: { ...state, status: "playing" },
		commands: [{ kind: "play" }, { kind: "clearTimer", timer: "longPause" }],
	};
}

function brk(state: ReadingState, kind: BreakKind): ReadingStep {
	if (kind === "voice") {
		return {
			state: { ...state, status: "stopped", failure: "voice", busy: false },
			commands: [{ kind: "close" }],
		};
	}
	return {
		state: { ...state, status: "waiting", failure: kind, busy: false },
		commands: [{ kind: "close" }, { kind: "awaitRecovery", from: kind }],
	};
}

function startFailed(state: ReadingState): ReadingStep {
	return {
		state: { ...state, status: "startFailed", busy: false },
		commands: [
			{ kind: "close" },
			{ kind: "startTimer", timer: "failedSpeaker" },
		],
	};
}

function onPress(
	state: ReadingState,
	messageId: string,
	from: number,
): ReadingStep {
	const same = state.messageId === messageId;
	switch (state.status) {
		case "idle":
		case "finished":
		case "startFailed":
			return open(state, "opening", messageId, from);
		case "opening":
			return same
				? toIdle(state, [{ kind: "close" }])
				: open(state, "opening", messageId, from);
		case "playing":
			return same ? pause(state) : open(state, "seeking", messageId, from);
		case "paused":
			return same ? resume(state) : open(state, "seeking", messageId, from);
		case "stopped":
			return same
				? reopen(state, state.sentence)
				: open(state, "seeking", messageId, from);
		case "seeking":
		case "waiting":
			return same ? stay(state) : open(state, "seeking", messageId, from);
	}
}

function onReadFrom(
	state: ReadingState,
	messageId: string,
	from: number,
): ReadingStep {
	switch (state.status) {
		case "idle":
		case "finished":
		case "startFailed":
		case "opening":
			return open(state, "opening", messageId, from);
		default:
			return open(state, "seeking", messageId, from);
	}
}

function onToggle(state: ReadingState): ReadingStep {
	switch (state.status) {
		case "opening":
			return toIdle(state, [{ kind: "close" }]);
		case "playing":
			return pause(state);
		case "paused":
			return resume(state);
		case "stopped":
			return reopen(state, state.sentence);
		default:
			return stay(state);
	}
}

function onHidden(state: ReadingState): ReadingStep {
	switch (state.status) {
		case "opening":
			return toIdle(state, [{ kind: "close" }]);
		case "playing":
		case "seeking":
			return {
				state: {
					...state,
					status: "paused",
					restartOnResume: true,
					drag: null,
				},
				commands: [{ kind: "close" }],
			};
		case "waiting":
			return {
				state: {
					...state,
					status: "paused",
					restartOnResume: true,
					drag: null,
				},
				commands: [],
			};
		default:
			return stay(state);
	}
}

function onDragEnd(state: ReadingState, sentence: number): ReadingStep {
	if (state.drag === null) return stay(state);
	if (state.drag.wasPlaying || state.status === "stopped")
		return reopen(state, sentence);
	return {
		state: {
			...state,
			status: "paused",
			sentence,
			word: null,
			restartOnResume: true,
			drag: null,
		},
		commands: [{ kind: "close" }],
	};
}

export function reduce(state: ReadingState, event: ReadingEvent): ReadingStep {
	const { status } = state;
	switch (event.type) {
		case "press":
			return onPress(state, event.messageId, event.from);
		case "readFrom":
			return onReadFrom(state, event.messageId, event.from);
		case "toggle":
			return onToggle(state);
		case "firstAudio":
			if (status !== "opening" && status !== "seeking") return stay(state);
			return {
				state: { ...state, status: "playing", busy: false },
				commands: [
					{ kind: "clearTimer", timer: "busy" },
					{ kind: "clearTimer", timer: "start" },
				],
			};
		case "busyTimeout":
			return status === "opening"
				? { state: { ...state, busy: true }, commands: [] }
				: stay(state);
		case "startTimeout":
			if (status === "opening") return startFailed(state);
			if (status === "seeking") return brk(state, "voice");
			return stay(state);
		case "sessionFailed":
			if (status === "opening") return startFailed(state);
			if (status === "seeking" || status === "playing")
				return brk(state, event.kind);
			return stay(state);
		case "broke":
			if (status === "seeking" || status === "playing")
				return brk(state, event.kind);
			// The update watch gave up (8 min): the voice is not coming back by itself.
			if (status === "waiting" && event.kind === "voice") {
				return {
					state: { ...state, status: "stopped", failure: "voice" },
					commands: [],
				};
			}
			return stay(state);
		case "startFailedTimeout":
			return status === "startFailed" ? toIdle(state, []) : stay(state);
		case "longPause":
			return status === "paused"
				? {
						state: { ...state, restartOnResume: true },
						commands: [{ kind: "close" }],
					}
				: stay(state);
		case "hidden":
			return onHidden(state);
		case "interrupted":
			return status === "playing"
				? {
						state: { ...state, status: "paused", restartOnResume: false },
						commands: [{ kind: "startTimer", timer: "longPause" }],
					}
				: stay(state);
		case "progress": {
			if (status !== "playing") return stay(state);
			if (event.sentence === state.sentence && event.word === state.word)
				return stay(state);
			const changed = event.sentence !== state.sentence;
			return {
				state: { ...state, sentence: event.sentence, word: event.word },
				commands: changed ? [{ kind: "report", sentence: event.sentence }] : [],
			};
		}
		case "recovered":
			return status === "waiting" ? reopen(state, state.sentence) : stay(state);
		case "retry":
			return status === "stopped" ? reopen(state, state.sentence) : stay(state);
		case "seek":
			if (status === "paused") {
				return {
					state: {
						...state,
						sentence: event.sentence,
						word: null,
						restartOnResume: true,
					},
					commands: [{ kind: "close" }],
				};
			}
			return status === "playing" ||
				status === "seeking" ||
				status === "stopped" ||
				status === "waiting"
				? reopen(state, event.sentence)
				: stay(state);
		case "dragStart":
			if (state.drag !== null) return stay(state);
			if (status === "playing") {
				return {
					state: {
						...state,
						drag: { target: state.sentence, wasPlaying: true },
					},
					commands: [{ kind: "pause" }],
				};
			}
			return status === "paused" || status === "stopped"
				? {
						state: {
							...state,
							drag: { target: state.sentence, wasPlaying: false },
						},
						commands: [],
					}
				: stay(state);
		case "dragMove":
			if (state.drag === null || state.drag.target === event.sentence)
				return stay(state);
			return {
				state: { ...state, drag: { ...state.drag, target: event.sentence } },
				commands: [],
			};
		case "dragEnd":
			return onDragEnd(state, event.sentence);
		case "done":
			return ACTIVE.has(status) && !state.doneReceived
				? { state: { ...state, doneReceived: true }, commands: [] }
				: stay(state);
		case "ended":
			return status === "playing"
				? {
						state: { ...state, status: "finished" },
						commands: [{ kind: "startTimer", timer: "finished" }],
					}
				: stay(state);
		case "finishedTimeout":
			return status === "finished"
				? toIdle(state, [{ kind: "close" }])
				: stay(state);
		case "speed":
			return {
				state: { ...state, speed: event.value },
				commands: [{ kind: "speed", value: event.value }],
			};
		case "replaced":
		case "stop":
			return status === "idle"
				? stay(state)
				: toIdle(state, [{ kind: "close" }]);
	}
}

/**
 * What a break in a reading was, for its note:
 * - the service said it failed: the voice;
 * - otherwise, the browser is offline: offline;
 * - otherwise, the server is draining or away behind the proxy: an update;
 * - anything else: the voice.
 */
export function classifyBreak(p: {
	serviceError: boolean;
	online: boolean;
	health: "up" | "draining" | "proxy_down" | "unreachable" | null;
}): BreakKind {
	if (p.serviceError) return "voice";
	if (!p.online) return "offline";
	if (p.health === "draining" || p.health === "proxy_down") return "updating";
	return "voice";
}
