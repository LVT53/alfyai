// Run against two real scratch AlfyAI listeners and the pinned native service.
const assert = require("node:assert/strict");
const { writeFileSync } = require("node:fs");
const { setTimeout: pause } = require("node:timers/promises");

const app = "http://127.0.0.1:18892";
const observer = "http://127.0.0.1:18893";
const admission = "/api/internal/memory-admission";
const gateway = "http://127.0.0.1:18890/ext/alfyai/inference";
const auth = { authorization: "Bearer synthetic-activity" };
const inferenceHeaders = {
	authorization: "Bearer synthetic-admission",
	"content-type": "application/json",
};
const results = { baseline: [], trials: [], authStatuses: [] };

async function status() {
	const response = await fetch(gateway + "/status", { headers: inferenceHeaders });
	assert.equal(response.status, 200);
	return response.json();
}

async function activity(base = observer) {
	const start = performance.now();
	const response = await fetch(base + admission, { headers: auth });
	assert.equal(response.status, 200);
	return { ...(await response.json()), latencyMs: Math.round(performance.now() - start) };
}

async function until(read, match, description) {
	const started = performance.now();
	do {
		const value = await read();
		if (match(value)) return value;
		await pause(15);
	} while (performance.now() - started < 10_000);
	throw Error(description);
}

async function infer(long) {
	const started = performance.now();
	const response = await fetch(gateway + "/v1/chat/completions", {
		method: "POST",
		headers: inferenceHeaders,
		body: JSON.stringify({
			model: "qwen3-6-27b",
			messages: [{
				role: "user",
				content: long
					? "Synthetic throughput check: list every integer from 1 to 320 separated by comma. Output only the list."
					: "Synthetic admission check: answer 'blue'.",
			}],
			max_tokens: long ? 650 : 32,
			stream: false,
			chat_template_kwargs: { enable_thinking: false },
		}),
		signal: AbortSignal.timeout(120_000),
	});
	await response.arrayBuffer();
	return { status: response.status, ms: Math.round(performance.now() - started) };
}

async function login() {
	const response = await fetch(app + "/api/auth/login", {
		method: "POST",
		headers: { "content-type": "application/json", origin: app },
		body: JSON.stringify({
			email: "memory-acceptance@example.test",
			password: "synthetic-memory-acceptance-password",
		}),
	});
	assert.equal(response.status, 200);
	return response.headers.getSetCookie()[0].split(";")[0];
}

async function newConversation(cookie) {
	const headers = { "content-type": "application/json", origin: app, cookie };
	const response = await fetch(app + "/api/conversations", {
		method: "POST",
		headers,
		body: JSON.stringify({ title: "Synthetic native operation overlap", memoryIncognito: true }),
	});
	assert.equal(response.status, 201);
	return { headers, conversationId: (await response.json()).id };
}

async function foreground({ headers, conversationId }) {
	const start = performance.now();
	const response = await fetch(app + "/api/chat/send", {
		method: "POST",
		headers,
		body: JSON.stringify({
			conversationId,
			message: "Give the digits 1 through 40 as a comma-separated list. Then stop.",
			model: "model1",
			reasoningDepth: "quick",
		}),
		signal: AbortSignal.timeout(120_000),
	});
	const payload = await response.json();
	return {
		status: response.status,
		ms: Math.round(performance.now() - start),
		hasResponse: Boolean(payload.response),
	};
}

async function main() {
	for (const [headers, method] of [[auth, "GET"], [{ authorization: "Bearer invalid" }, "GET"], [{}, "GET"], [auth, "HEAD"]]) {
		const response = await fetch(app + admission, { headers, method });
		results.authStatuses.push(response.status);
	}
	assert.deepEqual(results.authStatuses, [200, 401, 401, 401]);
	const cookie = await login();
	await foreground(await newConversation(cookie)); // Warm the route and model.
	for (let i = 0; i < 3; i++) {
		const result = await foreground(await newConversation(cookie));
		assert.equal(result.status, 200);
		assert(result.hasResponse);
		results.baseline.push(result);
	}
	for (let i = 0; i < 3; i++) {
		const conversation = await newConversation(cookie);
		const idle = await activity();
		assert.equal(idle.idle, true);
		assert.equal(idle.active, false);
		assert.equal(idle.healthy, true);
		const pending = Promise.all(Array.from({ length: 6 }, () => infer(true)));
		const full = await until(status, (value) => value.active === 6, "six background calls never overlapped");
		const turn = foreground(conversation);
		const active = await until(activity, (value) => value.active, "second app process never observed foreground");
		const blocked = await infer(false);
		assert.equal(blocked.status, 429);
		const combined = { idle, full, active, blocked, foreground: await turn, background: await pending };
		assert.equal(combined.foreground.status, 200);
		assert(combined.foreground.hasResponse);
		assert(combined.background.every((result) => result.status === 200));
		combined.finished = await until(activity, (value) => !value.active, "finished foreground lease remained active");
		results.trials.push(combined);
	}
	results.final = await status();
	assert.equal(results.final.active, 0);
	assert.equal(results.final.peak, 6);
	results.passed = true;
}
main()
	.catch((error) => {
		results.error = error.message;
		process.exitCode = 1;
	})
	.finally(() => {
		writeFileSync(
			process.env.ALFYAI_OVERLAP_RESULTS ?? "/tmp/alfyai-nativeops-app-overlap.json",
			JSON.stringify(results, null, 2),
		);
		console.log(JSON.stringify(results));
	});
