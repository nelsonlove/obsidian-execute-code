import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
// Everything imported here is Obsidian-free by construction — that is the point of the
// core/index split. If a future change pulls `obsidian` into one of these modules, this
// file stops loading, which is the signal we want.
import { matchesPredicate, propertyConditionHolds, normalizeTag } from "../src/tangle/predicate.ts";
import {
	resolveDestination, isWithin, isAllowedDestination, resolveOutsideRoots, extensionFor,
	isKnownLanguage, defaultDestination,
} from "../src/tangle/resolve.ts";
import {
	renderHeader, looksGenerated, stripGeneratedHeader, DEFAULT_MARKER, DEFAULT_HEADER_TEMPLATE,
} from "../src/tangle/header.ts";
import { planTangle, writeArtifact, parseNoteBlocks, parseOrgTangleArg, walkFiles } from "../src/tangle/core.ts";
import { migrateTangleSettings, DEFAULT_TANGLE_SETTINGS } from "../src/tangle/settings.ts";
import { extractDocstring, renderDocstring } from "../src/tangle/docstring.ts";

const CTX = { vaultBase: "/vault", noteFolder: "notes/lib", homeDir: "/home/me" };
const SETTINGS = {
	autoTangle: false,
	tangleDebounceMs: 2000,
	tangleWhen: { tags: ["tangle"], properties: [] },
	defaultDestination: "Scripts",
	allowedOutsideRoots: [],
	docstringHeading: "Docstring",
	headerTemplate: DEFAULT_HEADER_TEMPLATE,
	marker: DEFAULT_MARKER,
};

describe("eligibility predicate", () => {
	const facts = { tags: ["tangle", "note/lib"], frontmatter: { "acceptance-status": "accepted", n: 3 } };

	test("any listed tag qualifies; every property condition must hold", () => {
		assert.equal(matchesPredicate({ tags: ["tangle"], properties: [] }, facts), true);
		assert.equal(matchesPredicate({ tags: ["other", "tangle"], properties: [] }, facts), true);
		assert.equal(matchesPredicate({ tags: ["other"], properties: [] }, facts), false);
		assert.equal(
			matchesPredicate(
				{ tags: ["tangle"], properties: [{ key: "acceptance-status", op: "equals", value: "accepted" }] },
				facts,
			),
			true,
		);
		assert.equal(
			matchesPredicate(
				{ tags: ["tangle"], properties: [{ key: "acceptance-status", op: "equals", value: "proposed" }] },
				facts,
			),
			false,
		);
	});

	test("an EMPTY predicate tangles NOTHING (fails closed)", () => {
		// The dangerous reading of "no conditions" is "no constraints, so everything
		// matches", which would turn a misconfiguration into a vault-wide code-generation
		// event.
		assert.equal(matchesPredicate({ tags: [], properties: [] }, facts), false);
		assert.equal(matchesPredicate(undefined, facts), false);
		// Blank rows do not count as conditions.
		assert.equal(matchesPredicate({ tags: ["  ", "#"], properties: [] }, facts), false);
	});

	test("a section left empty imposes nothing when the other has content", () => {
		assert.equal(
			matchesPredicate({ tags: [], properties: [{ key: "acceptance-status", op: "exists" }] }, facts),
			true,
		);
		assert.equal(matchesPredicate({ tags: ["tangle"], properties: [] }, facts), true);
	});

	test("tags compare case- and hash-insensitively", () => {
		assert.equal(normalizeTag("#Tangle"), "tangle");
		assert.equal(matchesPredicate({ tags: ["#TANGLE"], properties: [] }, facts), true);
	});

	test("a property row without a key FAILS rather than vanishing", () => {
		// A half-built row must narrow what tangles, never widen it mid-edit.
		assert.equal(matchesPredicate({ tags: ["tangle"], properties: [{ key: "", op: "equals", value: "x" }] }, facts), false);
	});

	test("operators behave, absence included", () => {
		const f = { tags: [], frontmatter: { kind: ["lib", "util"], name: "Flow Control", ok: true, n: 3 } };
		assert.equal(propertyConditionHolds({ key: "name", op: "contains", value: "flow" }, f), true);
		assert.equal(propertyConditionHolds({ key: "name", op: "starts-with", value: "flow" }, f), true);
		assert.equal(propertyConditionHolds({ key: "name", op: "ends-with", value: "control" }, f), true);
		assert.equal(propertyConditionHolds({ key: "name", op: "not-contains", value: "zzz" }, f), true);
		assert.equal(propertyConditionHolds({ key: "kind", op: "equals", value: "util" }, f), true);
		assert.equal(propertyConditionHolds({ key: "kind", op: "contains", value: "ut" }, f), true);
		assert.equal(propertyConditionHolds({ key: "ok", op: "equals", value: "true" }, f), true);
		assert.equal(propertyConditionHolds({ key: "n", op: "equals", value: "3" }, f), true);
		assert.equal(propertyConditionHolds({ key: "n", op: "equals", value: "4" }, f), false);
		// Missing property: positive operators fail, negative ones hold, exists splits.
		assert.equal(propertyConditionHolds({ key: "nope", op: "equals", value: "x" }, f), false);
		assert.equal(propertyConditionHolds({ key: "nope", op: "contains", value: "x" }, f), false);
		assert.equal(propertyConditionHolds({ key: "nope", op: "not-equals", value: "x" }, f), true);
		assert.equal(propertyConditionHolds({ key: "nope", op: "exists" }, f), false);
		assert.equal(propertyConditionHolds({ key: "nope", op: "not-exists" }, f), true);
		// A BLANK comparison value fails the condition for EVERY value-using operator —
		// including the negated ones, where `!matchesNothing` would otherwise read as
		// matches-everything and silently un-gate eligibility mid-edit.
		assert.equal(propertyConditionHolds({ key: "name", op: "contains", value: "" }, f), false);
		assert.equal(propertyConditionHolds({ key: "name", op: "not-contains", value: "" }, f), false);
		assert.equal(propertyConditionHolds({ key: "name", op: "not-equals", value: "" }, f), false);
		assert.equal(propertyConditionHolds({ key: "name", op: "equals", value: "" }, f), false);
		assert.equal(propertyConditionHolds({ key: "name", op: "equals", value: "  " }, f), false);
		// The blank-equals hazards specifically: Number("") is 0, and "" equals "".
		const zeroed = { tags: [], frontmatter: { n: 0, s: "" } };
		assert.equal(propertyConditionHolds({ key: "n", op: "equals", value: "" }, zeroed), false);
		assert.equal(propertyConditionHolds({ key: "s", op: "equals", value: "" }, zeroed), false);
		assert.equal(propertyConditionHolds({ key: "missing", op: "not-contains", value: "" }, zeroed), false);
		// An operator from a newer config version fails closed.
		assert.equal(propertyConditionHolds({ key: "name", op: "regex", value: ".*" }, f), false);
	});
});

