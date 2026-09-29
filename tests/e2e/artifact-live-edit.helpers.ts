import { expect, type Page } from "@playwright/test";
import {
	AI_SMOKE_API_KEY,
	AI_SMOKE_MODEL_ID,
} from "../fixtures/ai/openai-compatible-scenarios";

// The fake-provider plumbing a spec needs to drive a REAL `edit_artifact` call
// through `/api/chat/stream` (the mechanism `artifact-document.spec.ts`'s
// "T8 live" suite established). Copied rather than imported: importing one
// spec file from another makes Playwright register the first file's tests
// again inside the second.

export async function snapshotUserModelPreference(
	page: Page,
): Promise<string | null> {
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

export async function updateUserModelPreference(
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

export async function createTemporaryFakeProviderModel(
	page: Page,
	baseUrl: string,
): Promise<{ providerId: string; modelId: string; selectedModel: string }> {
	const result = await page.evaluate(
		async ({ apiKey, base, modelName }) => {
			const unique = Date.now();
			const providerResponse = await fetch("/api/admin/providers", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					name: `fake_edit_artifact_provider_${unique}`,
					displayName: `Fake Edit Artifact Provider ${unique}`,
					baseUrl: base,
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
								displayName: "Fake Edit Artifact Provider Model",
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
		{ apiKey: AI_SMOKE_API_KEY, base: baseUrl, modelName: AI_SMOKE_MODEL_ID },
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
	return {
		providerId: result.providerId,
		modelId: result.modelId,
		selectedModel: `provider:${result.providerId}:${result.modelId}`,
	};
}

export async function deleteTemporaryProvider(
	page: Page,
	providerId: string,
): Promise<void> {
	await page.evaluate(async (id) => {
		await fetch(`/api/admin/providers/${id}`, { method: "DELETE" });
	}, providerId);
}
