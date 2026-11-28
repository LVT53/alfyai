// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, expect, it, vi } from "vitest";
import {
	fetchBoschBikeNames,
	saveBoschBikeName,
} from "$lib/client/api/connections";
import BoschBikeNames from "./BoschBikeNames.svelte";

vi.mock("$lib/client/api/connections", () => ({
	fetchBoschBikeNames: vi.fn(),
	saveBoschBikeName: vi.fn(),
}));

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.resetAllMocks();
});

it("discovers shared bikes while visible, on return and only while mounted", async () => {
	vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
	const visibility = vi
		.spyOn(document, "visibilityState", "get")
		.mockReturnValue("visible");
	const fetch = vi.mocked(fetchBoschBikeNames);
	fetch
		.mockResolvedValueOnce({ bikes: [] })
		.mockResolvedValue({ bikes: [{ id: "cube", name: null }] });
	const panel = render(BoschBikeNames);
	await tick();
	expect(fetch).toHaveBeenCalledTimes(1);
	visibility.mockReturnValue("hidden");
	await vi.advanceTimersByTimeAsync(60_000);
	expect(fetch).toHaveBeenCalledTimes(1);
	visibility.mockReturnValue("visible");
	document.dispatchEvent(new Event("visibilitychange"));
	window.dispatchEvent(new Event("focus"));
	await vi.advanceTimersByTimeAsync(0);
	await tick();
	expect(fetch).toHaveBeenCalledTimes(2);
	expect(screen.getByRole("textbox", { name: /cube/ })).toBeVisible();
	await vi.advanceTimersByTimeAsync(30_000);
	expect(fetch).toHaveBeenCalledTimes(3);
	panel.unmount();
	window.dispatchEvent(new Event("focus"));
	await vi.advanceTimersByTimeAsync(60_000);
	expect(fetch).toHaveBeenCalledTimes(3);
	expect(fetch.mock.calls[0][0].aborted).toBe(true);
});

it("keeps drafts and a completed save when a late inventory arrives", async () => {
	const original = { bikes: [{ id: "one", name: "First" }] };
	const fetch = vi.mocked(fetchBoschBikeNames);
	fetch.mockResolvedValue(original);
	vi.mocked(saveBoschBikeName).mockResolvedValue(undefined);
	render(BoschBikeNames);
	const field = await screen.findByDisplayValue("First");
	await fireEvent.input(field, { target: { value: "My Cube" } });
	fetch.mockResolvedValueOnce({
		bikes: [...original.bikes, { id: "two", name: null }],
	});
	window.dispatchEvent(new Event("focus"));
	expect(await screen.findByRole("textbox", { name: /two/ })).toBeVisible();
	expect(field).toHaveValue("My Cube");
	const late = Promise.withResolvers<typeof original>();
	fetch.mockReturnValueOnce(late.promise);
	window.dispatchEvent(new Event("focus"));
	await fireEvent.click(
		within(screen.getByRole("form", { name: /one/ })).getByRole("button", {
			name: "Save",
		}),
	);
	await screen.findByText("Bike name saved.");
	late.resolve(original);
	await tick();
	expect(field).toHaveValue("My Cube");
	expect(saveBoschBikeName).toHaveBeenCalledTimes(1);
});
