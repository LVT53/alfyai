import { randomUUID } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import { and, eq } from "drizzle-orm";
import { db } from "../../src/lib/server/db";
import {
	artifacts,
	conversations,
	messages,
} from "../../src/lib/server/db/schema";
import {
	AI_SMOKE_API_KEY,
	AI_SMOKE_MODEL_ID,
} from "../fixtures/ai/openai-compatible-scenarios";
import { createOpenAICompatibleProviderHarness } from "../mocks/ai-provider/openai-compatible-provider";
import { login, sendMessage, waitForHydration } from "./helpers";

/**
 * A turn's evidence is written AFTER its terminal stream frame: the browser
 * gets the receipt, the server then composes the evidence summary (and the
 * count of project files the turn read) and persists both. Everything the
 * reader sees about evidence on the live page therefore has to arrive through
 * the post-completion path — either the evidence poll the client runs on every
 * completion, or a conversation-detail hydration.
 *
 * This spec defends the reader-visible half of that contract: after a turn in a
 * project conversation that read project files, WITHOUT reloading the page,
 *   - the Info popover shows the "Project files" row, and
 *   - the message shows its Sources panel.
 *
 * It runs against the deterministic fake provider, so no live model is needed.
 * The retrieval that selects the project files is server-side and driven by the
 * question naming the file, exactly as the Slice E capture did it.
 */

const UPLOAD_RAW_PATH = "/api/knowledge/upload/raw";

const provider = createOpenAICompatibleProviderHarness();

test.describe("live evidence metadata", () => {
	test.beforeAll(async () => {
		await provider.start();
	});

	test.afterAll(async () => {
		await provider.stop();
	});

	test.beforeEach(async ({ page }) => {
		await provider.reset();
		await page.setViewportSize({ width: 1440, height: 1000 });
		await login(page);
	});

	test("shows the Project files row and the Sources panel without a reload", async ({
		page,
	}) => {
		// Registered before the turn so the diagnosis sees the evidence
		// endpoint's answers, not a summary someone remembered to write.
		const evidenceCalls: string[] = [];
		const evidenceRequests: number[] = [];
		watchEvidenceEndpoint(page, evidenceCalls);
		page.on("request", (request) => {
			if (request.url().includes("/evidence"))
				evidenceRequests.push(Date.now());
		});

		const turn = await runProjectTurn(page);
		const bubble = page.getByTestId("assistant-message").last();

		// The Sources panel is rendered by MessageEvidenceDetails off the
		// message's own `evidenceSummary` — the field the evidence poll writes.
		await expect(
			bubble.getByRole("button", { name: /Sources/ }),
			"the message's Sources panel must be there without a reload",
		).toBeAttached({ timeout: 25000 });

		// The popover's row reads `projectFilesRead`, a different field on the
		// same message. Both are written by the server in one metadata write at
		// the end of the turn.
		await expect(
			page
				.locator(".info-popover")
				.last()
				.locator(".audit-row--action", { hasText: "Project files" }),
			"the Info popover's Project files row must be there without a reload",
		).toHaveCount(1, { timeout: 25000 });

		// Reported at the end, when every answer the poll got has been seen: the
		// evidence is composed AFTER the terminal frame, so the poll's first
		// attempt can legitimately come back "pending".
		console.log(
			`[evidence-live] conversation ${turn.conversationId.slice(0, 8)} · ${evidenceRequests.length} evidence request(s), answers: ${
				evidenceCalls.join(", ") || "(none seen)"
			}`,
		);
	});

	test("still shows both after a reload", async ({ page }) => {
		await runProjectTurn(page);

		await page.reload({ waitUntil: "domcontentloaded" });
		const bubble = page.getByTestId("assistant-message").last();
		await expect(bubble).toContainText(/\S/, { timeout: 30000 });
		await waitForHydration(page);

		await expect(
			bubble.getByRole("button", { name: /Sources/ }),
			"the reloaded page must still show the Sources panel",
		).toBeAttached({ timeout: 25000 });
		await expect(
			page
				.locator(".info-popover")
				.last()
				.locator(".audit-row--action", { hasText: "Project files" }),
			"the reloaded page must still show the Project files row",
		).toHaveCount(1, { timeout: 25000 });

		// One turn, one row, one panel: a reload (or a second hydration) must
		// not double-apply the evidence.
		await expect(bubble.getByRole("button", { name: /Sources/ })).toHaveCount(
			1,
		);
		await expect(
			page
				.locator(".info-popover")
				.last()
				.locator(".audit-row--action", { hasText: "Project files" }),
		).toHaveCount(1);
	});
});

type ProjectTurn = {
	conversationId: string;
	projectId: string;
	artifactId: string;
};

/** Every answer the evidence endpoint gave during the turn, in order. */
function watchEvidenceEndpoint(page: Page, into: string[]) {
	page.on("response", (response) => {
		if (!response.url().includes("/evidence")) return;
		into.push(String(response.status()));
	});
}

/** What the server actually holds for this turn, read from the row itself. */
async function persistedEvidence(conversationId: string) {
	const [row] = await db
		.select({ metadataJson: messages.metadataJson })
		.from(messages)
		.where(
			and(
				eq(messages.conversationId, conversationId),
				eq(messages.role, "assistant"),
			),
		);
	const metadata = row?.metadataJson
		? (JSON.parse(row.metadataJson) as Record<string, unknown>)
		: null;
	const summary = metadata?.evidenceSummary as
		| { groups?: unknown[] }
		| undefined;
	return {
		evidenceStatus: metadata?.evidenceStatus,
		projectFilesRead: metadata?.projectFilesRead,
		evidenceGroups: summary?.groups?.length ?? 0,
	};
}

