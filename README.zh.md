# Chronos Seal GUI

**时序为封印 · 行为作密钥 · 岁月守护原创**

---

[English](./README.md) | [简体中文](./README.zh.md)

---

[![Platform](https://img.shields.io/badge/platform-Windows%2032%2F64-blue)]()
[![Electron](https://img.shields.io/badge/Electron-22.3.27-blue.svg)](https://www.electronjs.org/)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-1.0.0-red.svg)]()
[![Docs](https://img.shields.io/badge/docs-docs.crclare.top-blue)](https://docs.crclare.top)

---

> **⚠ 项目状态：预准备阶段**
>
> Chronos Seal GUI 目前处于发布前的预准备阶段。
> 待核心链路端到端验证通过后，将开启公测。
>
> 关于贡献指南、安全策略与代码签名协议，请参见
> [主仓库](https://github.com/CrCLARE/Chronos-Seal)。

---

**用途**：为 [Chronos Seal](https://github.com/CrCLARE/Chronos-Seal) 提供桌面端配套工具 —— 不碰命令行，即可完成 RPG Maker MV / MZ 游戏资源加密与增量补丁分发。

**核心哲学**：把整条加密链路封装成引导式 GUI。零本地工具链、零配置文件、零手动步骤。

**说明**：本仓库**仅提供源码**。终端用户请前往 [主仓库](https://github.com/CrCLARE/Chronos-Seal/releases) 下载编译好的发行包。希望自行编译的开发者请参考下方开发章节。

## 关于本项目

GUI 把 Chronos Seal 的完整流程变成一次点击到底的体验 —— 从引擎选择到加密发行包，独立创作者全程无需打开终端。

它负责管理：

- **引擎检测** —— 根据你的 RPG Maker 工程自动分流 MV / MZ
- **Node.js 检测与安装** —— 按 Windows 版本自动下载并静默安装
- **GitHub OAuth** —— 一键登录、自动 Fork 构建模板、触发云端编译
- **资源加密** —— 调用核心 `encrypt_assets.js` / 原生 `.node` 链路
- **增量补丁** —— 生成 `patch_MZ.zip` / `patch_MV.zip` 分发给玩家
- **内核管理** —— 通过 Ed25519 签名校验安全热更新加密内核
- **双语界面** —— 简体中文 / English

GUI 本身**不包含任何加密逻辑**。所有密码学工作都在 `Tools/` 下的内核脚本中完成，可独立签名与验证。

## 下载

**两个位置，两种用途 —— 请按需选择：**

- **预编译 GUI（普通用户推荐）**
  前往 [主仓库 Releases](https://github.com/CrCLARE/Chronos-Seal/releases) 下载。
  解压到任意目录（推荐 D 盘），双击 `Chronos Seal.exe` 即可运行。

- **源码（开发者使用）**
  你现在就在源码仓库里。克隆后按下方开发章节本地编译。

> 预编译 GUI 统一发布在主仓库，便于集中管理面向用户的产物。

## 系统要求

- **Windows 10 / 11**（Windows 7 / 8 / 8.1 需先安装 [KB2533623](https://www.microsoft.com/en-us/download/details.aspx?id=52685)）
- **无需安装 Node.js、Python 或 MSVC** —— GUI 会自动处理 Node.js 安装
- **RPG Maker MV / MZ 工程** —— 你想保护的那款游戏

## 关于安全警告

预编译 GUI 使用 **CrCLARE Studio 自签名证书**，首次启动时 Windows Defender 可能提示「未知发布者」。

请点击 **「更多信息」→「仍要运行」**，或参考 [文档](https://docs.crclare.top) 手动添加信任。

**证书指纹（SHA-1）：**

```

24B6F02C01DE207A4AF55AFC8EA61BE3D420B431

```

核对方式：右键 `Chronos Seal.exe` → 属性 → 数字签名 → 详细信息 → 指纹。

## 关于盲代理

GUI 使用可选代理 `proxy.crclare.top`，仅用于 GitHub OAuth 临时令牌交换。

- 代理只转发 OAuth code，不存储、不记录任何用户密钥或 access token
- 部署于 Vercel Serverless，前置 Cloudflare WAF 防护
- 如不信任公共代理，可 Fork [代理仓库](https://github.com/CrCLARE/Chronos-Seal-Proxy)，部署到自己的 Vercel，并修改 GUI 配置

## 内核校验

GUI 会从 GitHub 热更新加密内核。每次内核发布都会经过 **Ed25519 签名校验**，通过后才允许执行：

1. GUI 从内核仓库下载 `manifest.json` 和 `manifest.sig`
2. 使用内置在 GUI 里的硬编码公钥验签 `manifest.sig`
3. 使用验签通过的清单逐个校验内核脚本哈希
4. 任一项不匹配 → 拒绝执行、弹出警告、写入日志

这意味着即使内核仓库或 CDN 被攻破，被篡改的内核也无法执行。

## 开发

### 环境要求

- Node.js 18+
- Windows 10 / 11

### 本地运行

```bash
npm install
npm start
```

打包便携版 zip

```bash
set CSC_KEY_PASSWORD=<你的证书密码>
npm run dist
```

产出：dist/Chronos-Seal-1.0.0.zip

项目结构

```
Chronos-Seal-GUI/
├── main.js              Electron 主进程
├── preload.js           上下文桥接（window.__TAURI__ 伪装）
├── sign.js              内核签名工具
├── src/
│   ├── index.html       前端（全部 UI + 内联逻辑）
│   └── styles.css       深色主题
├── Tools/
│   └── V2.2/
│       ├── MV/          MV 内核脚本
│       └── MZ/          MZ 内核脚本
└── .github/workflows/
    ├── sign-kernel.yml  提交时自动签名内核
    └── build.yml       打 tag 时自动打包 GUI
```

相关仓库

· 主仓库 —— https://github.com/CrCLARE/Chronos-Seal
· 构建模板 —— https://github.com/CrCLARE/Chronos-Builder-Template
· 代理仓库 —— https://github.com/CrCLARE/Chronos-Seal-Proxy
· 文档 —— https://docs.crclare.top
· 官网 —— https://crclare.top
· 博客 —— https://blog.crclare.top

参与贡献

本项目遵循主仓库的贡献指南、安全策略与代码签名协议。

· 贡献指南 —— 见 CONTRIBUTING.md
· 安全策略 —— 见 SECURITY.md
· 代码签名协议 —— 见 CODE_SIGNING.md

预准备阶段仅接受 bug 修复。新功能请求推迟到公测之后再评估。

许可证

本项目采用 MIT License 开源。详见 LICENSE 文件。

· ✅ 允许：将 Chronos Seal GUI 集成进你的工作流、按需修改自用、按 MIT 条款再分发
· ❌ 严禁：将 GUI 作为独立商业产品售卖、或去除版权声明后售卖

简单来说：你可以自由使用 Chronos Seal GUI，但不能售卖 GUI 本身。

联系

· 作者：CLARE-XHL
· 主项目：https://github.com/CrCLARE/Chronos-Seal
· 文档：https://docs.crclare.top
· 代码签名政策见 CODE_SIGNING.md

⭐ 如果本项目对你有帮助，欢迎给 主仓库 点一个 Star！
