import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { describe, expect, it } from "vitest";
import ImagePicture from "./ImagePicture.svelte";

const here = path.dirname(fileURLToPath(import.meta.url));

describe("ImagePicture", () => {
	it("draws the picture from its file route in a box of its own shape, with its size set", () => {
		render(ImagePicture, {
			fileId: "file-7",
			width: 1248,
			height: 832,
			alt: "Cosy room",
			conversationId: "conv-1",
		});

		const img = screen.getByRole("img", { name: "Cosy room" });
		expect(img.getAttribute("src")).toContain("/api/images/files/file-7");
		expect(img.getAttribute("src")).toContain("conversationId=conv-1");
		expect(img).toHaveAttribute("width", "1248");
		expect(img).toHaveAttribute("height", "832");
		expect(img).toHaveAttribute("decoding", "async");
		const box = screen.getByTestId("image-picture");
		expect(box.style.aspectRatio).toBe("1248 / 832");
	});

	it("loads only the full picture for the panel's main view", () => {
		render(ImagePicture, {
			fileId: "file-9",
			width: 1248,
			height: 832,
			alt: "Panel",
			conversationId: "conv-1",
			variant: "original",
		});
		const img = screen.getByRole("img", { name: "Panel" });
		expect(img.getAttribute("src")).toBe(
			"/api/images/files/file-9?conversationId=conv-1",
		);
		expect(img.getAttribute("srcset")).toBeNull();
		expect(img.getAttribute("sizes")).toBeNull();
	});

	it("offers the thumbnail and the full picture by width, and only the thumbnail for a thumb", () => {
		render(ImagePicture, {
			fileId: "file-7",
			width: 832,
			height: 1248,
			alt: "Tall",
		});
		const srcset = screen.getByRole("img").getAttribute("srcset") ?? "";
		expect(srcset).toContain("variant=thumb");
		expect(srcset).toContain(" 213w");
		expect(srcset).toContain(" 832w");

		render(ImagePicture, {
			fileId: "file-8",
			width: 832,
			height: 1248,
			alt: "Thumb",
			variant: "thumb",
		});
		const thumb = screen.getByRole("img", { name: "Thumb" });
		expect(thumb.getAttribute("src")).toContain("variant=thumb");
		expect(thumb.hasAttribute("srcset")).toBe(false);
	});

	it("fades the picture in once it has loaded", async () => {
		render(ImagePicture, { fileId: "f", width: 10, height: 10, alt: "P" });
		const img = screen.getByRole("img");
		expect(img).not.toHaveClass("is-loaded");
		await fireEvent.load(img);
		expect(img).toHaveClass("is-loaded");
	});

	it("draws a see-through picture over the checkerboard", () => {
		render(ImagePicture, {
			fileId: "f",
			width: 10,
			height: 10,
			alt: "Cut out",
			hasAlpha: true,
		});
		expect(screen.getByTestId("image-picture")).toHaveClass(
			"image-checkerboard",
		);
	});

	it("draws the checkerboard with its own tokens, which each theme sets (Review Focus 2, F8)", () => {
		// One shared look (checkerboard.css), used by the picture and History's wipe.
		const source = readFileSync(path.join(here, "checkerboard.css"), "utf8");
		expect(source).toContain("var(--checker-a)");
		expect(source).toContain("var(--checker-b)");
		for (const user of ["ImagePicture.svelte", "CompareWipe.svelte"]) {
			expect(readFileSync(path.join(here, user), "utf8")).toContain(
				'import "./checkerboard.css";',
			);
		}
		const css = readFileSync(path.join(here, "../../../../app.css"), "utf8");
		const light = css.indexOf("--checker-a: #ffffff");
		const dark = css.indexOf("--checker-a: #2a2a2a");
		expect(light).toBeGreaterThan(-1);
		expect(dark).toBeGreaterThan(css.indexOf(".dark {"));
		expect(css).toMatch(
			/\.stage--incognito \{[^}]*--checker-a: var\(--incognito-checker-a\)/,
		);
	});

	it("shows the picture it was made from on Before, and itself again on After", async () => {
		const { rerender } = render(ImagePicture, {
			fileId: "after-file",
			width: 10,
			height: 10,
			alt: "Sofa",
			beforeFileId: "before-file",
			showing: "after",
		});
		expect(
			screen.getByRole("img", { name: "Sofa" }).getAttribute("src"),
		).toContain("after-file");

		await rerender({ showing: "before" });
		// After stays until Before has loaded (fix wave, B-I3).
		await fireEvent.load(screen.getByTestId("image-picture-before"));
		expect(
			screen.getByRole("img", { name: "Sofa" }).getAttribute("src"),
		).toContain("before-file");
		expect(screen.getByTestId("image-picture")).toHaveAttribute(
			"data-showing",
			"before",
		);

		await rerender({ showing: "after" });
		expect(
			screen.getByRole("img", { name: "Sofa" }).getAttribute("src"),
		).toContain("after-file");
	});
});

