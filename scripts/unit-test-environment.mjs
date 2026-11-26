import { readFileSync, statSync } from "node:fs";
import { dirname, extname, join, normalize, relative } from "node:path";
import ts from "typescript";

const svelteSource = /\.svelte(?:\.[jt]s)?$/;
// Mermaid uses DOMPurify even when parsing a diagram without rendering it.
const browserImport =
	/^(?:svelte(?:\/|$)|\$app\/|esm-env(?:\/|$)|mermaid(?:\/|$)|@testing-library\/)/;
const browserGlobals = new Set([
	"window",
	"document",
	"navigator",
	"localStorage",
	"sessionStorage",
]);

function localModule(root, file, specifier) {
	const path = specifier.split(/[?#]/, 1)[0];
	let base;
	if (path.startsWith("$lib/")) base = join(root, "src/lib", path.slice(5));
	else if (path.startsWith(".")) base = normalize(join(dirname(file), path));
	else return;

	const candidates = [base];
	const extension = extname(base);
	if (extension === ".js") candidates.push(`${base.slice(0, -3)}.ts`);
	if (!extension) {
		candidates.push(
			...[".ts", ".js", ".svelte.ts", ".svelte.js"].map(
				(suffix) => base + suffix,
			),
			join(base, "index.ts"),
			join(base, "index.js"),
		);
	}
	return candidates.find(
		(candidate) =>
			/\.(?:[cm]?[jt]s|svelte)$/.test(candidate) &&
			statSync(candidate, { throwIfNoEntry: false })?.isFile(),
	);
}

function importSource(node) {
	if (ts.isImportDeclaration(node)) {
		const clause = node.importClause;
		if (clause?.isTypeOnly) return;
		// TypeScript erases inline type specifiers, but can retain the empty
		// import for side effects under verbatimModuleSyntax.
		return node.moduleSpecifier;
	}
	if (ts.isExportDeclaration(node) && !node.isTypeOnly)
		return node.moduleSpecifier;
	if (
		ts.isCallExpression(node) &&
		node.expression.kind === ts.SyntaxKind.ImportKeyword
	)
		return node.arguments[0];
}

// Ignore a local variable declared in an enclosing block, such as a stored
// artifact named document. Unrecognized bindings still get flagged.
function isLocalVariable(reference, name) {
	for (let scope = reference.parent; scope; scope = scope.parent) {
		if (!ts.isBlock(scope) && !ts.isSourceFile(scope)) continue;
		for (const statement of scope.statements) {
			if (!ts.isVariableStatement(statement)) continue;
			if (
				statement.declarationList.declarations.some(
					({ name: binding }) =>
						ts.isIdentifier(binding) && binding.text === name,
				)
			)
				return true;
		}
	}
	return false;
}

function inspect(file, source) {
	const imports = new Set();
	let reason;
	let testReason;
	const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
	function visit(node) {
		const specifier = importSource(node);
		if (specifier && ts.isStringLiteralLike(specifier)) {
			imports.add(specifier.text);
			if (browserImport.test(specifier.text))
				reason ??= `import "${specifier.text}"`;
		}
		if (ts.isTypeOfExpression(node) && ts.isIdentifier(node.expression)) {
			const name = node.expression.text;
			if (browserGlobals.has(name)) reason ??= `typeof ${name}`;
		}
		if (
			ts.isNewExpression(node) &&
			ts.isIdentifier(node.expression) &&
			node.expression.text === "DOMParser"
		)
			reason ??= "new DOMParser";
		if (
			ts.isPropertyAccessExpression(node) ||
			ts.isElementAccessExpression(node)
		) {
			const receiver = node.expression.getText(tree);
			const property = ts.isPropertyAccessExpression(node)
				? node.name.text
				: ts.isStringLiteralLike(node.argumentExpression)
					? node.argumentExpression.text
					: undefined;
			if (receiver === "globalThis" && property && browserGlobals.has(property))
				reason ??= `globalThis.${property}`;
			if (property === "SSR" && receiver === "import.meta.env")
				reason ??= "import.meta.env.SSR";
			if (
				browserGlobals.has(receiver) &&
				!isLocalVariable(node.expression, receiver)
			)
				testReason ??= `${receiver} property access`;
		}
		if (
			ts.isIdentifier(node) &&
			["HTMLElement", "HTMLCanvasElement", "customElements"].includes(node.text)
		)
			testReason ??= node.text;
		ts.forEachChild(node, visit);
	}
	visit(tree);
	return { imports, reason, testReason };
}

export function browserEnvironmentViolations(root, testFiles) {
	const modules = new Map();
	function readModule(file) {
		if (!modules.has(file)) {
			if (svelteSource.test(file)) {
				modules.set(file, { reason: "Svelte source" });
			} else {
				const source = readFileSync(file, "utf8");
				// Match the first marker, using the same syntax as Vitest.
				const environment = source.match(
					/@(?:vitest|jest)-environment\s+([\w-]+)\b/,
				)?.[1];
				const { imports, reason, testReason } = inspect(file, source);
				const dependencies = [...imports]
					.map((specifier) => localModule(root, file, specifier))
					.filter(Boolean);
				modules.set(file, { environment, reason, testReason, dependencies });
			}
		}
		return modules.get(file);
	}

	const violations = [];
	for (const file of testFiles) {
		const entry = join(root, file);
		const { environment } = readModule(entry);
		if (environment === "jsdom" || environment === "happy-dom") continue;
		const seen = new Set();
		const pending = [entry];
		while (pending.length) {
			const next = pending.pop();
			if (seen.has(next)) continue;
			seen.add(next);
			const { reason, testReason, dependencies = [] } = readModule(next);
			const why = reason ?? (next === entry ? testReason : undefined);
			if (why) {
				violations.push({ file, module: relative(root, next), reason: why });
				break;
			}
			for (const dependency of dependencies) pending.push(dependency);
		}
	}
	return violations;
}
