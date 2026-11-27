import { beforeEach, expect, it, vi } from "vitest";
import {
	distillConnectorPayload,
	hasLocalDistillEnabled,
	isCloudModel,
} from "../connections/locality";
import { createPendingWrite } from "../connections/pending-writes";
import {
	teamsDestination,
	teamsRead,
} from "../connections/providers/teams-messaging";
import { resolveConnectionsForCapability } from "../connections/resolve";
import type { ConnectionPublic } from "../connections/store";
import { reasonCodeOf } from "./shared";
import { runTeamsTool } from "./teams";

vi.mock("./shared", async (importOriginal) => ({
	...(await importOriginal<typeof import("./shared")>()),
	isInsideToolCall: () => true,
	markCallLocallyDistilled: vi.fn(),
}));
vi.mock("../connections/pending-writes", () => ({
	createPendingWrite: vi.fn(),
}));
vi.mock("../connections/providers/teams-messaging", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../connections/providers/teams-messaging")
	>()),
	teamsRead: vi.fn(),
	teamsDestination: vi.fn(),
}));
vi.mock("../connections/resolve", async (importOriginal) => ({
	...(await importOriginal<typeof import("../connections/resolve")>()),
	resolveConnectionsForCapability: vi.fn(),
}));
vi.mock("../connections/locality", () => ({
	hasLocalDistillEnabled: vi.fn(),
	isCloudModel: vi.fn(),
	distillConnectorPayload: vi.fn(),
}));
const conn: ConnectionPublic = {
	id: "account",
	userId: "user",
	provider: "onedrive",
	label: "Work",
	accountIdentifier: "work@invalid.test",
	status: "connected",
	statusDetail: null,
	defaultOn: true,
	allowWrites: true,
	writeAllowlist: [],
	capabilities: ["teams_chat"],
	config: { microsoftOrganizationAccount: true },
	oauthScopes: ["Chat.Read", "ChatMessage.Send"],
	tokenExpiresAt: null,
	hasSecret: true,
	hasWriteSecret: false,
	createdAt: 0,
	updatedAt: 0,
};
const chats = new Set(["teams_chat"]);
const list = { action: "list_chats" } as const;
beforeEach(() => {
	vi.resetAllMocks();
	vi.mocked(resolveConnectionsForCapability).mockResolvedValue([conn]);
});
it("isolates a disabled capability before looking up any account", async () => {
	const result = await runTeamsTool(
		"user",
		list,
		"model",
		new Set(["teams_files"]),
	);
	expect(reasonCodeOf(result.modelPayload)).toBe("not_connected");
	expect(resolveConnectionsForCapability).not.toHaveBeenCalled();
});
it("asks which account to use when the selector is ambiguous", async () => {
	vi.mocked(resolveConnectionsForCapability).mockResolvedValue([
		conn,
		{ ...conn, id: "other", accountIdentifier: "other@invalid.test" },
	]);
	const result = await runTeamsTool(
		"user",
		{ ...list, account: "Work" },
		"model",
		chats,
	);
	expect(reasonCodeOf(result.modelPayload)).toBe("no_such_account");
	expect(teamsRead).not.toHaveBeenCalled();
});
it("proposes a write only on the selected account, with a private durable preview and no provider mutation", async () => {
	vi.mocked(teamsDestination).mockResolvedValue({
		destination: "Private room",
		original: null,
	});
	vi.mocked(createPendingWrite).mockImplementation(async (_user, params) => ({
		id: "pending",
		preview: params.preview,
	}));
	const out = await runTeamsTool(
		"user",
		{
			action: "send",
			chatId: "chat",
			body: "Approved wording",
			account: conn.accountIdentifier,
		},
		"model",
		chats,
		"conversation",
	);
	expect(out.modelPayload.pendingWriteId).toBe("pending");
	expect(JSON.stringify(out)).not.toContain("Private room");
	expect(createPendingWrite).toHaveBeenCalledWith(
		"user",
		expect.objectContaining({
			connectionId: "account",
			conversationId: "conversation",
			content: expect.stringContaining("Approved wording"),
		}),
	);
});
it("keeps private names and deep links out of the cloud model payload while the user's Sources retain them", async () => {
	vi.mocked(hasLocalDistillEnabled).mockResolvedValue(true);
	vi.mocked(isCloudModel).mockResolvedValue(true);
	vi.mocked(distillConnectorPayload).mockResolvedValue({
		distilled: "A meeting.",
	});
	const item = {
		id: "sensitive-id",
		label: "Private room",
		body: "Secret",
		url: "https://teams.microsoft.com/l/message/private/1",
		time: null,
		reactions: [],
		deleted: false,
	};
	vi.mocked(teamsRead).mockResolvedValue({ items: [item], more: false });
	const result = await runTeamsTool("user", list, "cloud", chats);
	expect(result.modelPayload).toMatchObject({
		message: "A meeting.",
		items: [],
		citations: [],
	});
	expect(result.candidates[0]).toMatchObject({
		title: item.label,
		url: item.url,
		snippet: item.body,
	});
});
