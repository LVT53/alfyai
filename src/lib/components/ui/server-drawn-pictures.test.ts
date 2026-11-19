import { render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import AvatarCircle from "./AvatarCircle.svelte";
import ModelIcon from "./ModelIcon.svelte";

// An avatar and a model's icon are drawn by the server whenever their host knows the
// picture while the server renders, so a picture can fail before the page's code runs.
// Svelte would replay that error from an inline handler, which the policy the boxes
// enforce refuses: the broken-picture glyph stays where the initial belongs. jsdom
// fetches no picture, so the picture here has already come back broken when the
// component appears, and no error event comes.
describe("a picture drawn by the server that broke before the page ran", () => {
	const saved = new Map<string, PropertyDescriptor | undefined>();

	beforeEach(() => {
		for (const name of ["complete", "naturalWidth", "decode"]) {
			saved.set(
				name,
				Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, name),
			);
		}
		Object.defineProperty(HTMLImageElement.prototype, "complete", {
			configurable: true,
			get: () => true,
		});
		Object.defineProperty(HTMLImageElement.prototype, "naturalWidth", {
			configurable: true,
			get: () => 0,
		});
		Object.defineProperty(HTMLImageElement.prototype, "decode", {
			configurable: true,
			value: () => Promise.reject(new DOMException("broken", "EncodingError")),
		});
	});

	afterEach(() => {
		for (const [name, descriptor] of saved) {
			if (descriptor)
				Object.defineProperty(HTMLImageElement.prototype, name, descriptor);
			else Reflect.deleteProperty(HTMLImageElement.prototype, name);
		}
	});

	it("gives the avatar its initial", async () => {
		const { container } = render(AvatarCircle, {
			userId: "user-1",
			name: "Ada",
			profilePicture: "set",
		});
		await waitFor(() => expect(container.querySelector("img")).toBeNull());
		expect(screen.getByText("A")).toBeInTheDocument();
	});

	it("gives a model's icon its initial", async () => {
		const { container } = render(ModelIcon, {
			iconUrl: "/api/model-icons/icon-1",
			displayName: "Qwen",
		});
		await waitFor(() => expect(container.querySelector("img")).toBeNull());
		expect(screen.getByText("Q")).toBeInTheDocument();
	});
});
