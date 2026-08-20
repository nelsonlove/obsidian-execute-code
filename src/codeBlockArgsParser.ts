import * as JSON5 from "json5";
import type { CodeBlockArgs, ExportType } from "./CodeBlockArgs";

/**
 * Pure code-block argument parsing — the body of `getArgs`, with the user-facing Notice
 * lifted out to the caller.
 *
 * Split out so the tangle decision layer (which must decide WHERE a file is written
 * before writing it) can be tested without a running Obsidian. Two details make that
 * work, and both were latent bugs waiting for any non-Obsidian caller:
 *
 *  - `String.prototype.contains` is an Obsidian runtime extension, not standard JS, so
 *    it is `includes` here.
 *  - the failure path RETURNS the error text rather than raising a Notice, so a headless
 *    caller can report it however it likes.
 *
 * The type import is erased at compile time, so the two modules do not form a runtime
 * cycle.
 */
export function parseArgs(firstLineOfCode: string): { args: CodeBlockArgs; error?: string } {
	// No args specified
	if (!firstLineOfCode.includes("{") && !firstLineOfCode.includes("}"))
		return { args: {} };
	try {
		let args = firstLineOfCode.substring(firstLineOfCode.indexOf("{") + 1).trim();
		// Transform custom syntax to JSON5
		args = args.replace(/=/g, ":");
		// Handle unnamed export arg - pre / post at the beginning of the args without any arg name
		const exports: ExportType[] = [];
		const handleUnnamedExport = (exportName: ExportType) => {
			let i = args.indexOf(exportName);
			while (i !== -1) {
				const nextChar = args[i + exportName.length];
				if (nextChar !== `"` && nextChar !== `'`) {
					// Remove from args string
					args = args.substring(0, i) + args.substring(i + exportName.length + (nextChar === "}" ? 0 : 1));
					exports.push(exportName);
				}
				i = args.indexOf(exportName, i + 1);
			}
		};
		handleUnnamedExport("pre");
		handleUnnamedExport("post");
		args = `{export: ['${exports.join("', '")}'], ${args}`;
		return { args: JSON5.parse(args) };
	} catch (err) {
		return { args: {}, error: String(err) };
	}
}
