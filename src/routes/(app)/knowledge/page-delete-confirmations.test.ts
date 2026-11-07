import { fireEvent, render, screen, within } from "@testing-library/svelte";
import type { Component } from "svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockPageState = vi.hoisted(() => ({
	page: {
		url: new URL("http://localhost/knowledge?tab=documents"),
		state: {},
	},
}));

vi.mock("$app/environment", () => ({
	browser: true,
	building: false,
	dev: false,
	version: "test",
}));

vi.mock("$app/navigation", () => ({
	goto: vi.fn(),
	invalidateAll: vi.fn(),
	replaceState: vi.fn(),
}));

vi.mock("$app/state", () => mockPageState);

import { uiLanguage } from "$lib/stores/settings";
import Page from "./+page.svelte";

function document(id: string, name: string) {
	return {
		id,
		type: "source_document",
		displayArtifactId: id,
		promptArtifactId: null,
		familyArtifactIds: [id],
		name,
		mimeType: "application/pdf",
		sizeBytes: 1024,
		conversationId: null,
		summary: null,
		normalizedAvailable: false,
		documentOrigin: "uploaded",
		createdAt: 1_000_000_000_000,
		updatedAt: 1_000_000_000_000,
	};
}

function pageData(...names: string[]) {
	const documents = names.map((name, index) =>
		document(`doc-${index + 1}`, name),
	);
	return {
		library: {
			documents,
			results: [],
			workflows: [],
			query: "",
			sort: { key: "date" as const, direction: "desc" as const },
			pagination: {
				page: 1,
				pageSize: 20,
				totalItems: documents.length,
				totalPages: 1,
			},
		},
	};
}

const KnowledgePage = Page as unknown as Component<{
	data: ReturnType<typeof pageData>;
}>;

// The titles and the buttons of these two dialogs were translated; the question
// between them was a template string in English, so a Hungarian reader was asked
// about deleting a document in English.
describe("Knowledge page: confirming a delete", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		uiLanguage.set("en");
	});

	async function askToDeleteOne() {
		render(KnowledgePage, { data: pageData("Budget.pdf") });
		await fireEvent.click(
			screen.getByRole("button", { name: "Delete document?" }),
		);
		return screen.findByRole("dialog");
	}

	async function askToDeleteTwo(selectLabel: (name: string) => string) {
		render(KnowledgePage, { data: pageData("Budget.pdf", "Notes.pdf") });
		await fireEvent.click(
			screen.getByRole("checkbox", { name: selectLabel("Budget.pdf") }),
		);
		await fireEvent.click(
			screen.getByRole("checkbox", { name: selectLabel("Notes.pdf") }),
		);
	}

	it("names the document it will remove, in English", async () => {
		const dialog = await askToDeleteOne();

		expect(
			within(dialog).getByText("Remove “Budget.pdf” from the Knowledge Base?"),
		).toBeInTheDocument();
	});

	it("asks in Hungarian for a Hungarian reader", async () => {
		uiLanguage.set("hu");
		render(KnowledgePage, { data: pageData("Budget.pdf") });
		await fireEvent.click(
			screen.getByRole("button", { name: "Biztosan törlöd a dokumentumot?" }),
		);

		const dialog = await screen.findByRole("dialog");
		expect(
			within(dialog).getByText(
				"Eltávolítod a(z) „Budget.pdf” dokumentumot a Tudásbázisból?",
			),
		).toBeInTheDocument();
		expect(
			within(dialog).queryByText(/Knowledge Base/),
		).not.toBeInTheDocument();
	});

	it("counts the selected documents it will delete, in English", async () => {
		await askToDeleteTwo((name) => `Select ${name}`);
		await fireEvent.click(
			screen.getByRole("button", { name: "Delete Selected" }),
		);

		const dialog = await screen.findByRole("dialog");
		expect(
			within(dialog).getByText(
				"Delete 2 selected documents? This cannot be undone.",
			),
		).toBeInTheDocument();
	});

	it("counts the selected documents in Hungarian for a Hungarian reader", async () => {
		uiLanguage.set("hu");
		await askToDeleteTwo((name) => `${name} kijelölése`);
		await fireEvent.click(
			screen.getByRole("button", { name: "Kijelöltek törlése" }),
		);

		const dialog = await screen.findByRole("dialog");
		expect(
			within(dialog).getByText(
				"Törlöd a kijelölt 2 dokumentumot? Ez nem vonható vissza.",
			),
		).toBeInTheDocument();
		expect(
			within(dialog).queryByText(/cannot be undone/),
		).not.toBeInTheDocument();
	});
});