describe("ImagePicture with a picture already in the cache", () => {
	it("shows it once loaded and flips to Before without looping (the browser still fires load for a cached picture)", async () => {
		const complete = Object.getOwnPropertyDescriptor(
			HTMLImageElement.prototype,
			"complete",
		);
		const natural = Object.getOwnPropertyDescriptor(
			HTMLImageElement.prototype,
			"naturalWidth",
		);
		Object.defineProperty(HTMLImageElement.prototype, "complete", {
			configurable: true,
			get: () => true,
		});
		Object.defineProperty(HTMLImageElement.prototype, "naturalWidth", {
			configurable: true,
			get: () => 10,
		});
		try {
			const { rerender } = render(ImagePicture, {
				fileId: "after-file",
				width: 10,
				height: 10,
				alt: "Cached",
				beforeFileId: "before-file",
			});
			await fireEvent.load(screen.getByRole("img", { name: "Cached" }));
			expect(screen.getByRole("img", { name: "Cached" })).toHaveClass(
				"is-loaded",
			);
			await rerender({ showing: "before" });
			const before = screen.getByTestId("image-picture-before");
			expect(before.getAttribute("src")).toContain("before-file");
			await fireEvent.load(before);
			expect(before).toHaveClass("is-loaded");
			expect(screen.getByRole("img", { name: "Cached" })).toBe(before);
		} finally {
			if (complete)
				Object.defineProperty(HTMLImageElement.prototype, "complete", complete);
			if (natural)
				Object.defineProperty(
					HTMLImageElement.prototype,
					"naturalWidth",
					natural,
				);
		}
	});
});

describe("ImagePicture swapping its picture", () => {
	it("fades the new picture in once it loads, over the one it replaces", async () => {
		const { rerender } = render(ImagePicture, {
			fileId: "first",
			width: 10,
			height: 10,
			alt: "Swap",
		});
		await fireEvent.load(screen.getByTestId("image-picture-after"));
		await rerender({ fileId: "second" });
		const next = screen.getByTestId("image-picture-after");
		expect(next.getAttribute("src")).toContain("second");
		expect(screen.getByTestId("image-picture-leaving")).toHaveClass(
			"is-loaded",
		);
		await fireEvent.load(next);
		// A picture already in the cache loads in the frame it is made: it is shown
		// a frame later, so its fade over the old one runs (the panel's new version,
		// F23, found by the T3 motion check).
		expect(next).not.toHaveClass("is-loaded");
		await new Promise((resolve) => requestAnimationFrame(resolve));
		expect(next).toHaveClass("is-loaded");
	});
});

// Final fix wave (B-I2, B-I3): a flip never shows the box's background, and
// the first Before press never empties the box while Before downloads.
describe("ImagePicture flipping Before / After", () => {
	async function rendered(hasAlpha = false) {
		const view = render(ImagePicture, {
			fileId: "after-file",
			width: 10,
			height: 10,
			alt: "Sofa",
			hasAlpha,
			beforeFileId: "before-file",
			showing: "after",
		});
		await fireEvent.load(screen.getByTestId("image-picture-after"));
		return view;
	}

	it("fetches Before ahead of the first press, once After is shown", async () => {
		await rendered();
		await waitFor(() =>
			expect(screen.getByTestId("image-picture-before")).toBeInTheDocument(),
		);
		expect(screen.getByTestId("image-picture")).toHaveAttribute(
			"data-showing",
			"after",
		);
	});

	it("keeps After on screen until Before has loaded", async () => {
		const { rerender } = await rendered();
		await rerender({ showing: "before" });
		const after = screen.getByTestId("image-picture-after");
		expect(after).not.toHaveClass("is-hidden");
		expect(screen.getByTestId("image-picture")).toHaveAttribute(
			"data-showing",
			"after",
		);
		await fireEvent.load(screen.getByTestId("image-picture-before"));
		expect(screen.getByTestId("image-picture")).toHaveAttribute(
			"data-showing",
			"before",
		);
	});

	it("keeps an opaque After fully shown underneath while Before fades in over it", async () => {
		const { rerender } = await rendered(false);
		await rerender({ showing: "before" });
		await fireEvent.load(screen.getByTestId("image-picture-before"));
		expect(screen.getByTestId("image-picture-after")).not.toHaveClass(
			"is-hidden",
		);
		expect(screen.getByTestId("image-picture-before")).not.toHaveClass(
			"is-hidden",
		);
		await rerender({ showing: "after" });
		expect(screen.getByTestId("image-picture-after")).not.toHaveClass(
			"is-hidden",
		);
		expect(screen.getByTestId("image-picture-before")).toHaveClass("is-hidden");
	});

	it("crossfades a see-through pair, so After never shows through Before's clear parts", async () => {
		const { rerender } = await rendered(true);
		await rerender({ showing: "before" });
		await fireEvent.load(screen.getByTestId("image-picture-before"));
		expect(screen.getByTestId("image-picture-after")).toHaveClass("is-hidden");
	});
});
