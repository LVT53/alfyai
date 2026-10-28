import { fireEvent, render, screen } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { uiLanguage } from "$lib/stores/settings";
import IntegrationsPage from "./IntegrationsPage.svelte";

function renderPage(overrides: Record<string, unknown> = {}) {
	const setValue = vi.fn();
	render(IntegrationsPage, {
		adminConfig: {},
		envDefaults: { IMAGE_EXPLICIT_FILTER_ENABLED: "true" },
		isDirty: () => false,
		setValue,
		resetValue: vi.fn(),
		revertValue: vi.fn(),
		...overrides,
	});
	return { setValue };
}

describe("the Pictures section of Integrations", () => {
	beforeEach(() => {
		uiLanguage.set("en");
	});

	it("shows the explicit picture filter switched on by default and turns it off", async () => {
		const { setValue } = renderPage();
		const toggle = screen.getByRole("switch", {
			name: "Explicit picture filter",
		});
		expect(toggle).toHaveAttribute("aria-checked", "true");
		await fireEvent.click(toggle);
		expect(setValue).toHaveBeenCalledWith(
			"IMAGE_EXPLICIT_FILTER_ENABLED",
			"false",
		);
	});

	it("shows it off when an admin turned it off", () => {
		renderPage({ adminConfig: { IMAGE_EXPLICIT_FILTER_ENABLED: "false" } });
		expect(
			screen.getByRole("switch", { name: "Explicit picture filter" }),
		).toHaveAttribute("aria-checked", "false");
	});

	it("has the picture server's address beside it", () => {
		renderPage({ adminConfig: { COMFYUI_URL: "http://comfy:8188" } });
		expect(screen.getByDisplayValue("http://comfy:8188")).toBeInTheDocument();
	});
});
