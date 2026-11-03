import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServerHealth } from "$lib/client/api/health";
import {
	answerOrFallBack,
	createServerUpdateWatch,
	judgeServerUpdate,
	SERVER_UPDATE_READ_MAX_MS,
	SERVER_UPDATE_WATCH_FALSE_ALARM_MS,
	SERVER_UPDATE_WATCH_MAX_MS,
	SERVER_UPDATE_WATCH_POLL_MS,
	type ServerUpdateLook,
	type ServerUpdateWatchEnd,
} from "./server-update-watch";

const UP: ServerHealth = { state: "up" };
const DRAINING: ServerHealth = { state: "draining" };
const PROXY_DOWN: ServerHealth = { state: "proxy_down" };
const UNREACHABLE: ServerHealth = { state: "unreachable" };

/** The page's own clock, or a test's: the real timers, which the fake ones replace. */
const timers = {
	setTimer: (callback: () => void, delayMs: number) =>
		setTimeout(callback, delayMs),
	clearTimer: (handle: unknown) =>
		clearTimeout(handle as ReturnType<typeof setTimeout>),
};

describe("answerOrFallBack", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("gives what the read answers", async () => {
		expect(await answerOrFallBack(async () => "yes", "no", timers)).toBe("yes");
	});

	it("gives the fallback for a read that fails, or throws before it returns a promise", async () => {
		expect(
			await answerOrFallBack(
				async () => {
					throw new Error("offline");
				},
				"no",
				timers,
			),
		).toBe("no");
		expect(
			await answerOrFallBack(
				() => {
					throw new Error("offline");
				},
				"no",
				timers,
			),
		).toBe("no");
	});

	it("gives the fallback for a read that has not answered in five seconds, and drops its late answer", async () => {
		vi.useFakeTimers();
		let answer: (value: string) => void = () => {};
		const pending = answerOrFallBack(
			() => new Promise<string>((resolve) => (answer = resolve)),
			"no",
			timers,
		);

		await vi.advanceTimersByTimeAsync(SERVER_UPDATE_READ_MAX_MS - 1);
		let settled = false;
		void pending.then(() => {
			settled = true;
		});
		await vi.advanceTimersByTimeAsync(0);
		expect(settled).toBe(false);
		await vi.advanceTimersByTimeAsync(1);

		expect(await pending).toBe("no");
		answer("late");
	});
});

describe("judgeServerUpdate", () => {
	function reads(
		overrides: Partial<Parameters<typeof judgeServerUpdate>[0]> = {},
	) {
		return {
			fetchHealth: vi.fn(async () => UP),
			checkVersion: vi.fn(async () => false),
			versionWasLive: false,
			isOffline: vi.fn(() => false),
			...timers,
			...overrides,
		};
	}

	afterEach(() => {
		vi.useRealTimers();
	});

	it("is none when the server is up and runs the version this page has", async () => {
		const r = reads();

		expect(await judgeServerUpdate(r)).toBe("none");
		expect(r.fetchHealth).toHaveBeenCalledTimes(1);
		expect(r.checkVersion).toHaveBeenCalledTimes(1);
	});

	it("is draining when the server says it is draining, without asking for the version", async () => {
		const r = reads({ fetchHealth: vi.fn(async () => DRAINING) });

		expect(await judgeServerUpdate(r)).toBe("draining");
		expect(r.checkVersion).not.toHaveBeenCalled();
	});

	// During the restart the version file cannot be read either, so the proxy's
	// page counts by itself.
	it("is restarting when the proxy answers instead of the app", async () => {
		const r = reads({
			fetchHealth: vi.fn(async () => PROXY_DOWN),
			checkVersion: vi.fn(async () => false),
		});

		expect(await judgeServerUpdate(r)).toBe("restarting");
		expect(r.checkVersion).not.toHaveBeenCalled();
	});

	// A phone that lost its signal gets no answer at all, and that is not an update.
	it("is none when the server cannot be reached, whatever the version says", async () => {
		const r = reads({
			fetchHealth: vi.fn(async () => UNREACHABLE),
			checkVersion: vi.fn(async () => true),
		});

		expect(await judgeServerUpdate(r)).toBe("none");
	});

	it("is a new version when one went live during this turn: not live when the failure was handled, and live now", async () => {
		const r = reads({
			versionWasLive: false,
			checkVersion: vi.fn(async () => true),
		});

		expect(await judgeServerUpdate(r)).toBe("new_version");
	});

	// A tab that missed a deploy has `updated.check()` true for ever.
	it("is none for a version that was already live when the failure was handled, the server being well", async () => {
		const r = reads({
			versionWasLive: true,
			checkVersion: vi.fn(async () => true),
		});

		expect(await judgeServerUpdate(r)).toBe("none");
		expect(r.checkVersion).not.toHaveBeenCalled();
	});

	it("is none when the version cannot be checked and nothing else says so", async () => {
		const r = reads({
			checkVersion: vi.fn(async () => {
				throw new Error("offline");
			}),
		});

		expect(await judgeServerUpdate(r)).toBe("none");
	});

	it("does not wait for a version fetch that never answers: five seconds is no", async () => {
		vi.useFakeTimers();
		const r = reads({
			checkVersion: vi.fn(() => new Promise<boolean>(() => {})),
		});

		const asked = judgeServerUpdate(r);
		await vi.advanceTimersByTimeAsync(SERVER_UPDATE_READ_MAX_MS);

		expect(await asked).toBe("none");
	});

	it("takes a health read that never answers for none", async () => {
		vi.useFakeTimers();
		const r = reads({
			fetchHealth: vi.fn(() => new Promise<ServerHealth>(() => {})),
		});

		const asked = judgeServerUpdate(r);
		await vi.advanceTimersByTimeAsync(SERVER_UPDATE_READ_MAX_MS);

		expect(await asked).toBe("none");
	});

	// A phone that lost its connection cannot reach the server, and that is not an
	// update.
	it("is none for a browser that reports itself offline, whatever the server would say", async () => {
		const r = reads({
			isOffline: vi.fn(() => true),
			fetchHealth: vi.fn(async () => PROXY_DOWN),
		});

		expect(await judgeServerUpdate(r)).toBe("none");
		expect(r.fetchHealth).not.toHaveBeenCalled();
	});
});

