import { fireEvent, render, screen } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearToasts, showToast } from "$lib/stores/toast";
import Toast from "./Toast.svelte";

// A toast now leaves through an outro (redesign §7.2 #33), and jsdom never
// runs an outro to its end — so the tests below that are about DISMISSAL
// itself (the timer, the action, the close button) ask for reduced motion,
// whose exit is instant by the spec's own §7.3. The exit's motion has its own
// tests: `toast-motion.test.ts` for its numbers, the "exit" describe below
// for the wiring, and Playwright for the real thing.
const originalMatchMedia = window.matchMedia;

function stubReducedMotion(reduce: boolean) {
	window.matchMedia = vi.fn((query: string) => ({
		matches: reduce && query.includes("prefers-reduced-motion"),
		media: query,
		addEventListener: vi.fn(),
		removeEventListener: vi.fn(),
		addListener: vi.fn(),
		removeListener: vi.fn(),
		dispatchEvent: vi.fn(),
		onchange: null,
	})) as unknown as typeof window.matchMedia;
}

describe("Toast", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		clearToasts();
	});

	afterEach(() => {
		clearToasts();
		vi.useRealTimers();
		window.matchMedia = originalMatchMedia;
		vi.restoreAllMocks();
	});

	it("renders nothing when there are no active toasts", () => {
		render(Toast);

		expect(screen.queryByTestId("toast-entry")).not.toBeInTheDocument();
	});

	it("renders its region above the modal z-index band so it's never hidden behind a dialog", () => {
		render(Toast);

		// App modals top out at z-[10000] (see ConversationItem's conversation-menu);
		// the toast region must render strictly above that band.
		expect(screen.getByTestId("toast-region")).toHaveClass("z-[10100]");
	});

	it("renders a pushed success toast with an accessible status role", async () => {
		render(Toast);

		showToast({ type: "success", message: "Copied to clipboard" });
		await tick();

		const entry = screen.getByRole("status");
		expect(entry).toHaveTextContent("Copied to clipboard");
	});

	it("renders a pushed error toast with an accessible alert role", async () => {
		render(Toast);

		showToast({ type: "error", message: "Couldn't copy to clipboard" });
		await tick();

		const entry = screen.getByRole("alert");
		expect(entry).toHaveTextContent("Couldn't copy to clipboard");
	});

	it("auto-dismisses a toast after its duration elapses", async () => {
		stubReducedMotion(true);
		render(Toast);

		showToast({ type: "success", message: "Bye soon", duration: 1000 });
		await tick();
		expect(screen.getByTestId("toast-entry")).toBeInTheDocument();

		vi.advanceTimersByTime(1000);
		await tick();

		expect(screen.queryByTestId("toast-entry")).not.toBeInTheDocument();
	});

	it("renders an inline action button and runs it, then dismisses the toast, on click", async () => {
		stubReducedMotion(true);
		render(Toast);
		const onAction = vi.fn();

		showToast({
			type: "success",
			message: "Now showing v2",
			actionLabel: "Undo",
			onAction,
			duration: 0,
		});
		await tick();

		const actionButton = screen.getByRole("button", { name: "Undo" });
		await fireEvent.click(actionButton);

		expect(onAction).toHaveBeenCalledOnce();
		expect(screen.queryByTestId("toast-entry")).not.toBeInTheDocument();
	});

	it("renders no action button when a toast has no actionLabel/onAction", async () => {
		render(Toast);

		showToast({ type: "success", message: "Copied to clipboard" });
		await tick();

		expect(
			screen.queryByRole("button", { name: "Undo" }),
		).not.toBeInTheDocument();
	});

	it("dismisses a toast via its manual close button", async () => {
		stubReducedMotion(true);
		render(Toast);

		showToast({ type: "success", message: "Close me", duration: 0 });
		await tick();
		const closeButton = screen.getByRole("button", { name: "Close" });

		await fireEvent.click(closeButton);

		expect(screen.queryByTestId("toast-entry")).not.toBeInTheDocument();
	});

	describe("exit (redesign §7.2 #33)", () => {
		it("starts its exit animation on dismiss: the standard 150ms, fading out and sinking 12px", async () => {
			stubReducedMotion(false);
			const animate = vi.spyOn(Element.prototype, "animate");
			render(Toast);
			showToast({ type: "success", message: "Bye", duration: 0 });
			await tick();
			animate.mockClear();

			await fireEvent.click(screen.getByRole("button", { name: "Close" }));

			// Svelte starts an outro with a dummy animation and begins the real one
			// when that finishes; jsdom finishes nothing on its own, so finish it.
			for (const result of animate.mock.results) {
				(result.value as { onfinish?: () => void }).onfinish?.();
			}

			const exit = animate.mock.calls.find(
				([, options]) =>
					(options as KeyframeAnimationOptions | undefined)?.duration === 150,
			);
			expect(exit, "the toast's outro animation").toBeTruthy();
			const keyframes = exit?.[0] as Keyframe[];
			expect(keyframes[0]).toMatchObject({
				opacity: "1",
				transform: "translateY(0px)",
			});
			expect(keyframes[keyframes.length - 1]).toMatchObject({
				opacity: "0",
				transform: "translateY(12px)",
			});
		});

		it("leaves at once under reduced motion: no animation, nothing left in the DOM", async () => {
			stubReducedMotion(true);
			const animate = vi.spyOn(Element.prototype, "animate");
			render(Toast);
			showToast({ type: "success", message: "Bye", duration: 0 });
			await tick();
			animate.mockClear();

			await fireEvent.click(screen.getByRole("button", { name: "Close" }));

			expect(screen.queryByTestId("toast-entry")).not.toBeInTheDocument();
			expect(animate).not.toHaveBeenCalled();
		});
	});
});
