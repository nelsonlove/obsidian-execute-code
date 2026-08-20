import {Notice} from "obsidian";
import { parseArgs } from "./codeBlockArgsParser";

export type ExportType = "pre" | "post";

/**
 * Arguments for code blocks, specified next to the language identifier as JSON
 * @example ```python {"export": "pre"}
 * @example ```cpp {"ignoreExport": ["post"]}
 */
export interface CodeBlockArgs {
	label?: string;
	results?: "value" | "output";
	tangle?: string;
	var?: Record<string, string>;
	import?: string | string[];
	export?: ExportType | ExportType[];
	ignore?: (ExportType | "global")[] | ExportType | "global" | "all";
}

/**
 * Get code block args given the first line of the code block.
 *
 * @param firstLineOfCode The first line of a code block that contains the language name.
 * @returns The arguments from the first line of the code block.
 */
export function getArgs(firstLineOfCode: string): CodeBlockArgs {
	const { args, error } = parseArgs(firstLineOfCode);
	if (error)
		new Notice(`Failed to parse code block arguments from line:\n${firstLineOfCode}\n\nFailed with error:\n${error}`);
	return args;
}

