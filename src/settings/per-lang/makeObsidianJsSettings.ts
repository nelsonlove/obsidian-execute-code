import { Setting } from "obsidian";
import { SettingsTab } from "../SettingsTab";

export default (tab: SettingsTab, containerEl: HTMLElement) => {
	containerEl.createEl("h3", { text: "Obsidian JS (in-app) Settings" });
	containerEl.createEl("p", {
		text: "obsidianjs blocks run inside Obsidian with full vault access and can modify or delete notes. Only run code you understand. Registrations do not survive a restart.",
		cls: "setting-item-description",
	});
	new Setting(containerEl)
		.setName("Execution tier")
		.setDesc("Ephemeral: run once, no registrations. Session lifecycle: blocks may addCommand / register events that live until Obsidian quits.")
		.addDropdown(dropdown => dropdown
			.addOption("ephemeral", "Ephemeral")
			.addOption("lifecycle", "Session lifecycle")
			.setValue(tab.plugin.settings.obsidianJsTier)
			.onChange(async (value) => {
				tab.plugin.settings.obsidianJsTier = value as "ephemeral" | "lifecycle";
				await tab.plugin.saveSettings();
			}));
};
