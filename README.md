# Chronos Seal GUI

**Time as the seal · Action as the key · Time itself guards originality**

---

[English](./README.md) | [简体中文](./README.zh.md)

---

[![Platform](https://img.shields.io/badge/platform-Windows%2032%2F64-blue)]()
[![Electron](https://img.shields.io/badge/Electron-22.3.27-blue.svg)](https://www.electronjs.org/)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-1.0.0-red.svg)]()
[![Docs](https://img.shields.io/badge/docs-docs.crclare.top-blue)](https://docs.crclare.top)

---

> **⚠ Project Status: Pre-release Preparation**
>
> Chronos Seal GUI is currently in the pre-release preparation stage.
> A public beta will be released once the core pipeline is validated end-to-end.
>
> For contribution guidelines, security policy, and code signing agreement,
> please refer to the [main repository](https://github.com/CrCLARE/Chronos-Seal).

---

**Purpose**: A desktop companion for [Chronos Seal](https://github.com/CrCLARE/Chronos-Seal) — encrypt RPG Maker MV / MZ game assets and deliver incremental patches without touching a command line.

**Core Philosophy**: Wrap the entire encryption pipeline into a guided GUI. Zero local toolchain, zero config files, zero manual steps.

**Note**: This repository contains **source code only**. End users should download the pre-built release from the [main repository](https://github.com/CrCLARE/Chronos-Seal/releases). Developers who want to build from source should follow the instructions below.

## About This Project

The GUI turns the entire Chronos Seal workflow into a click-through experience — from engine selection to encrypted distribution package — so indie creators never need to open a terminal.

It manages:

- **Engine detection** — MV / MZ auto-routing based on your RPG Maker project
- **Node.js detection & installation** — automatic per-Windows-version download and silent install
- **GitHub OAuth** — one-click login, automatic fork of the builder template, cloud compile trigger
- **Asset encryption** — invokes the core `encrypt_assets.js` / native `.node` pipeline
- **Incremental patching** — generates `patch_MZ.zip` / `patch_MV.zip` for player delivery
- **Kernel management** — signed hot-update of the encryption kernel via Ed25519 verification
- **Bilingual UI** — Simplified Chinese / English

The GUI itself does **not** contain any encryption logic. All cryptographic work happens inside the kernel scripts under `Tools/`, which are signed and independently verifiable.

## Download

**Two locations, two purposes — please choose the right one:**

- **Pre-built GUI (recommended for users)**
  Download from the [main repository Releases](https://github.com/CrCLARE/Chronos-Seal/releases).
  Unzip anywhere (D: drive recommended) and double-click `Chronos Seal.exe`.

- **Source code (for developers)**
  You are already in the source repository. Clone it and build locally — see [Development](#development).

> The pre-built GUI is published on the main repository to keep all user-facing artifacts in one place.

## System Requirements

- **Windows 10 / 11** (Windows 7 / 8 / 8.1 supported with [KB2533623](https://www.microsoft.com/en-us/download/details.aspx?id=52685))
- **No Node.js, Python, or MSVC required** — the GUI handles Node.js installation automatically
- **RPG Maker MV / MZ project** — the game you want to protect

## About the Security Warning

The pre-built GUI is signed with a **CrCLARE Studio self-signed certificate**. Windows Defender may show *"Unknown publisher"* on first launch.

Click **"More info" → "Run anyway"**, or follow the [documentation](https://docs.crclare.top) to add trust manually.

**Certificate thumbprint (SHA-1):**

```

24B6F02C01DE207A4AF55AFC8EA61BE3D420B431

```

Verify via: right-click `Chronos Seal.exe` → Properties → Digital Signatures → Details → Thumbprint.

## About the Blind Proxy

The GUI uses an optional proxy at `proxy.crclare.top` for GitHub OAuth token exchange only.

- The proxy forwards OAuth codes — it never stores or logs user keys or access tokens
- Deployed on Vercel Serverless behind Cloudflare WAF
- If you prefer, fork the [proxy repository](https://github.com/CrCLARE/Chronos-Seal-Proxy), deploy it to your own Vercel, and point the GUI to your endpoint

## Kernel Verification

The GUI hot-updates its encryption kernel from GitHub. Every kernel release is verified with **Ed25519 signature checking** before execution:

1. GUI downloads `manifest.json` and `manifest.sig` from the kernel repository
2. Verifies `manifest.sig` against a hardcoded public key baked into the GUI
3. Uses the verified manifest to hash-check every kernel script
4. Any mismatch → execution refused, warning shown, log written

This means even if the kernel repository or CDN is compromised, a modified kernel cannot be executed.

## Development

### Requirements

- Node.js 18+
- Windows 10 / 11

### Run locally

```bash
npm install
npm start
```

Build portable zip

```bash
set CSC_KEY_PASSWORD=<your-cert-password>
npm run dist
```

Output: dist/Chronos-Seal-1.0.0.zip

Project structure

```
Chronos-Seal-GUI/
├── main.js              Electron main process
├── preload.js           Context bridge (window.__TAURI__ shim)
├── sign.js              Kernel signing tool
├── src/
│   ├── index.html       Frontend (all UI + inline logic)
│   └── styles.css       Dark theme
├── Tools/
│   └── V2.2/
│       ├── MV/          MV kernel scripts
│       └── MZ/          MZ kernel scripts
└── .github/workflows/
    ├── sign-kernel.yml  Auto-sign kernel on commit
    └── build.yml        Auto-build GUI on tag
```

Related Repositories

· Main Repo — https://github.com/CrCLARE/Chronos-Seal
· Builder Template — https://github.com/CrCLARE/Chronos-Builder-Template
· Proxy Repo — https://github.com/CrCLARE/Chronos-Seal-Proxy
· Documentation — https://docs.crclare.top
· Website — https://crclare.top
· Blog — https://blog.crclare.top

Contributing

This project follows the contribution guidelines, security policy, and code signing agreement of the main repository.

· Contribution guidelines — see CONTRIBUTING.md
· Security policy — see SECURITY.md
· Code signing agreement — see CODE_SIGNING.md

Only bug fixes are accepted for the GUI during the pre-release stage. New feature requests are deferred until after the public beta.

License

This project is open-sourced under the MIT License. See the LICENSE file for details.

· ✅ Allowed: Integrate Chronos Seal GUI into your workflow, modify for your own use, redistribute under MIT terms
· ❌ Strictly Prohibited: Selling the GUI as a standalone commercial product, or removing copyright notices

In simple terms: You can use Chronos Seal GUI freely, but you cannot sell the GUI itself.

Contact

· Author: CLARE-XHL
· Main Project: https://github.com/CrCLARE/Chronos-Seal
· Documentation: https://docs.crclare.top
· For code signing policy, see CODE_SIGNING.md

⭐ If this project has been helpful to you, please give the main repository a Star!
