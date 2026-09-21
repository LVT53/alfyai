import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type MineruHealthLike,
	type MineruProbeClient,
	MineruProbeError,
	resetMineruCapabilitiesCacheForTests,
	setMineruProbeClientFactory,
} from "$lib/server/services/mineru/capabilities";
import { getMineru4GatedFileTypeIds } from "$lib/shared/file-types";
import {
	getUploadFormatGate,
	resolveEffectiveIntakeRoute,
} from "./format-availability";

function fakeClient(
	overrides: Partial<MineruProbeClient> = {},
): MineruProbeClient {
	return {
		getHealth: vi.fn(
			async (): Promise<MineruHealthLike> => ({ version: "4.0.4" }),
		),
		getTiers: vi.fn(async () => []),
		getUsage: vi.fn(async () => ({})),
		...overrides,
	};
}

beforeEach(() => {
	resetMineruCapabilitiesCacheForTests();
});

afterEach(() => {
	setMineruProbeClientFactory(null);
	resetMineruCapabilitiesCacheForTests();
});

describe("getUploadFormatGate", () => {
	it("fails open, and does not block, when the cache is cold and the probe cannot finish", async () => {
		// A `getHealth` that never resolves stands in for a cold cache plus a
		// slow/hanging network call. If this call ever awaited the real probe it
		// would hang forever and the test would time out; resolving at all,
		// quickly, IS the assertion that the upload hot path never blocks on the
		// network (spec §3.5 / the slice's "never make a network call" rule).
		setMineruProbeClientFactory(() =>
			fakeClient({
				getHealth: vi.fn(() => new Promise<MineruHealthLike>(() => {})),
			}),
		);

		const gate = await getUploadFormatGate();

		expect(gate.reason).toBeNull();
		expect(gate.disabledEntryIds.size).toBe(0);
		expect(gate.backendVersion).toBeNull();
	});

	it("stays open on a reachable 4.x backend", async () => {
		setMineruProbeClientFactory(() =>
			fakeClient({ getHealth: vi.fn(async () => ({ version: "4.0.4" })) }),
		);

		const gate = await getUploadFormatGate();

		expect(gate.reason).toBeNull();
		expect(gate.disabledEntryIds.size).toBe(0);
	});

	it("closes on a reachable pre-4 health response, disabling exactly the gated ids", async () => {
		setMineruProbeClientFactory(() =>
			fakeClient({ getHealth: vi.fn(async () => ({ version: "3.9.0" })) }),
		);

		const gate = await getUploadFormatGate();

		expect(gate.reason).toBe("backend_version");
		expect(gate.backendVersion).toBe("3.9.0");
		expect([...gate.disabledEntryIds].sort()).toEqual(
			[...getMineru4GatedFileTypeIds()].sort(),
		);
	});

	it("closes when /v1/health fails in the 'no /v1 namespace' (pre-4) shape", async () => {
		setMineruProbeClientFactory(() =>
			fakeClient({
				getHealth: vi.fn(async () => {
					throw new MineruProbeError("protocol", "404 Not Found");
				}),
			}),
		);

		const gate = await getUploadFormatGate();

		expect(gate.reason).toBe("backend_version");
		// The server never answered a version at all.
		expect(gate.backendVersion).toBeNull();
	});

	it("stays open on a generic transport failure (connection refused)", async () => {
		setMineruProbeClientFactory(() =>
			fakeClient({
				getHealth: vi.fn(async () => {
					throw Object.assign(new Error("connect ECONNREFUSED"), {
						code: "ECONNREFUSED",
					});
				}),
			}),
		);

		const gate = await getUploadFormatGate();

		expect(gate.reason).toBeNull();
	});

	it("stays open when the reported version cannot be parsed", async () => {
		setMineruProbeClientFactory(() =>
			fakeClient({ getHealth: vi.fn(async () => ({ version: "unknown" })) }),
		);

		const gate = await getUploadFormatGate();

		expect(gate.reason).toBeNull();
	});

	it("shares exactly one in-flight probe across a concurrent burst", async () => {
		const getHealth = vi.fn(async () => ({ version: "4.0.4" }));
		setMineruProbeClientFactory(() => fakeClient({ getHealth }));

		const [a, b, c] = await Promise.all([
			getUploadFormatGate(),
			getUploadFormatGate(),
			getUploadFormatGate(),
		]);

		expect(getHealth).toHaveBeenCalledTimes(1);
		expect(a.reason).toBeNull();
		expect(b.reason).toBeNull();
		expect(c.reason).toBeNull();
	});
});

describe("resolveEffectiveIntakeRoute", () => {
	it("returns the base route when the gate is open", () => {
		expect(
			resolveEffectiveIntakeRoute("page.html", "text/html", { reason: null }),
		).toBe("mineru");
	});

	it("degrades html to direct-text when the gate has closed", () => {
		expect(
			resolveEffectiveIntakeRoute("page.html", "text/html", {
				reason: "backend_version",
			}),
		).toBe("direct-text");
		expect(
			resolveEffectiveIntakeRoute("legacy.htm", null, {
				reason: "backend_version",
			}),
		).toBe("direct-text");
	});

	it("leaves a gated entry with no fallback on its base route even when closed", () => {
		// Refusing rtf/odt/ods/odp/epub is the admission layer's job; a caller
		// that reaches this far with one of them (it should not) gets the
		// unchanged base route rather than a silently invented fallback.
		expect(
			resolveEffectiveIntakeRoute("notes.rtf", "application/rtf", {
				reason: "backend_version",
			}),
		).toBe("mineru");
	});

	it("leaves an ungated route untouched regardless of the gate", () => {
		expect(
			resolveEffectiveIntakeRoute("report.pdf", "application/pdf", {
				reason: "backend_version",
			}),
		).toBe("mineru");
		expect(
			resolveEffectiveIntakeRoute("data.tsv", "text/tab-separated-values", {
				reason: "backend_version",
			}),
		).toBe("direct-text");
	});
});
