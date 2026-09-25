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
	AI_SMOKE_PROJECT_FILE_PROBE_PREFIX,
	AI_SMOKE_READ_PROJECT_FILE_FINAL_TEXT,
	AI_SMOKE_READ_PROJECT_FILE_MARKER,
} from "../fixtures/ai/openai-compatible-scenarios";
import { createOpenAICompatibleProviderHarness } from "../mocks/ai-provider/openai-compatible-provider";
import { login, waitForHydration } from "./helpers";

/**
 * `live-evidence-metadata.spec.ts` proves the "project files read" row for a
 * file the turn's evidence SELECTION picked — the question names the file, and
 * retrieval surfaces it. It never exercises the other channel `countProjectFilesRead`
 * now unions in: a file the model reached with `read_generated_file` because it
 * saw the name in the prompt's "Project Files" listing, not because retrieval
 * matched the question to the file's content.
 *
 * This spec drives that second channel for real, through the live stream: the
 * marker message shares no word with the probe file's name or text, so
 * evidence selection has nothing to match — the ONLY way the count can reach 1
 * is the tool recording what it actually read. It asserts, off one real turn
 * and with no reload in between, that the Info popover's row appears; then
 * reloads and checks it survives.
 */

const UPLOAD_RAW_PATH = "/api/knowledge/upload/raw";

const provider = createOpenAICompatibleProviderHarness();

type TemporaryProviderModel = {
	providerId: string;
	modelId: string;
	selectedModel: `provider:${string}:${string}`;
};

test.describe("project file read through a live tool call", () => {
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

	test("shows the Project files row without a reload, credited to the tool read", async ({
		page,
	}) => {
		const previousModelPreference = await snapshotUserModelPreference(page);
		const previousSelectedModel = await snapshotBrowserSelectedModel(page);
		let temporaryProvider: TemporaryProviderModel | null = null;

		try {
			temporaryProvider = await installFakeProvider(page);
			const turn = await runProjectToolReadTurn(page);
			const bubble = page.getByTestId("assistant-message").last();

			// The turn only completes this way if the app executed a real
			// `read_generated_file` call the provider asked for and answered the
			// second round trip in text — the fake model never says this on its
			// own initiative.
			await expect(bubble).toContainText(
				AI_SMOKE_READ_PROJECT_FILE_FINAL_TEXT,
				{
					timeout: 30000,
				},
			);

			// The row is on screen NOW, no navigation or reload between the turn
			// finishing and this assertion.
			await expect(
				page
					.locator(".info-popover")
					.last()
					.locator(".audit-row--action", { hasText: "Project files" }),
				"the Info popover's Project files row must be there without a reload",
			).toHaveCount(1, { timeout: 25000 });

			// It is the persisted count, and it is made of the tool's read, not a
			// selection this turn's question could never have produced: the
			// marker and the probe file share no word.
			const evidence = await persistedEvidence(turn.conversationId);
			expect(evidence.projectFilesRead).toBe(1);
			expect(evidence.groupSourceTypes).toContain("tool");
			expect(evidence.groupSourceTypes).not.toContain("document");

			await page.reload({ waitUntil: "domcontentloaded" });
			await expect(bubble).toContainText(
				AI_SMOKE_READ_PROJECT_FILE_FINAL_TEXT,
				{
					timeout: 30000,
				},
			);
			await waitForHydration(page);
			await expect(
				page
					.locator(".info-popover")
					.last()
					.locator(".audit-row--action", { hasText: "Project files" }),
				"the reloaded page must still show the Project files row",
			).toHaveCount(1, { timeout: 25000 });
		} finally {
			await updateUserModelPreference(page, previousModelPreference);
			await setBrowserSelectedModel(page, previousSelectedModel);
			if (temporaryProvider) {
				await deleteTemporaryProvider(page, temporaryProvider.providerId);
			}
		}
	});
});

type ProjectTurn = {
	conversationId: string;
	projectId: string;
	artifactId: string;
};

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
		| { groups?: Array<{ sourceType?: string }> }
		| undefined;
	return {
		evidenceStatus: metadata?.evidenceStatus,
		projectFilesRead: metadata?.projectFilesRead,
		groupSourceTypes: (summary?.groups ?? []).map((group) => group.sourceType),
	};
}

/**
 * One project conversation whose first turn reads a linked project file with
 * `read_generated_file`, never by naming it in the question. The probe
 * filename is only ever said by the server's own "Project Files" prompt
 * listing; the marker message that starts the turn names nothing.
 */
