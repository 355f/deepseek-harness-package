# DeepSeek Harness 桌面客户端

将 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`@deepseek-ai/dsh`）的官方 Web 端封装为 Windows 桌面客户端。

## 技术方案

- **壳**：Electron 43.4.0（`ELECTRON_RUN_AS_NODE` 复用内置 Node 渲染后端）
- **运行时**：内置官方 `dsh` CLI 与完整依赖树（`dsh-runtime/node_modules`，318MB）
- **发行形式**：单文件便携 exe（NSIS portable target），免安装，双击即用
- **目标系统**：Windows 10 / 11，x64
- **数据共享**：使用用户真实 `~/.dsh`（与官方 Web 端共享会话/凭据/插件）
- **模型推理**：调用 DeepSeek 云端 API（需联网 + DeepSeek API Key）

## 启动流程

```
DeepSeek-Harness-*.exe
   └─ electron.exe main.js
        ├─ 清空 NODE_OPTIONS（避免宿主 shim 干扰）
        ├─ ELECTRON_RUN_AS_NODE=1 spawn(electron.exe, [dsh/lib/bin.js, web, --port, 0])
        ├─ 解析 stdout「dsh web: http://127.0.0.1:PORT」获取端口
        └─ BrowserWindow loadURL(http://127.0.0.1:PORT)
```

## 目录结构

```
client/
  main.js                主进程：spawn dsh 子进程 + 创建窗口
  package.json           electron + electron-builder 配置
  build/
    icon.ico / icon.png  DeepSeek 鲸鱼（品牌蓝 #3964fe）
    generate-icon.js       图标生成脚本（用 sharp 栅格化 favicon.svg）
  dsh-runtime/
    node_modules/        完整 dsh 依赖树（extraResources 打包）

.build-output/            产物输出
  DeepSeek-Harness-0.1.0-rc.6-portable.exe
```

## 开发与构建

```sh
# 开发模式（需已装 electron）
cd client
npm start

# 重新生成图标
node build/generate-icon.js

# 构建单文件便携 exe
npm run build
```

## 品牌一致性

| 元素 | 来源 |
|---|---|
| 应用名 | `DeepSeek Harness`（来自 `dsh-web-frontend/dist/index.html`） |
| Logo | DeepSeek 黑色鲸鱼 SVG（来自官方 `favicon.svg` 原始黑色形态） |
| UI 渲染 | 直接渲染官方 React SPA（同一份 `dsh-web-frontend/dist`） |
| 主题 | 官方主题色 `--dsw-alias-brand-primary: #3964fe` |

## 自动更新

客户端启动后会自动检查 GitHub Release（`355f/deepseek-harness-client`）是否有新版本，有则提示下载并自动替换重启。

更新链路：

```
官方 @deepseek-ai/dsh 发新版(npm)
   ↓ GitHub Actions 每天自动检测
自动重打包 → 发布 GitHub Release（tag = v<dsh版本>）
   ↓
客户端启动时检测 → 下载新 exe → 替换自身 → 重启
```

- **版本号约定**：exe 版本 = dsh 版本（`package.json` 的 `version`）
- **发布渠道**：`.github/workflows/auto-release.yml`（每天 08:00 UTC + 手动触发）
- **打包脚本**：`client/build.ps1`（本地/CI 通用，从 npm 安装到产出 exe 全自动）

## 关键决策

- **缓存复用秒启动**：解压到 `%LOCALAPPDATA%\DeepSeek Harness\app-<版本>`，写 marker，二次启动跳过解压秒开。
- **保留 Web 端插件机制**：通过 `~/.dsh/profiles/node_modules` 软链与官方 `dsh web` 启动流程一致，会话/凭据/插件数据完全兼容。

## 故障排查

- 启动闪退：查看 `%APPDATA%\DeepSeek Harness\dsh-client.log`。
- 依赖自愈：`healProfilesModuleFallback` 会在 `~/.dsh/profiles/node_modules/` 创建 junction，如被破坏会在下次启动自动重建。
- 端口冲突：`dsh web --port 0` 由 OS 自动分配空闲端口。