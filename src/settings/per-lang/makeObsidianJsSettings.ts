import { SettingsTab } from "../SettingsTab";

export default (_tab: SettingsTab, containerEl: HTMLElement) => {
    containerEl.createEl("h3", { text: "Obsidian JS (in-app) Settings" });
    containerEl.createEl("p", {
        text: "obsidianjs blocks run inside Obsidian with full vault access and can modify or delete notes. Only run code you understand.",
        cls: "setting-item-description",
    });
};