async function runProjectToolReadTurn(page: Page): Promise<ProjectTurn> {
	const unique = randomUUID().slice(0, 8);
	const projectResponse = await page.request.post("/api/projects", {
		data: { name: `Tool read live ${unique}` },
	});
	expect(projectResponse.ok(), "creating a project must succeed").toBe(true);
	const projectId = ((await projectResponse.json()) as { id: string }).id;

	const probeFilename = `${AI_SMOKE_PROJECT_FILE_PROBE_PREFIX}${unique}.txt`;
	const documentBody = "Ceiling paint: eggshell, colour code RAL 9010.\n";
	const uploadResponse = await page.request.post(UPLOAD_RAW_PATH, {
		headers: {
			"content-type": "text/plain",
			"x-alfyai-upload-name": encodeURIComponent(probeFilename),
			"x-alfyai-upload-size": String(Buffer.byteLength(documentBody, "utf8")),
			"x-alfyai-upload-trace-id": `e2e-${randomUUID()}`,
		},
		data: documentBody,
	});
	expect(uploadResponse.ok(), "uploading the probe file must succeed").toBe(
		true,
	);
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

		const input = page.getByTestId("message-input");
		await input.waitFor({ state: "visible" });
		await input.fill(AI_SMOKE_READ_PROJECT_FILE_MARKER);
		const sendButton = page.getByTestId("send-button");
		await expect(sendButton).toBeEnabled({ timeout: 10000 });
		const chatStreamResponse = page.waitForResponse(
			(response) =>
				response.url().endsWith("/api/chat/stream") &&
				response.request().method() === "POST",
		);
		await sendButton.click();
		await expect(page).toHaveURL(/\/chat\//, { timeout: 20000 });
		expect((await chatStreamResponse).status()).toBe(200);

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
 * sees a source document with no text of its own — `read_generated_file` then
 * finds the file but hands the model nothing, and records no read. Wait on the
 * same condition the app's readiness check reads.
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
async function installFakeProvider(
	page: Page,
): Promise<TemporaryProviderModel> {
	const result = await page.evaluate(
		async ({ apiKey, baseUrl, modelName }) => {
			const unique = Date.now();
			const providerResponse = await fetch("/api/admin/providers", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					name: `tool_read_live_${unique}`,
					displayName: `Tool read live ${unique}`,
					baseUrl,
					apiKey,
				}),
			});
			const providerBody = (await providerResponse.json()) as {
				provider?: { id: string };
				error?: string;
			};
			if (!providerResponse.ok || !providerBody.provider?.id) {
				return {
					ok: false as const,
					status: providerResponse.status,
					error: providerBody.error ?? "Provider creation failed",
				};
			}

			const modelResponse = await fetch(
				`/api/admin/providers/${providerBody.provider.id}/models/batch`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						models: [
							{
								name: modelName,
								displayName: "Tool read live model",
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
				error?: string;
			};
			const modelId = modelBody.models?.[0]?.id;
			if (!modelResponse.ok || !modelId) {
				return {
					ok: false as const,
					status: modelResponse.status,
					error: modelBody.error ?? "Provider model creation failed",
					providerId: providerBody.provider.id,
				};
			}

			return {
				ok: true as const,
				providerId: providerBody.provider.id,
				modelId,
			};
		},
		{
			apiKey: AI_SMOKE_API_KEY,
			baseUrl: provider.baseURL,
			modelName: AI_SMOKE_MODEL_ID,
		},
	);

	expect(
		result.ok,
		`fake provider setup failed with ${
			"status" in result ? result.status : "unknown"
		}: ${"error" in result ? result.error : ""}`,
	).toBe(true);
	if (!("providerId" in result) || !("modelId" in result)) {
		throw new Error(
			"Fake provider setup did not return provider and model ids",
		);
	}
	const selectedModel =
		`provider:${result.providerId}:${result.modelId}` as const;
	await updateUserModelPreference(page, selectedModel);
	await setBrowserSelectedModel(page, selectedModel);
	return {
		providerId: result.providerId,
		modelId: result.modelId,
		selectedModel,
	};
}

async function deleteTemporaryProvider(
	page: Page,
	providerId: string,
): Promise<void> {
	await page.evaluate(async (id) => {
		await fetch(`/api/admin/providers/${id}`, { method: "DELETE" });
	}, providerId);
}

async function snapshotUserModelPreference(page: Page): Promise<string | null> {
	return page.evaluate(async () => {
		const response = await fetch("/api/settings");
		if (!response.ok) {
			throw new Error(`Failed to snapshot user settings: ${response.status}`);
		}
		const data = (await response.json()) as {
			preferences?: { preferredModel?: string | null };
		};
		return data.preferences?.preferredModel ?? null;
	});
}

async function updateUserModelPreference(
	page: Page,
	preferredModel: string | null,
): Promise<void> {
	const result = await page.evaluate(async (nextPreferredModel) => {
		const response = await fetch("/api/settings/preferences", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ preferredModel: nextPreferredModel }),
		});
		return { ok: response.ok, status: response.status };
	}, preferredModel);

	expect(
		result.ok,
		`User model preference update failed with ${result.status}`,
	).toBe(true);
}

async function snapshotBrowserSelectedModel(
	page: Page,
): Promise<string | null> {
	return page.evaluate(() => localStorage.getItem("selectedModel"));
}

async function setBrowserSelectedModel(
	page: Page,
	selectedModel: string | null,
): Promise<void> {
	await page.evaluate((nextSelectedModel) => {
		if (nextSelectedModel === null) {
			localStorage.removeItem("selectedModel");
			return;
		}
		localStorage.setItem("selectedModel", nextSelectedModel);
	}, selectedModel);
}
