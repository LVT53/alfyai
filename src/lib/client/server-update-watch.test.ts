import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServerHealth } from "$lib/client/api/health";
import {
	createServerUpdateWatch,
	isServerBeingUpdated,
	SERVER_UPDATE_WATCH_FALSE_ALARM_MS,
	SERVER_UPDATE_WATCH_MAX_MS,
	SERVER_UPDATE_WATCH_POLL_MS,
	type ServerUpdateLook,
	type ServerUpdateWatchEnd,
} from "./server-update-watch";

const WELL: ServerHealth = { reachable: true, draining: false };

function reads(
	overrides: Partial<Parameters<typeof isServerBeingUpdated>[0]> = {},
) {
	return {
		fetchHealth: vi.fn(async () => WELL),
		checkVersion: vi.fn(async () => false),
		isOffline: vi.fn(() => false),
		...overrides,
	};
}

describe("isServerBeingUpdated", () => {
	it("is no when the server answers, is not draining and runs the version this page has", async () => {
		const r = reads();

		expect(await isServerBeingUpdated(r)).toBe(false);
		expect(r.fetchHealth).toHaveBeenCalledTimes(1);
		expect(r.checkVersion).toHaveBeenCalledTimes(1);
	});

	it("is yes when the server says it is draining, without asking for the version", async () => {
		const r = reads({
			fetchHealth: vi.fn(async () => ({ reachable: true, draining: true })),
		});

		expect(await isServerBeingUpdated(r)).toBe(true);
		expect(r.checkVersion).not.toHaveBeenCalled();
	});

	// During the restart the version file cannot be read either, so "away" has to
	// count by itself.
	it("is yes when the server does not answer", async () => {
		const r = reads({
			fetchHealth: vi.fn(async () => ({ reachable: false, draining: false })),
			checkVersion: vi.fn(async () => false),
		});

		expect(await isServerBeingUpdated(r)).toBe(true);
	});

	it("is yes when a new version is live, though the server is well", async () => {
		const r = reads({ checkVersion: vi.fn(async () => true) });

		expect(await isServerBeingUpdated(r)).toBe(true);
	});

	it("is no when the version cannot be checked and nothing else says so", async () => {
		const r = reads({
			checkVersion: vi.fn(async () => {
				throw new Error("offline");
			}),
		});

		expect(await isServerBeingUpdated(r)).toBe(false);
	});

	// A phone that lost its connection cannot reach the server, and that is not an
	// update.
	it("is no for a browser that reports itself offline, whatever the server would say", async () => {
		const r = reads({
			isOffline: vi.fn(() => true),
			fetchHealth: vi.fn(async () => ({ reachable: false, draining: false })),
		});

		expect(await isServerBeingUpdated(r)).toBe(false);
		expect(r.fetchHealth).not.toHaveBeenCalled();
	});
});

// The shell's watch over a server update (ADR-0054, "An Update During A Turn").
// A sign says an update may be under way; the watch then looks at the server every
// few seconds, so the banner and the Refresh notice come up within seconds of the
// restart and not a minute later.
describe("createServerUpdateWatch", () => {
	const AWAY: ServerHealth = { reachable: false, draining: false };
	const DRAINING: ServerHealth = { reachable: true, draining: true };

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

	it("reports what each look found: a draining server, a server that does not answer, a new version", async () => {
		const { watch, server, looks } = startWatch();

		watch.sign();
		await vi.advanceTimersByTimeAsync(0);
		server.health = AWAY;
		await vi.advanceTimersByTimeAsync(SERVER_UPDATE_WATCH_POLL_MS);
		server.health = { reachable: true, draining: false };
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
		server.health = { reachable: true, draining: false };
		server.newVersion = true;
		await vi.advanceTimersByTimeAsync(SERVER_UPDATE_WATCH_POLL_MS);

		expect(ends).toEqual(["update_ready"]);
		const looked = looks.length;
		await vi.advanceTimersByTimeAsync(SERVER_UPDATE_WATCH_POLL_MS * 5);
		expect(looks).toHaveLength(looked);
	});

	it("ends as a false alarm after a minute of a server that answers, is not draining and runs this version", async () => {
		const { watch, server, ends } = startWatch();
		server.health = { reachable: true, draining: false };

		watch.sign();
		await vi.advanceTimersByTimeAsync(SERVER_UPDATE_WATCH_FALSE_ALARM_MS - 1);
		expect(ends).toEqual([]);
		await vi.advanceTimersByTimeAsync(SERVER_UPDATE_WATCH_POLL_MS);
		expect(ends).toEqual(["false_alarm"]);
	});

	it("does not call a restart a false alarm: a look that finds the server away starts the minute again", async () => {
		const { watch, server, ends } = startWatch();
		server.health = { reachable: true, draining: false };

		watch.sign();
		await vi.advanceTimersByTimeAsync(
			SERVER_UPDATE_WATCH_FALSE_ALARM_MS - 5000,
		);
		server.health = AWAY;
		await vi.advanceTimersByTimeAsync(SERVER_UPDATE_WATCH_POLL_MS * 2);
		server.health = { reachable: true, draining: false };
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
		server.health = { reachable: true, draining: false };
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
		answer({ reachable: true, draining: false });
		await vi.advanceTimersByTimeAsync(0);

		expect(looks).toEqual([]);
	});
});