/**
 * One project conversation whose first turn reads a linked project file. The
 * first send on the project page is what puts the conversation in the project;
 * a send that landed elsewhere is retried rather than asserted away.
 */
async function runProjectTurn(page: Page): Promise<ProjectTurn> {
	await installFakeProvider(page);

	const unique = randomUUID().slice(0, 8);
	const projectResponse = await page.request.post("/api/projects", {
		data: { name: `Evidence latency ${unique}` },
	});
	expect(projectResponse.ok(), "creating a project must succeed").toBe(true);
	const projectId = ((await projectResponse.json()) as { id: string }).id;

	const documentBody =
		"Hotel Motto, Vienna. Two nights, 12-14 October. Booking reference HM-88421.\n";
	const uploadResponse = await page.request.post(UPLOAD_RAW_PATH, {
		headers: {
			"content-type": "text/plain",
			"x-alfyai-upload-name": encodeURIComponent("Hotel Motto booking.txt"),
			"x-alfyai-upload-size": String(Buffer.byteLength(documentBody, "utf8")),
			"x-alfyai-upload-trace-id": `e2e-${randomUUID()}`,
		},
		data: documentBody,
	});
	expect(uploadResponse.ok(), "uploading the document must succeed").toBe(true);
	const artifactId = (
		(await uploadResponse.json()) as { artifact: { id: string } }
	).artifact.id;

	const linkResponse = await page.request.post(
		`/api/projects/${projectId}/knowledge`,
		{ data: { artifactIds: [artifactId] } },
	);
	expect(linkResponse.ok(), "linking must succeed").toBe(true);
	await waitForNormalized(artifactId);

	for (let attempt = 1; attempt <= 3; attempt += 1) {
		await page.goto(`/projects/${projectId}`, {
			waitUntil: "domcontentloaded",
		});
		await page.getByTestId("project-greeting").waitFor({ timeout: 15000 });
		await waitForHydration(page);

		await sendMessage(
			page,
			"Summarise what Hotel Motto booking.txt says about the stay.",
		);
		await expect(page).toHaveURL(/\/chat\//, { timeout: 20000 });
		const conversationId =
			page.url().split("/chat/")[1]?.split(/[/?#]/)[0] ?? "";
		const [conversation] = await db
			.select({ projectId: conversations.projectId })
			.from(conversations)
			.where(eq(conversations.id, conversationId));
		if (conversation?.projectId !== projectId) continue;

		const bubble = page.getByTestId("assistant-message").last();
		await expect(bubble).toContainText(/\S/, { timeout: 30000 });
		// The server composes evidence after the terminal frame; the client's
		// poll (and this test's assertions) live in that window.
		await expect
			.poll(() => persistedEvidence(conversationId), {
				message: "the server must persist evidence for this turn",
				timeout: 25000,
			})
			.toMatchObject({ evidenceStatus: "ready" });

		return { conversationId, projectId, artifactId };
	}

	throw new Error("no turn landed in the project conversation");
}

/**
 * Normalization is a background pass, and a turn that starts before it lands
 * sees a source document with no text of its own — the file then quietly fails
 * to reach the turn. Wait on the same condition the app's readiness check reads.
 */
async function waitForNormalized(artifactId: string) {
	for (let attempt = 0; attempt < 60; attempt += 1) {
		const rows = await db
			.select({
				metadataJson: artifacts.metadataJson,
				contentText: artifacts.contentText,
			})
			.from(artifacts)
			.where(eq(artifacts.type, "normalized_document"));
		const normalized = new Set(
			rows
				.filter((row) => Boolean(row.contentText?.trim()))
				.map((row) => {
					try {
						return (
							JSON.parse(row.metadataJson ?? "{}") as {
								sourceArtifactId?: string;
							}
						).sourceArtifactId;
					} catch {
						return undefined;
					}
				})
				.filter((id): id is string => Boolean(id)),
		);
		if (normalized.has(artifactId)) return;
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
	throw new Error("the project file was never normalized");
}

/** A deterministic fake provider, so the chat screen needs no real model. */
async function installFakeProvider(page: Page): Promise<string> {
	const result = await page.evaluate(
		async ({ apiKey, baseUrl, modelName }) => {
			const unique = Date.now();
			const providerResponse = await fetch("/api/admin/providers", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					name: `evidence_live_${unique}`,
					displayName: `Evidence live ${unique}`,
					baseUrl,
					apiKey,
				}),
			});
			const providerBody = (await providerResponse.json()) as {
				provider?: { id: string };
			};
			if (!providerResponse.ok || !providerBody.provider?.id) return null;

			const modelResponse = await fetch(
				`/api/admin/providers/${providerBody.provider.id}/models/batch`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						models: [
							{
								name: modelName,
								displayName: "Evidence live model",
								contextLength: 8192,
								supportsChat: true,
								supportsTools: true,
							},
						],
					}),
				},
			);
			const modelBody = (await modelResponse.json()) as {
				models?: Array<{ id: string }>;
			};
			const modelId = modelBody.models?.[0]?.id;
			if (!modelResponse.ok || !modelId) return null;
			return `provider:${providerBody.provider.id}:${modelId}`;
		},
		{
			apiKey: AI_SMOKE_API_KEY,
			baseUrl: provider.baseURL,
			modelName: AI_SMOKE_MODEL_ID,
		},
	);
	expect(result, "the fake provider must register").toBeTruthy();
	if (!result) throw new Error("no fake provider model");
	await page.evaluate(async (preferredModel) => {
		await fetch("/api/settings/preferences", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ preferredModel }),
		});
		localStorage.setItem("selectedModel", preferredModel);
	}, result);
	return result;
}
