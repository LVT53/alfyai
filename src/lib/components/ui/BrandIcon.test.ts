import { render, screen } from "@testing-library/svelte";
import { describe, expect, it } from "vitest";
import BrandIcon from "./BrandIcon.svelte";

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
});
