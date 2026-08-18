'use strict'

const { app, BrowserWindow, dialog, shell, Menu } = require('electron')
const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')
const { checkForUpdates } = require('./updater')

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------
const APP_NAME = 'DeepSeek Harness'
const DSH_HOST = '127.0.0.1'
const STARTUP_TIMEOUT_MS = 40000

let mainWindow = null
let dshChild = null
let dshUrl = null
let quitting = false
let logStream = null

// ---------------------------------------------------------------------------
// 日志：写入 %APPDATA%\DeepSeek Harness\dsh-client.log
// ---------------------------------------------------------------------------
function initLog() {
  try {
    const dir = path.join(app.getPath('userData'))
    fs.mkdirSync(dir, { recursive: true })
    logStream = fs.createWriteStream(path.join(dir, 'dsh-client.log'), { flags: 'a' })
    return logStream
  } catch (_) {
    return null
  }
}

function log(msg) {
  const line = '[' + new Date().toISOString() + '] ' + msg + '\n'
  try {
    if (logStream) logStream.write(line)
  } catch (_) { /* noop */ }
  // 开发调试时可取消注释下一行
  // console.log(line.trim())
}

// ---------------------------------------------------------------------------
// 定位 dsh 运行时
// ---------------------------------------------------------------------------
function resolveDshRuntime() {
  const candidates = [
    path.join(process.resourcesPath || '', 'dsh-runtime'),
    path.join(__dirname, 'dsh-runtime'),
    'D:/Program Files (x86)',
  ]
  for (const root of candidates) {
    if (!root) continue
    const bin = path.join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    if (fs.existsSync(bin)) return { bin, nodeModules: path.join(root, 'node_modules') }
  }
  return null
}

// ---------------------------------------------------------------------------
// 启动 dsh web 子进程
// ---------------------------------------------------------------------------
function startDshServer() {
  const rt = resolveDshRuntime()
  if (!rt) {
    log('FATAL: dsh runtime not found')
    dialog.showErrorBox(APP_NAME, '未找到 DeepSeek Harness 运行时（dsh-runtime 缺失）。')
    app.quit()
    return
  }
  log('dsh runtime: ' + rt.bin)

  const env = Object.assign({}, process.env, {
    ELECTRON_RUN_AS_NODE: '1',
    NODE_OPTIONS: '',
  })
  delete env.DSH_HOME // 使用真实 ~/.dsh，与 Web 端共享数据

  // --expose-internals 是 cordis-plugin-hmr（热重载）必需；缺它 dsh 会启动后崩溃
  const args = ['--expose-internals', rt.bin, 'web', '--host', DSH_HOST, '--port', '0']

  log('spawn: ' + process.execPath + ' ' + args.join(' '))

  dshChild = spawn(process.execPath, args, {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })

  // 缓冲 stdout，避免 URL 被拆到多个 chunk 导致正则漏匹配
  let stdoutBuf = ''
  dshChild.stdout.on('data', (chunk) => {
    const text = chunk.toString()
    log('[dsh:out] ' + text.replace(/\s+$/, ''))
    stdoutBuf += text
    if (dshUrl) return
    const m = stdoutBuf.match(/https?:\/\/127\.0\.0\.1:(\d+)/)
    if (m) {
      dshUrl = 'http://' + DSH_HOST + ':' + m[1]
      log('server ready at ' + dshUrl)
      onServerReady()
    }
  })

  dshChild.stderr.on('data', (chunk) => {
    log('[dsh:err] ' + chunk.toString())
  })

  dshChild.on('error', (err) => {
    log('spawn error: ' + String(err))
    if (quitting) return
    dialog.showErrorBox(APP_NAME, '启动 DeepSeek Harness 服务失败：\n' + String(err))
    app.quit()
  })

  dshChild.on('exit', (code, signal) => {
    log('dsh child exited: code=' + code + ' signal=' + signal)
    dshChild = null
    if (quitting) return
    if (!dshUrl || !mainWindow) {
      dialog.showErrorBox(
        APP_NAME,
        'DeepSeek Harness 服务意外退出（code=' + code + '）。\n日志：' + (logStream ? logStream.path : '无')
      )
      app.quit()
    }
  })

  // 启动超时兜底
  setTimeout(() => {
    if (!dshUrl && !quitting) {
      log('startup timeout after ' + STARTUP_TIMEOUT_MS + 'ms')
      dialog.showErrorBox(
        APP_NAME,
        'DeepSeek Harness 启动超时，请查看日志：\n' + (logStream ? logStream.path : '无')
      )
      app.quit()
    }
  }, STARTUP_TIMEOUT_MS)
}

// ---------------------------------------------------------------------------
// 服务就绪后的处理
// ---------------------------------------------------------------------------
function onServerReady() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.loadURL(dshUrl).catch((err) => {
      log('loadURL failed: ' + String(err))
    })
  }
}

// ---------------------------------------------------------------------------
// 创建主窗口
// ---------------------------------------------------------------------------
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: APP_NAME,
    backgroundColor: '#ffffff',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  })

  // 页面真正加载完成后再显示，避免黑屏/闪烁
  mainWindow.webContents.once('did-finish-load', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show()
  })

  if (dshUrl) {
    mainWindow.loadURL(dshUrl).catch((err) => log('loadURL failed: ' + String(err)))
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://127.0.0.1') || url.startsWith('http://localhost')) {
      return { action: 'allow' }
    }
    shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('http://127.0.0.1') && !url.startsWith('http://localhost')) {
      e.preventDefault()
      shell.openExternal(url)
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
    stopDshServer()
  })
}

// ---------------------------------------------------------------------------
// 生命周期
// ---------------------------------------------------------------------------
function stopDshServer() {
  if (dshChild) {
    try {
      dshChild.kill()
    } catch (_) { /* noop */ }
    dshChild = null
  }
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(() => {
    app.setName(APP_NAME)
    app.setAppUserModelId('ai.deepseek.harness')
    Menu.setApplicationMenu(null)
    initLog()
    log('=== app start v' + app.getVersion() + ' ===')
    startDshServer()
    createWindow()

    // 启动后延迟检查更新（不影响首屏加载）
    setTimeout(() => {
      try {
        checkForUpdates(log)
      } catch (e) {
        log('auto-update: unexpected error: ' + e.message)
      }
    }, 5000)

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('before-quit', () => {
    quitting = true
    stopDshServer()
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
