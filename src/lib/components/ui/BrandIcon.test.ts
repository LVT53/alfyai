import { render, screen } from "@testing-library/svelte";
import { describe, expect, it } from "vitest";
import BrandIcon from "./BrandIcon.svelte";
import {
	BRAND_GLYPHS,
	type BrandIconProvider,
	MIN_CONTAINMENT_FRACTION,
	OPTICAL_TARGET_FRACTION,
} from "./brand-icon-data";

function renderIcon(overrides: Record<string, unknown> = {}) {
	return render(BrandIcon, {
		props: {
			provider: "google",
			...overrides,
		},
	});
}

describe("BrandIcon", () => {
	it("renders the vendored brand glyph for a known provider", () => {
		renderIcon({ provider: "google" });

		const icon = screen.getByRole("img", { name: "Google" });
		expect(icon.tagName).toBe("svg");
		expect(icon.querySelector("path")).not.toBeNull();
	});

	it.each([
		["gmail", "Gmail"],
		["nextcloud", "Nextcloud"],
		["immich", "Immich"],
		["apple", "Apple"],
		["plex", "Plex"],
		["github", "GitHub"],
	])("renders the vendored glyph for %s", (provider, name) => {
		renderIcon({ provider });

		const icon = screen.getByRole("img", { name });
		expect(icon.tagName).toBe("svg");
	});

	it("falls back to the Lucide MapPin glyph for owntracks", () => {
		renderIcon({ provider: "owntracks" });

		const icon = screen.getByRole("img", { name: "OwnTracks" });
		expect(icon.querySelector("svg")).not.toBeNull();
		expect(icon.querySelector("svg")?.getAttribute("class")).toContain(
			"lucide-map-pin",
		);
	});

	it.each([
		"imap",
		"email",
	])("falls back to the Lucide Mail glyph for %s", (provider) => {
		renderIcon({ provider });

		const icon = screen.getByRole("img");
		expect(icon.querySelector("svg")?.getAttribute("class")).toContain(
			"lucide-mail",
		);
	});

	it("falls back to a generic glyph for an unknown provider", () => {
		renderIcon({ provider: "some-unknown-thing" });

		const icon = screen.getByRole("img", { name: "Some-unknown-thing" });
		expect(icon.querySelector("svg")).not.toBeNull();
	});

	it("applies the requested size", () => {
		renderIcon({ provider: "google", size: 32 });

		const icon = screen.getByRole("img", { name: "Google" });
		expect(icon).toHaveAttribute("width", "32");
		expect(icon).toHaveAttribute("height", "32");
	});

	it("uses an explicit title over the humanized provider name", () => {
		renderIcon({ provider: "nextcloud", title: "My Nextcloud account" });

		expect(
			screen.getByRole("img", { name: "My Nextcloud account" }),
		).toBeInTheDocument();
	});

	it("is hidden from the accessibility tree when ariaHidden is set", () => {
		renderIcon({ provider: "google", ariaHidden: true });

		expect(screen.queryByRole("img")).not.toBeInTheDocument();
	});

	describe("optical-size normalization (R3-fix #2)", () => {
		// Google's "G" nearly fills its raw 24x24 source box while Nextcloud's
		// wordmark-free logo is a short, wide band — rendering both with a
		// literal "0 0 24 24" viewBox made Nextcloud/Plex look visibly smaller
		// than Google/Immich at the same `size`. Each glyph now gets its own
		// square viewBox, sized/centered so its bounding box occupies the same
		// fraction of that square (see brand-icon-data.ts module doc). This
		// asserts the invariant directly from the data (no DOM bbox APIs,
		// which aren't available in SSR/jsdom) — every provider's occupied
		// fraction should be the same, within floating-point rounding.
		// R3-fix2 #1 — the geometric-mean optical-size formula alone hits the
		// 0.8 target fraction for near-square glyphs, but for very oblong
		// glyphs (Nextcloud, Plex: ~24 wide, ~11 tall) it under-sizes the box
		// relative to the glyph's longest dimension, clipping it. Those two now
		// get a LARGER box (the containment floor below), so they no longer
		// hit the 0.8 optical fraction — only the unaffected, near-square
		// providers still do.
		it("gives near-square-glyph providers the target optical-size fraction", () => {
			const nearSquareProviders: BrandIconProvider[] = [
				"google",
				"gmail",
				"immich",
				"apple",
				"github",
			];

			for (const provider of nearSquareProviders) {
				const glyph = BRAND_GLYPHS[provider];
				const [, , sideStr] = glyph.viewBox.split(" ");
				const side = Number(sideStr);
				const opticalSize = Math.sqrt(glyph.bbox.width * glyph.bbox.height);
				const occupiedFraction = opticalSize / side;
				expect(occupiedFraction).toBeCloseTo(OPTICAL_TARGET_FRACTION, 2);
			}
		});

		it("grows oblong providers (Nextcloud, Plex) past the optical fraction to hit the containment floor instead", () => {
			const oblongProviders: BrandIconProvider[] = ["nextcloud", "plex"];

			for (const provider of oblongProviders) {
				const glyph = BRAND_GLYPHS[provider];
				const [, , sideStr] = glyph.viewBox.split(" ");
				const side = Number(sideStr);
				const opticalSize = Math.sqrt(glyph.bbox.width * glyph.bbox.height);
				const opticalFraction = opticalSize / side;
				// Smaller than the near-square target — the box grew beyond what
				// the optical-size formula alone would have produced.
				expect(opticalFraction).toBeLessThan(OPTICAL_TARGET_FRACTION);

				const longestDimension = Math.max(glyph.bbox.width, glyph.bbox.height);
				expect(longestDimension / side).toBeCloseTo(
					MIN_CONTAINMENT_FRACTION,
					2,
				);
			}
		});

		it("centers each glyph's bounding box within its normalized viewBox", () => {
			for (const provider of Object.keys(BRAND_GLYPHS) as BrandIconProvider[]) {
				const glyph = BRAND_GLYPHS[provider];
				const [minXStr, minYStr, sideStr] = glyph.viewBox.split(" ");
				const minX = Number(minXStr);
				const minY = Number(minYStr);
				const side = Number(sideStr);
				const bboxCenterX = glyph.bbox.x + glyph.bbox.width / 2;
				const bboxCenterY = glyph.bbox.y + glyph.bbox.height / 2;
				expect(minX + side / 2).toBeCloseTo(bboxCenterX, 2);
				expect(minY + side / 2).toBeCloseTo(bboxCenterY, 2);
			}
		});

		it("uses a square viewBox (equal width/height) for every provider", () => {
			for (const provider of Object.keys(BRAND_GLYPHS) as BrandIconProvider[]) {
				const [, , w, h] = BRAND_GLYPHS[provider].viewBox.split(" ");
				expect(w).toBe(h);
			}
		});

		// R3-fix2 #1 — the actual bug: Nextcloud and Plex's glyphs were cropped
		// left/right in the detail-modal header (and anywhere BrandIcon
		// renders) because their old optical-size viewBox side (~20.2/20.5)
		// was narrower than their bbox's 24-unit width. This asserts the real
		// invariant directly — every provider's viewBox must fully contain its
		// path's bounding box on all four sides — so a future glyph refresh
		// (or optical-size tweak) can't reintroduce clipping without failing a
		// test, for ANY provider, not just these two.
		it("never clips a glyph — every provider's viewBox fully contains its path bbox", () => {
			for (const provider of Object.keys(BRAND_GLYPHS) as BrandIconProvider[]) {
				const glyph = BRAND_GLYPHS[provider];
				const [minXStr, minYStr, sideStr] = glyph.viewBox.split(" ");
				const minX = Number(minXStr);
				const minY = Number(minYStr);
				const side = Number(sideStr);

				expect(minX, `${provider} left edge`).toBeLessThanOrEqual(glyph.bbox.x);
				expect(minY, `${provider} top edge`).toBeLessThanOrEqual(glyph.bbox.y);
				expect(minX + side, `${provider} right edge`).toBeGreaterThanOrEqual(
					glyph.bbox.x + glyph.bbox.width,
				);
				expect(minY + side, `${provider} bottom edge`).toBeGreaterThanOrEqual(
					glyph.bbox.y + glyph.bbox.height,
				);
			}
		});

		it("renders Google and Nextcloud with a different raw viewBox but the same width/height attrs at a given size", () => {
			const { unmount: unmountGoogle } = renderIcon({
				provider: "google",
				size: 24,
			});
			const google = screen.getByRole("img", { name: "Google" });
			expect(google.getAttribute("viewBox")).toBe(BRAND_GLYPHS.google.viewBox);
			unmountGoogle();

			renderIcon({ provider: "nextcloud", size: 24 });
			const nextcloud = screen.getByRole("img", { name: "Nextcloud" });
			expect(nextcloud.getAttribute("viewBox")).toBe(
				BRAND_GLYPHS.nextcloud.viewBox,
			);
			expect(nextcloud.getAttribute("viewBox")).not.toBe(
				google.getAttribute("viewBox"),
			);
			// Both still render at the same requested pixel size — only the
			// internal coordinate mapping (viewBox) differs.
			expect(nextcloud.getAttribute("width")).toBe(
				google.getAttribute("width"),
			);
		});
	});
});
