import { Outputter } from "src/output/Outputter";

/**
 * Deterministic djb2-xor string hash, hex-encoded. Gives each obsidianjs code
 * block a stable identity (per file) for session-lifecycle cleanup.
 */
export function hashCode(str: string): string {
	let hash = 5381;
	for (let i = 0; i < str.length; i++) {
		hash = ((hash << 5) + hash) ^ str.charCodeAt(i);
	}
	return (hash >>> 0).toString(16);
}

/** Render a single console/return argument to a display string. */
export function stringifyArg(arg: unknown): string {
	if (typeof arg === "string") return arg;
	if (arg instanceof Error) return `${arg.name}: ${arg.message}`;
	try {
		return JSON.stringify(arg, null, 2) ?? String(arg);
	} catch {
		return String(arg);
	}
}

/** Join console arguments the way console.log does (space-separated). */
export function formatConsoleArgs(args: unknown[]): string {
	return args.map(stringifyArg).join(" ");
}

/**
 * Build a console-like object whose log/info/debug go to stdout styling and
 * warn/error go to stderr styling, both routed into the block's Outputter.
 * Inherits from the real console so uncommon methods still exist.
 */
export function makeConsoleShim(outputter: Outputter): Console {
	const out = (args: unknown[]) => outputter.write(formatConsoleArgs(args) + "\n");
	const err = (args: unknown[]) => outputter.writeErr(formatConsoleArgs(args) + "\n");
	const shim = Object.create(console) as Console;
	shim.log = (...a: unknown[]) => out(a);
	shim.info = (...a: unknown[]) => out(a);
	shim.debug = (...a: unknown[]) => out(a);
	shim.dir = (...a: unknown[]) => out(a);
	shim.trace = (...a: unknown[]) => out(a);
	shim.table = (...a: unknown[]) => out(a);
	shim.group = (...a: unknown[]) => out(a);
	shim.groupCollapsed = (...a: unknown[]) => out(a);
	shim.groupEnd = () => {};
	shim.warn = (...a: unknown[]) => err(a);
	shim.error = (...a: unknown[]) => err(a);
	shim.assert = (condition?: boolean, ...a: unknown[]) => { if (!condition) err(["Assertion failed:", ...a]); };
	return shim;
}
