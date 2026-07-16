import { app, BrowserWindow, shell, ipcMain, Tray, Menu, nativeImage, Notification } from 'electron'
import { join } from 'path'
import { existsSync } from 'fs'
import { registerIpcHandlers } from './ipc-handlers'

const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged
let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let isQuitting = false

/** Resolve the preload bundle — electron-vite outputs .js (CJS) or .mjs (ESM).
 *  We try both so the app starts regardless of the "type" field in package.json. */
function resolvePreload(): string {
  const base = join(__dirname, '../preload')
  const js = join(base, 'index.js')
  const mjs = join(base, 'index.mjs')
  if (existsSync(js)) return js
  if (existsSync(mjs)) return mjs
  return js // electron-vite dev will create it before starting electron
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    frame: false,
    backgroundColor: '#0d1117',
    webPreferences: {
      preload: resolvePreload(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    show: false,
  })

  // Graceful show after load to avoid white flash
  win.once('ready-to-show', () => {
    win.show()
    if (isDev) win.webContents.openDevTools({ mode: 'detach' })
  })

  // Open external links in the OS browser, not in the app
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (isDev) {
    win.loadURL('http://localhost:5173')
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
}

app.whenReady().then(() => {
  const win = createWindow()
  mainWindow = win
  registerIpcHandlers(win)

  // System tray
  if (process.platform !== 'darwin') {
    // Create a simple 16x16 tray icon from raw pixel data (π glyph)
    const icon = nativeImage.createEmpty()
    tray = new Tray(icon.resize({ width: 16, height: 16 }))
    tray.setToolTip('Pi Tools')
    const contextMenu = Menu.buildFromTemplate([
      { label: 'Show', click: () => win.show() },
      { label: 'Quit', click: () => { isQuitting = true; app.quit() } },
    ])
    tray.setContextMenu(contextMenu)
    tray.on('click', () => win.show())

    // Minimize to tray instead of closing
    win.on('close', (event) => {
      if (!isQuitting) {
        event.preventDefault()
        win.hide()
      }
    })
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => {
  isQuitting = true
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// Custom title bar: handle drag region + window controls via IPC
ipcMain.on('window:minimize', () => BrowserWindow.getFocusedWindow()?.minimize())
ipcMain.on('window:maximize', () => {
  const win = BrowserWindow.getFocusedWindow()
  if (!win) return
  win.isMaximized() ? win.unmaximize() : win.maximize()
})
ipcMain.on('window:close', () => BrowserWindow.getFocusedWindow()?.close())

// System tray notification
ipcMain.handle('notify', (_event, title: string, body: string) => {
  if (Notification.isSupported()) {
    new Notification({ title, body }).show()
    return true
  }
  return false
})
