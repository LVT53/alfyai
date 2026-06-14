import { fireEvent, render, screen } from "@testing-library/svelte";
import { describe, expect, it } from "vitest";
import MessageEvidenceDetails from "./MessageEvidenceDetails.svelte";

describe("MessageEvidenceDetails", () => {
	it("expands the evidence list when the toggle is clicked", async () => {
		render(MessageEvidenceDetails, {
			evidenceSummary: {
				structuredWebSearch: false,
				groups: [
					{
						sourceType: "document",
						label: "Documents",
						reranked: false,
						items: [
							{
								id: "evidence-1",
								title: "Quarterly report",
								sourceType: "document",
								status: "selected",
								description: "Summary evidence",
							},
						],
					},
				],
			},
		});

		expect(screen.queryByText("Quarterly report")).toBeNull();

		await fireEvent.click(screen.getByRole("button", { name: /Evidence/i }));

		expect(screen.getByText("Quarterly report")).toBeInTheDocument();
		expect(screen.getByText("Summary evidence")).toBeInTheDocument();
	});
});
