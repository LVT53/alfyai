import { describe, expect, it, vi } from "vitest";
import type { DocumentExtractionJobDTO } from "$lib/shared/extraction-status";
import {
	cancelExtraction,
	createExtractionPoller,
	EXTRACTION_POLL_FAST_INTERVAL_MS,
	EXTRACTION_POLL_FAST_WINDOW_MS,
	EXTRACTION_POLL_MAX_IDS,
	EXTRACTION_POLL_SLOW_INTERVAL_MS,
	fetchExtractionJobs,
	retryExtraction,
} from "./_extraction-client";

function job(
	overrides: Partial<DocumentExtractionJobDTO> & { id: string },
): DocumentExtractionJobDTO {
	return {
		sourceArtifactId: overrides.id,
		normalizedArtifactId: null,
		status: "parsing",
		intakeRoute: "mineru",
		fileName: "report.pdf",
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

function jsonResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

describe("extraction endpoint client", () => {
	it("asks the batch endpoint for a comma-separated, deduped id list", async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValue(jsonResponse({ jobs: [job({ id: "a" })] }));

		const jobs = await fetchExtractionJobs(["a", "b", "a", ""], fetchImpl);

		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(String(fetchImpl.mock.calls[0][0])).toBe(
			"/api/knowledge/extraction?artifactIds=a%2Cb",
		);
		expect(jobs).toHaveLength(1);
	});

	it("never exceeds the endpoint's id cap", async () => {
		const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ jobs: [] }));
		const ids = Array.from({ length: 80 }, (_, index) => `id-${index}`);

		await fetchExtractionJobs(ids, fetchImpl);

		const url = new URL(String(fetchImpl.mock.calls[0][0]), "http://localhost");
		expect(url.searchParams.get("artifactIds")?.split(",")).toHaveLength(
			EXTRACTION_POLL_MAX_IDS,
		);
	});

	it("makes no request at all for an empty list", async () => {
		const fetchImpl = vi.fn();
		expect(await fetchExtractionJobs([], fetchImpl)).toEqual([]);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("posts retry and cancel to the artifact-keyed paths", async () => {
		// A fresh Response per call: a body can only be read once.
		const fetchImpl = vi
			.fn()
			.mockImplementation(async () =>
				jsonResponse({ job: job({ id: "a/b" }) }),
			);

		await retryExtraction("a/b", fetchImpl);
		await cancelExtraction("a/b", fetchImpl);

		expect(String(fetchImpl.mock.calls[0][0])).toBe(
			"/api/knowledge/extraction/a%2Fb/retry",
		);
		expect(fetchImpl.mock.calls[0][1]).toMatchObject({ method: "POST" });
		expect(String(fetchImpl.mock.calls[1][0])).toBe(
			"/api/knowledge/extraction/a%2Fb/cancel",
		);
	});
});

describe("createExtractionPoller", () => {
	function harness(options: {
		ids: () => string[];
		jobs: () => Promise<DocumentExtractionJobDTO[]>;
		hidden?: () => boolean;
	}) {
		let clock = 0;
		let pending: (() => void) | null = null;
		let lastDelay = 0;
		const onJobs = vi.fn();
		const onError = vi.fn();

		const poller = createExtractionPoller({
			getArtifactIds: options.ids,
			onJobs,
			onError,
			fetchJobs: options.jobs,
			now: () => clock,
			isHidden: options.hidden ?? (() => false),
			setTimer: (callback, ms) => {
				lastDelay = ms;
				pending = callback;
				return 1;
			},
			clearTimer: () => {
				pending = null;
			},
		});

		return {
			poller,
			onJobs,
			onError,
			get delay() {
				return lastDelay;
			},
			get armed() {
				return pending !== null;
			},
			advance(ms: number) {
				clock += ms;
			},
			async fire() {
				const callback = pending;
				pending = null;
				callback?.();
				await Promise.resolve();
				await Promise.resolve();
				await Promise.resolve();
			},
		};
	}

	it("polls fast for the first ten seconds and calmly after", async () => {
		const h = harness({
			ids: () => ["a"],
			jobs: async () => [job({ id: "a" })],
		});

		h.poller.start();
		expect(h.delay).toBe(EXTRACTION_POLL_FAST_INTERVAL_MS);

		await h.fire();
		expect(h.delay).toBe(EXTRACTION_POLL_FAST_INTERVAL_MS);

		h.advance(EXTRACTION_POLL_FAST_WINDOW_MS);
		await h.fire();
		expect(h.delay).toBe(EXTRACTION_POLL_SLOW_INTERVAL_MS);
	});

	it("disarms once every tracked job has settled", async () => {
		const h = harness({
			ids: () => ["a"],
			jobs: async () => [job({ id: "a", status: "succeeded" })],
		});

		h.poller.start();
		await h.fire();

		expect(h.onJobs).toHaveBeenCalledTimes(1);
		expect(h.armed).toBe(false);
	});

	it("disarms when there is nothing left to track", async () => {
		const fetchJobs = vi.fn(async () => []);
		const h = harness({ ids: () => [], jobs: fetchJobs });

		h.poller.start();
		await h.fire();

		expect(fetchJobs).not.toHaveBeenCalled();
		expect(h.armed).toBe(false);
	});

	it("skips the request while the tab is hidden but keeps the schedule", async () => {
		const fetchJobs = vi.fn(async () => [job({ id: "a" })]);
		let hidden = true;
		const h = harness({
			ids: () => ["a"],
			jobs: fetchJobs,
			hidden: () => hidden,
		});

		h.poller.start();
		await h.fire();
		expect(fetchJobs).not.toHaveBeenCalled();
		expect(h.armed).toBe(true);

		hidden = false;
		await h.fire();
		expect(fetchJobs).toHaveBeenCalledTimes(1);
	});

	it("keeps polling after a failed request rather than freezing a row", async () => {
		// A dropped request is not a verdict. If one failure disarmed the
		// poller the row would sit on "Extracting text" until a manual reload.
		const fetchJobs = vi
			.fn<() => Promise<DocumentExtractionJobDTO[]>>()
			.mockRejectedValueOnce(new Error("offline"))
			.mockResolvedValue([job({ id: "a", status: "succeeded" })]);
		const h = harness({ ids: () => ["a"], jobs: fetchJobs });

		h.poller.start();
		await h.fire();

		expect(h.onError).toHaveBeenCalledTimes(1);
		expect(h.armed).toBe(true);

		await h.fire();
		expect(h.onJobs).toHaveBeenCalledTimes(1);
		expect(h.armed).toBe(false);
	});

	it("is idempotent on start", () => {
		const setTimer = vi.fn(() => 1);
		const poller = createExtractionPoller({
			getArtifactIds: () => ["a"],
			onJobs: vi.fn(),
			fetchJobs: async () => [],
			now: () => 0,
			isHidden: () => false,
			setTimer,
			clearTimer: vi.fn(),
		});

		poller.start();
		poller.start();
		expect(setTimer).toHaveBeenCalledTimes(1);
	});
});
