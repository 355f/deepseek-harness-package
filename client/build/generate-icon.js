'use strict'
/**
 * 生成 DeepSeek Harness 应用图标（可移植，CI/本地通用）：
 * 1. 从官方 dsh-web-frontend 的 favicon.svg 提取鲸鱼 path，重着色为黑色 #000000
 * 2. 用 sharp 栅格化为透明背景 PNG（512/256/128/64/48/32/24/16）
 * 3. 组装为 PNG-embedded 多尺寸 ICO，并输出 icon.png（512）
 *
 * 依赖：sharp（本地 node_modules 或全局）
 * 源：安装 @deepseek-ai/dsh 后提供的 dsh-web-frontend/dist/favicon.svg
 */
const path = require('path')
const fs = require('fs')

// 解析 sharp：优先本地 node_modules，回退全局安装
let sharp
try { sharp = require('sharp') }
catch (_) {
  try { sharp = require('D:/Program Files (x86)/node_modules/sharp') }
  catch (e) {
    console.error('未找到 sharp，请先 `npm install sharp`')
    process.exit(1)
  }
}

const BRAND = '#000000'

// 候选 favicon 源（dsh 安装后可能出现的位置）
const CANDIDATES = [
  path.join(__dirname, '..', 'dsh-runtime', 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist', 'favicon.svg'),
  path.join(__dirname, '..', 'staging', 'app', 'resources', 'dsh-runtime', 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist', 'favicon.svg'),
  path.join(__dirname, '..', 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist', 'favicon.svg'),
]
const SRC = CANDIDATES.find((p) => fs.existsSync(p))
if (!SRC) {
  console.error('找不到 favicon.svg，请先安装 @deepseek-ai/dsh（npm install @deepseek-ai/dsh）')
  process.exit(1)
}
const OUT_DIR = __dirname

// 1. 提取鲸鱼 path 并重建干净 SVG
const raw = fs.readFileSync(SRC, 'utf8')
const dMatch = raw.match(/<path[^>]*\sd="([^"]+)"[^>]*\/?>/)
if (!dMatch) {
  console.error('未能从 favicon.svg 提取 path 数据')
  process.exit(1)
}
const d = dMatch[1]
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 50 50" fill="none">
  <path d="${d}" fill="${BRAND}" fill-rule="nonzero"/>
</svg>`

// 2. 栅格化 + 多尺寸
const SIZES = [512, 256, 128, 64, 48, 32, 24, 16]

async function main() {
  // 主图标 512
  const png512 = await sharp(Buffer.from(svg)).resize(512, 512).png().toBuffer()
  fs.writeFileSync(path.join(OUT_DIR, 'icon.png'), png512)

  // 各尺寸 PNG（供 ICO 使用）
  const pngs = []
  for (const s of SIZES) {
    const buf = await sharp(Buffer.from(svg)).resize(s, s).png().toBuffer()
    pngs.push({ size: s, buf })
  }

  // 3. 组装 ICO（PNG-embedded）
  const count = pngs.length
  const headerSize = 6 + count * 16
  let offset = headerSize
  const header = Buffer.alloc(headerSize)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(count, 4) // count

  const chunks = []
  pngs.forEach((p, i) => {
    const entry = 6 + i * 16
    const dim = p.size >= 256 ? 0 : p.size
    header.writeUInt8(dim, entry) // width
    header.writeUInt8(dim, entry + 1) // height
    header.writeUInt8(0, entry + 2) // palette
    header.writeUInt8(0, entry + 3) // reserved
    header.writeUInt16LE(1, entry + 4) // planes
    header.writeUInt16LE(32, entry + 6) // bpp
    header.writeUInt32LE(p.buf.length, entry + 8) // size
    header.writeUInt32LE(offset, entry + 12) // offset
    offset += p.buf.length
    chunks.push(p.buf)
  })

  const ico = Buffer.concat([header, ...chunks])
  fs.writeFileSync(path.join(OUT_DIR, 'icon.ico'), ico)

  console.log('生成完成:')
  console.log('  icon.png  512x512  (' + png512.length + ' bytes)')
  console.log('  icon.ico  多尺寸    (' + ico.length + ' bytes, ' + count + ' sizes)')
}

main().catch((e) => {
  console.error('图标生成失败:', e)
  process.exit(1)
})
