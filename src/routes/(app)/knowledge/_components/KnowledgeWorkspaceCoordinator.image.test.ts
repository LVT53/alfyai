import { render, screen, waitFor } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { KnowledgeDocumentItem } from "$lib/server/services/knowledge/types";
import { serializeImageVersionBody } from "$lib/shared/artifacts/image-body";
import KnowledgeWorkspaceCoordinator from "./KnowledgeWorkspaceCoordinator.svelte";

// Workspace Search hands an image result off as `/knowledge?open_artifact=<id>`;
// the knowledge page opens it in the working-document panel, which dispatches
// on the item's kind to the image body.

const api = vi.hoisted(() => ({
	fetchArtifact: vi.fn(),
	fetchArtifactHistory: vi.fn(),
	fetchKnowledgeWorkspaceDocument: vi.fn(),
}));

vi.mock("$app/state", () => ({
	page: {
		url: new URL(
			"http://localhost/knowledge?open_artifact=img-1&open_filename=Harbour%20at%20dusk",
		),
		state: {},
	},
}));
vi.mock("$app/navigation", () => ({ replaceState: vi.fn() }));
vi.mock("$app/environment", () => ({
	browser: true,
	building: false,
	dev: true,
	version: "test",
}));
vi.mock("$lib/client/api/knowledge", () => ({
	fetchKnowledgeWorkspaceDocument: api.fetchKnowledgeWorkspaceDocument,
	recordDocumentWorkspaceOpen: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("$lib/client/api/artifacts", () => ({
	fetchArtifact: api.fetchArtifact,
	fetchArtifactHistory: api.fetchArtifactHistory,
}));

const imageRow = {
	id: "img-1",
	name: "Harbour at dusk",
	type: "artifact",
	kind: "image",
	mimeType: null,
	sizeBytes: null,
	createdAt: 1,
	updatedAt: 1,
	displayArtifactId: "img-1",
	promptArtifactId: null,
	familyArtifactIds: ["img-1"],
	conversationId: "conv-1",
	summary: null,
	normalizedAvailable: false,
} as unknown as KnowledgeDocumentItem;

describe("an image result handed off from Workspace Search", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		global.fetch = vi.fn(() => new Promise(() => undefined)) as typeof fetch;
		api.fetchArtifactHistory.mockResolvedValue({
			ok: true,
			artifactKind: "image",
			moments: [],
			older: false,
			nextBefore: null,
			newestVersion: 1,
			newestHash: "h",
		});
		api.fetchArtifact.mockResolvedValue({
			artifact: {
				id: "img-1",
				kind: "image",
				title: "Harbour at dusk",
				body: serializeImageVersionBody({
					v: 1,
					fileId: "file-1",
					width: 1200,
					height: 800,
					hasAlpha: false,
					baseFileId: null,
					sources: [],
					marks: null,
					prompt: null,
					takeId: null,
					seed: null,
					anchorFileId: null,
					chainSinceAnchor: 0,
				}),
				versionNumber: 1,
				conversationId: "conv-1",
				metadata: {},
			},
			versions: [],
			comments: [],
		});
	});

	it("opens in the panel with the image body", async () => {
		render(KnowledgeWorkspaceCoordinator, {
			props: { documents: [imageRow] },
		});

		await screen.findByRole("complementary", {
			name: "Harbour at dusk, Image",
		});
		const picture = await screen.findByTestId("image-body-picture");
		await waitFor(() => {
			expect(
				picture
					.querySelector('[data-testid="image-picture-after"]')
					?.getAttribute("src"),
			).toContain("/api/images/files/file-1");
		});
	});
});
