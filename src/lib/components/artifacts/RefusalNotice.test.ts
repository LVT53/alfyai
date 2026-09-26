import { cleanup, fireEvent, render, screen } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
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
});
