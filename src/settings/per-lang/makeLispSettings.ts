import { Setting } from "obsidian";
import { SettingsTab } from "../SettingsTab";

export default (tab: SettingsTab, containerEl: HTMLElement) => {
    containerEl.createEl('h3', { text: 'Common Lisp Settings' });
    new Setting(containerEl)
        .setName('sbcl path')
        .setDesc("Path to your sbcl installation")
        .addText(text => text
            .setValue(tab.plugin.settings.lispPath)
            .onChange(async (value) => {
                const sanitized = tab.sanitizePath(value);
                tab.plugin.settings.lispPath = sanitized;
                console.log('sbcl path set to: ' + sanitized);
                await tab.plugin.saveSettings();
            }));
    new Setting(containerEl)
        .setName('Common Lisp arguments')
        .addText(text => text
            .setValue(tab.plugin.settings.lispArgs)
            .onChange(async (value) => {
                tab.plugin.settings.lispArgs = value;
                console.log('Common Lisp args set to: ' + value);
                await tab.plugin.saveSettings();
            }));
    tab.makeInjectSetting(containerEl, "lisp");
}
