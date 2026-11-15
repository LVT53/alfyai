import { render, screen } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AppVersionPreview from "./AppVersionPreview.svelte";

const versionBody = vi.fn();
vi.mock("$lib/components/artifacts/history/version-bodies", () => ({
	versionBody: (...args: unknown[]) => versionBody(...args),
}));

const props = {
	artifactId: "app-1",
	conversationId: null,
	versionId: "v2",
	baseVersionId: "v1",
	compare: "step" as const,
	author: "alfy" as const,
	nowVersionId: "v2",
	nowHash: "hash-2",
	label: "Version 2",
	changeCursor: { index: -1, nonce: 0 },
	onState: vi.fn(),
};

beforeEach(() => {
	vi.clearAllMocks();
	versionBody.mockResolvedValue(
		"<!doctype html><html><body><h1>Budget</h1></body></html>",
	);
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => ({ status: 200 })),
	);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

// W11 (UI wishes, 2026-11): the selected segment's right padding was the one
// thing the two controls disagreed about. Both controls now size their tracks
// equally (an inline grid of 1fr columns), so the selected background fills
// exactly one segment — the defect was present in both, so it is fixed in both.
describe("AppVersionPreview — the Preview/Code control", () => {
	// jsdom renders no stylesheet (see DocumentsList.test.ts's own note): the
	// rule text is the only thing here that can pin the fix. The real geometry
	// is measured by artifact-app.spec.ts in a browser.
	it("gives both segments equal inner padding in one equal-track control", async () => {
		const { container } = render(AppVersionPreview, props);
		await screen.findByRole("tab", { name: /Preview/ });
		expect(container.querySelector(".seg")).not.toBeNull();
		expect(container.querySelectorAll(".seg-tab")).toHaveLength(2);

		const source = await import("./AppVersionPreview.svelte?raw");
		const styleText =
			source.default.match(/<style>([\s\S]*)<\/style>/)?.[1] ?? "";
		const segRule = styleText.match(/\.seg\s*\{([^}]*)\}/)?.[1] ?? "";
		expect(segRule).toMatch(/display:\s*inline-grid/);
		expect(segRule).toMatch(/grid-auto-flow:\s*column/);
		expect(segRule).toMatch(/grid-auto-columns:\s*1fr/);

		const tabRule = styleText.match(/\.seg-tab\s*\{([^}]*)\}/)?.[1] ?? "";
		expect(tabRule).toMatch(/padding:\s*0\.25rem 0\.75rem/);
		// No width shift on selection: this control's selected state changes
		// only the surface and colour; the weight is the same in both states,
		// unlike AppBody's bold-selected label (which reserves its bold width).
		expect(tabRule).toMatch(/font-weight:\s*600/);
		const selectedRule =
			styleText.match(/\.seg-tab\[aria-selected='true'\]\s*\{([^}]*)\}/)?.[1] ??
			"";
		expect(selectedRule).not.toMatch(/font-weight/);
	});
});
