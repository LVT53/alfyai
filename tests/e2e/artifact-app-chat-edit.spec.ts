import { randomUUID } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import { eq } from "drizzle-orm";
import { db } from "../../src/lib/server/db";
import {
	artifacts,
	artifactVersions,
	users,
} from "../../src/lib/server/db/schema";
import {
	AI_SMOKE_EDIT_APP_FINAL_TEXT,
	AI_SMOKE_REBUILT_APP_HEADING,
	encodeEditAppScenarioMessage,
} from "../fixtures/ai/openai-compatible-scenarios";
import { createOpenAICompatibleProviderHarness } from "../mocks/ai-provider/openai-compatible-provider";
import {
	createTemporaryFakeProviderModel,
	deleteTemporaryProvider,
	snapshotUserModelPreference,
	updateUserModelPreference,
} from "./artifact-live-edit.helpers";
import { createEmptyConversation, login, sendMessage } from "./helpers";

// F2 (ruling 77, the friction audit): asking in the chat to change an App used to
// make a SECOND App of the same name while the open panel kept showing the old
// one (the tool told the model "Apps are not edited here"). Now `edit_artifact`
// on an App rebuilds THAT App through the panel's own rebuild: one new Alfy
// version, the open panel loads it, and the list still has one App. A REAL
// `edit_artifact` call, through the real chat, through the fake provider; the
// App generator's call (the handler's rebuild) reaches the same fake, because
// this spec points the `model1` provider (the one an App is generated with) at it.

