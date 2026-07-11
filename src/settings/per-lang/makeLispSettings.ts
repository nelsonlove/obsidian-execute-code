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
    new Setting(containerEl)
        .setName("Run Common Lisp blocks in Notebook Mode")
        .setDesc("Blocks share a persistent SBCL session per note: definitions and state carry over between blocks. Uses the sbcl path above; the arguments setting is ignored in this mode.")
        .addToggle((toggle) => toggle
            .setValue(tab.plugin.settings.lispInteractive)
            .onChange(async (value) => {
                tab.plugin.settings.lispInteractive = value;
                await tab.plugin.saveSettings();
            }));
    tab.makeInjectSetting(containerEl, "lisp");
}