describe("destination resolution", () => {
	test("a BARE path is vault-relative", () => {
		assert.equal(resolveDestination("Scripts/flow.js", CTX), "/vault/Scripts/flow.js");
	});

	test("the legacy vault: prefix still means the same thing", () => {
		assert.equal(resolveDestination("vault:Scripts/flow.js", CTX), "/vault/Scripts/flow.js");
		assert.equal(resolveDestination("vault:/Scripts/flow.js", CTX), "/vault/Scripts/flow.js");
	});

	test("~ expands to home, absolute stays absolute", () => {
		assert.equal(resolveDestination("~/x/lib.js", CTX), "/home/me/x/lib.js");
		assert.equal(resolveDestination("/tmp/x/lib.js", CTX), "/tmp/x/lib.js");
	});

	test("./ and ../ are note-relative", () => {
		assert.equal(resolveDestination("./flow.js", CTX), "/vault/notes/lib/flow.js");
		assert.equal(resolveDestination("../flow.js", CTX), "/vault/notes/flow.js");
		// A name merely STARTING with a dot is a hidden file, not a relative prefix.
		assert.equal(resolveDestination(".hidden.js", CTX), "/vault/.hidden.js");
	});

	test("an empty destination is an error, not a write to the root", () => {
		assert.throws(() => resolveDestination("   ", CTX));
		assert.throws(() => resolveDestination("vault:", CTX));
	});

	test("the default destination may be note-relative", () => {
		assert.equal(defaultDestination("flow", "js", "./generated", CTX), "/vault/notes/lib/generated/flow.js");
		assert.equal(defaultDestination("flow", "js", "Scripts", CTX), "/vault/Scripts/flow.js");
		assert.throws(() => defaultDestination("flow", "js", "", CTX));
	});
});

