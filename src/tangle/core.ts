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
	resolveTangleRoot,
	ResolveContext,
} from "./resolve";
import { looksGenerated } from "./header";
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
 * `{tangle="…"}` beats the central root. `{tangle="no"}` excludes a block outright,
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
	const roots = allowedRoots(settings, ctx);
	// Block destinations resolve with the tangle root in scope, so a bare relative path
	// lands INSIDE it. Roots themselves were resolved without it (see resolveTangleRoot).
	const blockCtx: ResolveContext = { ...ctx, tangleRootAbs: resolveTangleRoot(settings.tangleRoot, ctx) };

	for (const b of blocks) {
		const explicit = b.args.tangle === undefined ? undefined : String(b.args.tangle).trim();
		if (explicit && /^(no|false|off)$/i.test(explicit)) continue;
		// With no explicit destination a block only rides the central root if we know what
		// to call the file — an unrecognized language has no extension we could pick
		// without guessing, and guessing produces `.txt` modules nobody asked for.
		if (!explicit && !isKnownLanguage(b.language)) continue;

		let destination: string;
		try {
			destination = explicit
				? resolveDestination(explicit, blockCtx)
				: defaultDestination(noteBasename, b.language, settings.tangleRoot, ctx);
		} catch (e) {
			refused.push({ destination: explicit ?? "(central root)", reason: (e as Error).message });
			continue;
		}

		if (!isAllowedDestination(destination, roots)) {
			refused.push({
				destination,
				reason: roots.length
					? "outside every declared tangle root"
					: "no tangle roots are declared, so no destination is writable",
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
 * The roots a destination may live in: the central tangle root plus the explicit
 * override allowlist. Resolved through the same function destinations are, so a root
 * written as `vault:…` or `~/…` means the same thing on both sides of the comparison.
 */
export function allowedRoots(settings: TangleSettings, ctx: ResolveContext): string[] {
	const declared = [settings.tangleRoot, ...(settings.additionalRoots ?? [])];
	const out: string[] = [];
	for (const r of declared) {
		if (!r || !r.trim()) continue;
		try {
			// Roots resolve WITHOUT a root in scope — a root cannot be relative to itself.
			out.push(resolveDestination(r, { ...ctx, noteFolder: "", tangleRootAbs: undefined }));
		} catch {
			/* a malformed root simply grants nothing */
		}
	}
	return out;
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
 */
export function writeArtifact(destination: string, body: string, marker: string): WriteOutcome {
	try {
		if (fs.existsSync(destination)) {
			const current = fs.readFileSync(destination, "utf8");
			if (!looksGenerated(current, marker))
				return {
					destination,
					status: "refused-foreign",
					detail: "target exists and was not generated by this plugin — refusing to overwrite",
				};
			if (current === body) return { destination, status: "unchanged" };
		}
		fs.mkdirSync(path.dirname(destination), { recursive: true });
		const tmp = path.join(path.dirname(destination), `.${path.basename(destination)}.tangle-tmp`);
		try {
			fs.writeFileSync(tmp, body);
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

/** Depth-limited directory walk. Symlinked directories are not followed. */
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
		if (e.isDirectory()) yield* walkFiles(full, depth + 1);
		else if (e.isFile()) yield full;
	}
}