// The shell's watch over a server update (ADR-0054, "An Update During A Turn").
// A sign says an update may be under way; the watch then looks at the server every
// few seconds, so the banner and the Refresh notice come up within seconds of the
// restart and not a minute later.
describe("createServerUpdateWatch", () => {
	// The restart: the proxy answers instead of the app.
	const AWAY: ServerHealth = PROXY_DOWN;

	function startWatch() {
		vi.useFakeTimers();
		const server = {
			health: DRAINING as ServerHealth,
			newVersion: false,
			versionCheckFails: false,
		};
		const looks: ServerUpdateLook[] = [];
		const ends: ServerUpdateWatchEnd[] = [];
		const watch = createServerUpdateWatch({
			fetchHealth: vi.fn(async () => server.health),
			checkVersion: vi.fn(async () => {
				if (server.versionCheckFails) throw new Error("offline");
				return server.newVersion;
			}),
			now: () => Date.now(),
			setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
			clearTimer: (handle) =>
				clearTimeout(handle as ReturnType<typeof setTimeout>),
			onLook: (look) => looks.push(look),
			onEnd: (end) => ends.push(end),
		});
		return { watch, server, looks, ends };
	}

	afterEach(() => {
		vi.useRealTimers();
	});

	it("looks at once on a sign, and then every three seconds", async () => {
		const { watch, looks } = startWatch();

		watch.sign();
		await vi.advanceTimersByTimeAsync(0);
		expect(looks).toHaveLength(1);

		await vi.advanceTimersByTimeAsync(SERVER_UPDATE_WATCH_POLL_MS - 1);
		expect(looks).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(looks).toHaveLength(2);
		await vi.advanceTimersByTimeAsync(SERVER_UPDATE_WATCH_POLL_MS * 3);
		expect(looks).toHaveLength(5);
	});

	it("reports what each look found: a draining server, the proxy answering for the app, a new version", async () => {
		const { watch, server, looks } = startWatch();

		watch.sign();
		await vi.advanceTimersByTimeAsync(0);
		server.health = AWAY;
		await vi.advanceTimersByTimeAsync(SERVER_UPDATE_WATCH_POLL_MS);
		server.health = UP;
		server.newVersion = true;
		await vi.advanceTimersByTimeAsync(SERVER_UPDATE_WATCH_POLL_MS);

		expect(looks).toEqual([
			{ draining: true, away: false, versionChanged: false },
			{ draining: false, away: true, versionChanged: false },
			{ draining: false, away: false, versionChanged: true },
		]);
	});

	it("ends when the new version is live, which is when the Refresh notice shows, and looks no more", async () => {
		const { watch, server, looks, ends } = startWatch();
		watch.sign();
		await vi.advanceTimersByTimeAsync(0);
		server.health = AWAY;
		await vi.advanceTimersByTimeAsync(SERVER_UPDATE_WATCH_POLL_MS * 10);
		expect(ends).toEqual([]);

		// The restart is over: the new process answers, with a new version.
		server.health = UP;
		server.newVersion = true;
		await vi.advanceTimersByTimeAsync(SERVER_UPDATE_WATCH_POLL_MS);

		expect(ends).toEqual(["update_ready"]);
		const looked = looks.length;
		await vi.advanceTimersByTimeAsync(SERVER_UPDATE_WATCH_POLL_MS * 5);
		expect(looks).toHaveLength(looked);
	});

	it("ends as a false alarm after a minute of a server that answers, is not draining and runs this version", async () => {
		const { watch, server, ends } = startWatch();
		server.health = UP;

		watch.sign();
		await vi.advanceTimersByTimeAsync(SERVER_UPDATE_WATCH_FALSE_ALARM_MS - 1);
		expect(ends).toEqual([]);
		await vi.advanceTimersByTimeAsync(SERVER_UPDATE_WATCH_POLL_MS);
		expect(ends).toEqual(["false_alarm"]);
	});

	it("does not call a restart a false alarm: a look that finds the server away starts the minute again", async () => {
		const { watch, server, ends } = startWatch();
		server.health = UP;

		watch.sign();
		await vi.advanceTimersByTimeAsync(
			SERVER_UPDATE_WATCH_FALSE_ALARM_MS - 5000,
		);
		server.health = AWAY;
		await vi.advanceTimersByTimeAsync(SERVER_UPDATE_WATCH_POLL_MS * 2);
		server.health = UP;
		await vi.advanceTimersByTimeAsync(
			SERVER_UPDATE_WATCH_FALSE_ALARM_MS - 5000,
		);
		expect(ends).toEqual([]);

		await vi.advanceTimersByTimeAsync(SERVER_UPDATE_WATCH_POLL_MS * 3);
		expect(ends).toEqual(["false_alarm"]);
	});

	it("gives up after eight minutes of a server that keeps draining", async () => {
		const { watch, ends } = startWatch();

		watch.sign();
		await vi.advanceTimersByTimeAsync(SERVER_UPDATE_WATCH_MAX_MS - 1);
		expect(ends).toEqual([]);
		await vi.advanceTimersByTimeAsync(SERVER_UPDATE_WATCH_POLL_MS);

		expect(ends).toEqual(["timed_out"]);
	});

	it("takes a version check that fails for no new version, and goes on looking", async () => {
		const { watch, server, looks, ends } = startWatch();
		server.versionCheckFails = true;

		watch.sign();
		await vi.advanceTimersByTimeAsync(SERVER_UPDATE_WATCH_POLL_MS * 2);

		expect(looks.every((look) => !look.versionChanged)).toBe(true);
		expect(looks.length).toBeGreaterThanOrEqual(3);
		expect(ends).toEqual([]);
	});

	it("starts its clock again on a sign while it watches, without a second loop", async () => {
		const { watch, looks, ends } = startWatch();

		watch.sign();
		await vi.advanceTimersByTimeAsync(SERVER_UPDATE_WATCH_MAX_MS - 10_000);
		watch.sign();
		const looked = looks.length;
		await vi.advanceTimersByTimeAsync(SERVER_UPDATE_WATCH_POLL_MS * 2);
		// One look every three seconds, as before: the sign did not start another loop.
		expect(looks.length - looked).toBeLessThanOrEqual(3);

		// Past the first clock's end, and still watching.
		await vi.advanceTimersByTimeAsync(20_000);
		expect(ends).toEqual([]);
		await vi.advanceTimersByTimeAsync(SERVER_UPDATE_WATCH_MAX_MS);
		expect(ends).toEqual(["timed_out"]);
	});

	it("watches again on a sign after it ended", async () => {
		const { watch, server, looks, ends } = startWatch();
		server.health = UP;
		watch.sign();
		await vi.advanceTimersByTimeAsync(
			SERVER_UPDATE_WATCH_FALSE_ALARM_MS + 5000,
		);
		expect(ends).toEqual(["false_alarm"]);

		const looked = looks.length;
		server.health = DRAINING;
		watch.sign();
		await vi.advanceTimersByTimeAsync(SERVER_UPDATE_WATCH_POLL_MS);

		expect(looks.length).toBeGreaterThan(looked);
		expect(looks.at(-1)).toMatchObject({ draining: true });
	});

	it("stops when the shell goes away: no more looks and no end", async () => {
		const { watch, looks, ends } = startWatch();
		watch.sign();
		await vi.advanceTimersByTimeAsync(0);

		watch.stop();
		const looked = looks.length;
		await vi.advanceTimersByTimeAsync(SERVER_UPDATE_WATCH_MAX_MS);

		expect(looks).toHaveLength(looked);
		expect(ends).toEqual([]);
	});

	// A phone that lost its signal gets no answer from the health route, and that is
	// neither the restart (the banner is for that) nor a calm server (a false alarm
	// needs a minute of those).
	it("takes a server that cannot be reached for neither away nor calm", async () => {
		const { watch, server, looks, ends } = startWatch();
		server.health = UNREACHABLE;

		watch.sign();
		await vi.advanceTimersByTimeAsync(SERVER_UPDATE_WATCH_FALSE_ALARM_MS * 2);

		expect(looks.every((look) => !look.away && !look.draining)).toBe(true);
		expect(looks.length).toBeGreaterThan(10);
		expect(ends).toEqual([]);
	});

	// SvelteKit's `updated.check()` has no timeout of its own: a stalled request must
	// not stop the watch for good, which it did when the next look waited for it.
	it("goes on looking when a version fetch never answers", async () => {
		vi.useFakeTimers();
		const looks: ServerUpdateLook[] = [];
		const checkVersion = vi.fn(() => new Promise<boolean>(() => {}));
		const watch = createServerUpdateWatch({
			fetchHealth: vi.fn(async () => PROXY_DOWN),
			checkVersion,
			now: () => Date.now(),
			...timers,
			onLook: (look) => looks.push(look),
			onEnd: () => {},
		});

		watch.sign();
		await vi.advanceTimersByTimeAsync(0);
		expect(looks).toHaveLength(0);
		await vi.advanceTimersByTimeAsync(SERVER_UPDATE_READ_MAX_MS);

		// The look found the proxy answering, and the version check as no change.
		expect(looks).toEqual([
			{ draining: false, away: true, versionChanged: false },
		]);
		// And the next look is made, three seconds after.
		await vi.advanceTimersByTimeAsync(SERVER_UPDATE_WATCH_POLL_MS);
		expect(checkVersion).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(
			SERVER_UPDATE_READ_MAX_MS + SERVER_UPDATE_WATCH_POLL_MS,
		);
		expect(checkVersion).toHaveBeenCalledTimes(3);
		watch.stop();
	});

	it("goes on looking when a health read never answers", async () => {
		vi.useFakeTimers();
		const looks: ServerUpdateLook[] = [];
		const fetchHealth = vi.fn(() => new Promise<ServerHealth>(() => {}));
		const watch = createServerUpdateWatch({
			fetchHealth,
			checkVersion: async () => false,
			now: () => Date.now(),
			...timers,
			onLook: (look) => looks.push(look),
			onEnd: () => {},
		});

		watch.sign();
		await vi.advanceTimersByTimeAsync(
			(SERVER_UPDATE_READ_MAX_MS + SERVER_UPDATE_WATCH_POLL_MS) * 2,
		);

		expect(fetchHealth.mock.calls.length).toBeGreaterThanOrEqual(2);
		expect(looks.every((look) => !look.away && !look.draining)).toBe(true);
		watch.stop();
	});

	it("reports nothing from a look that was out when it stopped", async () => {
		vi.useFakeTimers();
		let answer: (health: ServerHealth) => void = () => {};
		const looks: ServerUpdateLook[] = [];
		const watch = createServerUpdateWatch({
			fetchHealth: () =>
				new Promise<ServerHealth>((resolve) => {
					answer = resolve;
				}),
			checkVersion: async () => true,
			now: () => Date.now(),
			setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
			clearTimer: (handle) =>
				clearTimeout(handle as ReturnType<typeof setTimeout>),
			onLook: (look) => looks.push(look),
			onEnd: () => {},
		});

		watch.sign();
		watch.stop();
		answer(UP);
		await vi.advanceTimersByTimeAsync(0);

		expect(looks).toEqual([]);
	});
});
