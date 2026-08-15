import { fireEvent, render } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ErrorMessage from "./ErrorMessage.svelte";

describe("ErrorMessage", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("renders error message correctly", () => {
		const errorText = "Something went wrong";
		const { getByText } = render(ErrorMessage, {
			props: {
				error: errorText,
				canRetry: true,
				onRetry: vi.fn(),
				onClose: vi.fn(),
			},
		});

		expect(getByText(errorText)).toBeInTheDocument();
	});

	it("displays retry button", () => {
		const onRetry = vi.fn();
		const { getByRole } = render(ErrorMessage, {
			props: {
				error: "Error occurred",
				canRetry: true,
				onRetry,
				onClose: vi.fn(),
			},
		});

		const button = getByRole("button", { name: /retry/i });
		expect(button).toBeInTheDocument();
	});

	it("calls onRetry when button is clicked", async () => {
		const onRetry = vi.fn();
		const { getByRole } = render(ErrorMessage, {
			props: {
				error: "Error occurred",
				canRetry: true,
				onRetry,
				onClose: vi.fn(),
			},
		});

		const button = getByRole("button", { name: /retry/i });
		await fireEvent.click(button);

		expect(onRetry).toHaveBeenCalledTimes(1);
	});

	it("shows error icon", () => {
		const { container } = render(ErrorMessage, {
			props: {
				error: "Error occurred",
				canRetry: true,
				onRetry: vi.fn(),
				onClose: vi.fn(),
			},
		});

		expect(container.querySelector(".error-icon svg")).toBeTruthy();
	});

	it("renders the expected alert shell classes", () => {
		const { container, getByRole } = render(ErrorMessage, {
			props: {
				error: "Error occurred",
				canRetry: true,
				onRetry: vi.fn(),
				onClose: vi.fn(),
			},
		});

		expect(getByRole("alert")).toHaveClass("error-toast");
		expect(container.querySelector(".error-actions")).toBeTruthy();
	});

	it("calls onClose when the dismiss button is clicked", async () => {
		const onClose = vi.fn();
		const { getByRole } = render(ErrorMessage, {
			props: {
				error: "Error occurred",
				canRetry: true,
				onRetry: vi.fn(),
				onClose,
			},
		});

		await fireEvent.click(getByRole("button", { name: /close/i }));

		expect(onClose).toHaveBeenCalledTimes(1);
	});

	// R1 (ADR-0060) — canRetry crossing the seam. Before this, the runtime's
	// own canRetry never reached the page at all, so this affordance was
	// unconditionally offered even when the runtime would silently refuse a
	// retry() call.
	it("does not offer a retry affordance when canRetry is false", () => {
		const onRetry = vi.fn();
		const { queryByRole, getByRole } = render(ErrorMessage, {
			props: {
				error: "Skill session could not be recovered",
				canRetry: false,
				onRetry,
				onClose: vi.fn(),
			},
		});

		expect(queryByRole("button", { name: /retry/i })).toBeNull();
		// The dismiss control must still be offered — only retry is gated.
		expect(getByRole("button", { name: /close/i })).toBeInTheDocument();
	});

	it("still shows the error text when canRetry is false", () => {
		const { getByText } = render(ErrorMessage, {
			props: {
				error: "Skill session could not be recovered",
				canRetry: false,
				onRetry: vi.fn(),
				onClose: vi.fn(),
			},
		});

		expect(
			getByText("Skill session could not be recovered"),
		).toBeInTheDocument();
	});
});
