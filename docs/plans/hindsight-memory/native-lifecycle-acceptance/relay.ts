import assert from "node:assert/strict";
import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import { setTimeout as wait } from "node:timers/promises";

type Event = { path: string; method: string; response: number; body?: unknown };
type Fault = {
	match(event: Event): boolean;
	remaining: number;
	before?: "unavailable" | "malformed" | "slow";
	after?: (event: Event) => Promise<void>;
};

export async function startRelay(port = 0, events: Event[] = []) {
	let fault: Fault | undefined;
	async function proxy(req: IncomingMessage, res: ServerResponse) {
		const path = req.url ?? "";
		assert.match(path, /^\/(?:v1\/default\/banks\/|ext\/alfyai\/)/);
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(Buffer.from(chunk));
		const body = Buffer.concat(chunks);
		const event: Event = {
			path,
			method: req.method ?? "GET",
			response: 0,
			body: body.length ? JSON.parse(body.toString("utf8")) : undefined,
		};
		const matched =
			fault && fault.remaining > 0 && fault.match(event) ? fault : undefined;
		if (matched) matched.remaining--;
		const upstream = async () => {
			const headers = new Headers();
			for (const name of ["authorization", "content-type", "accept"]) {
				const value = req.headers[name];
				if (typeof value === "string") headers.set(name, value);
			}
			return fetch("http://127.0.0.1:18890" + path, {
				method: event.method,
				headers,
				body: body.length ? body : undefined,
				redirect: "error",
				signal: AbortSignal.timeout(185_000),
			});
		};
		const finish = (status: number, data: string) => {
			event.response = status;
			events.push(event);
			if (!res.destroyed)
				res.writeHead(status, { "content-type": "application/json" }).end(data);
		};
		if (matched?.before === "unavailable") {
			finish(503, '{"error":{"message":"synthetic gateway outage"}}');
			return;
		}
		if (matched?.before === "malformed") {
			finish(
				200,
				'{"choices":[{"index":0,"message":{"role":"assistant","content":"not JSON"},"finish_reason":"stop"}],"id":"synthetic-malformed","model":"qwen3-6-27b","object":"chat.completion","created":0}',
			);
			return;
		}
		if (matched?.before === "slow") await wait(4_000);
		const response = await upstream();
		const data = await response.text();
		if (matched?.after)
			await matched.after({ ...event, response: response.status });
		finish(response.status, data);
	}
	const server = createServer((req, res) => {
		void proxy(req, res).catch((error: unknown) => {
			console.error("relay", error);
			if (!res.destroyed && !res.headersSent) res.writeHead(502).end();
		});
	});
	await new Promise<void>((resolve) =>
		server.listen(port, "127.0.0.1", resolve),
	);
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	return {
		base: `http://127.0.0.1:${address.port}`,
		events,
		arm(next: Fault) {
			fault = next;
		},
		remaining: () => fault?.remaining,
		close() {
			server.closeAllConnections();
			server.close();
		},
	};
}
