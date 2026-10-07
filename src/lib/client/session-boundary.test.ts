import { afterEach, describe, expect, it, vi } from "vitest";

const TOUR = {
	artifactType: "canvas",
	contentKey: "default:1",
	source: "default",
	slides: [{ title: { en: "One", hu: "Egy" }, body: { en: "a", hu: "a" } }],
	summary: { en: "Empty board.", hu: "Üres tábla." },
};

// The one client boundary signing out and in cross (`Sidebar`, `Header`, the
// login page): everything the page remembered about an account goes with it.
describe("clearClientAccountState", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("drops the tours the page was told, so the next reader is asked for their own", async () => {
		const fetchStub = vi.fn(
			async () =>
				new Response(
					JSON.stringify({ ok: true, tour: TOUR, seen: true, lastSlide: 0 }),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
		);
		vi.stubGlobal("fetch", fetchStub);
		vi.resetModules();
		const { getArtifactTour } = await import("$lib/client/api/artifact-tours");
		const { clearClientAccountState } = await import("./session-boundary");

		await getArtifactTour("canvas");
		await getArtifactTour("canvas");
		expect(fetchStub).toHaveBeenCalledTimes(1);

		clearClientAccountState();

		await getArtifactTour("canvas");
		expect(fetchStub).toHaveBeenCalledTimes(2);
	});
});
