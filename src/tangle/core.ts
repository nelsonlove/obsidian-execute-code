import * as fs from "fs";
import * as path from "path";
import type { CodeBlockArgs } from "../CodeBlockArgs";
import { parseArgs } from "../codeBlockArgsParser";
import { expandNoweb } from "../transforms/noweb";
import {
	defaultDestination,
	isAllowedDestination,
	isKnownLanguage,
	resolveDestination,
	resolveOutsideRoots,
	ResolveContext,
} from "./resolve";
import { looksGenerated, stripGeneratedHeader } from "./header";
import type { TangleSettings } from "./settings";

/**
 * The tangle DECISION layer — what would be written, where, and whether we are allowed
 * to write it — plus the write itself.
 *
 * Deliberately free of any `obsidian` import: this is where the safety rails live, and
 * a rail that can only be exercised by hand in a running vault is a rail nobody
 * regression-tests. Everything Obsidian-shaped (reading the note, its tags, its
 * frontmatter) is in `index.ts`.
 */

export interface ParsedBlock {
	language: string;
	args: CodeBlockArgs;
	code: string;
}

/**
 * Org-babel-style header argument on the fence line: ```js :tangle ./generated
 *
 * Only `:tangle` is recognized. The value is the next token — quoted when the path
 * carries spaces (`:tangle "Script notes/lib.js"`). `:tangle no` excludes the block;
 * `:tangle yes` (org's spelling for "to the default file") is the default behavior
 * here, so it reads as no destination. The JSON5 form `{tangle="…"}` wins when both
 * are present, being the more explicit spelling.
 */
export function parseOrgTangleArg(info: string): string | undefined {
	const m = /(?:^|\s):tangle(?:\s+(?:"([^"]*)"|'([^']*)'|([^\s{}]+)))?(?=\s|$|\{)/.exec(info);
	if (!m) return undefined;
	const value = (m[1] ?? m[2] ?? m[3] ?? "").trim();
	if (!value || /^yes$/i.test(value)) return undefined;
	return value;
}

