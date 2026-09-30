import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MOTION_DURATION, MOTION_EASING } from "$lib/utils/motion";
import RefusalNotice from "./RefusalNotice.svelte";

afterEach(() => {
	cleanup();
});

describe("RefusalNotice", () => {
	it("names the refused block's label, its reason, and the count of untouched parts", () => {
		render(RefusalNotice, {
			message: "Alfy left one part alone because you had changed it.",
			items: [
				{
					label: "Hotel budget",
					reason: "you changed this after Alfy last read it",
				},
			],
		});
		const notice = screen.getByTestId("refusal-notice");
		expect(notice).toHaveTextContent(
			"Alfy left one part alone because you had changed it.",
		);
		expect(notice).toHaveTextContent("Hotel budget");
		expect(notice).toHaveTextContent(
			"you changed this after Alfy last read it",
		);
	});

	it("lists every refused part when there is more than one", () => {
		render(RefusalNotice, {
			message: "Alfy left some parts alone because you had changed them.",
			items: [
				{
					label: "Hotel budget",
					reason: "you changed this after Alfy last read it",
				},
				{ label: "Packing list", reason: "this part no longer exists" },
			],
		});
		expect(
			screen.getByText("Hotel budget", { exact: false }),
		).toBeInTheDocument();
		expect(
			screen.getByText("Packing list", { exact: false }),
		).toBeInTheDocument();
	});

	it('offers a "see what Alfy did" affordance only when both the label and the handler are given', () => {
		const onSeeChange = vi.fn();
		render(RefusalNotice, {
			message: "Alfy left one part alone because you had changed it.",
			items: [
				{
					label: "Hotel budget",
					reason: "you changed this after Alfy last read it",
				},
			],
			seeChangeLabel: "See what Alfy did",
			onSeeChange,
		});
		const button = screen.getByRole("button", { name: "See what Alfy did" });
		expect(button).toBeInTheDocument();
	});

	it("scrolls to the applied change when the affordance is used", async () => {
		const onSeeChange = vi.fn();
		render(RefusalNotice, {
			message: "Alfy left one part alone because you had changed it.",
			seeChangeLabel: "See what Alfy did",
			onSeeChange,
		});
		await fireEvent.click(
			screen.getByRole("button", { name: "See what Alfy did" }),
		);
		expect(onSeeChange).toHaveBeenCalledOnce();
	});

	it("renders no affordance when there is nothing applied to see", () => {
		render(RefusalNotice, {
			message: "Alfy left one part alone because you had changed it.",
		});
		expect(screen.queryByRole("button")).not.toBeInTheDocument();
	});

	it("offers Ask again and Dismiss when both handlers and labels are given", async () => {
		const onAskAgain = vi.fn();
		const onDismiss = vi.fn();
		render(RefusalNotice, {
			message: "Alfy left one part alone because you had changed it.",
			askAgainLabel: "Ask again",
			onAskAgain,
			dismissLabel: "Dismiss",
			onDismiss,
		});
		await fireEvent.click(screen.getByRole("button", { name: "Ask again" }));
		expect(onAskAgain).toHaveBeenCalledOnce();
		await fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
		// The card leaves first (motion #22), then the caller clears it.
		await waitFor(() => expect(onDismiss).toHaveBeenCalledOnce());
	});

	it("renders neither Ask again nor Dismiss without their own handlers", () => {
		render(RefusalNotice, {
			message: "Alfy left one part alone because you had changed it.",
		});
		expect(
			screen.queryByRole("button", { name: "Ask again" }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Dismiss" }),
		).not.toBeInTheDocument();
	});

	it("stays the same pinned card regardless of how many actions it offers (data-testid stable)", () => {
		render(RefusalNotice, {
			message: "Alfy left one part alone because you had changed it.",
			seeChangeLabel: "See what Alfy did",
			onSeeChange: vi.fn(),
			askAgainLabel: "Ask again",
			onAskAgain: vi.fn(),
			dismissLabel: "Dismiss",
			onDismiss: vi.fn(),
		});
		expect(screen.getByTestId("refusal-notice")).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "See what Alfy did" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Ask again" }),
		).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Dismiss" })).toBeInTheDocument();
	});
});

