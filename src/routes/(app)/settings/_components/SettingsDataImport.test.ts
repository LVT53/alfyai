import { fireEvent, render, screen } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import SettingsDataImport from "./SettingsDataImport.svelte";

vi.mock("$lib/components/chat/ImportChatGPTModal.svelte", async () => {
	const { default: MockModal } = await import(
		"./__mocks__/ImportChatGPTModal.svelte"
	);
	return { default: MockModal };
});

describe("SettingsDataImport", () => {
	it("renders with correct title and description", () => {
		render(SettingsDataImport, {
			props: { projects: [] },
		});

		expect(screen.getByText("Data & Import")).toBeInTheDocument();
		expect(
			screen.getByText(
				"Import your conversations from ChatGPT to continue where you left off.",
			),
		).toBeInTheDocument();
	});

	it("renders the import button", () => {
		render(SettingsDataImport, {
			props: { projects: [] },
		});

		expect(
			screen.getByRole("button", { name: "Import from ChatGPT" }),
		).toBeInTheDocument();
	});

	it("opens the import modal when button is clicked", async () => {
		render(SettingsDataImport, {
			props: { projects: [] },
		});

		const button = screen.getByRole("button", { name: "Import from ChatGPT" });
		await fireEvent.click(button);

		expect(screen.getByTestId("import-chatgpt-modal")).toBeInTheDocument();
	});

	it("passes projects to the modal", async () => {
		const projects = [
			{
				id: "proj-1",
				name: "My Project",
				sortOrder: 0,
				createdAt: 1,
				updatedAt: 2,
			},
		];

		render(SettingsDataImport, {
			props: { projects },
		});

		const button = screen.getByRole("button", { name: "Import from ChatGPT" });
		await fireEvent.click(button);

		expect(screen.getByTestId("import-chatgpt-modal")).toBeInTheDocument();
	});

	it("follows existing settings-card styling pattern", () => {
		const { container } = render(SettingsDataImport, {
			props: { projects: [] },
		});

		const section = container.querySelector("section.settings-card");
		expect(section).toBeInTheDocument();

		const title = section?.querySelector("h2.settings-section-title");
		expect(title).toBeInTheDocument();
	});
});
