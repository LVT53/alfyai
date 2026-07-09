import { fireEvent, render, screen } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import GoogleSignInButton from "./GoogleSignInButton.svelte";

function renderButton(overrides: Record<string, unknown> = {}) {
	return render(GoogleSignInButton, {
		props: {
			...overrides,
		},
	});
}

describe("GoogleSignInButton", () => {
	it("renders with the default localized label as its accessible name", () => {
		renderButton();

		expect(
			screen.getByRole("button", { name: "Continue with Google" }),
		).toBeInTheDocument();
	});

	it("renders the multicolor Google G mark", () => {
		renderButton();

		const button = screen.getByRole("button", { name: "Continue with Google" });
		const paths = button.querySelectorAll("svg path");
		expect(paths.length).toBeGreaterThanOrEqual(4);
		const fills = new Set(Array.from(paths).map((p) => p.getAttribute("fill")));
		expect(fills.size).toBeGreaterThan(1);
	});

	it("calls onClick when clicked", async () => {
		const onClick = vi.fn();
		renderButton({ onClick });

		await fireEvent.click(
			screen.getByRole("button", { name: "Continue with Google" }),
		);

		expect(onClick).toHaveBeenCalledOnce();
	});

	it("does not call onClick when disabled", async () => {
		const onClick = vi.fn();
		renderButton({ onClick, disabled: true });

		await fireEvent.click(
			screen.getByRole("button", { name: "Continue with Google" }),
		);

		expect(onClick).not.toHaveBeenCalled();
	});

	it("reflects the disabled prop", () => {
		renderButton({ disabled: true });

		expect(
			screen.getByRole("button", { name: "Continue with Google" }),
		).toBeDisabled();
	});

	it("accepts a custom label", () => {
		renderButton({ label: "Connect Google" });

		expect(
			screen.getByRole("button", { name: "Connect Google" }),
		).toBeInTheDocument();
	});
});
