import { afterEach, describe, expect, it, vi } from "vitest";
import { APP_MAX_OUTPUT_TOKENS } from "$lib/server/services/artifacts/app/contract";
import { resolveOpenAICompatibleProviderAdapterProfile } from "$lib/server/services/normal-chat-model/provider-compatibility";
import { resolveModelCallSampling } from "$lib/server/services/normal-chat-model/sampling";
import { resolveEvalArtifactsClient } from "./client";
import { EVAL_ARTIFACTS_SAMPLING } from "./config";
import { buildToolPathRequestBody } from "./tool-path";

// A measurement taken at a different temperature than the product runs at is not
// a measurement of the product. Every model call in the app takes its sampling
// from one route (`resolveModelCallSampling`, with top_k from the same family
// profile through the provider builder); this reads what the HARNESS puts on the
// wire for both of its request builders and holds it to what that route resolves
// for the model the harness is run against. The harness keeps a frozen copy of the
// numbers so runs stay comparable (config.ts), and config.test.ts pins the copy to
// the profile; this is the half that pins the requests to the copy's source.

const ENDPOINT = "http://127.0.0.1:30402/v1";
const MODEL = "qwen3-6-27b";

/** The provider the harness's endpoint and model name make, as the app would see it. */
const PROVIDER = {
	name: "eval",
	displayName: "eval",
	baseUrl: ENDPOINT,
	modelName: MODEL,
};

function whatTheAppSends() {
	const { temperature, topP } = resolveModelCallSampling(PROVIDER);
	const topK =
		resolveOpenAICompatibleProviderAdapterProfile(PROVIDER).defaultSampling
			?.topK;
	return { temperature, top_p: topP, top_k: topK };
}

describe("the sampling the harness sends is the app's own", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("resolves to a real profile for the model under test, so the comparison below means something", () => {
		expect(whatTheAppSends()).toEqual({
			temperature: 0.6,
			top_p: 0.95,
			top_k: 20,
		});
	});

	it("puts exactly that on the wire from the plain client (the document, app and verification suites)", async () => {
		const fetchMock = vi.fn(
			async (_input: RequestInfo | URL, _init?: RequestInit) =>
				new Response(
					JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
		);
		vi.stubGlobal("fetch", fetchMock);
		const client = resolveEvalArtifactsClient({
			baseUrl: ENDPOINT,
			model: MODEL,
			apiKey: null,
		});

		await client.send({ prompt: "hi", thinking: "off" });

		const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
		expect({
			temperature: body.temperature,
			top_p: body.top_p,
			top_k: body.top_k,
		}).toEqual(whatTheAppSends());
	});

	it("puts exactly that on the wire from the tool path (the canvas suite)", () => {
		const body = buildToolPathRequestBody(MODEL, {
			system: "system",
			user: "user",
			language: "en",
			toolChoice: "auto",
			thinking: "off",
		});

		expect({
			temperature: body.temperature,
			top_p: body.top_p,
			top_k: body.top_k,
		}).toEqual(whatTheAppSends());
	});

	// The App call is capped at APP_MAX_OUTPUT_TOKENS by the app itself
	// (`generateApp`, bounded further by the model's own limit); the harness's
	// frozen cap is that number, so an App answer is never cut shorter or allowed
	// longer than the product's would be.
	it("caps an answer at the App's own output limit", () => {
		expect(EVAL_ARTIFACTS_SAMPLING.maxTokens).toBe(APP_MAX_OUTPUT_TOKENS);
	});
});
