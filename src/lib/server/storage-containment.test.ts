// The guard that stands between a row's `storage_path` and `unlink`.
//
// Hostile paths are the point. Every path this app writes today is
// server-generated and safe; the sweep and the eviction pass are the first
// readers that take a path out of a row and delete it box-wide, so the check
// belongs at the delete, where the damage would be, and not at the write,
// where the assumption currently holds.

import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveDeletablePath, storageRoots } from "./storage-containment";

let sandbox: string;
let roots: string[];

beforeEach(async () => {
	sandbox = await mkdtemp(join(tmpdir(), "alfyai-containment-"));
	roots = [
		join(sandbox, "data", "knowledge"),
		join(sandbox, "data", "chat-files"),
	];
	for (const root of roots) await mkdir(root, { recursive: true });
});

afterEach(async () => {
	await rm(sandbox, { recursive: true, force: true }).catch(() => undefined);
});

describe("resolveDeletablePath", () => {
	it("accepts a normal stored path inside a root", async () => {
		const dir = join(roots[0], "user-1");
		await mkdir(dir, { recursive: true });
		const file = join(dir, "doc.pdf");
		await writeFile(file, "bytes");

		expect(await resolveDeletablePath(file, roots)).toBe(resolve(file));
	});

	it("accepts a path whose leaf does not exist", async () => {
		// The unlink may lose a race with another sweep; the guard's job is
		// containment, not existence.
		const dir = join(roots[1], "conv-1");
		await mkdir(dir, { recursive: true });

		expect(await resolveDeletablePath(join(dir, "gone.pdf"), roots)).toBe(
			resolve(dir, "gone.pdf"),
		);
	});

	it("refuses a traversal out of the roots", async () => {
		expect(
			await resolveDeletablePath(
				join(roots[0], "user-1", "..", "..", "..", "etc", "passwd"),
				roots,
			),
		).toBeNull();
	});

	it("refuses an absolute path that ignores the roots entirely", async () => {
		// `join(cwd, storagePath)` would have quietly produced this one;
		// `resolve` lets an absolute value win, which is exactly why the check
		// happens AFTER resolution rather than trusting the join.
		expect(await resolveDeletablePath("/etc/passwd", roots)).toBeNull();
	});

	it("refuses a path whose parent directory is a symlink out of the roots", async () => {
		const outside = join(sandbox, "outside");
		await mkdir(outside, { recursive: true });
		await writeFile(join(outside, "secret.txt"), "bytes");
		await symlink(outside, join(roots[0], "escape"));

		// Lexically inside a root; really not.
		expect(
			await resolveDeletablePath(join(roots[0], "escape", "secret.txt"), roots),
		).toBeNull();
	});

	it("refuses an empty or blank path", async () => {
		expect(await resolveDeletablePath("", roots)).toBeNull();
		expect(await resolveDeletablePath("   ", roots)).toBeNull();
	});

	it("names both of the app's data directories by default", () => {
		expect(storageRoots()).toEqual([
			resolve(process.cwd(), "data", "knowledge"),
			resolve(process.cwd(), "data", "chat-files"),
		]);
	});
});
