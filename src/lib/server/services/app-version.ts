import { readFileSync } from "node:fs";
import { resolve } from "node:path";

interface PackageMetadata {
	version?: string;
}

export interface AppVersionMetadata {
	full: string;
	compact: string;
}

function readPackageMetadata(): PackageMetadata {
	return JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8")) as PackageMetadata;
}

function compactVersion(version: string): string {
	const [major = "0", minor = "0"] = version.split(".");
	return `v${major}.${minor}`;
}

export function getAppVersionMetadata(): AppVersionMetadata {
	const full = readPackageMetadata().version ?? "0.0.0";
	return {
		full,
		compact: compactVersion(full),
	};
}
