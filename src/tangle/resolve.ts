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
 * Four forms, each unambiguous on its face:
 *
 *   Scripts/lib.js       → vault root + path       (survives the note moving)
 *   ./lib/flow.js        → relative to the NOTE'S folder
 *   ~/x/lib.js           → home-relative           (outside the vault — gated)
 *   /Users/me/x/lib.js   → filesystem-absolute     (outside the vault — gated)
 *
 * A BARE path is vault-relative. That makes the common case structurally unable to
 * leave the vault, and it is why a bare leading `/` can safely mean a real absolute
 * path — the two are no longer competing for the same spelling. The legacy `vault:`
 * prefix is still accepted as an alias for the bare form, so old block args keep
 * meaning what they meant.
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

	// Explicitly note-relative. A name merely STARTING with a dot (`.hidden.js`) is a
	// hidden file, not a relative prefix.
	if (/^\.\.?([\\/]|$)/.test(raw)) return path.resolve(ctx.vaultBase, ctx.noteFolder ?? "", raw);

	// Bare relative: inside the vault.
	return path.resolve(ctx.vaultBase, raw);
}

/**
 * Is `child` inside `parent`?
 *
 * Segment-boundary comparison, so `/roots/lib-evil` is NOT inside `/roots/lib`. Both
 * sides are resolved first, which collapses any `..` before the comparison rather than
 * after it. Equality counts as inside (a root named directly is within itself); a
 * destination that turns out to be a folder fails loudly at write time, not here.
 */
export function isWithin(parent: string, child: string): boolean {
	const p = path.resolve(parent);
	const c = path.resolve(child);
	if (p === c) return true;
	const rel = path.relative(p, c);
	return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Expand the configured outside-the-vault folders to absolute paths.
 *
 * Entries are `~/…` or absolute. A relative entry would be inside the vault — where
 * writes are already permitted — so it grants nothing and is dropped rather than
 * guessed at.
 */
export function resolveOutsideRoots(allowedOutsideRoots: string[] | undefined, ctx: ResolveContext): string[] {
	const out: string[] = [];
	for (const r of allowedOutsideRoots ?? []) {
		if (!r || !r.trim()) continue;
		try {
			const abs = resolveDestination(r, { ...ctx, noteFolder: "" });
			if (!isWithin(ctx.vaultBase, abs)) out.push(abs);
		} catch {
			/* a malformed entry simply grants nothing */
		}
	}
	return out;
}

/**
 * RAIL 2 — the vault is the sandbox; leaving it takes an explicit grant.
 *
 * A destination inside the vault is always writable (rail 1 still refuses to overwrite
 * files we did not generate). A destination OUTSIDE the vault is writable only inside
 * one of the folders the user listed in settings. Without this a note would be an
 * arbitrary file-write primitive: any `{tangle="~/…"}` string in any eligible note
 * would be honored, and eligible notes are agent-writable. An EMPTY outside list
 * therefore refuses every outside write — opt in, never out.
 */
export function isAllowedDestination(destination: string, ctx: ResolveContext, outsideRootsAbs: string[]): boolean {
	if (isWithin(ctx.vaultBase, destination)) return true;
	return (outsideRootsAbs ?? []).some((r) => r && r.trim() && isWithin(r, destination));
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
 * Gates the default-destination path only. A block with an explicit `{tangle="…"}`
 * names its own filename and needs no mapping; a block relying on the default does, and
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
 * The destination when a note names none: the configured default folder plus the
 * note's own basename with the language's extension (`flow.md` carrying js blocks →
 * `flow.js`). The folder may itself be note-relative (`./generated` beside a note in
 * `Script notes/` lands in `Script notes/generated/`), which is why it resolves with
 * the note's context rather than once at startup.
 */
export function defaultDestination(noteBasename: string, language: string, defaultFolder: string, ctx: ResolveContext): string {
	if (!defaultFolder || !defaultFolder.trim())
		throw new Error("no default tangle destination is configured, so a block without an explicit one has nowhere to go");
	const folder = resolveDestination(defaultFolder, ctx);
	return path.join(folder, `${noteBasename}.${extensionFor(language)}`);
}
