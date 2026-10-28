import { fireEvent, render, screen, within } from "@testing-library/svelte";
import { tick } from "svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { uiLanguage } from "$lib/stores/settings";
import ImageCardBody from "./ImageCardBody.svelte";
import { card, take } from "./image-card-fixtures.test-helpers";

/** Svelte makes a leaving element inert (a property, which jsdom does not reflect). */
function isInert(element: Element | null): boolean {
	for (let node = element; node; node = node.parentElement) {
		if ((node as HTMLElement).inert) return true;
	}
	return false;
}

describe("ImageCardBody", () => {
	beforeEach(() => {
		uiLanguage.set("en");
	});

	it("shows a take being made as a shimmer over its box, its words for screen readers only, and Stop", async () => {
		const making = take({
			status: "running",
			phase: "rendering",
			phaseAt: Date.now(),
			etaSeconds: 8,
			progressPercent: 40,
			fileId: null,
			width: null,
			height: null,
		});
		const onAction = vi.fn();
		render(ImageCardBody, { card: card([making]), onAction });

		const shimmer = screen.getByTestId("image-card-shimmer");
		expect(shimmer).toHaveAttribute("aria-hidden", "true");
		expect(shimmer.textContent?.trim()).toBe("");
		expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
		expect(screen.queryByTestId("image-card-state")).not.toBeInTheDocument();
		const status = screen.getByTestId("image-card-status");
		expect(status).toHaveAttribute("role", "status");
		expect(status).toHaveClass("sr-only");
		expect(status).toHaveTextContent("Making the picture… About 8 s left");
		await fireEvent.click(screen.getByRole("button", { name: "Stop" }));
		expect(onAction).toHaveBeenCalledWith({ type: "stop", takeId: making.id });
	});

	it("keeps one shimmer from waiting through making, and fades it out for the picture in place", async () => {
		const waiting = take({
			status: "queued",
			fileId: null,
			width: null,
			height: null,
		});
		const { rerender } = render(ImageCardBody, { card: card([waiting]) });
		const shimmer = screen.getByTestId("image-card-shimmer");
		expect(screen.getByTestId("image-card-status")).toHaveTextContent(
			"Next up",
		);

		await rerender({
			card: card([
				{
					...waiting,
					status: "running",
					phase: "rendering",
					progressPercent: 30,
				},
			]),
		});
		expect(screen.getByTestId("image-card-shimmer")).toBe(shimmer);
		expect(screen.getByTestId("image-card-status")).toHaveTextContent(
			"Making the picture…",
		);
		expect(screen.queryByRole("button", { name: "Stop" })).toBeInTheDocument();

		await rerender({
			card: card([
				{
					...waiting,
					status: "succeeded",
					phase: null,
					fileId: "landed",
					width: 1248,
					height: 832,
				},
			]),
		});
		expect(screen.getByTestId("image-card-picture")).toBeInTheDocument();
		expect(screen.getByTestId("image-card-status")).toHaveTextContent("");
		const stop = screen.queryByTestId("image-card-stop");
		expect(stop === null || isInert(stop), "Stop is gone or fading out").toBe(
			true,
		);
	});

	it("says how many pictures are ahead of a waiting take", () => {
		render(ImageCardBody, {
			card: card([
				take({
					status: "running",
					phase: "submitted",
					queueAhead: 1,
					fileId: null,
				}),
			]),
		});
		expect(screen.getByTestId("image-card-status")).toHaveTextContent(
			"1 ahead of this one",
		);
		expect(screen.getByTestId("image-card-shimmer")).toBeInTheDocument();
		expect(
			screen.queryByText("Another picture is being made"),
		).not.toBeInTheDocument();
	});

	it("says Next up for a chat's first picture waiting to start, not that another is being made", () => {
		render(ImageCardBody, {
			card: card([take({ status: "queued", fileId: null })]),
		});
		expect(screen.getByTestId("image-card-status")).toHaveTextContent(
			"Next up",
		);
		expect(
			screen.queryByText("Another picture is being made"),
		).not.toBeInTheDocument();
	});

	it("says the picture maker is starting after a quiet spell", () => {
		render(ImageCardBody, {
			card: card([
				take({
					status: "running",
					phase: "starting",
					phaseAt: Date.now() - 10_000,
					fileId: null,
				}),
			]),
		});
		expect(screen.getByTestId("image-card-status")).toHaveTextContent(
			"Starting the picture maker…",
		);
		expect(screen.getByTestId("image-card-shimmer")).toBeInTheDocument();
	});

	it("draws a ready take from its file, sized, in the box its take reserved", () => {
		const ready = take({ fileId: "file-a", box: { width: 1248, height: 832 } });
		render(ImageCardBody, { card: card([ready]), conversationId: "conv-1" });

		const img = screen.getByRole("img", { name: "Cosy room" });
		expect(img.getAttribute("src")).toContain("/api/images/files/file-a");
		expect(img).toHaveAttribute("width", "1248");
		expect(img).toHaveAttribute("height", "832");
		expect(screen.getByTestId("image-card-stage").style.aspectRatio).toBe(
			"1248 / 832",
		);
	});

	it("keeps the take's box while it is made, so nothing moves when it lands (Review Focus 1)", async () => {
		const making = take({
			status: "running",
			phase: "rendering",
			fileId: null,
			width: null,
			height: null,
			box: { width: 1184, height: 896 },
		});
		const { rerender } = render(ImageCardBody, { card: card([making]) });
		const stage = screen.getByTestId("image-card-stage");
		expect(stage.style.aspectRatio).toBe("1184 / 896");

		await rerender({
			card: card([
				{
					...making,
					status: "succeeded",
					phase: null,
					fileId: "landed",
					width: 1184,
					height: 896,
				},
			]),
		});
		expect(screen.getByTestId("image-card-stage")).toBe(stage);
		expect(stage.style.aspectRatio).toBe("1184 / 896");
	});

	it("draws a see-through picture over the checkerboard", () => {
		render(ImageCardBody, { card: card([take({ hasAlpha: true })]) });
		expect(
			within(screen.getByTestId("image-card-stage")).getByTestId(
				"image-picture",
			),
		).toHaveClass("image-checkerboard");
	});

	it("marks the take in use, and offers Use this on another take chosen in the strip", async () => {
		const first = take();
		const second = take();
		const onAction = vi.fn();
		render(ImageCardBody, {
			card: card([first, second], { pickedTakeId: first.id }),
			onAction,
		});

		const tiles = screen.getAllByTestId("image-card-tile");
		expect(tiles).toHaveLength(2);
		expect(
			within(tiles[0]).getByTestId("image-card-in-use"),
		).toBeInTheDocument();
		expect(within(tiles[1]).queryByTestId("image-card-in-use")).toBeNull();
		expect(screen.queryByRole("button", { name: /Use this/ })).toBeNull();

		await fireEvent.click(tiles[1]);
		expect(tiles[1]).toHaveAttribute("aria-pressed", "true");
		expect(
			screen
				.getByTestId("image-card-stage")
				.querySelector('[data-testid="image-picture-after"]')
				?.getAttribute("src"),
		).toContain(second.fileId);
		await fireEvent.click(screen.getByRole("button", { name: /Use this/ }));
		expect(onAction).toHaveBeenCalledWith({ type: "use", takeId: second.id });
	});

	it("never offers a held take", async () => {
		const first = take();
		const held = take({ held: true });
		render(ImageCardBody, {
			card: card([first, held], { pickedTakeId: first.id }),
		});
		await fireEvent.click(screen.getAllByTestId("image-card-tile")[1]);
		expect(screen.queryByRole("button", { name: /Use this/ })).toBeNull();
	});

	it("asks for Another, shows its tile at once and the take it queued once the card has it", async () => {
		const first = take();
		const onAction = vi.fn(async () => ({ takeId: "take-new" }));
		const { rerender } = render(ImageCardBody, {
			card: card([first]),
			onAction,
		});
		expect(screen.queryByTestId("image-card-strip")).toBeNull();

		await fireEvent.click(screen.getByRole("button", { name: /Another/ }));
		expect(onAction).toHaveBeenCalledWith({
			type: "another",
			cardId: "card-1",
		});
		expect(
			screen.getByTestId("image-card-tile-placeholder"),
		).toBeInTheDocument();
		expect(screen.getByTestId("image-card-body")).toHaveAttribute(
			"data-state",
			"waiting",
		);

		const queued = take({
			id: "take-new",
			status: "queued",
			fileId: null,
			origin: "another",
		});
		await rerender({ card: card([first, queued], { pickedTakeId: first.id }) });
		await tick();
		expect(screen.queryByTestId("image-card-tile-placeholder")).toBeNull();
		const tiles = screen.getAllByTestId("image-card-tile");
		expect(tiles).toHaveLength(2);
		expect(tiles[1]).toHaveAttribute("aria-pressed", "true");
	});

	// Task 17 (rehearsal): while a picture was being made the card offered
	// Another beside Stop, and nothing said what pressing it would do. Another
	// is offered once no take of the card is on its way.
	it("does not offer Another while a take of the card is on its way", async () => {
		const making = take({
			status: "running",
			phase: "rendering",
			phaseAt: Date.now(),
			fileId: null,
		});
		const onAction = vi.fn();
		const { rerender } = render(ImageCardBody, {
			card: card([making]),
			onAction,
		});
		const another = screen.getByRole("button", { name: /Another/ });
		expect(another).toBeDisabled();
		await fireEvent.click(another);
		expect(onAction).not.toHaveBeenCalled();

		const queued = take({ id: "take-2", status: "queued", fileId: null });
		await rerender({ card: card([take(), queued]) });
		expect(screen.getByRole("button", { name: /Another/ })).toBeDisabled();

		await rerender({ card: card([take(), take({ id: "take-2" })]) });
		expect(screen.getByRole("button", { name: /Another/ })).not.toBeDisabled();
	});

	it("does not offer Another again while the one pressed is on its way", async () => {
		const onAction = vi.fn(async () => ({ takeId: "take-new" }));
		render(ImageCardBody, { card: card([take()]), onAction });
		await fireEvent.click(screen.getByRole("button", { name: /Another/ }));
		await tick();
		expect(screen.getByTestId("image-card-tile-placeholder")).toBeInTheDocument();
		expect(screen.getByTestId("image-card-another")).toBeDisabled();
	});

	it("takes the placeholder back when Another did not go through", async () => {
		const onAction = vi.fn(async () => {
			throw new Error("refused");
		});
		render(ImageCardBody, { card: card([take()]), onAction });
		await fireEvent.click(screen.getByRole("button", { name: /Another/ }));
		await tick();
		await tick();
		expect(screen.queryByTestId("image-card-tile-placeholder")).toBeNull();
	});

	it("leaves no unhandled rejection when an action fails (the page's toast is the one signal)", async () => {
		const unhandled: unknown[] = [];
		const collect = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", collect);
		try {
			// A plain function: a vi.fn() mock attaches its own handler to what it
			// returns (settledResults), which would hide the rejection.
			let calls = 0;
			const onAction = () => {
				calls += 1;
				return Promise.reject(new Error("refused"));
			};
			const first = take({ fileId: "file-1" });
			const making = take({
				status: "running",
				phase: "rendering",
				fileId: null,
			});
			render(ImageCardBody, {
				card: card([first, making], { pickedTakeId: first.id }),
				onAction,
			});
			await fireEvent.click(screen.getByTestId("image-card-picture"));
			await fireEvent.click(screen.getAllByTestId("image-card-tile")[1]);
			await fireEvent.click(screen.getByRole("button", { name: "Stop" }));
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(calls).toBe(2);
			expect(unhandled).toEqual([]);
		} finally {
			process.off("unhandledRejection", collect);
		}
	});

	it("holds Download and History in its menu", async () => {
		const ready = take({ fileId: "file-z" });
		const onAction = vi.fn();
		render(ImageCardBody, { card: card([ready]), onAction });

		await fireEvent.click(screen.getByRole("button", { name: "More" }));
		await fireEvent.click(await screen.findByTestId("image-card-download"));
		expect(onAction).toHaveBeenCalledWith({
			type: "download",
			fileId: "file-z",
			title: "Cosy room",
		});

		await fireEvent.click(screen.getByRole("button", { name: "More" }));
		await fireEvent.click(await screen.findByTestId("image-card-history"));
		expect(onAction).toHaveBeenCalledWith({
			type: "history",
			artifactId: "artifact-1",
		});
	});

	it("attaches the shown picture, named after the card, from the More menu", async () => {
		const ready = take({ fileId: "file-z" });
		const onAction = vi.fn();
		render(ImageCardBody, { card: card([ready]), onAction });
		await fireEvent.click(screen.getByRole("button", { name: "More" }));
		await fireEvent.click(await screen.findByTestId("image-card-attach"));
		expect(onAction).toHaveBeenCalledWith({
			type: "attach",
			fileId: "file-z",
			name: "Cosy room",
			at: ready.createdAt,
		});
	});

	it("names an attached picture on one line of at most 80 characters, as the server does", async () => {
		const onAction = vi.fn();
		const long = `Lighthouse\non a hill ${"very ".repeat(30)}`;
		render(ImageCardBody, {
			card: { ...card([take({ fileId: "file-z" })]), title: long },
			onAction,
		});
		await fireEvent.click(screen.getByRole("button", { name: "More" }));
		await fireEvent.click(await screen.findByTestId("image-card-attach"));
		const { name } = onAction.mock.calls[0][0];
		expect(name).not.toMatch(/\n/);
		expect(Array.from(name).length).toBeLessThanOrEqual(80);
		expect(name.startsWith("Lighthouse on a hill")).toBe(true);
	});

	it("offers no Attach while the take has no picture yet", async () => {
		const making = take({
			status: "running",
			fileId: null,
			width: null,
			height: null,
		});
		render(ImageCardBody, { card: card([making]), onAction: vi.fn() });
		await fireEvent.click(screen.getByRole("button", { name: "More" }));
		expect(await screen.findByTestId("image-card-attach")).toBeDisabled();
	});

	it("opens the picture in the panel when it is pressed", async () => {
		const onAction = vi.fn();
		render(ImageCardBody, { card: card([take()]), onAction });
		await fireEvent.click(screen.getByTestId("image-card-picture"));
		expect(onAction).toHaveBeenCalledWith({
			type: "open",
			artifactId: "artifact-1",
		});
	});

	it("says pictures cannot be made when the server is out of reach, and tries again", async () => {
		const failed = take({
			status: "failed",
			fileId: null,
			errorCode: "image_server_unreachable",
			retryable: true,
		});
		const onAction = vi.fn();
		render(ImageCardBody, { card: card([failed]), onAction });

		expect(
			screen.getByText("Pictures can't be made right now."),
		).toBeInTheDocument();
		await fireEvent.click(screen.getByRole("button", { name: "Try again" }));
		expect(onAction).toHaveBeenCalledWith({ type: "retry", takeId: failed.id });
	});

	it("says a picture server that is not set up cannot make pictures either", () => {
		render(ImageCardBody, {
			card: card([
				take({
					status: "failed",
					fileId: null,
					errorCode: "image_server_not_configured",
				}),
			]),
		});
		expect(
			screen.getByText("Pictures can't be made right now."),
		).toBeInTheDocument();
	});

	it("says a failed take could not be made and that nothing was saved", () => {
		render(ImageCardBody, {
			card: card([
				take({
					status: "failed",
					fileId: null,
					errorCode: "image_render_failed",
				}),
			]),
		});
		expect(screen.getByText("Couldn't make this one.")).toBeInTheDocument();
		expect(screen.getByText("Nothing was saved.")).toBeInTheDocument();
	});

	it("offers Try again on a stopped take", async () => {
		const stopped = take({ status: "cancelled", fileId: null });
		const onAction = vi.fn();
		render(ImageCardBody, { card: card([stopped]), onAction });
		expect(screen.getByText("Stopped.")).toBeInTheDocument();
		await fireEvent.click(screen.getByRole("button", { name: "Try again" }));
		expect(onAction).toHaveBeenCalledWith({
			type: "retry",
			takeId: stopped.id,
		});
	});

	it("flips to the picture it was made from on Before, and back on After", async () => {
		const changed = take({ fileId: "after-f", baseFileId: "base-f" });
		render(ImageCardBody, {
			card: card([changed], { madeFrom: "photo" }),
		});
		const before = screen.getByRole("button", { name: "Before" });
		const after = screen.getByRole("button", { name: "After" });
		expect(after).toHaveAttribute("aria-pressed", "true");

		await fireEvent.click(before);
		// The switch answers at once; the picture flips once Before has loaded.
		expect(before).toHaveAttribute("aria-pressed", "true");
		await fireEvent.load(screen.getByTestId("image-picture-before"));
		expect(
			screen.getByRole("img", { name: "Cosy room" }).getAttribute("src"),
		).toContain("base-f");

		await fireEvent.click(after);
		expect(
			screen.getByRole("img", { name: "Cosy room" }).getAttribute("src"),
		).toContain("after-f");
	});

	it("shows the pictures a card was made from, numbered", () => {
		render(ImageCardBody, {
			card: card([take({ sourceFileIds: ["src-1", "src-2"] })], {
				madeFrom: "pictures",
				sourceCount: 2,
			}),
		});
		const row = screen.getByTestId("image-card-made-from");
		expect(row).toHaveTextContent("Made from");
		expect(row).toHaveTextContent("1");
		expect(row).toHaveTextContent("2");
		expect(row.querySelectorAll("img")).toHaveLength(2);
	});

	it("keeps the shown take with a quiet note while the server checks it once more, in the same box", async () => {
		const first = take({ fileId: "first-file" });
		const retry = take({
			origin: "auto_retry",
			held: true,
			retryOf: first.id,
			status: "running",
			phase: "rendering",
			fileId: null,
		});
		const { rerender } = render(ImageCardBody, {
			card: card([first, retry], { pickedTakeId: null }),
		});
		const stage = screen.getByTestId("image-card-stage");
		expect(screen.getByTestId("image-card-checking")).toHaveTextContent(
			"Alfy is trying once more…",
		);
		expect(
			stage
				.querySelector('[data-testid="image-picture-after"]')
				?.getAttribute("src"),
		).toContain("first-file");
		expect(screen.queryByTestId("image-card-strip")).toBeNull();

		// The retry won: the server hides the first take and releases the retry.
		await rerender({
			card: card(
				[
					{
						...retry,
						held: false,
						status: "succeeded",
						phase: null,
						fileId: "retry-file",
					},
				],
				{ pickedTakeId: retry.id },
			),
		});
		// Gone, or fading out (Svelte makes a leaving element inert).
		const leaving = screen.queryByTestId("image-card-checking");
		expect(leaving === null || isInert(leaving)).toBe(true);
		expect(screen.getByTestId("image-card-stage")).toBe(stage);
		expect(stage.style.aspectRatio).toBe("1248 / 832");
	});

	it("keeps Another's tile while only a held automatic retry joins the card", async () => {
		const first = take();
		const onAction = vi.fn(() => new Promise<{ takeId?: string }>(() => {}));
		const { rerender } = render(ImageCardBody, {
			card: card([first]),
			onAction,
		});
		await fireEvent.click(screen.getByRole("button", { name: /Another/ }));
		await rerender({
			card: card([
				first,
				take({
					origin: "auto_retry",
					held: true,
					retryOf: first.id,
					status: "queued",
					fileId: null,
				}),
			]),
		});
		expect(
			screen.getByTestId("image-card-tile-placeholder"),
		).toBeInTheDocument();
	});

	it("says a deleted picture is gone, in its box, and offers nothing to press", async () => {
		const ready = take({ fileId: "file-d" });
		const onAction = vi.fn();
		const { rerender } = render(ImageCardBody, {
			card: card([ready, take()]),
			onAction,
		});
		const stage = screen.getByTestId("image-card-stage");
		await rerender({ gone: "deleted" });

		expect(screen.getByTestId("image-card-gone")).toHaveTextContent(
			"The picture is no longer kept.",
		);
		// The picture fades out under the words (Svelte makes a leaving layer
		// inert), and cannot be pressed meanwhile.
		for (const picture of screen.queryAllByTestId("image-card-picture")) {
			expect((picture as HTMLButtonElement).disabled || isInert(picture)).toBe(
				true,
			);
		}
		expect(screen.getByTestId("image-card-stage")).toBe(stage);
		expect(stage.style.aspectRatio).toBe("1248 / 832");
		expect(screen.getByRole("button", { name: /Another/ })).toBeDisabled();
		expect(screen.getByRole("button", { name: "More" })).toBeDisabled();
		for (const tile of screen.getAllByTestId("image-card-tile")) {
			expect(tile).toBeDisabled();
			expect(tile.querySelector("img")).toBeNull();
		}
		expect(screen.queryByRole("button", { name: /Use this/ })).toBeNull();
		expect(onAction).not.toHaveBeenCalled();
	});

	it("says a picture made in another chat opens there, in Hungarian too", () => {
		uiLanguage.set("hu");
		render(ImageCardBody, { card: card([take()]), gone: "unreachable" });
		expect(screen.getByTestId("image-card-gone")).toHaveTextContent(
			"Abban a beszélgetésben nyitható meg, ahol készült.",
		);
		expect(screen.getByRole("button", { name: /Másik/ })).toBeDisabled();
	});

	it("speaks Hungarian", async () => {
		uiLanguage.set("hu");
		const first = take();
		const second = take();
		render(ImageCardBody, {
			card: card([
				first,
				second,
				take({ status: "running", phase: "rendering", fileId: null }),
			]),
		});
		expect(screen.getByRole("button", { name: /Másik/ })).toBeInTheDocument();
		await fireEvent.click(screen.getAllByTestId("image-card-tile")[1]);
		expect(
			screen.getByRole("button", { name: /Ez legyen/ }),
		).toBeInTheDocument();
		await fireEvent.click(screen.getAllByTestId("image-card-tile")[2]);
		expect(screen.getByTestId("image-card-status")).toHaveTextContent(
			"Készül a kép…",
		);
	});
});
