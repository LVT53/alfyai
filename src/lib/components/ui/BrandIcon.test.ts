import { render, screen } from "@testing-library/svelte";
import { describe, expect, it } from "vitest";
import BrandIcon from "./BrandIcon.svelte";
import {
	BRAND_GLYPHS,
	type BrandIconProvider,
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
		it("gives every provider the same occupied-fraction of its viewBox", () => {
			const providers = Object.keys(BRAND_GLYPHS) as BrandIconProvider[];
			expect(providers.length).toBeGreaterThanOrEqual(6);

			for (const provider of providers) {
				const glyph = BRAND_GLYPHS[provider];
				const [, , sideStr] = glyph.viewBox.split(" ");
				const side = Number(sideStr);
				const opticalSize = Math.sqrt(glyph.bbox.width * glyph.bbox.height);
				const occupiedFraction = opticalSize / side;
				expect(occupiedFraction).toBeCloseTo(OPTICAL_TARGET_FRACTION, 2);
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
