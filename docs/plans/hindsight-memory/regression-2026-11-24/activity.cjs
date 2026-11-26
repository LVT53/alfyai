// The admission service's activity signal on 127.0.0.1:18893 for the 2026-11-24 regression run.
//
// The suites recorded a scratch Vite app answering GET /api/internal/memory-admission. That
// route returns `readForegroundActivity()`: no foreground lease ever exists in the scratch app
// (the harnesses deliver turns in their own processes and SQLite files), so it answered
// inactive, healthy and, with HINDSIGHT_OVERNIGHT_IDLE=true, idle: the gateway's budget of six
// that the integrated benchmark recorded ("peak concurrency six"). This stand-in answers that
// same reading with the same bearer check and shape. The model bridge still caps the calls
// that reach Flash-Next at three.
"use strict";
const http = require("node:http");
const { timingSafeEqual } = require("node:crypto");

const port = Number(process.env.ALFYAI_ACTIVITY_PORT ?? 18893);
const expected = Buffer.from("Bearer synthetic-activity");
let reads = 0;
http
	.createServer((req, res) => {
		const supplied = Buffer.from(req.headers.authorization ?? "");
		const ok = supplied.length === expected.length && timingSafeEqual(supplied, expected);
		if (req.method !== "GET" || req.url !== "/api/internal/memory-admission" || !ok) {
			res.writeHead(401, { "Content-Type": "application/json" }).end('{"error":"Unauthorized"}');
			return;
		}
		reads++;
		res
			.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" })
			.end(JSON.stringify({ idle: true, active: false, healthy: true, observedAt: Date.now() }));
	})
	.listen(port, "127.0.0.1", () => console.log(`Synthetic activity signal ready on ${port}`));
process.on("SIGTERM", () => {
	console.log(`activity reads: ${reads}`);
	process.exit();
});
