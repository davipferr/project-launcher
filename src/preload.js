// The bridge between the sandboxed UI and the main process. The renderer gets
// `window.api` with exactly these functions — no Node, no fs, no child_process.
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);
const on = (channel) => (cb) => {
  const listener = (_e, ...args) => cb(...args);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('api', {
  getSettings: invoke('settings:get'),
  chooseRoot: invoke('settings:chooseRoot'),
  setEditor: invoke('settings:setEditor'),

  scan: invoke('projects:scan'),
  gitStatus: invoke('projects:git'),
  toggleFavorite: invoke('projects:toggleFavorite'),
  setDefaultCommand: invoke('projects:setDefault'),
  addCommand: invoke('projects:addCommand'),
  removeCommand: invoke('projects:removeCommand'),

  openEditor: invoke('open:editor'),
  openFolder: invoke('open:folder'),
  openTerminal: invoke('open:terminal'),
  openUrl: invoke('open:url'),

  start: invoke('run:start'),
  stop: invoke('run:stop'),
  removeRun: invoke('run:remove'),
  listRuns: invoke('run:list'),
  getLogs: invoke('run:logs'),

  onRunUpdate: on('run:update'),
  onRunLogs: on('run:logs'),
  onRunRemoved: on('run:removed'),
  onFocus: on('window:focus'),
  onToast: on('toast'),
});
