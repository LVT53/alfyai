// The synthetic Flash-Next bridge on 127.0.0.1:18891 for the 2026-11-24 regression run.
//
// The suites recorded `native-acceptance/proxy.cjs`, which reached the model through an
// ssh tunnel into the production box to read its provider row. This run has no production
// access, so this bridge calls Flash-Next at inference.alfycomms.com directly with the
// ALFY_API_KEY from ~/.dsh/.env (read at start, never printed or written). It keeps the
// recorded bridge's request rules exactly: only the `qwen3-6-27b` alias, `stream: false`,
// and thinking only when the caller asked for it explicitly (`enable_thinking: true`).
// It adds one rule of its own: at most ALFYAI_BRIDGE_LIMIT (3) calls in flight, the rest
// wait in arrival order. Synthetic data only; the trace holds synthetic prompts and answers.
"use strict";
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const port = Number(process.env.ALFYAI_BRIDGE_PORT ?? 18891);
const limit = Number(process.env.ALFYAI_BRIDGE_LIMIT ?? 3);
const upstream = "https://inference.alfycomms.com/v1/chat/completions";
const trace = process.env.ALFYAI_NATIVE_MODEL_TRACE;
if (!trace) throw Error("Set ALFYAI_NATIVE_MODEL_TRACE to a synthetic trace file");
let key = "";
for (const line of fs.readFileSync(path.join(os.homedir(), ".dsh/.env"), "utf8").split("\n")) {
	if (line.startsWith("ALFY_API_KEY=")) key = line.slice(13).trim().replace(/^["']|["']$/g, "");
}
if (!key) throw Error("ALFY_API_KEY missing");

const stats = { active: 0, waiting: 0, peak: 0, total: 0, statuses: {}, longestWaitMs: 0 };
const queue = [];
function acquire() {
	return new Promise((resolve) => {
		if (stats.active < limit) {
			stats.active++;
			stats.peak = Math.max(stats.peak, stats.active);
			resolve();
		} else {
			stats.waiting++;
			queue.push(resolve);
		}
	});
}
function release() {
	const next = queue.shift();
	if (next) {
		stats.waiting--;
		next();
	} else stats.active--;
}

http
	.createServer(async (req, res) => {
		if (req.method === "GET" && req.url === "/stats") {
			res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(stats));
			return;
		}
		let text = "";
		for await (const part of req) text += part;
		let body;
		try {
			if (req.method !== "POST" || !/^\/v1\/chat\/completions\/?$/.test(req.url ?? "")) throw Error("not found");
			body = JSON.parse(text);
			if (body.model !== "qwen3-6-27b") throw Error("Only local model permitted for remaining tests");
		} catch (error) {
			res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: error.message }));
			return;
		}
		const payload = {
			...body,
			stream: false,
			chat_template_kwargs: { enable_thinking: body.chat_template_kwargs?.enable_thinking === true },
		};
		const queued = Date.now();
		await acquire();
		const started = Date.now();
		stats.longestWaitMs = Math.max(stats.longestWaitMs, started - queued);
		let status = 500;
		let answer;
		try {
			const response = await fetch(upstream, {
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
				body: JSON.stringify(payload),
				signal: AbortSignal.timeout(180_000),
			});
			status = response.status;
			const raw = await response.text();
			try {
				answer = JSON.parse(raw);
			} catch {
				answer = { error: "non-JSON upstream answer", length: raw.length };
			}
		} catch (error) {
			answer = { error: String(error?.message ?? error) };
		} finally {
			release();
		}
		stats.total++;
		stats.statuses[status] = (stats.statuses[status] ?? 0) + 1;
		fs.appendFileSync(
			trace,
			JSON.stringify({
				at: new Date(queued).toISOString(),
				request: body,
				response: { status, body: answer, ms: Date.now() - started, waitedMs: started - queued },
			}) + "\n",
		);
		if (!res.destroyed) res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(answer));
	})
	.listen(port, "127.0.0.1", () => console.log(`Synthetic model bridge ready on ${port}, at most ${limit} in flight`));
process.on("SIGTERM", () => process.exit());
