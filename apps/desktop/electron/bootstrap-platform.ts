import fs from 'node:fs'

import { linuxOzoneBackend } from './hud-windowing'

function isWslEnvironment(env = process.env, platform = process.platform, kernelRelease = null) {
  if (platform !== 'linux') {
    return false
  }

  if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) {
    return true
  }

  try {
    const release = kernelRelease ?? fs.readFileSync('/proc/sys/kernel/osrelease', 'utf8')

    return /microsoft|wsl/i.test(release)
  } catch {
    return false
  }
}

function isWindowsBinaryPathInWsl(
  filePath,
  options: { isWsl?: boolean; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform } = {}
) {
  const isWsl = options.isWsl ?? isWslEnvironment(options.env, options.platform)

  if (!isWsl) {
    return false
  }

  const normalized = String(filePath || '')
    .replace(/\\/g, '/')
    .toLowerCase()

  return (
    normalized.endsWith('.exe') ||
    normalized.endsWith('.cmd') ||
    normalized.endsWith('.bat') ||
    normalized.endsWith('.ps1')
  )
}

function bundledRuntimeImportCheck(platform = process.platform) {
  return platform === 'win32' ? 'import fastapi, uvicorn, winpty' : 'import fastapi, uvicorn, ptyprocess'
}

const GPU_OVERRIDE_ON = new Set(['1', 'true', 'yes', 'on'])
const GPU_OVERRIDE_OFF = new Set(['0', 'false', 'no', 'off'])

/**
 * Decide whether the app is being shown over a remote/forwarded display, where
 * Chromium's GPU compositor produces an unstable, flickering surface (it can't
 * present accelerated layers cleanly over the wire). Native local Windows/macOS
 * sessions composite locally and never hit this, so we only fall back to
 * software rendering when a remote display is detected.
 *
 * Returns a short reason string when GPU acceleration should be disabled, or
 * null to keep it enabled. `HERMES_DESKTOP_DISABLE_GPU` overrides detection
 * both ways (1/true/yes/on → always disable, 0/false/no/off → never disable).
 *
 * Pure + dependency-free so it can be unit-tested and called before app ready.
 */
function detectRemoteDisplay(options: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform } = {}) {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform

  const override = String(env.HERMES_DESKTOP_DISABLE_GPU || '')
    .trim()
    .toLowerCase()

  if (GPU_OVERRIDE_ON.has(override)) {
    return 'override (HERMES_DESKTOP_DISABLE_GPU)'
  }

  if (GPU_OVERRIDE_OFF.has(override)) {
    return null
  }

  // Launched from an SSH session → the display is X11-forwarded or otherwise
  // remote. Covers the common `ssh user@box` + GUI-forwarding case.
  if (env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY) {
    return 'ssh-session'
  }

  if (platform === 'linux') {
    // X11 forwarding sets DISPLAY to "<host>:N" (e.g. "localhost:10.0"); a
    // local X server is ":0"/":1" with no host part before the colon.
    // NB: WSLg deliberately isn't treated as remote — it reports
    // GPU-accelerated vGPU surfaces locally and doesn't show the flicker.
    const display = String(env.DISPLAY || '')

    if (display.includes(':') && display.split(':')[0]) {
      return `x11-forwarding (DISPLAY=${display})`
    }
  }

  if (platform === 'win32') {
    // RDP sessions report SESSIONNAME like "RDP-Tcp#7"; the local console is
    // "Console".
    const sessionName = String(env.SESSIONNAME || '')

    if (/^rdp-/i.test(sessionName)) {
      return `rdp (SESSIONNAME=${sessionName})`
    }
  }

  return null
}

const LINUX_PASSWORD_STORES = new Set(['gnome-libsecret', 'kwallet', 'kwallet5', 'kwallet6', 'basic'])

