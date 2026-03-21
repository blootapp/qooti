const path = require("node:path");

const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");

const { getVaultPaths, ensureVault } = require("./vault/vault");
const { openDb, closeDb } = require("./db/db");
const { registerIpc } = require("./ipc/registerIpc");
const { startDevServer } = require("./serve");

let mainWindow = null;
let db = null;
let vault = null;
let devServer = null;
let baseUrl = null;

async function createWindow() {
  const iconPath = path.join(__dirname, "..", "assets", "icon.png");
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 980,
    minHeight: 640,
    backgroundColor: "#060709",
    title: "qooti",
    icon: iconPath,
    frame: false,
    titleBarStyle: "hidden",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.js")
    }
  });

  mainWindow.removeMenu();

  if (baseUrl) {
    mainWindow.loadURL(`${baseUrl}/src/index.html`);
  } else {
    mainWindow.loadFile(path.join(__dirname, "..", "src", "index.html"));
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
}

async function bootstrap() {
  ensureVault();
  vault = getVaultPaths();
  db = await openDb(vault.dbPath);

  if (!app.isPackaged) {
    try {
      const projectRoot = path.join(__dirname, "..");
      const { server, baseUrl: url } = await startDevServer(projectRoot, vault.root);
      devServer = server;
      baseUrl = url;
    } catch (e) {
      console.warn("[qooti] Dev server failed, using file://", e.message);
    }
  }

  registerIpc({
    ipcMain,
    dialog,
    shell,
    getMainWindow: () => mainWindow,
    getDb: () => db,
    setDb: (nextDb) => {
      db = nextDb;
    },
    getVault: () => vault,
    getBaseUrl: () => baseUrl
  });

  await createWindow();
}

// Register qooti:// protocol so the extension "Open Qooti" launches/focuses this app.
// In dev (process.defaultApp), Electron needs executable + app entry path args.
if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient("qooti", process.execPath, [path.resolve(process.argv[1])]);
  }
} else {
  app.setAsDefaultProtocolClient("qooti");
}

// Single instance: so when extension opens qooti://, we focus this app instead of opening a second window
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}

app.whenReady().then(bootstrap);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// When the app is opened via qooti:// (e.g. from the extension), focus the window
app.on("open-url", (event, url) => {
  event.preventDefault();
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

// Windows/Linux: second instance is launched with protocol URL in commandLine
app.on("second-instance", (event, commandLine) => {
  const url = commandLine.find((a) => a.startsWith("qooti://"));
  if (url && mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.on("before-quit", () => {
  try {
    if (devServer) devServer.close();
  } catch {
    // ignore
  }
  try {
    if (db) closeDb(db);
  } catch {
    // ignore
  }
});

