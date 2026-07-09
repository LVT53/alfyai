import { render, screen } from "@testing-library/svelte";
import { describe, expect, it } from "vitest";
import legalDict from "$lib/i18n/legal";
import PrivacyPolicy from "./PrivacyPolicy.svelte";

describe("PrivacyPolicy", () => {
	it("renders the policy title and last-updated line", () => {
		render(PrivacyPolicy);

		expect(
			screen.getByRole("heading", { level: 1, name: "Privacy Policy" }),
		).toBeInTheDocument();
		expect(screen.getAllByText(/Last updated/).length).toBeGreaterThan(0);
	});

	it("renders every section title from the single content source", () => {
		render(PrivacyPolicy);

		const sectionTitles = Object.entries(legalDict.en)
			.filter(
				([key]) => key.endsWith(".title") && key !== "legal.privacy.title",
			)
			.map(([, value]) => value);

		for (const title of sectionTitles) {
			expect(
				screen.getByRole("heading", { level: 2, name: title }),
			).toBeInTheDocument();
		}
	});

	it("includes the required substantive sections so none can silently disappear", () => {
		render(PrivacyPolicy);
		const body = document.body.textContent ?? "";

		// Connectors + encryption.
		expect(body).toMatch(/calendar/i);
		expect(body).toMatch(/AES-GCM/);
		// Data locality (local processing + first-time cloud warning).
		expect(body).toMatch(/local model/i);
		expect(body).toMatch(/one-time warning/i);
		// Third-party model providers.
		expect(body).toMatch(/third-party cloud model/i);
		// Memory + incognito.
		expect(body).toMatch(/incognito/i);
		expect(body).toMatch(/saved-but-untracked/i);
		// Writes are confirmed, never autonomous.
		expect(body).toMatch(/explicitly review and confirm/i);
		// Export + erasure.
		expect(body).toMatch(/Account Data Archive/i);
		expect(body).toMatch(/erasure/i);
		// Entity + contact.
		expect(body).toMatch(/AlfyAI/);
		expect(body).toMatch(/levente@alfydesign\.com/);
	});
});
