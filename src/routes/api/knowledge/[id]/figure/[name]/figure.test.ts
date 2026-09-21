// GET /api/knowledge/[id]/figure/[name]
//
// The route is thin on purpose — `readMineruFigure` owns the name and
// containment rules — so what is tested here is the part the route alone
// decides: who is allowed to ask, and that every refusal looks the same from
// outside.

import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockRequireAuth = vi.fn();
const mockGetArtifactForUser = vi.fn();
const mockGetSourceArtifactId = vi.fn();

vi.mock("$lib/server/auth/hooks", () => ({
	requireAuth: (...args: unknown[]) => mockRequireAuth(...args),
}));

vi.mock("$lib/server/services/knowledge/store/core", () => ({
	getArtifactForUser: (...args: unknown[]) => mockGetArtifactForUser(...args),
	getSourceArtifactIdForNormalizedArtifact: (...args: unknown[]) =>
		mockGetSourceArtifactId(...args),
}));

import {
	mineruBundleDir,
	writeMineruParseBundle,
} from "$lib/server/services/mineru/bundle";
import { parseMineruResultZip } from "$lib/server/services/mineru/result";
import { GET } from "./+server";

type FigureRouteEvent = Parameters<typeof GET>[0];

const PDF_ZIP = join(
	process.cwd(),
	"fixtures",
	"mineru-v1",
	"pdf",
	"result.zip",
);
const FIGURE_NAME = "page_2_image_body_3.jpg";

let userId: string;
let sourceArtifactId: string;

function makeEvent(id: string, name: string): FigureRouteEvent {
	return {
		request: new Request(`http://localhost/api/knowledge/${id}/figure/${name}`),
		locals: { user: { id: userId, email: "test@example.com" } },
		params: { id, name },
	} as unknown as FigureRouteEvent;
}

async function writeBundle(): Promise<void> {
	const { result } = await parseMineruResultZip({
		zipPathAbsolute: PDF_ZIP,
		sourceFilename: "sample.pdf",
	});
	await writeMineruParseBundle({
		userId,
		sourceArtifactId,
		zipPathAbsolute: PDF_ZIP,
		result,
		maxBytes: 33_554_432,
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	userId = `figure-user-${randomUUID()}`;
	sourceArtifactId = randomUUID();
	mockRequireAuth.mockImplementation(() => {});
	mockGetSourceArtifactId.mockResolvedValue(null);
	mockGetArtifactForUser.mockResolvedValue({
		id: sourceArtifactId,
		userId,
		type: "source_document",
	});
});

afterEach(async () => {
	await rm(join(process.cwd(), "data", "knowledge", userId), {
		recursive: true,
		force: true,
	}).catch(() => undefined);
});

describe("GET /api/knowledge/[id]/figure/[name]", () => {
	it("serves a figure from the bundle", async () => {
		await writeBundle();

		const response = await GET(makeEvent(sourceArtifactId, FIGURE_NAME));

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("image/jpeg");
		expect(response.headers.get("content-length")).toBe("24862");
		expect(response.headers.get("x-content-type-options")).toBe("nosniff");
		expect(response.headers.get("cache-control")).toBe("private, max-age=3600");
		expect(response.headers.get("content-security-policy")).toContain(
			"default-src 'none'",
		);
		expect(response.headers.get("content-disposition")).toContain("inline");

		const body = await response.arrayBuffer();
		expect(body.byteLength).toBe(24862);
		// A real JPEG: SOI marker.
		expect(new Uint8Array(body).slice(0, 2)).toEqual(
			new Uint8Array([0xff, 0xd8]),
		);
	});

	it("serves a figure of an artifact the caller may read but does not own", async () => {
		// `getArtifactForUser` grants access to an artifact canonically owned
		// through a conversation the caller owns — which is exactly why it
		// exists instead of a `userId` equality check. The bundle nonetheless
		// lives under the OWNER's directory, so a route that derived the path
		// from the CALLER 404'd every figure of such a document.
		await writeBundle();
		mockGetArtifactForUser.mockResolvedValue({
			id: sourceArtifactId,
			userId, // the owner; the session below is somebody else
			type: "source_document",
		});
		const event = makeEvent(sourceArtifactId, FIGURE_NAME);
		(event as unknown as { locals: { user: { id: string } } }).locals = {
			user: { id: `other-${randomUUID()}` },
		};

		const response = await GET(event);
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("image/jpeg");
	});

	it("401s without a session", async () => {
		const event = makeEvent(sourceArtifactId, FIGURE_NAME);
		(event as unknown as { locals: { user: null } }).locals = { user: null };

		expect((await GET(event)).status).toBe(401);
	});

	it("404s for another user's artifact, identically to an unknown one", async () => {
		await writeBundle();
		// `getArtifactForUser` is THE authorization check: it returns null for
		// an artifact this user cannot see, exactly as it does for one that
		// does not exist.
		mockGetArtifactForUser.mockResolvedValue(null);

		const owned = await GET(makeEvent(sourceArtifactId, FIGURE_NAME));
		const unknown = await GET(makeEvent(randomUUID(), FIGURE_NAME));

		expect(owned.status).toBe(404);
		expect(unknown.status).toBe(404);
		expect(await owned.text()).toBe(await unknown.text());
	});

	it("hops from a normalized document to its source", async () => {
		await writeBundle();
		const normalizedId = randomUUID();
		mockGetArtifactForUser.mockResolvedValue({
			id: normalizedId,
			userId,
			type: "normalized_document",
		});
		mockGetSourceArtifactId.mockResolvedValue(sourceArtifactId);

		const response = await GET(makeEvent(normalizedId, FIGURE_NAME));

		expect(response.status).toBe(200);
		expect(mockGetSourceArtifactId).toHaveBeenCalledWith(userId, normalizedId);
	});

	it("404s when a normalized document has no source link", async () => {
		await writeBundle();
		mockGetArtifactForUser.mockResolvedValue({
			id: randomUUID(),
			userId,
			type: "normalized_document",
		});
		mockGetSourceArtifactId.mockResolvedValue(null);

		expect((await GET(makeEvent(randomUUID(), FIGURE_NAME))).status).toBe(404);
	});

	it("404s on every traversal and every unlisted name", async () => {
		await writeBundle();
		// One of these — `manifest.json` — is a real file inside the bundle; the
		// rest are escapes. All must be indistinguishable from a typo.
		for (const name of [
			"..",
			"../manifest.json",
			"../../../../etc/passwd",
			"%2e%2e%2fmanifest.json",
			"manifest.json",
			"normalized.md",
			"page_1_table_body_3.jpg",
			"nope.jpg",
			"nope.svg",
		]) {
			const response = await GET(makeEvent(sourceArtifactId, name));
			expect(response.status, name).toBe(404);
		}
	});

	it("404s when the artifact has no bundle at all", async () => {
		expect((await GET(makeEvent(sourceArtifactId, FIGURE_NAME))).status).toBe(
			404,
		);
	});

	it("404s when the manifest lists a figure whose file is missing", async () => {
		await writeBundle();
		await rm(
			join(mineruBundleDir(userId, sourceArtifactId), "images", FIGURE_NAME),
		);

		expect((await GET(makeEvent(sourceArtifactId, FIGURE_NAME))).status).toBe(
			404,
		);
	});

	it("404s for a file smuggled into the bundle behind the manifest's back", async () => {
		await writeBundle();
		await writeFile(
			join(mineruBundleDir(userId, sourceArtifactId), "images", "evil.jpg"),
			"payload",
		);

		expect((await GET(makeEvent(sourceArtifactId, "evil.jpg"))).status).toBe(
			404,
		);
	});
});
