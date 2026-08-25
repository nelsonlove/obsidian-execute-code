import { Setting } from "obsidian";
import type { SettingsTab } from "./SettingsTab";
import type { PropertyOp } from "../tangle/predicate";
import { StringSuggest, vaultPropertyKeys, vaultTags } from "../tangle/suggest";

const OP_LABELS: Record<PropertyOp, string> = {
	"equals": "equals",
	"not-equals": "does not equal",
	"contains": "contains",
	"not-contains": "does not contain",
	"starts-with": "starts with",
	"ends-with": "ends with",
	"exists": "exists",
	"not-exists": "does not exist",
};

/** Settings for tangling — writing a note's code blocks out to real files. */
export default function makeTangleSettings(tab: SettingsTab, containerEl: HTMLElement) {
	containerEl.createEl("h3", { text: "Tangling" });
	containerEl.createEl("p", {
		text:
			"Tangling writes a note's code blocks to files on disk. Destinations are inside the vault " +
			"unless a folder below explicitly allows otherwise, and a file that this plugin did not " +
			"generate is never overwritten.",
		cls: "setting-item-description",
	});

	const settings = () => tab.plugin.settings.tangle;

	new Setting(containerEl)
		.setName("Default destination")
		.setDesc(
			"The folder artifacts land in when a block names no destination. A bare path is relative " +
			"to the vault root; './generated' is relative to each note's own folder; '~/dir' and " +
			"absolute paths need an allowed outside folder below. Empty means only blocks with an " +
			"explicit destination tangle.",
		)
		.addText((text) =>
			text
				.setPlaceholder("./generated")
				.setValue(settings().defaultDestination)
				.onChange(async (value) => {
					settings().defaultDestination = value.trim();
					await tab.plugin.saveSettings();
				}),
		);

	new Setting(containerEl)
		.setName("Allowed folders outside the vault")
		.setDesc(
			"One per line, '~/dir' or absolute. Destinations inside the vault are always allowed; a " +
			"destination outside it is refused unless it is under one of these folders. Empty means " +
			"nothing is ever written outside the vault.",
		)
		.addTextArea((area) => {
			area.inputEl.rows = 3;
			area
				.setPlaceholder("~/repos/scripts")
				.setValue((settings().allowedOutsideRoots ?? []).join("\n"))
				.onChange(async (value) => {
					settings().allowedOutsideRoots = value
						.split("\n")
						.map((l) => l.trim())
						.filter(Boolean);
					await tab.plugin.saveSettings();
				});
		});

	/* ------------------------------- Tangle when ------------------------------- */

	new Setting(containerEl)
		.setName("Tangle when")
		.setDesc(
			"A note tangles when it carries AT LEAST ONE of the listed tags and satisfies EVERY " +
			"property condition. A section left empty imposes nothing — but if both are empty, " +
			"nothing tangles.",
		)
		.setHeading();

	const whenEl = containerEl.createDiv();
	const save = () => tab.plugin.saveSettings();

	const renderWhen = () => {
		whenEl.empty();
		const when = settings().tangleWhen;

		when.tags.forEach((tag, i) => {
			new Setting(whenEl)
				.setName(i === 0 ? "Tags (any of)" : "")
				.addText((text) => {
					text.setPlaceholder("tangle")
						.setValue(tag)
						.onChange(async (value) => {
							when.tags[i] = value.trim().replace(/^#+/, "");
							await save();
						});
					new StringSuggest(tab.app, text.inputEl, () => vaultTags(tab.app));
				})
				.addExtraButton((btn) =>
					btn.setIcon("cross").setTooltip("Remove tag").onClick(async () => {
						when.tags.splice(i, 1);
						await save();
						renderWhen();
					}),
				);
		});

		when.properties.forEach((cond, i) => {
			const valueless = cond.op === "exists" || cond.op === "not-exists";
			const row = new Setting(whenEl).setName(i === 0 ? "Properties (all of)" : "");
			row.addText((text) => {
				text.setPlaceholder("property")
					.setValue(cond.key)
					.onChange(async (value) => {
						cond.key = value.trim();
						await save();
					});
				new StringSuggest(tab.app, text.inputEl, () => vaultPropertyKeys(tab.app));
			});
			row.addDropdown((drop) => {
				for (const [op, label] of Object.entries(OP_LABELS)) drop.addOption(op, label);
				drop.setValue(cond.op).onChange(async (value) => {
					cond.op = value as PropertyOp;
					await save();
					renderWhen(); // the value box appears or disappears with the operator
				});
			});
			if (!valueless)
				row.addText((text) =>
					text.setPlaceholder("value")
						.setValue(cond.value ?? "")
						.onChange(async (value) => {
							cond.value = value;
							await save();
						}),
				);
			row.addExtraButton((btn) =>
				btn.setIcon("cross").setTooltip("Remove condition").onClick(async () => {
					when.properties.splice(i, 1);
					await save();
					renderWhen();
				}),
			);
		});

		new Setting(whenEl)
			.addButton((btn) =>
				btn.setButtonText("Add tag").onClick(async () => {
					when.tags.push("");
					await save();
					renderWhen();
				}),
			)
			.addButton((btn) =>
				btn.setButtonText("Add property condition").onClick(async () => {
					when.properties.push({ key: "", op: "equals", value: "" });
					await save();
					renderWhen();
				}),
			);
	};
	renderWhen();

	/* ----------------------------- The rest, as before ----------------------------- */

	new Setting(containerEl)
		.setName("Tangle automatically on save")
		.setDesc(
			"Re-tangle an eligible note shortly after it stops changing. The manual command and the " +
			"sweep work whether or not this is on.",
		)
		.addToggle((toggle) =>
			toggle.setValue(settings().autoTangle).onChange(async (value) => {
				settings().autoTangle = value;
				await tab.plugin.saveSettings();
			}),
		);

	new Setting(containerEl)
		.setName("Auto-tangle delay (ms)")
		.setDesc("How long editing must be quiet before an automatic tangle fires. Minimum 250.")
		.addText((text) =>
			text.setValue(String(settings().tangleDebounceMs)).onChange(async (value) => {
				const n = Number(value);
				if (Number.isFinite(n) && n > 0) {
					settings().tangleDebounceMs = Math.max(250, Math.floor(n));
					await tab.plugin.saveSettings();
				}
			}),
		);

	new Setting(containerEl)
		.setName("Generated-file header")
		.setDesc(
			"Prepended to every tangled file. Placeholders: {{note}}, {{uid}}, {{date}}, {{comment}} " +
			"(the language's comment token).",
		)
		.addTextArea((area) => {
			area.inputEl.rows = 3;
			area.setValue(settings().headerTemplate).onChange(async (value) => {
				settings().headerTemplate = value;
				await tab.plugin.saveSettings();
			});
		});

	new Setting(containerEl)
		.setName("Generated-file marker")
		.setDesc(
			"The literal that identifies a file as ours. A target file not containing it is treated as " +
			"hand-written and is never overwritten. Changing this makes previously tangled files " +
			"unwritable until they are removed by hand — safe, but not a casual edit.",
		)
		.addText((text) =>
			text.setValue(settings().marker).onChange(async (value) => {
				settings().marker = value;
				await tab.plugin.saveSettings();
			}),
		);
}
