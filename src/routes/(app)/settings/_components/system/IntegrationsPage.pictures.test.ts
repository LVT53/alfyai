// @vitest-environment jsdom
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

	it("shows the picture model switch and both picture servers", () => {
		renderPage({
			adminConfig: {
				IMAGE_MODEL: "h3",
				COMFYUI_H3_URL: "http://h3:8189",
				COMFYUI_URL: "http://comfy:8188",
			},
		});

		const select = screen.getByRole("combobox", { name: "Picture model" });
		expect(select).toHaveValue("h3");
		expect(select).toHaveDisplayValue("MiniMax-H3-Image");
		expect(screen.getByDisplayValue("http://h3:8189")).toBeInTheDocument();
		expect(screen.getByDisplayValue("http://comfy:8188")).toBeInTheDocument();
	});

	it("switches to Qwen without touching the Qwen server address", async () => {
		const { setValue } = renderPage({
			adminConfig: {
				IMAGE_MODEL: "h3",
				COMFYUI_H3_URL: "http://h3:8189",
				COMFYUI_URL: "http://comfy:8188",
			},
		});

		await fireEvent.change(
			screen.getByRole("combobox", { name: "Picture model" }),
			{ target: { value: "qwen" } },
		);

		expect(setValue).toHaveBeenCalledWith("IMAGE_MODEL", "qwen");
		expect(setValue).not.toHaveBeenCalledWith("COMFYUI_URL", expect.anything());
		expect(screen.getByDisplayValue("http://comfy:8188")).toBeInTheDocument();
	});
});

describe("the Video section of Integrations", () => {
	beforeEach(() => {
		uiLanguage.set("en");
	});

	it("shows the LTX server and the caption endpoint, and edits them", async () => {
		const { setValue } = renderPage({
			adminConfig: {
				COMFYUI_LTX_URL: "http://ltx:8190",
				LTX_CAPTION_MODEL: "gemma-3-27b",
			},
		});
		expect(screen.getByDisplayValue("http://ltx:8190")).toBeInTheDocument();
		expect(screen.getByDisplayValue("gemma-3-27b")).toBeInTheDocument();
		const captionUrl = screen.getByRole("textbox", {
			name: "Caption endpoint",
		});
		await fireEvent.input(captionUrl, {
			target: { value: "http://127.0.0.1:11434" },
		});
		expect(setValue).toHaveBeenCalledWith(
			"LTX_CAPTION_URL",
			"http://127.0.0.1:11434",
		);
	});

	it("says a video needs the server, and names the caption rewrite", () => {
		renderPage();
		expect(
			screen.getByText(/LTX server makes a short clip from a still picture/),
		).toBeInTheDocument();
		expect(
			screen.getByText(/rewrites the motion idea into the caption style/),
		).toBeInTheDocument();
	});
});