/** Parses every fenced code block in a note. */
export function parseNoteBlocks(content: string): ParsedBlock[] {
	const blocks: ParsedBlock[] = [];
	let inside = false;
	let fence = "";
	let language = "";
	let args: CodeBlockArgs = {};
	let code: string[] = [];

	for (const line of content.split("\n")) {
		const m = line.match(/^(\s*)(`{3,}|~{3,})\s*(.*)$/);
		if (m && !inside) {
			inside = true;
			fence = m[2];
			const info = m[3].trim();
			language = info.split(/[\s{]/)[0];
			args = info ? parseArgs(info).args : {};
			if (args.tangle === undefined) {
				const org = parseOrgTangleArg(info);
				if (org !== undefined) args.tangle = org;
			}
			code = [];
		} else if (m && inside && m[2].charAt(0) === fence.charAt(0) && m[3].trim() === "") {
			blocks.push({ language, args, code: code.join("\n") + (code.length ? "\n" : "") });
			inside = false;
		} else if (inside) {
			code.push(line);
		}
	}
	return blocks;
}

export interface PlannedArtifact {
	destination: string;
	language: string;
	/** Block bodies in note order, noweb already expanded. */
	chunks: string[];
}

export interface TanglePlan {
	artifacts: PlannedArtifact[];
	/** Destinations refused by rail 2, with the reason, so a caller can report them. */
	refused: { destination: string; reason: string }[];
	/** noweb `<<label>>` references that resolved to nothing. */
	missingRefs: string[];
}

export interface PlanInputs {
	content: string;
	noteBasename: string;
	ctx: ResolveContext;
	settings: TangleSettings;
}

/**
 * Decide what would be written, and where — with no filesystem access, so the whole
 * decision (rail 2 included) is testable without a vault.
 *
 * A block's destination is the most specific one available: an explicit
 * `{tangle="…"}` beats the default destination. `{tangle="no"}` excludes a block outright,
 * which is how a note keeps illustrative or scratch blocks out of its artifact.
 */
export function planTangle({ content, noteBasename, ctx, settings }: PlanInputs): TanglePlan {
	const blocks = parseNoteBlocks(content);

	// noweb labels are shared across the whole note, including blocks that never tangle,
	// so a library block can be `{tangle="no", label="helpers"}` and still be referenced.
	const labels: Record<string, string> = {};
	for (const b of blocks)
		if (b.args.label && !(b.args.label in labels)) labels[b.args.label] = b.code;

	const missing = new Set<string>();
	const byDestination = new Map<string, PlannedArtifact>();
	const refused: { destination: string; reason: string }[] = [];
	const outsideRoots = resolveOutsideRoots(settings.allowedOutsideRoots, ctx);

	for (const b of blocks) {
		const explicit = b.args.tangle === undefined ? undefined : String(b.args.tangle).trim();
		if (explicit && /^(no|false|off)$/i.test(explicit)) continue;
		// With no explicit destination a block only rides the default destination if we
		// know what to call the file — an unrecognized language has no extension we could
		// pick without guessing, and guessing produces `.txt` modules nobody asked for.
		if (!explicit && !isKnownLanguage(b.language)) continue;

		let destination: string;
		try {
			destination = explicit
				? resolveDestination(explicit, ctx)
				: defaultDestination(noteBasename, b.language, settings.defaultDestination, ctx);
		} catch (e) {
			refused.push({ destination: explicit ?? "(default destination)", reason: (e as Error).message });
			continue;
		}

		if (!isAllowedDestination(destination, ctx, outsideRoots)) {
			refused.push({
				destination,
				reason: outsideRoots.length
					? "outside the vault and outside every allowed outside folder"
					: "outside the vault, and no outside folders are allowed",
			});
			continue;
		}

		const existing = byDestination.get(destination);
		const expanded = expandNoweb(b.code, labels, missing);
		const chunk = expanded.endsWith("\n") ? expanded : expanded + "\n";
		if (existing) existing.chunks.push(chunk);
		else byDestination.set(destination, { destination, language: b.language, chunks: [chunk] });
	}

	return { artifacts: [...byDestination.values()], refused, missingRefs: [...missing] };
}

/**
 * Where the orphan sweep looks for marker-carrying files: the vault. Outside roots are
 * deliberately NOT swept — a grant like `~/repos` can be enormous, and files out there
 * live under their own tools' management; walking them would be slow and presumptuous.
 * An artifact tangled outside the vault is simply not orphan-tracked.
 */
export function sweepRoots(ctx: ResolveContext): string[] {
	return [ctx.vaultBase];
}

export interface WriteOutcome {
	destination: string;
	status: "written" | "unchanged" | "refused-foreign" | "error";
	detail?: string;
}

/**
 * Write one artifact, with rails 1 and 4.
 *
 * Rail 1 — refuse when the target exists and does not carry our marker. Clobbering
 * hand-written code is unrecoverable, so a filename collision has to be loud rather
 * than destructive.
 * Rail 4 — write a temp file and rename over the target, so an interrupted tangle
 * cannot leave a half-written module for `require()` to load. Same-directory is not
 * incidental: `rename` is only atomic within one filesystem.
 *
 * `header` and `body` arrive separately so the unchanged check can ignore the header's
 * timestamp; the file written is still `header + "\n" + body`.
 */
export function writeArtifact(destination: string, header: string, body: string, marker: string): WriteOutcome {
	const full = header + "\n" + body;
	try {
		if (fs.existsSync(destination)) {
			const current = fs.readFileSync(destination, "utf8");
			if (!looksGenerated(current, marker))
				return {
					destination,
					status: "refused-foreign",
					detail: "target exists and was not generated by this plugin — refusing to overwrite",
				};
			// Compare BODIES, not whole files. The header carries a timestamp, so a
			// whole-file comparison always differs and every sweep would rewrite every
			// artifact. Leaving the old header in place is also the honest reading: the
			// stamp records when this CONTENT was generated, not when the tangler last ran.
			const currentBody = stripGeneratedHeader(current, marker);
			if (currentBody !== null && currentBody === body) return { destination, status: "unchanged" };
			if (currentBody === null && current === full) return { destination, status: "unchanged" };
		}
		fs.mkdirSync(path.dirname(destination), { recursive: true });
		const tmp = path.join(path.dirname(destination), `.${path.basename(destination)}.tangle-tmp`);
		try {
			fs.writeFileSync(tmp, full);
			fs.renameSync(tmp, destination);
		} catch (e) {
			try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* best effort */ }
			throw e;
		}
		return { destination, status: "written" };
	} catch (e) {
		return { destination, status: "error", detail: (e as Error).message };
	}
}

export interface TangleReport {
	note: string;
	eligible: boolean;
	outcomes: WriteOutcome[];
	refused: { destination: string; reason: string }[];
	missingRefs: string[];
}

export function summarize(report: TangleReport): string {
	const written = report.outcomes.filter((o) => o.status === "written").length;
	const unchanged = report.outcomes.filter((o) => o.status === "unchanged").length;
	const problems = [
		...report.outcomes
			.filter((o) => o.status !== "written" && o.status !== "unchanged")
			.map((o) => `${o.destination}: ${o.detail}`),
		...report.refused.map((r) => `${r.destination}: ${r.reason}`),
	];
	let msg = `tangled ${written} file${written === 1 ? "" : "s"}`;
	if (unchanged) msg += ` (${unchanged} unchanged)`;
	if (report.missingRefs.length) msg += `. Unknown noweb reference(s): ${report.missingRefs.join(", ")}`;
	if (problems.length) msg += `. Refused: ${problems.join("; ")}`;
	return msg;
}

/**
 * Depth-limited directory walk. Symlinked directories are not followed, and DOT
 * directories are skipped: the sweep now walks the vault itself, and `.obsidian`,
 * `.git`, and `.trash` are full of files we must not read as ours — this plugin's own
 * bundled `main.js` carries the marker literal, and without this skip the sweep would
 * report it as an orphan.
 */
export function* walkFiles(dir: string, depth = 0): Generator<string> {
	if (depth > 8) return;
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const e of entries) {
		const full = path.join(dir, e.name);
		if (e.isDirectory() && !e.name.startsWith(".")) yield* walkFiles(full, depth + 1);
		else if (e.isFile()) yield full;
	}
}
