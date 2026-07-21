import { Component } from "obsidian";
import Executor from "./Executor";
import { Outputter } from "src/output/Outputter";
import ExecuteCodePlugin from "src/main";
import { hashCode, makeConsoleShim, stringifyArg } from "./obsidianJsRuntime";

// The AsyncFunction constructor is not a global; grabbing it lets user code use
// top-level `await`.
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as
	new (...args: string[]) => (...callArgs: unknown[]) => Promise<unknown>;

/**
 * Executes JavaScript inside the Obsidian renderer with live `app` and
 * `require('obsidian')` access — the in-app counterpart to NodeJSExecutor.
 */
export default class ObsidianJSExecutor extends Executor {
	private plugin: ExecuteCodePlugin;
	/** Per-block session-lifecycle components, keyed by a hash of block source. */
	private components: Map<string, Component> = new Map();

	constructor(plugin: ExecuteCodePlugin, file: string) {
		super(file, "obsidianjs");
		this.plugin = plugin;
	}

	async run(code: string, outputter: Outputter): Promise<void> {
		const app = this.plugin.app;
		const consoleShim = makeConsoleShim(outputter);
		const lifecycle = this.plugin.settings.obsidianJsTier === "lifecycle";
		const ctx = lifecycle ? this.makeLifecycleContext(code) : { app };

		try {
			const fn = new AsyncFunction("app", "plugin", "require", "console", code);
			const ret = await fn(app, ctx, window.require, consoleShim);
			if (ret !== undefined) outputter.write(stringifyArg(ret) + "\n");
		} catch (e) {
			outputter.writeErr(stringifyArg(e) + "\n");
		}
	}

	/**
	 * Session-lifecycle `plugin` context. Task 4 fills this in; for now it
	 * behaves like the ephemeral context so the ephemeral path is testable.
	 */
	private makeLifecycleContext(_code: string): Record<string, unknown> {
		return { app: this.plugin.app };
	}

	async stop(): Promise<void> {
		for (const component of this.components.values()) this.plugin.removeChild(component);
		this.components.clear();
	}
}