describe("rail 2 — containment", () => {
	test("segment boundaries are respected", () => {
		assert.equal(isWithin("/roots/lib", "/roots/lib/a.js"), true);
		assert.equal(isWithin("/roots/lib", "/roots/lib-evil/a.js"), false);
	});

	test("inside the vault is always allowed; outside needs a grant", () => {
		assert.equal(isAllowedDestination("/vault/anywhere/x.js", CTX, []), true);
		assert.equal(isAllowedDestination("/home/me/x.js", CTX, []), false);
		assert.equal(isAllowedDestination("/home/me/x.js", CTX, ["/home/me"]), true);
		assert.equal(isAllowedDestination("/home/other/x.js", CTX, ["/home/me"]), false);
	});

	test("traversal is collapsed before comparison, not after", () => {
		// A vault-relative spelling that climbs OUT of the vault is an outside path.
		assert.equal(isAllowedDestination(path.resolve("/vault/../etc/passwd"), CTX, []), false);
		assert.equal(isAllowedDestination(path.resolve("/vault/sub/../ok.js"), CTX, []), true);
	});

	test("outside roots resolve ~ and drop vault-internal or malformed entries", () => {
		assert.deepEqual(resolveOutsideRoots(["~/repos", "Scripts", "", "  "], CTX), ["/home/me/repos"]);
		assert.deepEqual(resolveOutsideRoots(undefined, CTX), []);
	});

	test("a block naming an outside path is REFUSED, and the refusal is reported", () => {
		const plan = planTangle({
			content: '```js {tangle="/etc/cron.d/evil"}\nboom()\n```\n',
			noteBasename: "flow",
			ctx: CTX,
			settings: SETTINGS,
		});
		assert.equal(plan.artifacts.length, 0);
		assert.equal(plan.refused.length, 1);
		assert.match(plan.refused[0].reason, /outside the vault/);
	});

	test("a note-relative ../ that escapes the vault is refused too", () => {
		const plan = planTangle({
			content: '```js {tangle="../../../../outside.js"}\nno()\n```\n',
			noteBasename: "flow",
			ctx: CTX,
			settings: SETTINGS,
		});
		assert.equal(plan.artifacts.length, 0);
		assert.equal(plan.refused.length, 1);
	});

	test("an allowed outside folder permits exactly that folder", () => {
		const settings = { ...SETTINGS, allowedOutsideRoots: ["/opt/allowed"] };
		const plan = planTangle({
			content: '```js {tangle="/opt/allowed/x.js"}\nok()\n```\n' +
				'```js {tangle="/opt/allowed-not/x.js"}\nno()\n```\n',
			noteBasename: "flow",
			ctx: CTX,
			settings,
		});
		assert.deepEqual(plan.artifacts.map((a) => a.destination), ["/opt/allowed/x.js"]);
		assert.equal(plan.refused.length, 1);
	});
});