// Redesign §7.2 #22: "Dismiss slides 8 px right and fades" — out standard ·
// ease-in; reduced motion: instant. A Svelte out-transition cannot do this
// (it never finishes under the repo's jsdom animation mock, and the caller
// removes the card by clearing its own state), so the card animates itself
// with the Web Animations API and only then asks the caller to clear it.
describe("RefusalNotice: Dismiss leaves with motion (§7.2 #22)", () => {
	const originalMatchMedia = window.matchMedia;
	const originalAnimate = Element.prototype.animate;
	afterEach(() => {
		window.matchMedia = originalMatchMedia;
		Element.prototype.animate = originalAnimate;
	});

	function renderDismissable() {
		const onDismiss = vi.fn();
		render(RefusalNotice, {
			message: "Alfy left one part alone because you had changed it.",
			dismissLabel: "Dismiss",
			onDismiss,
		});
		return onDismiss;
	}

	/** An animation whose end the test controls. */
	function controlledAnimation() {
		let finish: () => void = () => {};
		const finished = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const animate = vi.fn(() => ({ finished, cancel: vi.fn() }));
		Element.prototype.animate =
			animate as unknown as typeof Element.prototype.animate;
		return { animate, finish };
	}

	it("slides 8px right and fades over the standard duration, and only then clears the card", async () => {
		const onDismiss = renderDismissable();
		const { animate, finish } = controlledAnimation();

		await fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));

		expect(animate).toHaveBeenCalledOnce();
		const [keyframes, options] = animate.mock.calls[0] as unknown as [
			Keyframe[],
			KeyframeAnimationOptions,
		];
		expect(keyframes.at(-1)).toMatchObject({
			opacity: 0,
			transform: "translateX(8px)",
		});
		expect(options.duration).toBe(MOTION_DURATION.standard);
		expect(options.easing).toBe(MOTION_EASING.in);
		expect(onDismiss).not.toHaveBeenCalled();

		finish();
		await waitFor(() => expect(onDismiss).toHaveBeenCalledOnce());
	});

	it("animates the card itself", async () => {
		renderDismissable();
		const { animate } = controlledAnimation();
		await fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
		const target = animate.mock.contexts[0] as unknown as HTMLElement;
		expect(target).toBe(screen.getByTestId("refusal-notice"));
	});

	it("clears the card at once under reduced motion, without an animation", async () => {
		window.matchMedia = ((query: string) => ({
			matches: query.includes("prefers-reduced-motion"),
			media: query,
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
		})) as unknown as typeof window.matchMedia;
		const onDismiss = renderDismissable();
		const { animate } = controlledAnimation();

		await fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));

		expect(animate).not.toHaveBeenCalled();
		expect(onDismiss).toHaveBeenCalledOnce();
	});

	it("ignores a second click while it is leaving", async () => {
		const onDismiss = renderDismissable();
		const { animate, finish } = controlledAnimation();

		const dismiss = screen.getByRole("button", { name: "Dismiss" });
		await fireEvent.click(dismiss);
		await fireEvent.click(dismiss);
		finish();
		await waitFor(() => expect(onDismiss).toHaveBeenCalledOnce());
		expect(animate).toHaveBeenCalledOnce();
	});

	it("does not clear anything if the card is gone before its exit ends", async () => {
		const onDismiss = renderDismissable();
		const { finish } = controlledAnimation();
		await fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));

		cleanup();
		finish();
		await Promise.resolve();
		await Promise.resolve();
		expect(onDismiss).not.toHaveBeenCalled();
	});

	// One more action, for a caller whose way out is neither "see what Alfy did"
	// nor "ask again" (a board's Undo that cannot be done points to its versions).
	it("offers one action of its caller's own, and calls it", async () => {
		const onAction = vi.fn();
		render(RefusalNotice, {
			message: "Alfy's change can't be undone here.",
			actionLabel: "Open Versions",
			onAction,
		});
		await fireEvent.click(
			screen.getByRole("button", { name: "Open Versions" }),
		);
		expect(onAction).toHaveBeenCalledTimes(1);
	});

	it("draws no action without both a label and a handler", () => {
		render(RefusalNotice, {
			message: "Alfy skipped 1 change.",
			actionLabel: "Open",
		});
		expect(screen.queryByRole("button")).toBeNull();
	});
});
