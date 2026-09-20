import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocumentExtractionJobDTO } from "$lib/shared/extraction-status";
import {
	createExtractionPoller,
	EXTRACTION_POLL_BATCH_SIZE,
	extractionFromUploadResponse,
	readExtractionJobDTO,
} from "./extraction-poll";

function job(
	overrides: Partial<DocumentExtractionJobDTO> & { sourceArtifactId: string },
): DocumentExtractionJobDTO {
	return {
		id: `job-${overrides.sourceArtifactId}`,
		normalizedArtifactId: null,
		status: "parsing",
		intakeRoute: "mineru",
		fileName: "doc.pdf",
		attemptCount: 1,
		maxAttempts: 3,
		retryable: false,
		cancelable: true,
		error: null,
		createdAt: 0,
		updatedAt: 0,
		startedAt: null,
		legacy: false,
		...overrides,
	};
}

function setVisibility(state: "visible" | "hidden") {
	Object.defineProperty(document, "visibilityState", {
		configurable: true,
		get: () => state,
	});
	document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
	vi.useFakeTimers();
	setVisibility("visible");
});

afterEach(() => {
	vi.useRealTimers();
});

describe("createExtractionPoller", () => {
	it("does not arm when there is nothing to track", () => {
		const fetchJobs = vi.fn();
		const poller = createExtractionPoller({
			getArtifactIds: () => [],
			onJobs: vi.fn(),
			fetchJobs,
		});

		poller.sync();
		vi.advanceTimersByTime(10_000);

		expect(poller.active).toBe(false);
		expect(fetchJobs).not.toHaveBeenCalled();
		poller.stop();
	});

	it("polls every second for the first ten, then every 2.5", async () => {
		const fetchJobs = vi.fn(async () => [job({ sourceArtifactId: "a" })]);
		const poller = createExtractionPoller({
			getArtifactIds: () => ["a"],
			onJobs: vi.fn(),
			fetchJobs,
			now: () => Date.now(),
		});

		poller.sync();
		expect(fetchJobs).not.toHaveBeenCalled();

		// Five fast ticks inside the ten-second window.
		for (let tick = 1; tick <= 5; tick += 1) {
			await vi.advanceTimersByTimeAsync(1000);
			expect(fetchJobs).toHaveBeenCalledTimes(tick);
		}

		// Past the escalation point a one-second wait is no longer enough.
		await vi.advanceTimersByTimeAsync(5000);
		const beforeEscalation = fetchJobs.mock.calls.length;
		await vi.advanceTimersByTimeAsync(1000);
		expect(fetchJobs).toHaveBeenCalledTimes(beforeEscalation);
		await vi.advanceTimersByTimeAsync(1500);
		expect(fetchJobs).toHaveBeenCalledTimes(beforeEscalation + 1);

		poller.stop();
	});

	it("disarms once every tracked job is terminal", async () => {
		let status: DocumentExtractionJobDTO["status"] = "parsing";
		const fetchJobs = vi.fn(async () => [
			job({ sourceArtifactId: "a", status }),
		]);
		const onJobs = vi.fn();
		const poller = createExtractionPoller({
			getArtifactIds: () => ["a"],
			onJobs,
			fetchJobs,
		});

		poller.sync();
		await vi.advanceTimersByTimeAsync(1000);
		expect(poller.active).toBe(true);

		status = "succeeded";
		await vi.advanceTimersByTimeAsync(1000);
		expect(fetchJobs).toHaveBeenCalledTimes(2);
		expect(poller.active).toBe(false);

		await vi.advanceTimersByTimeAsync(20_000);
		expect(fetchJobs).toHaveBeenCalledTimes(2);
		expect(onJobs).toHaveBeenCalledTimes(2);

		poller.stop();
	});

	it("stops polling while the tab is hidden and polls once on return", async () => {
		const fetchJobs = vi.fn(async () => [job({ sourceArtifactId: "a" })]);
		const poller = createExtractionPoller({
			getArtifactIds: () => ["a"],
			onJobs: vi.fn(),
			fetchJobs,
		});

		poller.sync();
		await vi.advanceTimersByTimeAsync(1000);
		expect(fetchJobs).toHaveBeenCalledTimes(1);

		setVisibility("hidden");
		expect(poller.active).toBe(false);
		await vi.advanceTimersByTimeAsync(10_000);
		expect(fetchJobs).toHaveBeenCalledTimes(1);

		setVisibility("visible");
		await vi.advanceTimersByTimeAsync(0);
		expect(fetchJobs).toHaveBeenCalledTimes(2);

		poller.stop();
	});

	it("never has two requests in flight", async () => {
		let inFlight = 0;
		let peak = 0;
		const fetchJobs = vi.fn(async () => {
			inFlight += 1;
			peak = Math.max(peak, inFlight);
			await new Promise((resolve) => setTimeout(resolve, 4000));
			inFlight -= 1;
			return [job({ sourceArtifactId: "a" })];
		});
		const poller = createExtractionPoller({
			getArtifactIds: () => ["a"],
			onJobs: vi.fn(),
			fetchJobs,
		});

		poller.sync();
		await vi.advanceTimersByTimeAsync(1000);
		void poller.refresh();
		void poller.refresh();
		await vi.advanceTimersByTimeAsync(4000);

		expect(peak).toBe(1);
		poller.stop();
	});

	it("chunks more ids than the endpoint accepts in one call", async () => {
		const ids = Array.from(
			{ length: EXTRACTION_POLL_BATCH_SIZE + 3 },
			(_, index) => `artifact-${index}`,
		);
		const fetchJobs = vi.fn(async (batch: string[]) =>
			batch.map((id) => job({ sourceArtifactId: id })),
		);
		const poller = createExtractionPoller({
			getArtifactIds: () => ids,
			onJobs: vi.fn(),
			fetchJobs,
		});

		poller.sync();
		await vi.advanceTimersByTimeAsync(1000);

		expect(fetchJobs).toHaveBeenCalledTimes(2);
		expect(fetchJobs.mock.calls[0]?.[0]).toHaveLength(
			EXTRACTION_POLL_BATCH_SIZE,
		);
		expect(fetchJobs.mock.calls[1]?.[0]).toHaveLength(3);

		poller.stop();
	});

	// F22. A chunk that failed used to throw the whole poll away, so a
	// Knowledge page past fifty documents could show nothing at all because its
	// last chunk hiccuped — and the ids of the failed chunk were then retired
	// as "unanswerable" on the strength of a request that never landed.
	it("keeps the chunks that answered when a later one fails", async () => {
		const ids = Array.from(
			{ length: EXTRACTION_POLL_BATCH_SIZE + 3 },
			(_, index) => `artifact-${index}`,
		);
		const fetchJobs = vi
			.fn<(batch: string[]) => Promise<DocumentExtractionJobDTO[]>>()
			.mockImplementationOnce(async (batch) =>
				batch.map((id) => job({ sourceArtifactId: id })),
			)
			.mockRejectedValueOnce(new Error("offline"))
			.mockImplementation(async (batch) =>
				batch.map((id) => job({ sourceArtifactId: id })),
			);
		const onJobs = vi.fn();
		const onError = vi.fn();
		const poller = createExtractionPoller({
			getArtifactIds: () => ids,
			onJobs,
			onError,
			fetchJobs,
		});

		poller.sync();
		await vi.advanceTimersByTimeAsync(1000);

		expect(onJobs).toHaveBeenCalledTimes(1);
		expect(onJobs.mock.calls[0]?.[0]).toHaveLength(EXTRACTION_POLL_BATCH_SIZE);
		expect(onError).toHaveBeenCalledTimes(1);

		// The tail is still tracked: it was never answered, only never asked.
		await vi.advanceTimersByTimeAsync(1000);
		const tailBatches = fetchJobs.mock.calls
			.slice(2)
			.map((call) => call[0]?.length);
		expect(tailBatches).toContain(3);

		poller.stop();
	});

	// F22. `lastStatus` and `unresolved` grew for the lifetime of the poller: a
	// composer that uploads and removes files all afternoon never dropped a
	// single entry.
	it("forgets ids the caller stopped tracking", async () => {
		let tracked = ["a", "b"];
		const fetchJobs = vi.fn(async (batch: string[]) =>
			batch.map((id) => job({ sourceArtifactId: id, status: "succeeded" })),
		);
		const poller = createExtractionPoller({
			getArtifactIds: () => tracked,
			onJobs: vi.fn(),
			fetchJobs,
		});

		poller.sync();
		await vi.advanceTimersByTimeAsync(1000);
		expect(fetchJobs).toHaveBeenCalledTimes(1);

		// "a" goes away and comes back — a fresh upload of the same document
		// after a delete, which reuses nothing but must not be answered from a
		// status remembered for the row that no longer exists.
		tracked = ["b"];
		poller.sync();
		tracked = ["a", "b"];
		poller.sync();
		await vi.advanceTimersByTimeAsync(1000);

		expect(fetchJobs).toHaveBeenCalledTimes(2);
		await poller.refresh();
		poller.stop();
	});

	it("stops tracking an id the endpoint declines to answer for", async () => {
		const fetchJobs = vi.fn(async () => []);
		const onError = vi.fn();
		const poller = createExtractionPoller({
			getArtifactIds: () => ["someone-elses-artifact"],
			onJobs: vi.fn(),
			onError,
			fetchJobs,
		});

		poller.sync();
		await vi.advanceTimersByTimeAsync(1000);
		expect(fetchJobs).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(20_000);
		expect(fetchJobs).toHaveBeenCalledTimes(1);
		expect(onError).not.toHaveBeenCalled();

		poller.stop();
	});

	it("keeps polling after a failed request and reports it", async () => {
		const fetchJobs = vi
			.fn<(ids: string[]) => Promise<DocumentExtractionJobDTO[]>>()
			.mockRejectedValueOnce(new Error("offline"))
			.mockResolvedValue([job({ sourceArtifactId: "a" })]);
		const onError = vi.fn();
		const poller = createExtractionPoller({
			getArtifactIds: () => ["a"],
			onJobs: vi.fn(),
			onError,
			fetchJobs,
		});

		poller.sync();
		await vi.advanceTimersByTimeAsync(1000);
		expect(onError).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(1000);
		expect(fetchJobs).toHaveBeenCalledTimes(2);

		poller.stop();
	});

	it("stops for good when the session is gone", async () => {
		// A session that ended in another tab answers 401 to every poll. Retrying
		// that is a request every 2.5 s that can never succeed — silent on the
		// composer, where onError is a no-op, while Send stays blocked because no
		// DTO ever arrives.
		const unauthorized = Object.assign(new Error("Unauthorized"), {
			status: 401,
		});
		const fetchJobs = vi
			.fn<(ids: string[]) => Promise<DocumentExtractionJobDTO[]>>()
			.mockRejectedValue(unauthorized);
		const onError = vi.fn();
		const poller = createExtractionPoller({
			getArtifactIds: () => ["a"],
			onJobs: vi.fn(),
			onError,
			fetchJobs,
		});

		poller.sync();
		await vi.advanceTimersByTimeAsync(1000);
		expect(fetchJobs).toHaveBeenCalledTimes(1);
		expect(onError).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(30_000);
		expect(fetchJobs).toHaveBeenCalledTimes(1);
		expect(poller.active).toBe(false);

		poller.stop();
	});

	it("keeps retrying a transient failure", async () => {
		// A 500 or a dropped connection is not a reason to give up: the box may
		// be mid-restart and the job is still running.
		const serverError = Object.assign(new Error("boom"), { status: 500 });
		const fetchJobs = vi
			.fn<(ids: string[]) => Promise<DocumentExtractionJobDTO[]>>()
			.mockRejectedValueOnce(serverError)
			.mockResolvedValue([job({ sourceArtifactId: "a" })]);
		const poller = createExtractionPoller({
			getArtifactIds: () => ["a"],
			onJobs: vi.fn(),
			onError: vi.fn(),
			fetchJobs,
		});

		poller.sync();
		await vi.advanceTimersByTimeAsync(1000);
		await vi.advanceTimersByTimeAsync(1000);
		expect(fetchJobs).toHaveBeenCalledTimes(2);

		poller.stop();
	});

	it("leaves no timer and no listener behind on stop", async () => {
		const removeSpy = vi.spyOn(document, "removeEventListener");
		const fetchJobs = vi.fn(async () => [job({ sourceArtifactId: "a" })]);
		const poller = createExtractionPoller({
			getArtifactIds: () => ["a"],
			onJobs: vi.fn(),
			fetchJobs,
		});

		poller.sync();
		await vi.advanceTimersByTimeAsync(1000);
		poller.stop();

		expect(poller.active).toBe(false);
		expect(vi.getTimerCount()).toBe(0);
		expect(removeSpy).toHaveBeenCalledWith(
			"visibilitychange",
			expect.any(Function),
		);

		await vi.advanceTimersByTimeAsync(20_000);
		expect(fetchJobs).toHaveBeenCalledTimes(1);
		removeSpy.mockRestore();
	});

	it("adopts a DTO it did not fetch, so a settled job never arms it", async () => {
		const fetchJobs = vi.fn(async () => [job({ sourceArtifactId: "a" })]);
		const poller = createExtractionPoller({
			getArtifactIds: () => ["a"],
			onJobs: vi.fn(),
			fetchJobs,
		});

		poller.observe(job({ sourceArtifactId: "a", status: "succeeded" }));
		poller.sync();
		await vi.advanceTimersByTimeAsync(20_000);

		expect(fetchJobs).not.toHaveBeenCalled();
		poller.stop();
	});
});

describe("readExtractionJobDTO", () => {
	it("accepts a well-formed DTO", () => {
		const dto = job({ sourceArtifactId: "a" });
		expect(readExtractionJobDTO(dto)).toEqual(dto);
	});

	it("rejects anything without an id and a known status", () => {
		expect(readExtractionJobDTO(null)).toBeNull();
		expect(readExtractionJobDTO({ id: "x" })).toBeNull();
		expect(readExtractionJobDTO({ id: "x", status: "elsewhere" })).toBeNull();
		expect(readExtractionJobDTO({ status: "queued" })).toBeNull();
	});
});

describe("extractionFromUploadResponse", () => {
	it("reads the field when the server sends one", () => {
		const dto = job({ sourceArtifactId: "a" });
		expect(
			extractionFromUploadResponse({ artifact: {}, extraction: dto }),
		).toEqual(dto);
	});

	it("tolerates an upload response that has no extraction field", () => {
		expect(
			extractionFromUploadResponse({ artifact: {}, promptReady: true }),
		).toBeNull();
		expect(extractionFromUploadResponse(undefined)).toBeNull();
	});
});
