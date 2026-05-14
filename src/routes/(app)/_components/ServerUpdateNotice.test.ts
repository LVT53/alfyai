import { fireEvent, render, screen } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";

import ServerUpdateNotice from "./ServerUpdateNotice.svelte";

describe("ServerUpdateNotice", () => {
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
});
