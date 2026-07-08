import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "$lib/server/db/schema";

let dbPath: string;
let sqlite: Database.Database;

vi.mock("$lib/server/db", () => ({
	get db() {
		return drizzle(sqlite, { schema });
	},
}));

const mockResolveProvider = vi.fn();
vi.mock("$lib/server/services/normal-chat-model", async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import("$lib/server/services/normal-chat-model")
		>();
	return {
		...actual,
		resolveNormalChatModelRunProvider: mockResolveProvider,
	};
});

const sendJsonControlMessageMock = vi.fn();
vi.mock("$lib/server/services/normal-chat-control-model", () => ({
	sendJsonControlMessage: sendJsonControlMessageMock,
}));

function seedUser(userId: string) {
	const db = drizzle(sqlite, { schema });
	const now = new Date();
	db.insert(schema.users)
		.values({
			id: userId,
			email: `${userId}@example.com`,
			passwordHash: "hash",
			createdAt: now,
			updatedAt: now,
		})
		.run();
}

function providerWithBaseUrl(baseUrl: string) {
	return {
		id: "prov-1",
		name: "mock-provider",
		displayName: "Mock Provider",
		baseUrl,
		modelName: "mock-model-1",
		apiKey: "",
	};
}

beforeEach(() => {
	dbPath = `./data/test-connections-locality-${randomUUID()}.db`;
	sqlite = new Database(dbPath);
	sqlite.pragma("foreign_keys = ON");
	migrate(drizzle(sqlite, { schema }), { migrationsFolder: "./drizzle" });
	mockResolveProvider.mockReset();
	sendJsonControlMessageMock.mockReset();
});

afterEach(() => {
	sqlite.close();
	try {
		unlinkSync(dbPath);
	} catch {
		// best effort
	}
});

describe("isCloudModel", () => {
	it("returns false when the resolved provider is a private-host (on-box local) model", async () => {
		mockResolveProvider.mockResolvedValue(
			providerWithBaseUrl("http://192.168.1.96:30000/v1"),
		);
		const { isCloudModel } = await import("./locality");

		expect(await isCloudModel("model1")).toBe(false);
	});

	it("returns true when the resolved provider is a public-host (cloud) model", async () => {
		mockResolveProvider.mockResolvedValue(
			providerWithBaseUrl("https://api.deepseek.com/v1"),
		);
		const { isCloudModel } = await import("./locality");

		expect(await isCloudModel("provider:abc:def")).toBe(true);
	});

	it("fails safe to true (cloud) when the provider resolver throws", async () => {
		mockResolveProvider.mockRejectedValue(new Error("provider not found"));
		const { isCloudModel } = await import("./locality");

		expect(await isCloudModel("unknown-model")).toBe(true);
	});
});

describe("hasCloudConnectorAck / recordCloudConnectorAck", () => {
	it("round-trips: false before ack, true after recordCloudConnectorAck", async () => {
		const { hasCloudConnectorAck, recordCloudConnectorAck } = await import(
			"./locality"
		);
		seedUser("user-ack");

		expect(await hasCloudConnectorAck("user-ack")).toBe(false);

		await recordCloudConnectorAck("user-ack");

		expect(await hasCloudConnectorAck("user-ack")).toBe(true);
	});
});

