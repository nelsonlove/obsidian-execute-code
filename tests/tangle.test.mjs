import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
// Everything imported here is Obsidian-free by construction — that is the point of the
// core/index split. If a future change pulls `obsidian` into one of these modules, this
// file stops loading, which is the signal we want.
import { matchesConditions, normalizeTag } from "../src/tangle/predicate.ts";
import {
	resolveDestination, isWithin, isAllowedDestination, extensionFor, isKnownLanguage,
	resolveTangleRoot,
} from "../src/tangle/resolve.ts";
import {
	renderHeader, looksGenerated, DEFAULT_MARKER, DEFAULT_HEADER_TEMPLATE,
} from "../src/tangle/header.ts";
import { planTangle, writeArtifact, parseNoteBlocks } from "../src/tangle/core.ts";
import { textToConditions, conditionsToText } from "../src/tangle/conditionText.ts";

const CTX = { vaultBase: "/vault", noteFolder: "notes/lib", homeDir: "/home/me" };
const SETTINGS = {
	autoTangle: false,
	tangleDebounceMs: 2000,
	tangleWhen: [{ tag: "tangle" }],
	tangleRoot: "vault:Scripts",
	additionalRoots: [],
	headerTemplate: DEFAULT_HEADER_TEMPLATE,
	marker: DEFAULT_MARKER,
};

describe("eligibility predicate", () => {
	const facts = { tags: ["tangle", "note/lib"], frontmatter: { "acceptance-status": "accepted", n: 3 } };

	test("all conditions must hold", () => {
		assert.equal(matchesConditions([{ tag: "tangle" }], facts), true);
		assert.equal(
			matchesConditions([{ tag: "tangle" }, { property: "acceptance-status", equals: "accepted" }], facts),
			true,
		);
		assert.equal(
			matchesConditions([{ tag: "tangle" }, { property: "acceptance-status", equals: "proposed" }], facts),
			false,
		);
	});

	test("an EMPTY condition list tangles NOTHING (fails closed)", () => {
		// The dangerous reading of an empty AND is "no constraints, so everything matches",
		// which would turn a misconfiguration into a vault-wide code-generation event.
		assert.equal(matchesConditions([], facts), false);
		assert.equal(matchesConditions(undefined, facts), false);
	});

	test("tags compare case- and hash-insensitively", () => {
		assert.equal(normalizeTag("#Tangle"), "tangle");
		assert.equal(matchesConditions([{ tag: "#TANGLE" }], facts), true);
	});

	test("an empty tag condition matches nothing rather than everything", () => {
		assert.equal(matchesConditions([{ tag: "  " }], facts), false);
	});

	test("a missing property never satisfies equals or a bare presence test", () => {
		assert.equal(matchesConditions([{ property: "nope", equals: "x" }], facts), false);
		assert.equal(matchesConditions([{ property: "nope" }], facts), false);
		assert.equal(matchesConditions([{ property: "nope", exists: false }], facts), true);
	});

	test("a single value matches a one-element list and vice versa", () => {
		const listy = { tags: [], frontmatter: { kind: ["lib", "util"] } };
		assert.equal(matchesConditions([{ property: "kind", equals: "util" }], listy), true);
		assert.equal(matchesConditions([{ property: "kind", equals: "other" }], listy), false);
	});
});

describe("destination resolution", () => {
	test("vault: is vault-root relative", () => {
		assert.equal(resolveDestination("vault:Scripts/flow.js", CTX), "/vault/Scripts/flow.js");
		assert.equal(resolveDestination("vault:/Scripts/flow.js", CTX), "/vault/Scripts/flow.js");
	});

	test("~ expands to home, absolute stays absolute", () => {
		assert.equal(resolveDestination("~/x/lib.js", CTX), "/home/me/x/lib.js");
		assert.equal(resolveDestination("/tmp/x/lib.js", CTX), "/tmp/x/lib.js");
	});

	test("a BARE relative path lands inside the tangle root", () => {
		const ctx = { ...CTX, tangleRootAbs: "/vault/Scripts" };
		assert.equal(resolveDestination("out/flow.js", ctx), "/vault/Scripts/out/flow.js");
	});

	test("./ and ../ are the explicit note-relative escape", () => {
		const ctx = { ...CTX, tangleRootAbs: "/vault/Scripts" };
		assert.equal(resolveDestination("./flow.js", ctx), "/vault/notes/lib/flow.js");
		assert.equal(resolveDestination("../flow.js", ctx), "/vault/notes/flow.js");
		// A name merely STARTING with a dot is a hidden file, not a relative prefix.
		assert.equal(resolveDestination(".hidden.js", ctx), "/vault/Scripts/.hidden.js");
	});

	test("with no tangle root yet, a bare path is vault-relative (the root setting itself)", () => {
		assert.equal(resolveDestination("Scripts/flow.js", CTX), "/vault/Scripts/flow.js");
		assert.equal(resolveTangleRoot("Scripts", CTX), "/vault/Scripts");
		assert.equal(resolveTangleRoot("vault:Scripts", CTX), "/vault/Scripts");
		assert.equal(resolveTangleRoot("", CTX), undefined);
	});

	test("a root is never resolved relative to itself", () => {
		// If `tangleRootAbs` leaked into root resolution, this would compound to
		// /vault/Scripts/Scripts on every pass.
		assert.equal(resolveTangleRoot("Scripts", { ...CTX, tangleRootAbs: "/vault/Scripts" }), "/vault/Scripts");
	});

	test("an empty destination is an error, not a write to the root", () => {
		assert.throws(() => resolveDestination("   ", CTX));
		assert.throws(() => resolveDestination("vault:", CTX));
	});
});

