import * as os from "os";
import * as path from "path";

/**
 * Where a tangled artifact goes, and — the load-bearing half — whether we are
 * allowed to write there at all.
 *
 * Pure: every input arrives as a string. No `obsidian` import, no fs access, so the
 * containment rule can be tested exhaustively without a vault.
 */

export interface ResolveContext {
	/** Absolute path of the vault root on disk. */
	vaultBase: string;
	/** Vault-relative folder of the note being tangled (`""` for a note at the root). */
	noteFolder: string;
	/** Home directory, injected so `~` expansion is testable. */
	homeDir?: string;
}

/**
 * Expand one destination string to an absolute filesystem path.
 *
 * Four forms, and the disambiguation matters:
 *
 *   vault:00-09 System/x/lib.js   → vault root + path      (survives the note moving)
 *   ~/x/lib.js                    → home-relative
 *   /Users/me/x/lib.js            → filesystem-absolute
 *   lib/flow.js                   → relative to the NOTE'S FOLDER (pre-existing behavior)
 *
 * The spec sketched vault-absolute as a bare leading `/` (`/00-09 System/…`). That is
 * ambiguous with a real absolute path — both start with `/`, and guessing between them
 * by probing the filesystem would make the meaning of a path depend on what happens to
 * exist. An explicit `vault:` scheme is unambiguous, greppable, and self-documenting,
 * and it leaves today's absolute-path behavior byte-identical.
 */
export function resolveDestination(target: string, ctx: ResolveContext): string {
	const raw = target.trim();
	if (!raw) throw new Error("empty tangle destination");

	const vaultScheme = /^vault:(.*)$/i.exec(raw);
	if (vaultScheme) {
		const rel = vaultScheme[1].replace(/^[\\/]+/, "");
		if (!rel) throw new Error(`tangle destination '${target}' names the vault root, not a file`);
		return path.resolve(ctx.vaultBase, rel);
	}

	if (raw === "~" || raw.startsWith("~/") || raw.startsWith("~\\"))
		return path.resolve(ctx.homeDir ?? os.homedir(), raw.slice(1).replace(/^[\\/]+/, ""));

	if (path.isAbsolute(raw)) return path.resolve(raw);

	return path.resolve(ctx.vaultBase, ctx.noteFolder ?? "", raw);
}

/**
 * Is `child` inside `parent`?
 *
 * Segment-boundary comparison, so `/roots/lib-evil` is NOT inside `/roots/lib`. Both
 * sides are resolved first, which collapses any `..` before the comparison rather than
 * after it. Equality counts as inside (a root named directly is within itself), though
 * a destination equal to a root is rejected elsewhere as "not a file".
 */
export function isWithin(parent: string, child: string): boolean {
	const p = path.resolve(parent);
	const c = path.resolve(child);
	if (p === c) return true;
	const rel = path.relative(p, c);
	return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * RAIL 2 — refuse to write outside the declared roots.
 *
 * Without this a note is an arbitrary file-write primitive: any `{tangle="…"}` string
 * in any eligible note would be honored, and eligible notes are agent-writable. This is
 * the rail that holds regardless of how permissive the eligibility predicate is, so it
 * must never be made conditional on the predicate.
 *
 * An EMPTY root list denies everything. Same reasoning as the empty predicate: the
 * reading that would be convenient ("unrestricted") turns a misconfiguration into an
 * unrestricted file-write primitive.
 */
export function isAllowedDestination(destination: string, roots: string[]): boolean {
	if (!roots || roots.length === 0) return false;
	return roots.some((r) => r && r.trim() && isWithin(r, destination));
}

/** Language → the file extension a tangled artifact of that language gets. */
const EXTENSIONS: Record<string, string> = {
	js: "js", javascript: "js", obsidianjs: "js",
	ts: "ts", typescript: "ts",
	python: "py", py: "py",
	shell: "sh", bash: "sh", batch: "bat", powershell: "ps1",
	lua: "lua", r: "r", ruby: "rb", php: "php", go: "go", rust: "rs",
	java: "java", kotlin: "kt", scala: "scala", swift: "swift", dart: "dart",
	c: "c", cpp: "cpp", cs: "cs", fsharp: "fs", groovy: "groovy",
	haskell: "hs", hs: "hs", lisp: "lisp", ocaml: "ml", prolog: "pl",
	racket: "rkt", sql: "sql", zig: "zig", octave: "m", maxima: "mac",
	mathematica: "nb", nb: "nb", wolfram: "wl", wl: "wl",
	applescript: "applescript", latex: "tex", tex: "tex", lean: "lean",
};

export function extensionFor(language: string): string {
	return EXTENSIONS[language?.trim().toLowerCase()] ?? "txt";
}

/**
 * Do we know what to CALL a file of this language?
 *
 * Gates the central-root path only. A block with an explicit `{tangle="…"}` names its
 * own filename and needs no mapping; a block relying on the central root does, and
 * falling back to `.txt` would silently produce artifacts nobody asked for.
 */
export function isKnownLanguage(language: string): boolean {
	return Object.prototype.hasOwnProperty.call(EXTENSIONS, language?.trim().toLowerCase() ?? "");
}

/** Language → its line-comment token, for the generated-by header. */
const LINE_COMMENT: Record<string, string> = {
	python: "#", py: "#", shell: "#", bash: "#", r: "#", ruby: "#", php: "#",
	perl: "#", zig: "//", powershell: "#", maxima: "/*", octave: "%",
	batch: "REM", lisp: ";;", racket: ";;", prolog: "%", haskell: "--", hs: "--",
	sql: "--", lua: "--", applescript: "--", latex: "%", tex: "%",
	mathematica: "(*", nb: "(*", wolfram: "(*", wl: "(*", ocaml: "(*",
};

export function commentTokenFor(language: string): string {
	return LINE_COMMENT[language?.trim().toLowerCase()] ?? "//";
}

/**
 * The default destination when a note names none: the central root plus the note's own
 * basename with the language's extension (`flow.md` carrying js blocks → `flow.js`).
 * A folder move then becomes ONE setting edit rather than N note edits, which is the
 * fragility this whole feature exists to remove.
 */
export function defaultDestination(noteBasename: string, language: string, tangleRoot: string, ctx: ResolveContext): string {
	const root = resolveDestination(tangleRoot, { ...ctx, noteFolder: "" });
	return path.join(root, `${noteBasename}.${extensionFor(language)}`);
}
