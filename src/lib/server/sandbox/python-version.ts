import path from "node:path";

/**
 * The Python minor version the file-production sandbox actually runs.
 *
 * Three places have to agree on this value or Python program mode silently
 * breaks: the container image, the `site-packages` directory the deploy
 * scripts install wheels into, and the bind-mount source this module builds.
 * It is declared once here and once in `scripts/sandbox-python-version.sh`
 * (shell can't import TypeScript); `scripts/deploy.test.ts` asserts the two
 * copies are identical, so changing one without the other fails the suite.
 *
 * Wheels must be built for THIS interpreter, not for whatever `python3` the
 * deploy host happens to ship — see `scripts/deploy-lib.sh`.
 */
export const SANDBOX_PYTHON_VERSION = "3.11";

/** The sandbox container image, derived from the one version constant. */
export const SANDBOX_PYTHON_IMAGE = `python:${SANDBOX_PYTHON_VERSION}-slim`;

/**
 * Release-relative path of the directory bind-mounted into the container at
 * {@link SANDBOX_PYTHON_PACKAGES_MOUNT_PATH}. The deploy scripts write to
 * exactly this path under the release directory.
 */
export const SANDBOX_PYTHON_SITE_PACKAGES_RELPATH = path.join(
	"sandbox-python-env",
	"lib",
	`python${SANDBOX_PYTHON_VERSION}`,
	"site-packages",
);

/** Where the site-packages directory is mounted inside the container. */
export const SANDBOX_PYTHON_PACKAGES_MOUNT_PATH = "/workspace/python-packages";

/**
 * The distribution names the deploy scripts install, in the order the
 * `run_python` / `produce_file` tool descriptions promise them.
 */
export const SANDBOX_PYTHON_PACKAGES = [
	"openpyxl",
	"xlsxwriter",
	"python-docx",
	"python-pptx",
] as const;

/** The module names those distributions import as. */
export const SANDBOX_PYTHON_IMPORT_NAMES = [
	"openpyxl",
	"xlsxwriter",
	"docx",
	"pptx",
] as const;