describe("rail 2 — containment", () => {
	test("segment boundaries are respected", () => {
		assert.equal(isWithin("/roots/lib", "/roots/lib/a.js"), true);
		assert.equal(isWithin("/roots/lib", "/roots/lib-evil/a.js"), false);
	});

	test("traversal is collapsed before comparison, not after", () => {
		assert.equal(isAllowedDestination("/roots/lib/../../etc/passwd", ["/roots/lib"]), false);
		assert.equal(isAllowedDestination("/roots/lib/sub/../ok.js", ["/roots/lib"]), true);
	});

	test("an EMPTY root list denies everything", () => {
		assert.equal(isAllowedDestination("/anywhere/x.js", []), false);
		assert.equal(isAllowedDestination("/anywhere/x.js", undefined), false);
		assert.equal(isAllowedDestination("/anywhere/x.js", ["", "   "]), false);
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
		assert.match(plan.refused[0].reason, /outside every declared tangle root/);
	});

	test("a bare override cannot escape the tangle root", () => {
		// This is the practical win of the bare-is-root-relative rule: the common override
		// form is structurally incapable of naming somewhere outside the root.
		const plan = planTangle({
			content: '```js {tangle="sub/lib.js"}\nok()\n```\n',
			noteBasename: "flow",
			ctx: CTX,
			settings: SETTINGS,
		});
		assert.deepEqual(plan.artifacts.map((a) => a.destination), ["/vault/Scripts/sub/lib.js"]);
		assert.equal(plan.refused.length, 0);
	});

	test("an explicit ./ override outside the roots is still refused", () => {
		const plan = planTangle({
			content: '```js {tangle="./beside.js"}\nno()\n```\n',
			noteBasename: "flow",
			ctx: CTX,
			settings: SETTINGS,
		});
		assert.equal(plan.artifacts.length, 0);
		assert.equal(plan.refused.length, 1);
	});

	test("an additional root permits exactly that root", () => {
		const settings = { ...SETTINGS, additionalRoots: ["/opt/allowed"] };
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
	test("with no explicit destination the central root plus the note name is used", () => {
		const plan = planTangle({
			content: "```js\nconst a = 1;\n```\n",
			noteBasename: "flow",
			ctx: CTX,
			settings: SETTINGS,
		});
		assert.deepEqual(plan.artifacts.map((a) => a.destination), ["/vault/Scripts/flow.js"]);
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

	test("an unknown language is skipped on the central-root path (no .txt artifacts)", () => {
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
		const out = writeArtifact(dest, header + "body\n", DEFAULT_MARKER);
		assert.equal(out.status, "written");
		assert.match(fs.readFileSync(dest, "utf8"), /body/);
	});

	test("REFUSES to overwrite a file it did not generate", () => {
		const dest = path.join(tmp, "handwritten.js");
		fs.writeFileSync(dest, "// a human wrote this\nimportant();\n");
		const out = writeArtifact(dest, header + "clobber\n", DEFAULT_MARKER);
		assert.equal(out.status, "refused-foreign");
		assert.match(fs.readFileSync(dest, "utf8"), /important\(\)/);
	});

	test("overwrites its own output, and reports an identical write as unchanged", () => {
		const dest = path.join(tmp, "mine.js");
		assert.equal(writeArtifact(dest, header + "v1\n", DEFAULT_MARKER).status, "written");
		assert.equal(writeArtifact(dest, header + "v2\n", DEFAULT_MARKER).status, "written");
		assert.match(fs.readFileSync(dest, "utf8"), /v2/);
		assert.equal(writeArtifact(dest, header + "v2\n", DEFAULT_MARKER).status, "unchanged");
	});

	test("leaves no temp file behind", () => {
		const dest = path.join(tmp, "sub", "deep.js");
		writeArtifact(dest, header + "x\n", DEFAULT_MARKER);
		const leftovers = fs.readdirSync(path.dirname(dest)).filter((f) => f.includes("tangle-tmp"));
		assert.deepEqual(leftovers, []);
	});

	test("an unwritable destination reports an error rather than throwing", () => {
		const out = writeArtifact(path.join(tmp, "new.js", "impossible.js"), "x", DEFAULT_MARKER);
		assert.equal(out.status, "error");
	});
});

describe("settings text round-trip", () => {
	test("conditions survive a round trip", () => {
		const text = "tag: tangle\nproperty: acceptance-status = accepted\nproperty: uid\nproperty: draft absent";
		const parsed = textToConditions(text);
		assert.deepEqual(parsed, [
			{ tag: "tangle" },
			{ property: "acceptance-status", equals: "accepted" },
			{ property: "uid", exists: true },
			{ property: "draft", exists: false },
		]);
		assert.deepEqual(textToConditions(conditionsToText(parsed)), parsed);
	});

	test("an unparseable line is dropped, never guessed into a weaker predicate", () => {
		// Dropping NARROWS what tangles; inventing a condition from a typo could widen it.
		assert.deepEqual(textToConditions("tag: tangle\nnonsense here"), [{ tag: "tangle" }]);
	});

	test("booleans and numbers are coerced, quotes stripped", () => {
		assert.deepEqual(textToConditions("property: a = true"), [{ property: "a", equals: true }]);
		assert.deepEqual(textToConditions("property: a = 3"), [{ property: "a", equals: 3 }]);
		assert.deepEqual(textToConditions('property: a = "3"'), [{ property: "a", equals: 3 }]);
		assert.deepEqual(textToConditions("property: a = accepted"), [{ property: "a", equals: "accepted" }]);
	});

	test("extensions map as expected", () => {
		assert.equal(extensionFor("javascript"), "js");
		assert.equal(extensionFor("obsidianjs"), "js");
		assert.equal(extensionFor("python"), "py");
	});
});
