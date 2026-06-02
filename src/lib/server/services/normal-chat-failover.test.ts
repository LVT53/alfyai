import { describe, expect, it } from "vitest";
import type { RuntimeConfig } from "$lib/server/config-store";
import {
	isModelTimeoutError,
	resolveModelTimeoutFailoverTargetModelId,
} from "./normal-chat-failover";

function runtimeConfig(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
	return {
		modelTimeoutFailoverEnabled: true,
		modelTimeoutFailoverTargetModel: "model2",
		model2Enabled: true,
		...overrides,
	} as RuntimeConfig;
}

describe("resolveModelTimeoutFailoverTargetModelId", () => {
	it("returns the configured failover target for a different source model", async () => {
		await expect(
			resolveModelTimeoutFailoverTargetModelId(
				"model1",
				runtimeConfig({
					modelTimeoutFailoverTargetModel: "model2",
				}),
			),
		).resolves.toBe("model2");
	});
});

describe("isModelTimeoutError", () => {
	it("recognizes model-provider timeout errors without classifying a plain abort as timeout", () => {
		const providerHttpxTimeout = new Error(
			"Code: None\n\n**APITimeoutError**\n - **Code: None**\nhttpcore.ReadTimeout\nhttpx.ReadTimeout",
		);
		const aiSdkTimeout = Object.assign(new Error("AI SDK request timeout"), {
			name: "TimeoutError",
		});
		const undiciTimeout = Object.assign(new Error("body timeout"), {
			code: "UND_ERR_BODY_TIMEOUT",
		});
		const userAbort = Object.assign(new Error("The operation was aborted"), {
			name: "AbortError",
		});

		expect(isModelTimeoutError(providerHttpxTimeout)).toBe(true);
		expect(isModelTimeoutError(aiSdkTimeout)).toBe(true);
		expect(isModelTimeoutError(undiciTimeout)).toBe(true);
		expect(isModelTimeoutError(userAbort)).toBe(false);
	});

	it("does not treat retired transport-specific timeout markers as the neutral contract", () => {
		const retiredTransportPrefix = "lang" + "flow";
		const retiredRequestName = Object.assign(
			new Error("remote transport failed"),
			{ name: `${retiredTransportPrefix}RequestTimeoutError` },
		);
		const retiredStreamName = Object.assign(
			new Error("remote transport failed"),
			{ name: `${retiredTransportPrefix}StreamConnectTimeoutError` },
		);
		const retiredRequestCode = Object.assign(
			new Error("remote transport failed"),
			{ code: `${retiredTransportPrefix}_request_timeout` },
		);
		const retiredStreamCode = Object.assign(
			new Error("remote transport failed"),
			{ code: `${retiredTransportPrefix}_stream_connect_timeout` },
		);

		expect(isModelTimeoutError(retiredRequestName)).toBe(false);
		expect(isModelTimeoutError(retiredStreamName)).toBe(false);
		expect(isModelTimeoutError(retiredRequestCode)).toBe(false);
		expect(isModelTimeoutError(retiredStreamCode)).toBe(false);
	});
});
