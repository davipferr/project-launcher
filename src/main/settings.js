// Tiny JSON-file settings store, kept in Electron's per-user data folder
// (%APPDATA%\project-launcher\settings.json on Windows).
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const DEFAULTS = {
  root: path.join(os.homedir(), 'Documents', 'projetos'),
  editor: 'code',
  favorites: [], // project paths
  defaultCommand: {}, // projectPath -> commandId
  customCommands: {}, // projectPath -> [{ id, label, cmd }]
};

class Settings {
  constructor(file) {
    this.file = file;
    this.data = { ...DEFAULTS };
    try {
      Object.assign(this.data, JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch {
      // first run or corrupt file: keep defaults
    }
  }

  get() {
    return structuredClone(this.data);
  }

  update(mutator) {
    mutator(this.data);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    // write-then-rename so a crash never leaves a half-written file
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
    return this.get();
  }
}

module.exports = { Settings, DEFAULTS };
