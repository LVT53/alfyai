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
		expect(extractionFromUploadResponse({ artifact: {}, extraction: dto }))
			.toEqual(dto);
	});

	it("tolerates an upload response that has no extraction field", () => {
		expect(
			extractionFromUploadResponse({ artifact: {}, promptReady: true }),
		).toBeNull();
		expect(extractionFromUploadResponse(undefined)).toBeNull();
	});
});
