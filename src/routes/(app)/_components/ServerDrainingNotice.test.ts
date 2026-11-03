import { render, screen } from "@testing-library/svelte";
import { afterEach, describe, expect, it } from "vitest";
import { uiLanguage } from "$lib/stores/settings";

import ServerDrainingNotice from "./ServerDrainingNotice.svelte";

describe("ServerDrainingNotice", () => {
	afterEach(() => {
		uiLanguage.set("en");
	});

	it("stays hidden while the server is not draining", () => {
		render(ServerDrainingNotice, {
			visible: false,
		});

		expect(
			screen.queryByRole("status", { name: "Update in progress" }),
		).not.toBeInTheDocument();
	});

	it("shows a non-blocking banner while the server is draining", () => {
		render(ServerDrainingNotice, {
			visible: true,
		});

		expect(
			screen.getByRole("status", { name: "Update in progress" }),
		).toBeVisible();
		// It promises only what happens: the running reply finishes, a new message
		// is sent when the update is done (it used to say it "will retry
		// automatically", which a send that gave up after four seconds did not do).
		expect(
			screen.getByText(
				"AlfyAI is being updated. A reply that's running finishes first, and a new message is sent when the update is done.",
			),
		).toBeVisible();
	});

	it("uses Hungarian copy when the UI language is Hungarian", () => {
		uiLanguage.set("hu");

		render(ServerDrainingNotice, {
			visible: true,
		});

		expect(
			screen.getByRole("status", { name: "Frissítés folyamatban" }),
		).toBeVisible();
		expect(
			screen.getByText(
				"Az AlfyAI frissül. A futó válasz előbb befejeződik, az új üzenet pedig a frissítés után megy el.",
			),
		).toBeVisible();
	});
});
