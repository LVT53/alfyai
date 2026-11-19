// Synthetic native tenant and method matrix. For Compose, pass the private
// synthetic alfyai-tenants.env path via ALFYAI_NATIVE_TEST_ENV.
const assert = require("node:assert/strict");
const { createHmac, randomUUID } = require("node:crypto");
const { writeFileSync } = require("node:fs");
const { setTimeout: pause } = require("node:timers/promises");
const bankConfig = require("./bank-config.json");

const base = process.env.ALFYAI_NATIVE_TEST_URL ?? "http://127.0.0.1:18890";
if (process.env.ALFYAI_NATIVE_TEST_ENV) process.loadEnvFile(process.env.ALFYAI_NATIVE_TEST_ENV);
const version = process.env.HINDSIGHT_TENANT_ACTIVE_KEY ?? "synthetic";
const masters = JSON.parse(process.env.HINDSIGHT_TENANT_MASTER_KEYS ?? JSON.stringify({ synthetic: "ab".repeat(32) }));
const tenants = [randomUUID(), randomUUID()];
const bank = randomUUID();
const marker = "SyntheticTraceMarkerPurpleLighthouse";
const result = { base, tenants, bank, methods: [], wrongKey: [], crossedTenant: [] };

function credential(tenant) {
	const label = version + "." + tenant;
	return label + "." + createHmac("sha256", Buffer.from(masters[version], "hex")).update(label).digest("hex");
}
function bankRoute(suffix = "") {
	return "/v1/default/banks/" + bank + suffix;
}
async function call(key, method, path, body) {
	const response = await fetch(base + path, {
		method,
		headers: { authorization: "Bearer " + key, "content-type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
		redirect: "error",
		signal: AbortSignal.timeout(65_000),
	});
	const data = await response.json().catch(() => null);
	return { status: response.status, data };
}
async function checked(key, method, path, status, body) {
	const value = await call(key, method, path, body);
	result.methods.push({ method, path, status: value.status });
	assert.equal(value.status, status, method + " " + path);
	return value.data;
}
async function settle(key) {
	for (let i = 0; i < 220; i++) {
		const { status, data } = await call(key, "GET", bankRoute("/operations?limit=100"));
		assert.equal(status, 200);
		assert(!data.operations.some((op) => op.status === "failed"), "native operation failed");
		if (data.operations.every((op) => ["completed", "cancelled"].includes(op.status))) return;
		await pause(400);
	}
	throw Error("native operations did not settle");
}
function retain(documentId, content) {
	return {
		items: [{ document_id: documentId, content, timestamp: "2026-11-18T12:00:00Z", context: "User-authored synthetic fixture." }],
		operation_id: randomUUID(),
		async: true,
	};
}
async function main() {
	const [keyA, keyB] = tenants.map(credential);
	try {
		const identities = [];
		for (const key of [keyA, keyB]) {
			const attestation = await checked(key, "GET", "/ext/alfyai/capabilities", 200);
			assert.equal(attestation.engine_commit, "9fb28dbd724dc1ce4da7cb4c49008e601db76c5f");
			assert.equal(attestation.tenant_extension, "AlfyTenant");
			identities.push(attestation.tenant_binding);
			await checked(key, "PUT", bankRoute(), 200, {});
			await checked(key, "PATCH", bankRoute("/config"), 200, { updates: bankConfig });
			const { config } = await checked(key, "GET", bankRoute("/config"), 200);
			for (const [field, value] of Object.entries(bankConfig)) assert.equal(config[field], value);
		}
		assert.notEqual(...identities);

		const documents = [
			retain("synthetic-en", "I own a lavender telescope. I named it " + marker + "."),
			retain("synthetic-hu", "Van egy narancssárga biciklim. A biciklim neve Paprika."),
		];
		for (const [index, key] of [keyA, keyB].entries()) {
			await checked(key, "POST", bankRoute("/memories"), 200, documents[index]);
			await settle(key);
		}
		const listing = "/memories/list?state=valid&limit=100&offset=0";
		const factsA = (await checked(keyA, "GET", bankRoute(listing), 200)).items;
		const factsB = (await checked(keyB, "GET", bankRoute(listing), 200)).items;
		assert.match(JSON.stringify(factsA), /lavender/i);
		assert.match(JSON.stringify(factsB), /paprika/i);
		assert.doesNotMatch(JSON.stringify(factsA), /paprika/i);
		assert.doesNotMatch(JSON.stringify(factsB), /telescope/i);
		const fact = factsA.find((value) => value.fact_type !== "observation");
		assert(fact);
		const factPath = bankRoute("/memories/" + fact.id);
		const docPath = bankRoute("/documents/synthetic-en");
		const recall = { query: "Tell me about my telescope.", max_tokens: 2048, types: ["observation"] };
		assert.match(JSON.stringify(await checked(keyA, "POST", bankRoute("/memories/recall"), 200, recall)), /telescope/i);
		const wrong = keyA.slice(0, -1) + (keyA.endsWith("0") ? "1" : "0");
		for (const [method, path, payload] of [
			["GET", "/ext/alfyai/capabilities"],
			["GET", bankRoute("/config")],
			["GET", bankRoute(listing)],
			["GET", factPath],
			["POST", bankRoute("/memories/recall"), recall],
			["POST", bankRoute("/memories"), retain("must-not-exist", "Synthetic denied content")],
			["PATCH", factPath, { text: "Synthetic denied correction" }],
			["DELETE", docPath],
			["DELETE", bankRoute()],
		]) {
			const { status } = await call(wrong, method, path, payload);
			assert.equal(status, 401, method + " " + path);
			result.wrongKey.push({ method, path, status });
		}
		for (const [method, path, payload] of [
			["GET", factPath],
			["GET", docPath],
			["PATCH", factPath, { text: "Synthetic denied cross-tenant correction" }],
			["DELETE", docPath],
		]) {
			const { status } = await call(keyB, method, path, payload);
			assert.equal(status, 404, method + " " + path);
			result.crossedTenant.push({ method, path, status });
		}
		await checked(keyA, "PATCH", factPath, 200, { text: "I own a violet telescope." });
		assert.match(JSON.stringify(await checked(keyA, "GET", factPath, 200)), /violet/i);
		await checked(keyA, "DELETE", docPath, 200);
		await settle(keyA);
		await checked(keyA, "GET", docPath, 404);
		assert.doesNotMatch(JSON.stringify((await checked(keyA, "GET", bankRoute(listing), 200)).items), /telescope/i);
		await checked(keyB, "GET", bankRoute("/documents/synthetic-hu"), 200);
		result.passed = true;
	} finally {
		for (const key of [keyA, keyB]) {
			const { status } = await call(key, "DELETE", bankRoute());
			assert([200, 404].includes(status));
		}
	}
}
main()
	.catch((error) => {
		result.error = error.message;
		process.exitCode = 1;
	})
	.finally(() => {
		writeFileSync(process.env.ALFYAI_NATIVE_METHODS_RESULTS ?? "/tmp/alfyai-nativeops-methods.json", JSON.stringify(result, null, 2));
		console.log(JSON.stringify({ passed: result.passed ?? false, error: result.error, methods: result.methods.length, wrongKey: result.wrongKey.length, crossedTenant: result.crossedTenant.length }));
	});