/**
 * Resolve the Chromium `--password-store` switch for Linux safeStorage.
 *
 * Without the switch Chromium often fails to pick a keychain backend when the
 * app is launched outside a full desktop session, safeStorage reports
 * encryption as unavailable, and hardening.ts refuses to persist remote
 * gateway tokens. The `hermes desktop` launcher detects the session keychain
 * (or reads `desktop.password_store` from config.yaml) and bridges the value
 * in via HERMES_DESKTOP_PASSWORD_STORE.
 *
 * Returns `{ store, warning }`: `store` is the validated backend to apply (or
 * null to leave Chromium's default), `warning` is a message to log for
 * unrecognized values. Pure + dependency-free so it can be unit-tested and
 * called before app ready.
 */
function resolveLinuxPasswordStore(options: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform } = {}) {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform

  const requested = String(env.HERMES_DESKTOP_PASSWORD_STORE || '').trim()

  if (platform !== 'linux' || !requested) {
    return { store: null, warning: null }
  }

  if (!LINUX_PASSWORD_STORES.has(requested)) {
    return { store: null, warning: `ignoring unknown HERMES_DESKTOP_PASSWORD_STORE value: ${requested}` }
  }

  return { store: requested, warning: null }
}

// ── Linux input-method reachability ────────────────────────────────────────
//
// CJK / dead-key input in Electron is not app logic: whether you can type
// Chinese depends on the *toolkit* being able to reach an input-method
// framework. On X11 a Chromium app only speaks two dialects — the IBus
// protocol over the session bus (which is also how fcitx5's "IBus Frontend"
// addon answers it), and GTK's im-modules (`--gtk-version=4` rides that path).
// startx, SSH forwarding, a systemd-less container and WSLg each drop one of
// those, and every one of them lands on the same maddening symptom: the IME
// hotkey works in every other window and does nothing in this one.
//
// This reports only what the environment can *prove*, and stays silent unless
// an input method was actually asked for, so it never cries wolf for users who
// run without one.

const GTK_LIB_ROOTS = ['/usr/lib', '/usr/lib64', '/lib', '/usr/local/lib']
// Debian-style multiarch prefixes under a lib root (`x86_64-linux-gnu`, …) —
// that, not `/usr/lib/gtk-3.0`, is where GTK's immodules really live.
const MULTIARCH_SEGMENT = /^[a-z0-9_]+-linux(?:-|$)/
const CJK_LOCALE = /^(zh|ja|ko)/

/** The frameworks the session asked apps to route input through. */
function requestedImModules(env: NodeJS.ProcessEnv): string[] {
  const names = new Set<string>()

  for (const key of ['GTK_IM_MODULE', 'QT_IM_MODULE'] as const) {
    const value = String(env[key] || '')
      .trim()
      .toLowerCase()

    if (value && value !== 'none') {
      names.add(value)
    }
  }

  const ximMatch = /@im=([^;\s]+)/i.exec(String(env.XMODIFIERS || ''))

  if (ximMatch) {
    names.add(ximMatch[1].toLowerCase())
  }

  // `xim` is the X server's own protocol and `*-simple` a GTK built-in — neither
  // has a client module file to look for, so asking would only guarantee a
  // false "not installed".
  return [...names].filter(name => name !== 'xim' && !name.endsWith('-simple'))
}

/** Every `immodules` directory GTK could load a client module from. */
function gtkImModuleDirs(readdir: (path: string) => string[]): string[] {
  const roots = new Set(GTK_LIB_ROOTS)

  for (const base of GTK_LIB_ROOTS) {
    let entries: string[]

    try {
      entries = readdir(base)
    } catch {
      continue
    }

    for (const entry of entries) {
      if (MULTIARCH_SEGMENT.test(entry)) {
        roots.add(`${base}/${entry}`)
      }
    }
  }

  const dirs: string[] = []

  for (const root of roots) {
    for (const gtk of ['gtk-3.0', 'gtk-4.0']) {
      let versions: string[]

      try {
        versions = readdir(`${root}/${gtk}`)
      } catch {
        continue
      }

      for (const version of versions) {
        dirs.push(`${root}/${gtk}/${version}/immodules`)
      }
    }
  }

  return dirs
}