describe("planning", () => {
	test("with no explicit destination the default folder plus the note name is used", () => {
		const plan = planTangle({
			content: "```js\nconst a = 1;\n```\n",
			noteBasename: "flow",
			ctx: CTX,
			settings: SETTINGS,
		});
		assert.deepEqual(plan.artifacts.map((a) => a.destination), ["/vault/Scripts/flow.js"]);
	});

	test("a note-relative default destination lands beside the note", () => {
		const plan = planTangle({
			content: "```js\nconst a = 1;\n```\n",
			noteBasename: "flow",
			ctx: CTX,
			settings: { ...SETTINGS, defaultDestination: "./generated" },
		});
		assert.deepEqual(plan.artifacts.map((a) => a.destination), ["/vault/notes/lib/generated/flow.js"]);
	});

	test("with NO default destination, only explicit blocks tangle and the rest report", () => {
		const plan = planTangle({
			content: '```js\nimplicit();\n```\n```js {tangle="Scripts/x.js"}\nexplicit();\n```\n',
			noteBasename: "flow",
			ctx: CTX,
			settings: { ...SETTINGS, defaultDestination: "" },
		});
		assert.deepEqual(plan.artifacts.map((a) => a.destination), ["/vault/Scripts/x.js"]);
		assert.equal(plan.refused.length, 1);
		assert.match(plan.refused[0].reason, /no default tangle destination/);
	});

	test("a bare explicit destination is vault-relative", () => {
		const plan = planTangle({
			content: '```js {tangle="lib/flow.js"}\nok()\n```\n',
			noteBasename: "flow",
			ctx: CTX,
			settings: SETTINGS,
		});
		assert.deepEqual(plan.artifacts.map((a) => a.destination), ["/vault/lib/flow.js"]);
	});

	test("blocks sharing a destination concatenate in note order", () => {
		const plan = planTangle({
			content: "```js\nfirst();\n```\n\ntext\n\n```js\nsecond();\n```\n",
			noteBasename: "flow",
			ctx: CTX,
			settings: SETTINGS,
		});
		assert.equal(plan.artifacts.length, 1);
		assert.match(plan.artifacts[0].chunks.join(""), /first\(\);[\s\S]*second\(\);/);
	});

	test('{tangle="no"} excludes a block', () => {
		const plan = planTangle({
			content: '```js {tangle="no"}\nscratch();\n```\n```js\nkeep();\n```\n',
			noteBasename: "flow",
			ctx: CTX,
			settings: SETTINGS,
		});
		assert.equal(plan.artifacts.length, 1);
		assert.match(plan.artifacts[0].chunks.join(""), /keep\(\)/);
		assert.doesNotMatch(plan.artifacts[0].chunks.join(""), /scratch\(\)/);
	});

	test("an unknown language is skipped on the default path (no .txt artifacts)", () => {
		assert.equal(isKnownLanguage("js"), true);
		assert.equal(isKnownLanguage("mermaid"), false);
		const plan = planTangle({
			content: "```mermaid\ngraph TD;\n```\n",
			noteBasename: "flow",
			ctx: CTX,
			settings: SETTINGS,
		});
		assert.equal(plan.artifacts.length, 0);
		assert.equal(plan.refused.length, 0);
	});

	test("different languages in one note get different files", () => {
		const plan = planTangle({
			content: "```js\na();\n```\n```python\nb()\n```\n",
			noteBasename: "flow",
			ctx: CTX,
			settings: SETTINGS,
		});
		assert.deepEqual(
			plan.artifacts.map((a) => a.destination).sort(),
			["/vault/Scripts/flow.js", "/vault/Scripts/flow.py"],
		);
	});

	test("a labelled non-tangling block is still available to noweb", () => {
		const plan = planTangle({
			content:
				'```js {tangle="no", label="helpers"}\nfunction h(){}\n```\n' +
				"```js\n<<helpers>>\nh();\n```\n",
			noteBasename: "flow",
			ctx: CTX,
			settings: SETTINGS,
		});
		assert.equal(plan.missingRefs.length, 0);
		assert.match(plan.artifacts[0].chunks.join(""), /function h\(\)\{\}/);
	});

	test("parseNoteBlocks still reads plain fences", () => {
		assert.equal(parseNoteBlocks("```js\nx\n```\n").length, 1);
	});
});

describe("org-babel :tangle syntax", () => {
	test("the fence-line form parses", () => {
		assert.equal(parseOrgTangleArg("js :tangle ./generated"), "./generated");
		assert.equal(parseOrgTangleArg('js :tangle "Script notes/lib.js"'), "Script notes/lib.js");
		assert.equal(parseOrgTangleArg("js :tangle no"), "no");
		// org's "yes" means "to the default file", which is this plugin's default anyway.
		assert.equal(parseOrgTangleArg("js :tangle yes"), undefined);
		assert.equal(parseOrgTangleArg("js"), undefined);
		assert.equal(parseOrgTangleArg("js :tangle"), undefined);
		// Not fooled by a colon-word inside other text.
		assert.equal(parseOrgTangleArg("js something:tangle x"), undefined);
	});

	test(":tangle drives the plan like {tangle=} does", () => {
		const plan = planTangle({
			content: "```js :tangle ./out/lib.js\nok()\n```\n```js :tangle no\nscratch()\n```\n",
			noteBasename: "flow",
			ctx: CTX,
			settings: SETTINGS,
		});
		assert.deepEqual(plan.artifacts.map((a) => a.destination), ["/vault/notes/lib/out/lib.js"]);
		assert.doesNotMatch(plan.artifacts[0].chunks.join(""), /scratch/);
	});

	test("the JSON5 form wins when both are present", () => {
		const plan = planTangle({
			content: '```js :tangle ./org.js {tangle="json5.js"}\nok()\n```\n',
			noteBasename: "flow",
			ctx: CTX,
			settings: SETTINGS,
		});
		assert.deepEqual(plan.artifacts.map((a) => a.destination), ["/vault/json5.js"]);
	});
});

