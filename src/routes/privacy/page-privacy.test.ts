import { render, screen } from "@testing-library/svelte";
import { describe, expect, it } from "vitest";
import PrivacyPage from "./+page.svelte";

describe("/privacy page", () => {
	it("renders the privacy policy content standalone, with no auth-only chrome", () => {
		render(PrivacyPage);

		expect(
			screen.getByRole("heading", { level: 1, name: "Privacy Policy" }),
		).toBeInTheDocument();
		expect(
			screen.getAllByText(/levente@alfydesign\.com/).length,
		).toBeGreaterThan(0);
		// Standalone page shell: a link back to the app, not the authenticated
		// (app) shell/sidebar.
		expect(screen.getByRole("link", { name: "AlfyAI" })).toHaveAttribute(
			"href",
			"/",
		);
	});
});
