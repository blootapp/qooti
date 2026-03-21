const { contextBridge, ipcRenderer, webUtils } = require("electron");

function invoke(channel, payload) {
  return ipcRenderer.invoke(channel, payload);
}

contextBridge.exposeInMainWorld("qooti", {
  // Utility: get file path from File object (for drag-and-drop)
  getPathForFile: (file) => webUtils.getPathForFile(file),

  // App
  getAppInfo: () => invoke("qooti:getAppInfo"),

  // Inspirations
  listInspirations: (params) => invoke("qooti:inspirations:list", params),
  addInspirationsFromFiles: () => invoke("qooti:inspirations:addFromFiles"),
  addInspirationsFromPaths: (paths) => invoke("qooti:inspirations:addFromPaths", { paths }),
  addImageFromBase64: (base64, mimeType) => invoke("qooti:inspirations:addFromBase64", { base64, mimeType }),
  addLinkInspiration: (url, metadata) => invoke("qooti:inspirations:addLink", { url, metadata }),
  fetchLinkPreview: (url) => invoke("qooti:inspirations:fetchLinkPreview", { url }),
  addThumbnailFromUrl: (thumbnailUrl, title) =>
    invoke("qooti:inspirations:addThumbnailFromUrl", { thumbnailUrl, title }),
  downloadVideoFromUrl: (url, title) =>
    invoke("qooti:inspirations:downloadVideoFromUrl", { url, title }),
  updateInspiration: (id, updates) => invoke("qooti:inspirations:update", { id, updates }),
  deleteInspiration: (id) => invoke("qooti:inspirations:delete", { id }),
  copyFileToClipboard: (storedPath) => invoke("qooti:inspirations:copyToClipboard", { storedPath }),
  startDragFile: (storedPath, iconPath) =>
    invoke("qooti:inspirations:startDrag", { storedPath, iconPath: iconPath || null }),
  openFileExternal: (storedPath) => invoke("qooti:inspirations:openExternal", { storedPath }),

  // Collections
  listCollections: () => invoke("qooti:collections:list"),
  createCollection: (name) => invoke("qooti:collections:create", { name }),
  renameCollection: (id, name) => invoke("qooti:collections:rename", { id, name }),
  deleteCollection: (id) => invoke("qooti:collections:delete", { id }),
  addToCollection: (collectionId, inspirationIds) =>
    invoke("qooti:collections:addItems", { collectionId, inspirationIds }),
  removeFromCollection: (collectionId, inspirationIds) =>
    invoke("qooti:collections:removeItems", { collectionId, inspirationIds }),

  // Moodboards
  listMoodboards: () => invoke("qooti:moodboards:list"),
  createMoodboard: (name) => invoke("qooti:moodboards:create", { name }),
  renameMoodboard: (id, name) => invoke("qooti:moodboards:rename", { id, name }),
  deleteMoodboard: (id) => invoke("qooti:moodboards:delete", { id }),
  getMoodboard: (id) => invoke("qooti:moodboards:get", { id }),
  saveMoodboardItems: (moodboardId, items) =>
    invoke("qooti:moodboards:saveItems", { moodboardId, items }),
  addInspirationsToMoodboard: (moodboardId, inspirationIds) =>
    invoke("qooti:moodboards:addInspirations", { moodboardId, inspirationIds }),

  // Preferences
  getPreference: (key) => invoke("qooti:preferences:get", key),
  setPreference: (key, value) => invoke("qooti:preferences:set", { key, value }),

  // Backup
  exportBackup: () => invoke("qooti:backup:export"),
  importBackup: () => invoke("qooti:backup:import"),

  // Window controls
  windowHide: () => invoke("qooti:window:hide"),
  windowMinimize: () => invoke("qooti:window:minimize"),
  windowClose: () => invoke("qooti:window:close"),

  // Events
  onThumbnailUpdated: (handler) => {
    if (typeof handler !== "function") return () => {};
    const listener = (_evt, payload) => handler(payload);
    ipcRenderer.on("qooti:thumb:updated", listener);
    return () => ipcRenderer.removeListener("qooti:thumb:updated", listener);
  },
  onVaultReplaced: (handler) => {
    if (typeof handler !== "function") return () => {};
    const listener = (_evt, payload) => handler(payload);
    ipcRenderer.on("qooti:vault:replaced", listener);
    return () => ipcRenderer.removeListener("qooti:vault:replaced", listener);
  },
  onDownloadProgress: (handler) => {
    if (typeof handler !== "function") return () => {};
    const listener = (_evt, percent) => handler(percent);
    ipcRenderer.on("qooti:download:progress", listener);
    return () => ipcRenderer.removeListener("qooti:download:progress", listener);
  }
});

