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

	async run(code: string, outputter: Outputter, _cmd?: string, _cmdArgs?: string, _ext?: string): Promise<void> {
		const app = this.plugin.app;
		const consoleShim = makeConsoleShim(outputter);
		const lifecycle = this.plugin.settings.obsidianJsTier === "lifecycle";
		const ctx = lifecycle ? this.makeLifecycleContext(code) : this.makeEphemeralContext();

		try {
			const fn = new AsyncFunction("app", "plugin", "require", "console", code);
			const ret = await fn(app, ctx, window.require, consoleShim);
			if (ret !== undefined) outputter.write(stringifyArg(ret) + "\n");
		} catch (e) {
			// The error path shows the full stack; stringifyArg keeps *values* concise.
			const detail = e instanceof Error ? (e.stack ?? `${e.name}: ${e.message}`) : stringifyArg(e);
			outputter.writeErr(detail + "\n");
		}
	}

	/**
	 * Ephemeral `plugin` context: `app` only. The lifecycle-only methods throw a
	 * clear hint rather than an opaque "is not a function" if a user runs a
	 * lifecycle-style block while the tier is left at the ephemeral default.
	 */
	private makeEphemeralContext() {
		const hint = "is only available in the 'Session lifecycle' execution tier (Settings \u2192 Execute Code \u2192 Obsidian JS).";
		const guard = (name: string) => () => { throw new Error(`plugin.${name} ${hint}`); };
		return {
			app: this.plugin.app,
			addCommand: guard("addCommand"),
			registerEvent: guard("registerEvent"),
			register: guard("register"),
			registerDomEvent: guard("registerDomEvent"),
			registerInterval: guard("registerInterval"),
		};
	}

	/**
	 * Build the session-lifecycle `plugin` object backed by a fresh Component.
	 * Re-running the same block first disposes its previous registrations
	 * (removing duplicate commands/listeners); the Component is a child of the
	 * plugin so everything is released on plugin unload too. Nothing persists
	 * across an Obsidian restart — that is inherent to the Run-button model.
	 */
	private makeLifecycleContext(code: string) {
		const app = this.plugin.app;
		// Keyed by a hash of the block source (the executor is already per-file).
		// Re-running an UNCHANGED block disposes its previous registration first.
		// Limitation: editing a block changes its hash, so the prior run's Component
		// is not found here and is only released on plugin unload — re-running an
		// *edited* lifecycle block can leave the previous command/listener registered
		// until then. Identical-source blocks in one note also share a Component.
		const key = hashCode(code);

		const previous = this.components.get(key);
		if (previous) this.plugin.removeChild(previous); // unloads → runs registered disposers

		const component = new Component();
		this.plugin.addChild(component); // auto-unloads on plugin unload
		this.components.set(key, component);

		return {
			app,
			addCommand: (cmd: Parameters<ExecuteCodePlugin["addCommand"]>[0]) => {
				const registered = this.plugin.addCommand(cmd);
				const fullId = `${this.plugin.manifest.id}:${cmd.id}`;
				// addCommand has no Component auto-cleanup; remove it explicitly on unload.
				component.register(() => {
					try {
						(app as unknown as { commands?: { removeCommand?(id: string): void } }).commands?.removeCommand?.(fullId);
					} catch (e) {
						console.error(`obsidianjs: failed to remove command ${fullId}`, e);
					}
				});
				return registered;
			},
			registerEvent: component.registerEvent.bind(component),
			register: component.register.bind(component),
			registerDomEvent: component.registerDomEvent.bind(component),
			registerInterval: component.registerInterval.bind(component),
		};
	}

	async stop(): Promise<void> {
		for (const component of this.components.values()) this.plugin.removeChild(component);
		this.components.clear();
	}
}