const TIP_APP_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Tip calculator</title></head>
<body><h1>Tip calculator</h1><p>Original version.</p></body>
</html>`;

async function testUserId(): Promise<string> {
	const [user] = await db
		.select({ id: users.id })
		.from(users)
		.where(eq(users.email, "admin@local"))
		.limit(1);
	expect(user, "the e2e admin must exist").toBeTruthy();
	return user.id;
}

async function seedApp(
	conversationId: string,
	html: string,
	title: string,
): Promise<string> {
	const userId = await testUserId();
	const artifactId = randomUUID();
	const now = new Date();
	await db.insert(artifacts).values({
		id: artifactId,
		userId,
		conversationId,
		type: "artifact",
		retrievalClass: "durable",
		name: title,
		contentText: html,
		metadataJson: JSON.stringify({ artifactType: "app", title }),
		createdAt: now,
		updatedAt: now,
	});
	await db.insert(artifactVersions).values({
		id: randomUUID(),
		artifactId,
		userId,
		versionNumber: 1,
		author: "alfy",
		summary: "Alfy wrote the first draft",
		body: html,
		bodyHash: "seed-hash",
		createdAt: now,
	});
	return artifactId;
}

async function appsOf(conversationId: string) {
	const rows = await db
		.select({ id: artifacts.id, metadataJson: artifacts.metadataJson })
		.from(artifacts)
		.where(eq(artifacts.conversationId, conversationId));
	return rows.filter(
		(row) =>
			(JSON.parse(row.metadataJson ?? "{}") as { artifactType?: string })
				.artifactType === "app",
	);
}

async function versionsOf(artifactId: string) {
	const rows = await db
		.select()
		.from(artifactVersions)
		.where(eq(artifactVersions.artifactId, artifactId));
	return rows.sort((a, b) => a.versionNumber - b.versionNumber);
}

async function openChatAndReload(page: Page, conversationId: string) {
	await page.evaluate((id) => {
		window.sessionStorage.removeItem(`pending-chat-message:${id}`);
	}, conversationId);
	await page.goto(`/chat/${conversationId}`);
	await page.reload({ waitUntil: "networkidle" });
}

/** The App generator is `model1`: its provider is pointed at the fake for the spec, and put back. */
async function pointModel1At(
	page: Page,
	baseUrl: string,
): Promise<() => Promise<void>> {
	const previous = await page.evaluate(async () => {
		const response = await fetch("/api/admin/providers");
		const body = (await response.json()) as {
			providers?: Array<{ id: string; name: string; baseUrl: string }>;
		};
		const model1 = body.providers?.find(
			(provider) => provider.name === "model1",
		);
		return model1 ? { id: model1.id, baseUrl: model1.baseUrl } : null;
	});
	expect(previous, "the e2e database has a model1 provider").toBeTruthy();
	const put = (url: string) =>
		page.evaluate(
			async ({ id, baseUrl: next }) => {
				const response = await fetch(`/api/admin/providers/${id}`, {
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ baseUrl: next }),
				});
				return response.ok;
			},
			{ id: previous?.id ?? "", baseUrl: url },
		);
	expect(await put(baseUrl)).toBe(true);
	return async () => {
		await put(previous?.baseUrl ?? "");
	};
}

test.describe("changing an App from the chat (F2)", () => {
	const fakeProvider = createOpenAICompatibleProviderHarness();

	test.beforeAll(async () => {
		await fakeProvider.start();
	});
	test.afterAll(async () => {
		await fakeProvider.stop();
	});
	test.beforeEach(async () => {
		await fakeProvider.reset();
	});

	test("'change this app' in the chat rebuilds the open App in place: the panel shows the new version, and there is still one App", async ({
		page,
	}) => {
		test.setTimeout(180_000);
		await page.setViewportSize({ width: 1440, height: 900 });
		await login(page);
		const previousModelPreference = await snapshotUserModelPreference(page);
		const restoreModel1 = await pointModel1At(page, fakeProvider.baseURL);
		const provider = await createTemporaryFakeProviderModel(
			page,
			fakeProvider.baseURL,
		);
		await updateUserModelPreference(page, provider.selectedModel);
		try {
			const conversationId = await createEmptyConversation(
				page,
				"Make me a tip calculator",
			);
			const artifactId = await seedApp(
				conversationId,
				TIP_APP_HTML,
				"Tip calculator",
			);
			await openChatAndReload(page, conversationId);

			// The reader has the App open in the panel.
			await page.getByTestId("artifact-count-button").click();
			await page
				.getByTestId("artifact-panel-list")
				.getByTestId("artifact-row")
				.first()
				.click();
			const frame = page.frameLocator("iframe.app-frame");
			await expect(
				frame.getByRole("heading", { name: "Tip calculator" }),
			).toBeVisible({ timeout: 30_000 });
			await expect(frame.getByText("Original version.")).toBeVisible();

			// They ask for a change, in the composer.
			await sendMessage(page, encodeEditAppScenarioMessage(artifactId));
			await expect(page.getByText(AI_SMOKE_EDIT_APP_FINAL_TEXT)).toBeVisible({
				timeout: 120_000,
			});

			// The panel they have open runs the new version, without reopening it.
			await expect(
				frame.getByRole("heading", { name: AI_SMOKE_REBUILT_APP_HEADING }),
			).toBeVisible({ timeout: 30_000 });
			await expect(frame.getByText("Original version.")).toHaveCount(0);

			// One App, one new Alfy version that is a rebuild: nothing was made twice.
			expect(await appsOf(conversationId)).toHaveLength(1);
			const versions = await versionsOf(artifactId);
			expect(versions.map((version) => version.versionNumber)).toEqual([1, 2]);
			expect(versions[1]).toMatchObject({ author: "alfy" });
			expect(versions[1].summary).toMatch(/^Alfy regenerated the app: /);
			expect(versions[1].body).toContain(AI_SMOKE_REBUILT_APP_HEADING);
			// The list the reader sees has the one App: back to "This chat" from the item.
			await page
				.locator(".artifact-panel-header-crumb:visible")
				.first()
				.click();
			const rows = page
				.getByTestId("artifact-panel-list")
				.getByTestId("artifact-row");
			await expect(rows).toHaveCount(1);
			await expect(rows.first()).toContainText("Tip calculator");
		} finally {
			await restoreModel1();
			await updateUserModelPreference(page, previousModelPreference);
			await deleteTemporaryProvider(page, provider.providerId);
		}
	});
});
