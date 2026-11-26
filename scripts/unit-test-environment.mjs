import { globSync, readFileSync, statSync } from "node:fs";
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

function withoutParens(node) {
	while (ts.isParenthesizedExpression(node)) node = node.expression;
	return node;
}

function accessName(node) {
	if (ts.isPropertyAccessExpression(node)) return node.name.text;
	if (
		ts.isElementAccessExpression(node) &&
		ts.isStringLiteralLike(node.argumentExpression)
	) {
		return node.argumentExpression.text;
	}
}

function importMetaAccess(node, name) {
	if (accessName(node) !== name) return false;
	const receiver = withoutParens(node.expression);
	return (
		ts.isMetaProperty(receiver) &&
		receiver.keywordToken === ts.SyntaxKind.ImportKeyword &&
		receiver.name.text === "meta"
	);
}

function relativeGlob(root, file, pattern) {
	if (pattern.startsWith("$lib/")) return `src/lib/${pattern.slice(5)}`;
	if (pattern.startsWith("/")) return pattern.slice(1);
	if (!pattern.startsWith(".")) return null;
	return join(relative(root, dirname(file)), pattern);
}

function globDependencies(root, file, globs) {
	return globs.flatMap((patterns) => {
		const include = [];
		const exclude = [];
		for (const pattern of patterns) {
			const negative = pattern.startsWith("!");
			const relative = relativeGlob(
				root,
				file,
				negative ? pattern.slice(1) : pattern,
			);
			if (relative) (negative ? exclude : include).push(relative);
		}
		if (!include.length) return [];
		return globSync(include, { cwd: root, exclude, withFileTypes: false })
			.filter(
				(path) =>
					/\.(?:[cm]?[jt]s|svelte)$/.test(path) &&
					statSync(join(root, path), { throwIfNoEntry: false })?.isFile(),
			)
			.map((path) => join(root, path));
	});
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

function isRawGlob(options) {
	if (!options || !ts.isObjectLiteralExpression(options)) return false;
	// Check the last property so an override or spread stays conservative.
	for (const property of [...options.properties].reverse()) {
		if (
			ts.isSpreadAssignment(property) ||
			ts.isComputedPropertyName(property.name)
		)
			return false;
		if (property.name.text !== "query") continue;
		return (
			ts.isPropertyAssignment(property) &&
			ts.isStringLiteralLike(property.initializer) &&
			/^\??raw(?:&|$)/.test(property.initializer.text)
		);
	}
	return false;
}

function inspect(file, source, isTestEntry) {
	const imports = new Set();
	const globs = [];
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
		if (
			ts.isCallExpression(node) &&
			importMetaAccess(node.expression, "glob") &&
			node.arguments.length &&
			!isRawGlob(node.arguments[1])
		) {
			const input = node.arguments[0];
			const patterns = ts.isArrayLiteralExpression(input)
				? input.elements
				: [input];
			globs.push(
				patterns.filter(ts.isStringLiteralLike).map(({ text }) => text),
			);
		}
		if (ts.isTypeOfExpression(node)) {
			const expression = withoutParens(node.expression);
			if (ts.isIdentifier(expression) && browserGlobals.has(expression.text)) {
				reason ??= `typeof ${expression.text}`;
			}
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
			const expression = withoutParens(node.expression);
			const receiver = ts.isIdentifier(expression)
				? expression.text
				: undefined;
			const property = accessName(node);
			if (receiver === "globalThis" && property && browserGlobals.has(property))
				reason ??= `globalThis.${property}`;
			if (property === "SSR" && importMetaAccess(expression, "env"))
				reason ??= "import.meta.env.SSR";
			if (
				isTestEntry &&
				browserGlobals.has(receiver) &&
				!isLocalVariable(node.expression, receiver)
			)
				testReason ??= `${receiver} property access`;
		}
		if (
			isTestEntry &&
			ts.isIdentifier(node) &&
			["HTMLElement", "HTMLCanvasElement", "customElements"].includes(node.text)
		)
			testReason ??= node.text;
		ts.forEachChild(node, visit);
	}
	visit(tree);
	return { imports, globs, reason, testReason };
}

export function browserEnvironmentViolations(root, testFiles) {
	const modules = new Map();
	const entries = new Set(testFiles.map((file) => join(root, file)));
	function readModule(file, entryOnly = false) {
		if (!modules.has(file)) {
			if (svelteSource.test(file)) {
				modules.set(file, { reason: "Svelte source" });
			} else {
				const source = readFileSync(file, "utf8");
				// Match the first marker, using the same syntax as Vitest.
				const environment = source.match(
					/@(?:vitest|jest)-environment\s+([\w-]+)\b/,
				)?.[1];
				// Declared browser entries need no AST unless a Node test imports them.
				if (
					entryOnly &&
					(environment === "jsdom" || environment === "happy-dom")
				)
					return { environment };
				const { imports, globs, reason, testReason } = inspect(
					file,
					source,
					entries.has(file),
				);
				const dependencies = [...imports]
					.map((specifier) => localModule(root, file, specifier))
					.filter(Boolean);
				dependencies.push(...globDependencies(root, file, globs));
				modules.set(file, { environment, reason, testReason, dependencies });
			}
		}
		return modules.get(file);
	}

	const violations = [];
	for (const file of testFiles) {
		const entry = join(root, file);
		const { environment } = readModule(entry, true);
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
