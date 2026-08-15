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
		expect(screen.getByText(/finishing a brief update/)).toBeVisible();
	});

	it("uses Hungarian copy when the UI language is Hungarian", () => {
		uiLanguage.set("hu");

		render(ServerDrainingNotice, {
			visible: true,
		});

		expect(
			screen.getByRole("status", { name: "Frissítés folyamatban" }),
		).toBeVisible();
		expect(screen.getByText(/rövid frissítést fejez be/)).toBeVisible();
	});
});
