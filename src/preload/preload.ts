import { contextBridge, ipcRenderer } from 'electron';
import { IPC, type PdmApi } from '../shared/api';

const api: PdmApi = {
  newDocument: (dbms) => ipcRenderer.invoke(IPC.new, dbms),
  openFile: () => ipcRenderer.invoke(IPC.open),
  openStartupFile: () => ipcRenderer.invoke(IPC.openStartup),
  save: (req) => ipcRenderer.invoke(IPC.save, req),
};

contextBridge.exposeInMainWorld('pdmApi', api);