describe("settings migration", () => {
	test("the legacy shape converts, vault: root becomes the default destination", () => {
		const migrated = migrateTangleSettings({
			autoTangle: true,
			tangleDebounceMs: 1500,
			tangleWhen: [
				{ property: "tangle", equals: true },
				{ property: "acceptance-status", equals: "accepted" },
				{ tag: "tangle" },
				{ property: "draft", exists: false },
				{ property: "uid" },
			],
			tangleRoot: "vault:Scripts/generated",
			additionalRoots: ["vault:Other", "~/repos/x"],
			headerTemplate: "H",
			marker: "M",
		});
		assert.equal(migrated.autoTangle, true);
		assert.equal(migrated.tangleDebounceMs, 1500);
		assert.equal(migrated.defaultDestination, "Scripts/generated");
		// Vault-internal legacy roots need no grant anymore; outside ones ride along.
		assert.deepEqual(migrated.allowedOutsideRoots, ["~/repos/x"]);
		assert.deepEqual(migrated.tangleWhen.tags, ["tangle"]);
		assert.deepEqual(migrated.tangleWhen.properties, [
			{ key: "tangle", op: "equals", value: "true" },
			{ key: "acceptance-status", op: "equals", value: "accepted" },
			{ key: "draft", op: "not-exists" },
			{ key: "uid", op: "exists" },
		]);
		assert.equal(migrated.headerTemplate, "H");
		assert.equal(migrated.marker, "M");
	});

	test("a migrated equals-boolean still matches the note that matched before", () => {
		const migrated = migrateTangleSettings({ tangleWhen: [{ property: "tangle", equals: true }] });
		assert.equal(
			matchesPredicate(migrated.tangleWhen, { tags: [], frontmatter: { tangle: true } }),
			true,
		);
		assert.equal(
			matchesPredicate(migrated.tangleWhen, { tags: [], frontmatter: { tangle: false } }),
			false,
		);
	});

	test("an outside legacy root lands in both the default and the outside list", () => {
		const migrated = migrateTangleSettings({ tangleRoot: "~/scripts" });
		assert.equal(migrated.defaultDestination, "~/scripts");
		assert.deepEqual(migrated.allowedOutsideRoots, ["~/scripts"]);
	});

	test("an empty legacy root becomes an empty default destination, not the shipped one", () => {
		// The legacy empty root meant "tangling disabled"; silently substituting the
		// shipped './generated' would ENABLE writes the old config refused.
		assert.equal(migrateTangleSettings({ tangleRoot: "" }).defaultDestination, "");
	});

	test("nothing saved yields the shipped defaults; current shape passes through", () => {
		assert.deepEqual(migrateTangleSettings(undefined), DEFAULT_TANGLE_SETTINGS);
		const current = {
			...DEFAULT_TANGLE_SETTINGS,
			defaultDestination: "Elsewhere",
			tangleWhen: { tags: ["t"], properties: [{ key: "k", op: "equals", value: "v" }] },
			allowedOutsideRoots: ["~/x"],
		};
		assert.deepEqual(migrateTangleSettings(current), current);
	});
});

