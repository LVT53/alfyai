import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	anotherImageTake,
	awaitImageTakeSettled,
	imageFileUrl,
	retryImageTake,
	stopImageTake,
	useImageTake,
} from "./images";

function ok(body: unknown = {}, status = 200) {
	return vi.fn(
		async () =>
			new Response(JSON.stringify(body), {
				status,
				headers: { "Content-Type": "application/json" },
			}),
	);
}

describe("imageFileUrl", () => {
	it("builds the file URL with its options", () => {
		expect(imageFileUrl("f1")).toBe("/api/images/files/f1");
		expect(imageFileUrl("f1", { variant: "thumb", conversationId: "c1" })).toBe(
			"/api/images/files/f1?variant=thumb&conversationId=c1",
		);
		expect(
			imageFileUrl("f1", { variant: "display", conversationId: "c1" }),
		).toBe("/api/images/files/f1?variant=display&conversationId=c1");
		expect(imageFileUrl("f1", { download: true })).toBe(
			"/api/images/files/f1?download=1",
		);
	});
});

describe("image card actions", () => {
	it("posts Use this and answers the version number", async () => {
		const fetchMock = ok({ versionNumber: 3 });
		await expect(useImageTake("t1", "c1", fetchMock)).resolves.toEqual({
			versionNumber: 3,
		});
		expect(fetchMock).toHaveBeenCalledWith(
			"/api/images/takes/t1/use?conversationId=c1",
			{ method: "POST" },
		);
	});

	it("posts Another and answers the take id", async () => {
		const fetchMock = ok({ takeId: "t9" }, 201);
		await expect(anotherImageTake("card1", null, fetchMock)).resolves.toEqual({
			takeId: "t9",
		});
		expect(fetchMock).toHaveBeenCalledWith("/api/images/cards/card1/another", {
			method: "POST",
		});
	});

	it("posts Stop and Try again", async () => {
		const stop = ok({ ok: true });
		await stopImageTake("t1", undefined, stop);
		expect(stop).toHaveBeenCalledWith("/api/images/takes/t1/stop", {
			method: "POST",
		});
		const retry = ok({ ok: true });
		await retryImageTake("t1", "c1", retry);
		expect(retry).toHaveBeenCalledWith(
			"/api/images/takes/t1/retry?conversationId=c1",
			{ method: "POST" },
		);
	});

	it("throws when the server refuses", async () => {
		const refused = ok({ error: "not_ready" }, 409);
		await expect(useImageTake("t1", null, refused)).rejects.toThrow();
	});
});

/** The browser's EventSource, as jsdom does not have one: the test drives it. */
const fakeSources: FakeEventSource[] = [];

class FakeEventSource {
	readonly url: string;
	closed = false;
	private readonly listeners = new Map<string, Set<(event: Event) => void>>();

	constructor(url: string) {
		this.url = url;
		fakeSources.push(this);
	}

	addEventListener(type: string, listener: EventListener) {
		let set = this.listeners.get(type);
		if (!set) {
			set = new Set();
			this.listeners.set(type, set);
		}
		set.add(listener as (event: Event) => void);
	}

	removeEventListener(type: string, listener: EventListener) {
		this.listeners.get(type)?.delete(listener as (event: Event) => void);
	}

	close() {
		this.closed = true;
	}

	emit(type: string, data?: unknown) {
		for (const listener of [...(this.listeners.get(type) ?? [])]) {
			listener({
				data: data === undefined ? undefined : JSON.stringify(data),
			} as Event);
		}
	}
}

describe("awaitImageTakeSettled", () => {
	beforeEach(() => {
		fakeSources.length = 0;
		vi.stubGlobal("EventSource", FakeEventSource);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("opens the take's events channel and closes it on the settled event", async () => {
		const onSettled = vi.fn();
		const waiting = awaitImageTakeSettled("c1", "t1", { onSettled });
		const source = fakeSources.at(-1);
		expect(source?.url).toBe("/api/images/takes/t1/events?conversationId=c1");

		source?.emit("settled", { takeId: "t1", status: "succeeded" });

		await expect(waiting).resolves.toEqual({ settled: true });
		expect(source?.closed).toBe(true);
		expect(onSettled).toHaveBeenCalledTimes(1);
	});

	it("leaves the chat out of the URL when none is named", async () => {
		void awaitImageTakeSettled(null, "t1");
		expect(fakeSources.at(-1)?.url).toBe("/api/images/takes/t1/events");
	});

	it("answers settled false when the EventSource errors, and closes it", async () => {
		const waiting = awaitImageTakeSettled("c1", "t1");
		const source = fakeSources.at(-1);

		source?.emit("error");

		await expect(waiting).resolves.toEqual({ settled: false });
		expect(source?.closed).toBe(true);
	});

	it("closes the stream and answers settled false when the caller aborts", async () => {
		const controller = new AbortController();
		const waiting = awaitImageTakeSettled("c1", "t1", {
			signal: controller.signal,
		});
		const source = fakeSources.at(-1);

		controller.abort();

		await expect(waiting).resolves.toEqual({ settled: false });
		expect(source?.closed).toBe(true);
	});

	it("opens nothing on a signal that is already aborted", async () => {
		const controller = new AbortController();
		controller.abort();

		await expect(
			awaitImageTakeSettled("c1", "t1", { signal: controller.signal }),
		).resolves.toEqual({ settled: false });
		expect(fakeSources).toHaveLength(0);
	});
});
