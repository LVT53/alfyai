import { describe, expect, it, vi } from "vitest";
import type { FetchLike } from "./http";
import type { UserSkillVariantDraft, UserSkillVariantUpdate } from "./skills";
import {
	createUserSkill,
	createUserSkillVariant,
	deleteUserSkill,
	deleteUserSkillVariant,
	discoverSkills,
	dismissSkillDraft,
	fetchSystemSkillSummaries,
	fetchUserSkills,
	fetchUserSkillVariants,
	saveSkillDraft,
	updateUserSkill,
	updateUserSkillVariant,
} from "./skills";

describe("skills client API", () => {
	it("lists user skills from the authenticated API", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						skills: [{ id: "skill-1", displayName: "Meeting critic" }],
						systemSkills: [
							{
								id: "system:interview",
								ownership: "system",
								displayName: "Interview",
								description: "Safe summary.",
							},
						],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
		);

		await expect(fetchUserSkills(fetchMock)).resolves.toEqual([
			{ id: "skill-1", displayName: "Meeting critic" },
		]);
		expect(fetchMock).toHaveBeenCalledWith("/api/skills");
	});

	it("lists enabled System Skill summaries separately without instruction bodies", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						skills: [{ id: "skill-1", displayName: "Private skill" }],
						systemSkills: [
							{
								id: "system:interview",
								ownership: "system",
								displayName: "Interview",
								description: "Safe summary.",
								instructions: "LEAKED_SYSTEM_INSTRUCTIONS",
								localizedDefaults: {
									en: {
										displayName: "Interview",
										description: "Safe summary.",
										instructions: "LEAKED_EN_INSTRUCTIONS",
									},
									hu: {
										displayName: "Interjú",
										description: "Biztonságos összefoglaló.",
										instructions: "LEAKED_HU_INSTRUCTIONS",
									},
								},
							},
						],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
		);

		await expect(fetchSystemSkillSummaries(fetchMock)).resolves.toEqual([
			{
				id: "system:interview",
				ownership: "system",
				displayName: "Interview",
				description: "Safe summary.",
				localizedDefaults: {
					en: {
						displayName: "Interview",
						description: "Safe summary.",
					},
					hu: {
						displayName: "Interjú",
						description: "Biztonságos összefoglaló.",
					},
				},
			},
		]);
		const summaries = await fetchSystemSkillSummaries(fetchMock);
		const serializedSummaries = JSON.stringify(summaries);
		expect(serializedSummaries).not.toContain("instructions");
		expect(serializedSummaries).not.toContain("LEAKED_SYSTEM_INSTRUCTIONS");
		expect(serializedSummaries).not.toContain("LEAKED_EN_INSTRUCTIONS");
		expect(serializedSummaries).not.toContain("LEAKED_HU_INSTRUCTIONS");
	});

	it("lists and writes owner-editable user Skill Variants without sending policy fields", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						variants: [
							{
								id: "variant-1",
								ownership: "user",
								skillKind: "skill_variant",
								baseSkillId: "system:pack",
								baseSkillDisplayName: "Pack",
								displayName: "Pack variant",
								description: "Personal tone.",
								instructions: "LEAKED_OVERLAY",
							},
						],
						variant: {
							id: "variant-1",
							ownership: "user",
							skillKind: "skill_variant",
							baseSkillId: "system:pack",
							displayName: "Saved variant",
						},
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
		);

		await expect(fetchUserSkillVariants(fetchMock)).resolves.toEqual([
			{
				id: "variant-1",
				ownership: "user",
				skillKind: "skill_variant",
				baseSkillId: "system:pack",
				baseSkillDisplayName: "Pack",
				displayName: "Pack variant",
				description: "Personal tone.",
				instructions: "LEAKED_OVERLAY",
			},
		]);
		await createUserSkillVariant(
			{
				baseSkillId: "system:pack",
				displayName: "Saved variant",
				description: "",
				instructions: "Use my tone.",
				activationExamples: [],
			},
			fetchMock,
		);
		await updateUserSkillVariant(
			"variant-1",
			{
				instructions: "Updated overlay.",
			},
			fetchMock,
		);
		await deleteUserSkillVariant("variant-1", fetchMock);

		expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/skills");
		expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/skills", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				skillKind: "skill_variant",
				baseSkillId: "system:pack",
				displayName: "Saved variant",
				description: "",
				instructions: "Use my tone.",
				activationExamples: [],
			}),
		});
		expect(fetchMock).toHaveBeenNthCalledWith(3, "/api/skills/variant-1", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				skillKind: "skill_variant",
				instructions: "Updated overlay.",
			}),
		});
		expect(fetchMock).toHaveBeenNthCalledWith(4, "/api/skills/variant-1", {
			method: "DELETE",
		});
	});

	it("keeps Skill Variant draft types limited to overlay-owned fields", () => {
		const validDraft: UserSkillVariantDraft = {
			baseSkillId: "system:pack",
			displayName: "Pack variant",
			description: "Personal tone.",
			instructions: "Use my tone.",
			activationExamples: [],
			enabled: true,
		};
		const validUpdate: UserSkillVariantUpdate = {
			instructions: "Updated overlay.",
		};

		expect(validDraft.baseSkillId).toBe("system:pack");
		expect(validUpdate.instructions).toBe("Updated overlay.");

		const draftWithPolicy: UserSkillVariantDraft = {
			...validDraft,
			// @ts-expect-error Skill Variants inherit duration policy from their base Skill Pack.
			durationPolicy: "session",
		};
		const updateWithPolicy: UserSkillVariantUpdate = {
			// @ts-expect-error Skill Variants inherit notes policy from their base Skill Pack.
			notesPolicy: "create_private_notes",
		};

		expect(draftWithPolicy).toBeDefined();
		expect(updateWithPolicy).toBeDefined();
	});

	it("creates, updates, and deletes user skills through JSON endpoints", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(
					JSON.stringify({ skill: { id: "skill-1", displayName: "Updated" } }),
					{
						status: 200,
						headers: { "Content-Type": "application/json" },
					},
				),
		);

		await createUserSkill(
			{
				displayName: "Meeting critic",
				description: "",
				instructions: "Review notes.",
				activationExamples: [],
			},
			fetchMock,
		);
		await updateUserSkill(
			"skill-1",
			{ enabled: false, displayName: "Updated" },
			fetchMock,
		);
		await deleteUserSkill("skill-1", fetchMock);

		expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/skills", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				displayName: "Meeting critic",
				description: "",
				instructions: "Review notes.",
				activationExamples: [],
			}),
		});
		expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/skills/skill-1", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ enabled: false, displayName: "Updated" }),
		});
		expect(fetchMock).toHaveBeenNthCalledWith(3, "/api/skills/skill-1", {
			method: "DELETE",
		});
	});

	it("discovers skills through the query endpoint and strips accidental instructions", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						skills: [
							{
								id: "skill-1",
								ownership: "user",
								displayName: "Interview coach",
								description: "Practice interviews.",
								instructions: "LEAKED_USER_INSTRUCTIONS",
							},
						],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
		);

		await expect(discoverSkills("interview prep", fetchMock)).resolves.toEqual([
			{
				id: "skill-1",
				ownership: "user",
				displayName: "Interview coach",
				description: "Practice interviews.",
			},
		]);
		expect(fetchMock).toHaveBeenCalledWith(
			"/api/skills/discovery?q=interview+prep",
		);
	});

	it("saves and dismisses assistant Skill Drafts through conversation-scoped endpoints", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						skill: { id: "skill-1" },
						draft: { id: "draft-1", status: "saved" },
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
		);

		await saveSkillDraft("conv 1", "msg/1", "draft 1", fetchMock);
		await dismissSkillDraft("conv 1", "msg/1", "draft 1", fetchMock);

		expect(fetchMock).toHaveBeenNthCalledWith(
			1,
			"/api/conversations/conv%201/messages/msg%2F1/skill-drafts/draft%201/save",
			{ method: "POST" },
		);
		expect(fetchMock).toHaveBeenNthCalledWith(
			2,
			"/api/conversations/conv%201/messages/msg%2F1/skill-drafts/draft%201",
			{ method: "DELETE" },
		);
	});

	it("returns the updated assistant Skill Draft from dismiss responses", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(
					JSON.stringify({ draft: { id: "draft-1", status: "dismissed" } }),
					{
						status: 200,
						headers: { "Content-Type": "application/json" },
					},
				),
		);

		await expect(
			dismissSkillDraft("conv-1", "assistant-1", "draft-1", fetchMock),
		).resolves.toEqual({
			draft: { id: "draft-1", status: "dismissed" },
		});
	});

	it("preserves API error keys from failed assistant Skill Draft save and dismiss actions", async () => {
		const actions: Array<(fetchMock: FetchLike) => Promise<unknown>> = [
			(fetchMock) =>
				saveSkillDraft("conv-1", "assistant-1", "draft-1", fetchMock),
			(fetchMock) =>
				dismissSkillDraft("conv-1", "assistant-1", "draft-1", fetchMock),
		];

		for (const action of actions) {
			const baseFetchMock = vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							error: "Skill draft not found.",
							errorKey: "skillDrafts.notFound",
						}),
						{ status: 404, headers: { "Content-Type": "application/json" } },
					),
			);

			await expect(action(baseFetchMock)).rejects.toMatchObject({
				message: "Skill draft not found.",
				errorKey: "skillDrafts.notFound",
			});
		}
	});
});
