'use strict'

const { app, dialog } = require('electron')
const https = require('https')
const fs = require('fs')
const { spawn } = require('child_process')

// ---------------------------------------------------------------------------
// 自动更新配置
// ---------------------------------------------------------------------------
// 发布渠道：GitHub 仓库（owner/repo），发布 new exe 的 GitHub Release
// 可在此直接修改，或通过环境变量 DSH_UPDATE_REPO 覆盖
const UPDATE_REPO = process.env.DSH_UPDATE_REPO || '355f/deepseek-harness-client'

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------
function getPortableExePath() {
  const prefix = '--portable-exe='
  for (const arg of process.argv) {
    if (arg.startsWith(prefix)) return arg.slice(prefix.length)
  }
  return null
}

function parseVersion(v) {
  return String(v).replace(/^v/i, '').trim()
}

// 语义化版本对比，支持 0.1.0-rc.6、0.1.0-rc.10、0.1.0-rc.6.1 这类 pre-release
function compareVersion(a, b) {
  const sa = parseVersion(a)
  const sb = parseVersion(b)
  // 主版本号：取 - 前的数字段
  const na = sa.split(/[-+]/)[0].split('.').map(Number)
  const nb = sb.split(/[-+]/)[0].split('.').map(Number)
  const len = Math.max(na.length, nb.length)
  for (let i = 0; i < len; i++) {
    const x = na[i] || 0
    const y = nb[i] || 0
    if (x > y) return 1
    if (x < y) return -1
  }
  // pre-release 部分（如 rc.6、rc.6.1），按 . 分段、数字段按数值比较
  const pa = (sa.split(/[-+]/)[1] || '').split('.')
  const pb = (sb.split(/[-+]/)[1] || '').split('.')
  if (!pa[0] && !pb[0]) return 0
  if (!pa[0]) return 1   // 无 pre-release 视为更新
  if (!pb[0]) return -1
  const plen = Math.max(pa.length, pb.length)
  for (let i = 0; i < plen; i++) {
    const x = pa[i]
    const y = pb[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const nx = parseInt(x, 10)
    const ny = parseInt(y, 10)
    if (!isNaN(nx) && !isNaN(ny)) {
      if (nx > ny) return 1
      if (nx < ny) return -1
    } else {
      if (x > y) return 1
      if (x < y) return -1
    }
  }
  return 0
}

function ghGet(url, log, cb) {
  const req = https.get(url, {
    headers: {
      'User-Agent': 'DeepSeek-Harness-Client',
      'Accept': 'application/vnd.github.v3+json',
    },
  }, (res) => {
    let data = ''
    res.on('data', (c) => { data += c })
    res.on('end', () => cb(null, data, res))
  })
  req.on('error', (e) => cb(e))
  req.setTimeout(15000, () => req.destroy())
}

// ---------------------------------------------------------------------------
// 检查更新
// ---------------------------------------------------------------------------
function checkForUpdates(log) {
  if (!UPDATE_REPO || /OWNER|REPO|yourname/i.test(UPDATE_REPO)) {
    log('auto-update: skipped (UPDATE_REPO not configured)')
    return
  }
  const api = `https://api.github.com/repos/${UPDATE_REPO}/releases/latest`
  log('auto-update: querying ' + api)

  ghGet(api, log, (err, data) => {
    if (err) { log('auto-update: check failed: ' + err.message); return }
    try {
      const rel = JSON.parse(data)
      if (!rel || !rel.tag_name) { log('auto-update: no release found'); return }
      const latest = parseVersion(rel.tag_name)
      const current = parseVersion(app.getVersion())
      log(`auto-update: current=${current} latest=${latest}`)
      if (compareVersion(latest, current) > 0) {
        const asset = (rel.assets || []).find((a) => /\.exe$/i.test(a.name))
        if (asset && asset.browser_download_url) {
          promptUpdate(latest, asset.browser_download_url, log)
        } else {
          log('auto-update: new version but no .exe asset in release')
        }
      }
    } catch (e) {
      log('auto-update: parse failed: ' + e.message)
    }
  })
}

function promptUpdate(latest, url, log) {
  dialog.showMessageBox({
    type: 'info',
    title: '发现新版本',
    message: `DeepSeek Harness 有新版本 v${latest}`,
    detail: '是否立即下载并更新？更新完成后会自动重启。',
    buttons: ['立即更新', '稍后'],
    defaultId: 0,
    cancelId: 1,
  }).then(({ response }) => {
    if (response === 0) downloadAndApply(url, log)
  })
}

// ---------------------------------------------------------------------------
// 下载 + 替换 + 重启
// ---------------------------------------------------------------------------
function downloadAndApply(url, log) {
  const portableExe = getPortableExePath()
  if (!portableExe) {
    log('auto-update: no --portable-exe arg, cannot self-replace')
    dialog.showErrorBox('更新失败', '无法定位便携版文件路径，请手动下载新版。')
    return
  }
  const tmpPath = portableExe + '.new'
  log('auto-update: downloading -> ' + tmpPath)

  const file = fs.createWriteStream(tmpPath)
  const req = https.get(url, { headers: { 'User-Agent': 'DeepSeek-Harness-Client' } }, (res) => {
    // 跟随重定向（GitHub asset 会 302 到 CDN）
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      file.close()
      try { fs.unlinkSync(tmpPath) } catch (_) { /* noop */ }
      downloadAndApply(res.headers.location, log)
      return
    }
    if (res.statusCode !== 200) {
      file.close()
      try { fs.unlinkSync(tmpPath) } catch (_) { /* noop */ }
      log('auto-update: download failed, HTTP ' + res.statusCode)
      dialog.showErrorBox('更新失败', '下载新版本失败（HTTP ' + res.statusCode + '）。')
      return
    }
    res.pipe(file)
    file.on('finish', () => {
      file.close()
      applyUpdate(tmpPath, portableExe, log)
    })
  })
  req.on('error', (e) => {
    log('auto-update: download error: ' + e.message)
    try { fs.unlinkSync(tmpPath) } catch (_) { /* noop */ }
    dialog.showErrorBox('更新失败', '下载新版本失败：' + e.message)
  })
  req.setTimeout(300000, () => req.destroy())
}

function applyUpdate(tmpPath, portableExe, log) {
  try {
    if (fs.existsSync(portableExe)) fs.unlinkSync(portableExe)
    fs.renameSync(tmpPath, portableExe)
    log('auto-update: replaced ' + portableExe)
  } catch (e) {
    log('auto-update: replace failed: ' + e.message)
    dialog.showErrorBox('更新失败', '替换文件失败（可能是文件被占用或权限不足）：' + e.message)
    return
  }

  dialog.showMessageBox({
    type: 'info',
    title: '更新完成',
    message: '新版本已就绪，重启后生效。',
    buttons: ['立即重启', '稍后'],
    defaultId: 0,
    cancelId: 1,
  }).then(({ response }) => {
    if (response === 0) {
      log('auto-update: restarting')
      spawn(portableExe, [], { detached: true, stdio: 'ignore' }).unref()
      app.quit()
    }
  })
}

module.exports = { checkForUpdates }