/** `<module>(gtk3|gtk4)` for each requested framework present on disk. */
function installedGtkImModules(modules: readonly string[], readdir: (path: string) => string[]): string[] {
  const found = new Set<string>()

  if (!modules.length) {
    return []
  }

  for (const dir of gtkImModuleDirs(readdir)) {
    let files: string[]

    try {
      files = readdir(dir)
    } catch {
      continue
    }

    const toolkit = dir.includes('/gtk-4.0/') ? 'gtk4' : 'gtk3'

    for (const name of modules) {
      if (files.some(file => file.startsWith(`im-${name}`) && file.endsWith('.so'))) {
        found.add(`${name}(${toolkit})`)
      }
    }
  }

  return [...found]
}

/**
 * Describe the Linux input-method situation, and warn when no bridge exists.
 *
 * Returns `{ details, warning }`: `details` is the one-line summary worth
 * having in the log when someone reports "IME works everywhere except Hermes"
 * (empty when there is nothing to diagnose), `warning` an actionable sentence or
 * null. Pure apart from the injected directory reader, so it runs before app
 * `ready` and unit-tests without touching the real filesystem.
 */
function describeLinuxInputMethod(
  options: {
    argv?: readonly string[]
    env?: NodeJS.ProcessEnv
    platform?: NodeJS.Platform
    readdir?: (path: string) => string[]
  } = {}
): { details: string; warning: null | string } {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform

  if (platform !== 'linux') {
    return { details: '', warning: null }
  }

  const modules = requestedImModules(env)
  const locale = String(env.LC_CTYPE || env.LC_ALL || env.LANG || '')

  // No framework requested and no CJK locale: this user is not expecting an
  // input method, so say nothing rather than print a line they can't act on.
  if (!modules.length && !CJK_LOCALE.test(locale)) {
    return { details: '', warning: null }
  }

  const readdir = options.readdir ?? ((path: string) => fs.readdirSync(path))
  const backend = linuxOzoneBackend(env, options.argv ?? process.argv)
  const hasSessionBus = Boolean(String(env.DBUS_SESSION_BUS_ADDRESS || '').trim())
  const gtkModules = installedGtkImModules(modules, readdir)

  const details = [
    `ozone=${backend}`,
    `DISPLAY=${env.DISPLAY || '-'}`,
    `WAYLAND_DISPLAY=${env.WAYLAND_DISPLAY || '-'}`,
    `im-module=${modules.join(',') || '-'}`,
    `session-dbus=${hasSessionBus ? 'yes' : 'no'}`,
    `gtk-im-modules=${gtkModules.length ? gtkModules.join(',') : 'none'}`
  ].join(' ')

  // Either bridge on its own is enough; only the absence of both is a verdict.
  // And a verdict needs a framework someone actually asked for: a CJK locale on
  // its own proves expectation, not brokenness, so it reports facts only.
  if (!modules.length || hasSessionBus || gtkModules.length) {
    return { details, warning: null }
  }

  return {
    details,
    warning:
      `no input-method bridge is reachable: the session asks for "${modules.join('/')}" but ` +
      'there is no session D-Bus for Chromium to speak IBus over, and no GTK im-module for it is ' +
      'installed, so CJK/dead-key input cannot reach this app even where it works elsewhere. Fix ' +
      'either one: launch from inside the graphical session (or export DBUS_SESSION_BUS_ADDRESS), or ' +
      'install the toolkit front-end (e.g. fcitx5-frontend-gtk3 / fcitx5-frontend-gtk4, ibus-gtk3 / ' +
      'ibus-gtk4), then restart Hermes Desktop.'
  }
}

export {
  bundledRuntimeImportCheck,
  describeLinuxInputMethod,
  detectRemoteDisplay,
  isWindowsBinaryPathInWsl,
  isWslEnvironment,
  resolveLinuxPasswordStore
}
