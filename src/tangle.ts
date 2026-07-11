import { App, Notice, TFile } from "obsidian";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { getArgs, CodeBlockArgs } from "./CodeBlockArgs";
import { expandNoweb } from "./transforms/noweb";

interface ParsedBlock {
	language: string;
	args: CodeBlockArgs;
	code: string;
}

/**
 * Parses every fenced code block in a note.
 */
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
			args = info ? getArgs(info) : {};
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

/**
 * Resolves a `tangle` target path: `~` expands to the home directory,
 * absolute paths are kept, and relative paths resolve against the note's
 * folder on disk.
 */
function resolveTanglePath(target: string, app: App, note: TFile): string {
	if (target.startsWith("~"))
		return path.join(os.homedir(), target.substring(1));
	if (path.isAbsolute(target))
		return target;
	// @ts-ignore — getBasePath exists on the desktop FileSystemAdapter
	const vaultBase: string = app.vault.adapter.getBasePath();
	return path.resolve(vaultBase, note.parent?.path ?? "", target);
}

/**
 * Tangles the active note, org-babel style: every code block with a
 * `{tangle="path"}` argument is written to its target file, in note order,
 * with noweb `<<label>>` references expanded. Blocks sharing a target are
 * concatenated. Target files are overwritten.
 */
export default async function tangleCurrentNote(app: App) {
	const note = app.workspace.getActiveFile();
	if (!note) {
		new Notice("Execute Code: no active note to tangle.");
		return;
	}
	const content = await app.vault.cachedRead(note);
	const blocks = parseNoteBlocks(content);

	// Labels are shared across the whole note for tangling
	const labels: Record<string, string> = {};
	for (const b of blocks)
		if (b.args.label && !(b.args.label in labels))
			labels[b.args.label] = b.code;

	const missing = new Set<string>();
	const targets = new Map<string, string[]>();
	for (const b of blocks) {
		if (!b.args.tangle) continue;
		const expanded = expandNoweb(b.code, labels, missing);
		const target = resolveTanglePath(String(b.args.tangle), app, note);
		if (!targets.has(target)) targets.set(target, []);
		targets.get(target).push(expanded.endsWith("\n") ? expanded : expanded + "\n");
	}

	if (targets.size === 0) {
		new Notice("Execute Code: no code blocks with a {tangle=\"...\"} argument in this note.");
		return;
	}

	let written = 0;
	for (const [target, chunks] of targets) {
		try {
			fs.mkdirSync(path.dirname(target), { recursive: true });
			fs.writeFileSync(target, chunks.join("\n"));
			written++;
		} catch (err) {
			new Notice(`Execute Code: failed to tangle to '${target}': ${err.message}`, 10000);
		}
	}

	let message = `Execute Code: tangled ${written} file${written === 1 ? "" : "s"} from ${note.basename}.`;
	if (missing.size)
		message += ` Unknown noweb reference(s): ${[...missing].join(", ")}.`;
	new Notice(message, missing.size ? 10000 : 5000);
}
