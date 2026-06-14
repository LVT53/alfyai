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
				onRetry: vi.fn(),
			},
		});

		expect(getByText(errorText)).toBeInTheDocument();
	});

	it("displays retry button", () => {
		const onRetry = vi.fn();
		const { getByRole } = render(ErrorMessage, {
			props: {
				error: "Error occurred",
				onRetry,
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
				onRetry,
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
				onRetry: vi.fn(),
				onClose,
			},
		});

		await fireEvent.click(getByRole("button", { name: /close/i }));

		expect(onClose).toHaveBeenCalledTimes(1);
	});
});