describe("shouldWarnCloudConnector", () => {
	it("returns false for a local model even with active capabilities and no ack", async () => {
		mockResolveProvider.mockResolvedValue(
			providerWithBaseUrl("http://192.168.1.96:30000/v1"),
		);
		const { shouldWarnCloudConnector } = await import("./locality");
		seedUser("user-local");

		const result = await shouldWarnCloudConnector({
			userId: "user-local",
			modelId: "model1",
			activeCapabilities: ["calendar"],
		});

		expect(result).toBe(false);
	});

	it("returns true for a cloud model with non-empty capabilities and no ack", async () => {
		mockResolveProvider.mockResolvedValue(
			providerWithBaseUrl("https://api.deepseek.com/v1"),
		);
		const { shouldWarnCloudConnector } = await import("./locality");
		seedUser("user-cloud");

		const result = await shouldWarnCloudConnector({
			userId: "user-cloud",
			modelId: "provider:abc:def",
			activeCapabilities: ["calendar"],
		});

		expect(result).toBe(true);
	});

	it("returns false once the user has acknowledged the cloud connector warning", async () => {
		mockResolveProvider.mockResolvedValue(
			providerWithBaseUrl("https://api.deepseek.com/v1"),
		);
		const { shouldWarnCloudConnector, recordCloudConnectorAck } = await import(
			"./locality"
		);
		seedUser("user-acked");
		await recordCloudConnectorAck("user-acked");

		const result = await shouldWarnCloudConnector({
			userId: "user-acked",
			modelId: "provider:abc:def",
			activeCapabilities: ["calendar"],
		});

		expect(result).toBe(false);
	});

	it("returns false for a cloud model when there are no active capabilities", async () => {
		mockResolveProvider.mockResolvedValue(
			providerWithBaseUrl("https://api.deepseek.com/v1"),
		);
		const { shouldWarnCloudConnector } = await import("./locality");
		seedUser("user-empty-caps");

		const result = await shouldWarnCloudConnector({
			userId: "user-empty-caps",
			modelId: "provider:abc:def",
			activeCapabilities: [],
		});

		expect(result).toBe(false);
		expect(mockResolveProvider).not.toHaveBeenCalled();
	});
});

describe("hasLocalDistillEnabled / setLocalDistillEnabled", () => {
	it("round-trips: false before enabling, true after setLocalDistillEnabled(true)", async () => {
		const { hasLocalDistillEnabled, setLocalDistillEnabled } = await import(
			"./locality"
		);
		seedUser("user-distill");

		expect(await hasLocalDistillEnabled("user-distill")).toBe(false);

		await setLocalDistillEnabled("user-distill", true);
		expect(await hasLocalDistillEnabled("user-distill")).toBe(true);

		await setLocalDistillEnabled("user-distill", false);
		expect(await hasLocalDistillEnabled("user-distill")).toBe(false);
	});
});

describe("distillConnectorPayload", () => {
	it("returns the distilled summary when the configured distill model is local", async () => {
		mockResolveProvider.mockResolvedValue(
			providerWithBaseUrl("http://192.168.1.96:30000/v1"),
		);
		sendJsonControlMessageMock.mockResolvedValue({
			text: "Summary: the invoice is due Friday.",
			rawResponse: {},
			modelId: "model1",
			modelDisplayName: "Local Qwen",
		});
		const { distillConnectorPayload } = await import("./locality");

		const result = await distillConnectorPayload({
			userId: "user-1",
			capability: "files",
			userQuestion: "When is the invoice due?",
			rawText: "Invoice #123, amount $500, due Friday, account 9876543210.",
		});

		expect(result).toEqual({
			distilled: "Summary: the invoice is due Friday.",
		});
		expect(sendJsonControlMessageMock).toHaveBeenCalledTimes(1);
		const [message, , options] = sendJsonControlMessageMock.mock.calls[0];
		expect(message).toContain("When is the invoice due?");
		expect(message).toContain("account 9876543210");
		expect(options).toMatchObject({ thinkingMode: "off" });
	});

	it("returns unavailable without calling the control model when the configured distill model resolves cloud", async () => {
		mockResolveProvider.mockResolvedValue(
			providerWithBaseUrl("https://api.deepseek.com/v1"),
		);
		const { distillConnectorPayload } = await import("./locality");

		const result = await distillConnectorPayload({
			userId: "user-1",
			capability: "files",
			userQuestion: "When is the invoice due?",
			rawText: "Invoice #123, amount $500, due Friday.",
		});

		expect(result).toEqual({ unavailable: true });
		expect(sendJsonControlMessageMock).not.toHaveBeenCalled();
	});

	it("returns unavailable when the control model call errors", async () => {
		mockResolveProvider.mockResolvedValue(
			providerWithBaseUrl("http://192.168.1.96:30000/v1"),
		);
		sendJsonControlMessageMock.mockRejectedValue(
			new Error("control model down"),
		);
		const { distillConnectorPayload } = await import("./locality");

		const result = await distillConnectorPayload({
			userId: "user-1",
			capability: "files",
			userQuestion: "When is the invoice due?",
			rawText: "Invoice #123, amount $500, due Friday.",
		});

		expect(result).toEqual({ unavailable: true });
	});
});
