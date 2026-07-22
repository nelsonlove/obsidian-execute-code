import Executor from "./Executor";
import { Outputter } from "src/output/Outputter";
import ExecuteCodePlugin from "src/main";
import { makeConsoleShim, stringifyArg } from "./obsidianJsRuntime";

// The AsyncFunction constructor is not a global; grabbing it lets user code use
// top-level `await`.
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as
	new (...args: string[]) => (...callArgs: unknown[]) => Promise<unknown>;

/**
 * Executes JavaScript inside the Obsidian renderer with live `app` and
 * `require('obsidian')` access — the in-app counterpart to NodeJSExecutor.
 *
 * Each run is independent: no persistent state and no registrations. `app` is
 * the live App, `require` resolves `obsidian` and Node builtins, `console`
 * output and a non-undefined return value are written inline, and top-level
 * `await` is supported. There is deliberately no command/event registration
 * surface — a Run button is the wrong place to mutate Obsidian's lifecycle.
 */
export default class ObsidianJSExecutor extends Executor {
	private plugin: ExecuteCodePlugin;

	constructor(plugin: ExecuteCodePlugin, file: string) {
		super(file, "obsidianjs");
		this.plugin = plugin;
	}

	async run(code: string, outputter: Outputter, _cmd?: string, _cmdArgs?: string, _ext?: string): Promise<void> {
		const app = this.plugin.app;
		const consoleShim = makeConsoleShim(outputter);
		try {
			const fn = new AsyncFunction("app", "require", "console", code);
			const ret = await fn(app, window.require, consoleShim);
			if (ret !== undefined) outputter.write(stringifyArg(ret) + "\n");
		} catch (e) {
			// The error path shows the full stack; stringifyArg keeps values concise.
			const detail = e instanceof Error ? (e.stack ?? `${e.name}: ${e.message}`) : stringifyArg(e);
			outputter.writeErr(detail + "\n");
		}
	}

	async stop(): Promise<void> {
		// Nothing to stop: no child process, no persistent registrations.
	}
}
