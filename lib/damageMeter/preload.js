'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// The damage meter's window runs with contextIsolation on and no Node access; everything its
// page can do is these two calls, each answered by the main process (lib/damageMeter/window.js).
contextBridge.exposeInMainWorld('damageMeter', {
    // 'hello', 'toggle', 'reset', 'export', 'copy', 'autoStart', 'dungeonMode', 'pin', ...:
    // see DamageMeter.command in lib/damageMeter/index.js.
    command: (cmd, arg) => ipcRenderer.invoke('damageMeter:command', cmd, arg),
    onView: (handler) => {
        const listener = (_event, view) => handler(view);
        ipcRenderer.on('damageMeter:view', listener);
        return () => ipcRenderer.removeListener('damageMeter:view', listener);
    }
});
