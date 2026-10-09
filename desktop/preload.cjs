const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('storyflowDesktop', {
  getState: () => ipcRenderer.invoke('storyflow:state'),
  update: () => ipcRenderer.invoke('storyflow:update'),
  chooseWorkspace: () => ipcRenderer.invoke('storyflow:workspace'),
  onState: callback => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('storyflow:state', listener);
    return () => ipcRenderer.removeListener('storyflow:state', listener);
  },
});
