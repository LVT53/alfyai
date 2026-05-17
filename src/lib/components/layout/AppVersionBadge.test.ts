import { fireEvent, render, screen } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import AppVersionBadge from "./AppVersionBadge.svelte";

describe("AppVersionBadge", () => {
	it("shows the compact version, exposes the full version, and calls back on click", async () => {
		const onClick = vi.fn();

		render(AppVersionBadge, {
			compactVersion: "v0.1",
			fullVersion: "0.1.0",
			onClick,
		});

		const badge = screen.getByRole("button", { name: "App version v0.1" });

		expect(badge).toHaveAttribute("title", "AlfyAI 0.1.0");

		await fireEvent.click(badge);

		expect(onClick).toHaveBeenCalledOnce();
	});
});
