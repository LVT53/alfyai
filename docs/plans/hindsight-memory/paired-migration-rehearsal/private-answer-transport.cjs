"use strict";

const http = require("node:http");
const { isIPv4 } = require("node:net");

// The exact endpoint and model in the frozen private run manifest must have
// been independently checked against the approved local provider binding.
async function privateAnswer({ endpoint, model, apiKey, messages, beforeDispatch }) {
	const url = new URL(endpoint);
	const [a, b] = url.hostname.split(".").map(Number);
	if (
		url.href !== endpoint ||
		url.protocol !== "http:" ||
		!isIPv4(url.hostname) ||
		!(a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		url.pathname !== "/v1/chat/completions" ||
		typeof model !== "string" ||
		!model ||
		typeof apiKey !== "string" ||
		!apiKey ||
		typeof beforeDispatch !== "function"
	) {
		throw new Error("private_binding_unavailable");
	}
	const body = JSON.stringify({
		model,
		messages,
		temperature: 0,
		top_p: 1,
		max_tokens: 400,
		stream: false,
		chat_template_kwargs: { enable_thinking: false },
	});
	if (beforeDispatch() !== undefined) throw new Error("private_binding_unavailable");
	return new Promise((resolve, reject) => {
		const unavailable = () => reject(new Error("private_answer_unavailable"));
		// A private agent with explicit empty defaults avoids global agents,
		// proxy environment hooks, redirects and DNS resolution.
		const agent = new http.Agent({ keepAlive: false, proxyEnv: {} });
		const request = http.request(
			url,
			{
				agent,
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"Content-Length": Buffer.byteLength(body),
					Authorization: `Bearer ${apiKey}`,
				},
				signal: AbortSignal.timeout(30_000),
			},
			(response) => {
				if (response.statusCode !== 200) {
					response.destroy();
					unavailable();
					return;
				}
				const chunks = [];
				let size = 0;
				response.on("data", (chunk) => {
					size += chunk.length;
					if (size > 65_536) {
						response.destroy();
						unavailable();
						return;
					}
					chunks.push(chunk);
				});
				response.on("error", unavailable);
				response.on("end", () => {
					try {
						const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
						const answer = parsed.choices?.[0]?.message?.content;
						if (typeof answer === "string" && answer.trim()) resolve(answer);
						else unavailable();
					} catch {
						unavailable();
					}
				});
			},
		);
		request.once("error", unavailable);
		request.once("close", () => agent.destroy());
		request.end(body);
	});
}

module.exports = { privateAnswer };
