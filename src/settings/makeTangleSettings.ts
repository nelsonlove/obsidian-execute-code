import { Setting } from "obsidian";
import type { SettingsTab } from "./SettingsTab";
import { conditionsToText, textToConditions } from "../tangle/conditionText";

/**
 * Settings for tangling — writing a note's code blocks out to real files.
 *
 * The eligibility predicate is edited as text (one condition per line) rather than as a
 * row-builder UI: it is a rarely-touched, security-relevant setting, and a text field
 * that round-trips exactly is easier to review than a widget that silently normalizes.
 */
export default function makeTangleSettings(tab: SettingsTab, containerEl: HTMLElement) {
	containerEl.createEl("h3", { text: "Tangling" });
	containerEl.createEl("p", {
		text:
			"Tangling writes a note's code blocks to files on disk. Those files are ordinary code that " +
			"other tools will load and run, so the destination is restricted to the roots you declare " +
			"below, and a file that this plugin did not generate is never overwritten.",
		cls: "setting-item-description",
	});

	const settings = () => tab.plugin.settings.tangle;

	new Setting(containerEl)
		.setName("Tangle root")
		.setDesc(
			"Where artifacts land when a note names no destination. Accepts 'vault:Some/Folder', " +
			"'~/dir', or an absolute path. Leave empty to disable tangling entirely — with no root " +
			"declared, every destination is refused.",
		)
		.addText((text) =>
			text
				.setPlaceholder("vault:00-09 System/00 System management/00.12 Scripts")
				.setValue(settings().tangleRoot)
				.onChange(async (value) => {
					settings().tangleRoot = value.trim();
					await tab.plugin.saveSettings();
				}),
		);

	new Setting(containerEl)
		.setName("Additional permitted roots")
		.setDesc(
			"One path per line. A block's explicit {tangle=\"…\"} may write into these as well as the " +
			"tangle root. Anything outside every listed root is refused. A bare path in a block " +
			"(sub/lib.js) is relative to the tangle root; './lib.js' is relative to the note.",
		)
		.addTextArea((area) => {
			area.inputEl.rows = 3;
			area
				.setValue((settings().additionalRoots ?? []).join("\n"))
				.onChange(async (value) => {
					settings().additionalRoots = value
						.split("\n")
						.map((l) => l.trim())
						.filter(Boolean);
					await tab.plugin.saveSettings();
				});
		});

	new Setting(containerEl)
		.setName("Tangle when")
		.setDesc(
			"Conditions a note must meet, ALL of them, before it tangles. One per line: " +
			"'tag: tangle', 'property: acceptance-status = accepted', or 'property: some-field' for " +
			"mere presence. Empty means nothing tangles.",
		)
		.addTextArea((area) => {
			area.inputEl.rows = 3;
			area
				.setPlaceholder("tag: tangle\nproperty: acceptance-status = accepted")
				.setValue(conditionsToText(settings().tangleWhen))
				.onChange(async (value) => {
					settings().tangleWhen = textToConditions(value);
					await tab.plugin.saveSettings();
				});
		});

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