describe("docstring", () => {
	const NOTE = [
		"# Title",
		"intro text",
		"## Docstring",
		"",
		"Handles the flow.",
		"",
		"Never touches records.",
		"### Detail",
		"still part of the docstring section",
		"## Next section",
		"not docstring",
		"```js",
		"code();",
		"```",
	].join("\n");

	test("extracts the section under the configured heading, up to a same-or-higher heading", () => {
		const doc = extractDocstring(NOTE, "Docstring");
		assert.match(doc, /Handles the flow\./);
		assert.match(doc, /still part of the docstring section/);
		// A DEEPER heading is structure the author wrote — kept verbatim, not dropped.
		assert.match(doc, /### Detail/);
		assert.doesNotMatch(doc, /not docstring/);
		assert.doesNotMatch(doc, /intro text/);
	});

	test("fences inside the docstring section are examples: not tangled unless explicitly targeted", () => {
		const note = [
			"## Docstring",
			"Usage:",
			"```js",
			"example();",
			"```",
			'```js {tangle="Scripts/wanted.js"}',
			"deliberate();",
			"```",
			"## Code",
			"```js",
			"real();",
			"```",
		].join("\n");
		const plan = planTangle({ content: note, noteBasename: "flow", ctx: CTX, settings: SETTINGS });
		const all = plan.artifacts.flatMap((a) => a.chunks).join("");
		assert.doesNotMatch(all, /example\(\)/); // untagged example stays prose
		assert.match(all, /deliberate\(\)/); // explicit destination overrides
		assert.match(all, /real\(\)/); // outside the section, business as usual
		// With the docstring feature off, the example fence tangles like any block.
		const off = planTangle({
			content: note, noteBasename: "flow", ctx: CTX,
			settings: { ...SETTINGS, docstringHeading: "" },
		});
		assert.match(off.artifacts.flatMap((a) => a.chunks).join(""), /example\(\)/);
	});

	test("heading match is case-insensitive; absence and blank sections yield undefined", () => {
		assert.equal(extractDocstring(NOTE, "DOCSTRING"), extractDocstring(NOTE, "Docstring"));
		assert.equal(extractDocstring(NOTE, "Nope"), undefined);
		assert.equal(extractDocstring("## Docstring\n\n\n## Next\nx", "Docstring"), undefined);
		assert.equal(extractDocstring(NOTE, ""), undefined);
	});

	test("a # line inside a code fence is neither a match nor a terminator", () => {
		const note = "```sh\n# Docstring\n```\n## Docstring\nreal doc\n```sh\n# not a heading\n```\nmore doc\n## End\n";
		const doc = extractDocstring(note, "Docstring");
		assert.match(doc, /real doc/);
		assert.match(doc, /more doc/);
		assert.match(doc, /# not a heading/);
	});

	test("renders one comment token per line, bare token on blanks", () => {
		assert.equal(renderDocstring("a\n\nb", "//"), "// a\n//\n// b\n");
		assert.equal(renderDocstring("x", "#"), "# x\n");
	});

	test("a docstring edit re-tangles: it lives in the compared body, not the header", () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tangle-doc-"));
		const dest = path.join(tmp, "doc.js");
		const header = renderHeader(DEFAULT_HEADER_TEMPLATE, { note: "n.md", date: "2026-01-01", comment: "//" });
		const body = (doc) => renderDocstring(doc, "//") + "\n" + "code();\n";
		assert.equal(writeArtifact(dest, header, body("v1 of the doc"), DEFAULT_MARKER).status, "written");
		assert.equal(writeArtifact(dest, header, body("v1 of the doc"), DEFAULT_MARKER).status, "unchanged");
		assert.equal(writeArtifact(dest, header, body("v2 of the doc"), DEFAULT_MARKER).status, "written");
		assert.match(fs.readFileSync(dest, "utf8"), /\/\/ v2 of the doc/);
	});
});

describe("header and rail 1", () => {
	test("placeholders render, and the comment token follows the language", () => {
		const out = renderHeader(DEFAULT_HEADER_TEMPLATE, {
			note: "a/b.md", uid: "u1", date: "2026-01-01", comment: "#",
		});
		assert.match(out, /^# /);
		assert.match(out, /a\/b\.md/);
		assert.ok(out.endsWith("\n"));
	});

	test("an unknown placeholder is left alone; a missing value renders empty", () => {
		assert.equal(renderHeader("x {{nope}} {{uid}}", { note: "n", date: "d", comment: "//" }), "x {{nope}} \n");
	});

	test("an empty marker does not make every file look generated", () => {
		assert.equal(looksGenerated("anything", ""), false);
		assert.equal(looksGenerated("anything", "   "), false);
	});

	test("the marker is only honored near the top of the file", () => {
		assert.equal(looksGenerated(DEFAULT_MARKER + "\ncode", DEFAULT_MARKER), true);
		assert.equal(looksGenerated("x".repeat(5000) + DEFAULT_MARKER, DEFAULT_MARKER), false);
	});
});

describe("rails 1 and 4 — writing", () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tangle-test-"));
	const header = renderHeader(DEFAULT_HEADER_TEMPLATE, {
		note: "n.md", date: "2026-01-01", comment: "//",
	});

	test("writes a new file", () => {
		const dest = path.join(tmp, "new.js");
		const out = writeArtifact(dest, header, "body\n", DEFAULT_MARKER);
		assert.equal(out.status, "written");
		assert.match(fs.readFileSync(dest, "utf8"), /body/);
	});

	test("REFUSES to overwrite a file it did not generate", () => {
		const dest = path.join(tmp, "handwritten.js");
		fs.writeFileSync(dest, "// a human wrote this\nimportant();\n");
		const out = writeArtifact(dest, header, "clobber\n", DEFAULT_MARKER);
		assert.equal(out.status, "refused-foreign");
		assert.match(fs.readFileSync(dest, "utf8"), /important\(\)/);
	});

	test("overwrites its own output, and reports an identical write as unchanged", () => {
		const dest = path.join(tmp, "mine.js");
		assert.equal(writeArtifact(dest, header, "v1\n", DEFAULT_MARKER).status, "written");
		assert.equal(writeArtifact(dest, header, "v2\n", DEFAULT_MARKER).status, "written");
		assert.match(fs.readFileSync(dest, "utf8"), /v2/);
		assert.equal(writeArtifact(dest, header, "v2\n", DEFAULT_MARKER).status, "unchanged");
	});

	test("leaves no temp file behind", () => {
		const dest = path.join(tmp, "sub", "deep.js");
		writeArtifact(dest, header, "x\n", DEFAULT_MARKER);
		const leftovers = fs.readdirSync(path.dirname(dest)).filter((f) => f.includes("tangle-tmp"));
		assert.deepEqual(leftovers, []);
	});

	test("a CHANGED header alone does not rewrite the file", () => {
		// The default header carries a timestamp. If "unchanged" compared whole files, every
		// sweep would rewrite every artifact — churning mtimes, waking watchers, and
		// invalidating any freshness check that compares generated mtime against source.
		const dest = path.join(tmp, "stamped.js");
		const h1 = renderHeader(DEFAULT_HEADER_TEMPLATE, { note: "n.md", date: "2026-01-01", comment: "//" });
		const h2 = renderHeader(DEFAULT_HEADER_TEMPLATE, { note: "n.md", date: "2099-12-31", comment: "//" });
		assert.notEqual(h1, h2);
		assert.equal(writeArtifact(dest, h1, "same();\n", DEFAULT_MARKER).status, "written");
		const firstBytes = fs.readFileSync(dest, "utf8");
		assert.equal(writeArtifact(dest, h2, "same();\n", DEFAULT_MARKER).status, "unchanged");
		assert.equal(fs.readFileSync(dest, "utf8"), firstBytes, "file must not be touched");
		// A real body change still lands, and carries the new header.
		assert.equal(writeArtifact(dest, h2, "different();\n", DEFAULT_MARKER).status, "written");
		assert.match(fs.readFileSync(dest, "utf8"), /2099-12-31/);
	});

	test("stripGeneratedHeader recovers the body, and refuses on a foreign file", () => {
		const h = renderHeader(DEFAULT_HEADER_TEMPLATE, { note: "n.md", date: "d", comment: "//" });
		assert.equal(stripGeneratedHeader(h + "\n" + "body();\n", DEFAULT_MARKER), "body();\n");
		assert.equal(stripGeneratedHeader("// human wrote this\n\nbody();\n", DEFAULT_MARKER), null);
	});

	test("an unwritable destination reports an error rather than throwing", () => {
		const out = writeArtifact(path.join(tmp, "new.js", "impossible.js"), header, "x", DEFAULT_MARKER);
		assert.equal(out.status, "error");
	});
});

describe("the orphan sweep's walk", () => {
	test("dot directories are skipped — .obsidian must never be swept", () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tangle-walk-"));
		fs.mkdirSync(path.join(tmp, ".obsidian", "plugins"), { recursive: true });
		fs.writeFileSync(path.join(tmp, ".obsidian", "plugins", "main.js"), DEFAULT_MARKER);
		fs.mkdirSync(path.join(tmp, "Scripts"));
		fs.writeFileSync(path.join(tmp, "Scripts", "real.js"), "x");
		const seen = [...walkFiles(tmp)].map((f) => path.relative(tmp, f));
		assert.deepEqual(seen, [path.join("Scripts", "real.js")]);
	});

	test("extensions map as expected", () => {
		assert.equal(extensionFor("javascript"), "js");
		assert.equal(extensionFor("obsidianjs"), "js");
		assert.equal(extensionFor("python"), "py");
	});
});
