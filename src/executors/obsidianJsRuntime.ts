import { Outputter } from "src/output/Outputter";

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
 * Build a console-like object whose output-producing methods route into the
 * block's Outputter (log/info/debug/dir/trace/table/group → stdout styling;
 * warn/error/failed-assert → stderr styling). Inherits from the real console so
 * any method not shimmed here still exists.
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
