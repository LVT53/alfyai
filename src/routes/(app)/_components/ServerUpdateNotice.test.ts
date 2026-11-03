import { fireEvent, render, screen } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import { uiLanguage } from "$lib/stores/settings";

import ServerUpdateNotice from "./ServerUpdateNotice.svelte";

describe("ServerUpdateNotice", () => {
	afterEach(() => {
		uiLanguage.set("en");
	});

	it("stays hidden until a server update is available", () => {
		render(ServerUpdateNotice, {
			visible: false,
			onRefresh: vi.fn(),
		});

		expect(
			screen.queryByRole("dialog", { name: "Update available" }),
		).not.toBeInTheDocument();
	});

	it("asks the user to refresh when a server update is available", async () => {
		const onRefresh = vi.fn();

		render(ServerUpdateNotice, {
			visible: true,
			onRefresh,
		});

		expect(
			screen.getByRole("dialog", { name: "Update available" }),
		).toBeVisible();
		expect(screen.getByText(/The server was updated/)).toBeVisible();

		await fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

		expect(onRefresh).toHaveBeenCalledTimes(1);
	});

	// A message that waits for the update has not reached the server, and a reload
	// now would lose it: the notice stays down until the wait is over.
	it("stays down while a message waits for the update, and comes up as soon as it does not", async () => {
		const { rerender } = render(ServerUpdateNotice, {
			visible: true,
			held: true,
			onRefresh: vi.fn(),
		});

		expect(
			screen.queryByRole("dialog", { name: "Update available" }),
		).not.toBeInTheDocument();

		await rerender({ visible: true, held: false, onRefresh: vi.fn() });

		expect(
			screen.getByRole("dialog", { name: "Update available" }),
		).toBeVisible();
	});

	it("stays hidden while held even when there is no update to offer yet", async () => {
		const { rerender } = render(ServerUpdateNotice, {
			visible: false,
			held: true,
			onRefresh: vi.fn(),
		});
		await rerender({ visible: false, held: false, onRefresh: vi.fn() });

		expect(
			screen.queryByRole("dialog", { name: "Update available" }),
		).not.toBeInTheDocument();
	});

	it("uses Hungarian copy when the UI language is Hungarian", () => {
		uiLanguage.set("hu");

		render(ServerUpdateNotice, {
			visible: true,
			onRefresh: vi.fn(),
		});

		expect(
			screen.getByRole("dialog", { name: "Frissítés érhető el" }),
		).toBeVisible();
		expect(screen.getByText(/A szerver frissült/)).toBeVisible();
		expect(screen.getByRole("button", { name: "Frissítés" })).toBeVisible();
	});
});
