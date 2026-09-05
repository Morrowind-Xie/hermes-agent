import assert from 'node:assert/strict'

import { test } from 'vitest'

import {
  bundledRuntimeImportCheck,
  describeLinuxInputMethod,
  detectRemoteDisplay,
  isWindowsBinaryPathInWsl,
  isWslEnvironment,
  resolveLinuxPasswordStore
} from './bootstrap-platform'

/** `readdirSync` over a fixed tree; throws like ENOENT for anything unstated. */
function fakeReaddir(tree: Record<string, string[]>) {
  return (dir: string): string[] => {
    if (!(dir in tree)) {
      throw Object.assign(new Error(`ENOENT: ${dir}`), { code: 'ENOENT' })
    }

    return tree[dir]
  }
}

const EMPTY_FS = () => {
  throw Object.assign(new Error('ENOENT: no filesystem in this test'), { code: 'ENOENT' })
}

test('isWslEnvironment detects WSL2 env vars on linux', () => {
  assert.equal(isWslEnvironment({ WSL_DISTRO_NAME: 'Ubuntu' }, 'linux'), true)
  assert.equal(isWslEnvironment({ WSL_INTEROP: '/run/WSL/123_interop' }, 'linux'), true)
  assert.equal(isWslEnvironment({}, 'linux', '6.6.87.2-microsoft-standard-WSL2'), true)
  assert.equal(isWslEnvironment({}, 'linux', '6.6.87-generic'), false)
  assert.equal(isWslEnvironment({ WSL_DISTRO_NAME: 'Ubuntu' }, 'darwin'), false)
})

test('isWindowsBinaryPathInWsl blocks Windows binary types on WSL', () => {
  assert.equal(isWindowsBinaryPathInWsl('/mnt/c/Tools/hermes.exe', { isWsl: true }), true)
  assert.equal(isWindowsBinaryPathInWsl('/mnt/c/Tools/hermes.cmd', { isWsl: true }), true)
  assert.equal(isWindowsBinaryPathInWsl('/mnt/c/Tools/hermes.bat', { isWsl: true }), true)
  assert.equal(isWindowsBinaryPathInWsl('/mnt/c/Tools/install.ps1', { isWsl: true }), true)
  assert.equal(isWindowsBinaryPathInWsl('/usr/local/bin/hermes', { isWsl: true }), false)
  assert.equal(isWindowsBinaryPathInWsl('/mnt/c/Tools/hermes.exe', { isWsl: false }), false)
})

test('bundledRuntimeImportCheck selects platform-specific import checks', () => {
  assert.equal(bundledRuntimeImportCheck('win32'), 'import fastapi, uvicorn, winpty')
  assert.equal(bundledRuntimeImportCheck('darwin'), 'import fastapi, uvicorn, ptyprocess')
  assert.equal(bundledRuntimeImportCheck('linux'), 'import fastapi, uvicorn, ptyprocess')
})

test('detectRemoteDisplay keeps GPU on for local sessions', () => {
  // Plain local X11, Wayland, native Windows, native macOS — no remote signal.
  assert.equal(detectRemoteDisplay({ env: { DISPLAY: ':0' }, platform: 'linux' }), null)
  assert.equal(detectRemoteDisplay({ env: { WAYLAND_DISPLAY: 'wayland-0' }, platform: 'linux' }), null)
  assert.equal(detectRemoteDisplay({ env: { SESSIONNAME: 'Console' }, platform: 'win32' }), null)
  assert.equal(detectRemoteDisplay({ env: {}, platform: 'darwin' }), null)
})

test('detectRemoteDisplay does not treat WSLg as remote', () => {
  // WSLg renders locally via vGPU and doesn't show the flicker, so a WSL
  // session with a local DISPLAY keeps hardware acceleration on.
  assert.equal(detectRemoteDisplay({ env: { WSL_DISTRO_NAME: 'Ubuntu', DISPLAY: ':0' }, platform: 'linux' }), null)
  assert.equal(
    detectRemoteDisplay({ env: { WSL_INTEROP: '/run/WSL/1_interop', DISPLAY: ':0' }, platform: 'linux' }),
    null
  )
})

test('detectRemoteDisplay flags SSH sessions on any platform', () => {
  assert.equal(
    detectRemoteDisplay({ env: { SSH_CONNECTION: '1.2.3.4 5 6.7.8.9 22' }, platform: 'linux' }),
    'ssh-session'
  )
  assert.equal(detectRemoteDisplay({ env: { SSH_CLIENT: '1.2.3.4 5 22' }, platform: 'darwin' }), 'ssh-session')
  assert.equal(detectRemoteDisplay({ env: { SSH_TTY: '/dev/pts/0' }, platform: 'win32' }), 'ssh-session')
})

test('detectRemoteDisplay flags forwarded X11 displays but not local ones', () => {
  assert.match(String(detectRemoteDisplay({ env: { DISPLAY: 'localhost:10.0' }, platform: 'linux' })), /x11-forwarding/)
  assert.match(String(detectRemoteDisplay({ env: { DISPLAY: '192.168.1.5:0' }, platform: 'linux' })), /x11-forwarding/)
  assert.equal(detectRemoteDisplay({ env: { DISPLAY: ':1' }, platform: 'linux' }), null)
})

test('detectRemoteDisplay flags RDP sessions', () => {
  assert.match(String(detectRemoteDisplay({ env: { SESSIONNAME: 'RDP-Tcp#7' }, platform: 'win32' })), /^rdp/)
})

test('detectRemoteDisplay honors the HERMES_DESKTOP_DISABLE_GPU override both ways', () => {
  // Force-on even on a local display.
  assert.match(
    String(detectRemoteDisplay({ env: { HERMES_DESKTOP_DISABLE_GPU: '1', DISPLAY: ':0' }, platform: 'linux' })),
    /override/
  )
  // Force-off even over SSH (escape hatch when a remote display has working accel).
  assert.equal(
    detectRemoteDisplay({
      env: { HERMES_DESKTOP_DISABLE_GPU: 'false', SSH_CONNECTION: '1.2.3.4 5 6.7.8.9 22' },
      platform: 'linux'
    }),
    null
  )
})

test('resolveLinuxPasswordStore applies known backends on linux', () => {
  for (const store of ['gnome-libsecret', 'kwallet', 'kwallet5', 'kwallet6', 'basic']) {
    assert.deepEqual(resolveLinuxPasswordStore({ env: { HERMES_DESKTOP_PASSWORD_STORE: store }, platform: 'linux' }), {
      store,
      warning: null
    })
  }
})

test('resolveLinuxPasswordStore is a no-op when the env var is unset', () => {
  assert.deepEqual(resolveLinuxPasswordStore({ env: {}, platform: 'linux' }), { store: null, warning: null })
  assert.deepEqual(resolveLinuxPasswordStore({ env: { HERMES_DESKTOP_PASSWORD_STORE: '  ' }, platform: 'linux' }), {
    store: null,
    warning: null
  })
})

test('resolveLinuxPasswordStore ignores the env var off linux', () => {
  assert.deepEqual(
    resolveLinuxPasswordStore({ env: { HERMES_DESKTOP_PASSWORD_STORE: 'gnome-libsecret' }, platform: 'darwin' }),
    { store: null, warning: null }
  )
  assert.deepEqual(
    resolveLinuxPasswordStore({ env: { HERMES_DESKTOP_PASSWORD_STORE: 'kwallet6' }, platform: 'win32' }),
    { store: null, warning: null }
  )
})

test('resolveLinuxPasswordStore warns on unknown values instead of applying them', () => {
  const result = resolveLinuxPasswordStore({
    env: { HERMES_DESKTOP_PASSWORD_STORE: 'keychain-of-wonders' },
    platform: 'linux'
  })

  assert.equal(result.store, null)
  assert.match(String(result.warning), /keychain-of-wonders/)
})

// ── describeLinuxInputMethod ───────────────────────────────────────────────
//
// WSLg-shaped reports ("Ctrl+Space works everywhere else") are diagnosed from
// desktop.log, so the contract these tests pin is: say nothing when there is
// nothing to say, always echo the facts when an IME is expected, and reserve
// the warning for a host where BOTH bridges are provably absent.

test('describeLinuxInputMethod stays silent off Linux', () => {
  assert.deepEqual(
    describeLinuxInputMethod({
      platform: 'darwin',
      argv: [],
      env: {
        DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/501/bus',
        DISPLAY: ':0',
        GTK_IM_MODULE: 'fcitx',
        LANG: 'zh_CN.UTF-8'
      },
      readdir: fakeReaddir({})
    }),
    { details: '', warning: null }
  )
})

test('describeLinuxInputMethod says nothing when no input method is expected', () => {
  assert.deepEqual(
    describeLinuxInputMethod({
      platform: 'linux',
      argv: [],
      env: { DISPLAY: ':0', LANG: 'C.UTF-8' },
      readdir: EMPTY_FS
    }),
    { details: '', warning: null }
  )
})

test('describeLinuxInputMethod reports the WSLg shape without warning (bus + explicit x11)', () => {
  const { details, warning } = describeLinuxInputMethod({
    platform: 'linux',
    argv: ['--ozone-platform=x11'],
    env: {
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
      DISPLAY: ':0',
      GTK_IM_MODULE: 'fcitx',
      LANG: 'zh_CN.UTF-8',
      QT_IM_MODULE: 'fcitx',
      WAYLAND_DISPLAY: 'wayland-0',
      XMODIFIERS: '@im=fcitx'
    },
    // A dead filesystem here is the interesting case: the session bus alone is
    // a bridge, so no module may be on disk and nothing may be inferred.
    readdir: EMPTY_FS
  })

  assert.match(details, /ozone=x11/)
  assert.match(details, /WAYLAND_DISPLAY=wayland-0/)
  assert.match(details, /im-module=fcitx/)
  assert.match(details, /session-dbus=yes/)
  assert.equal(warning, null)
})

test('describeLinuxInputMethod follows a Wayland session when the app asks for none', () => {
  const { details } = describeLinuxInputMethod({
    platform: 'linux',
    argv: [],
    env: {
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
      GTK_IM_MODULE: 'ibus',
      XDG_SESSION_TYPE: 'wayland'
    },
    readdir: EMPTY_FS
  })

  // Pure-Wayland sessions (XDG_SESSION_TYPE=wayland, no DISPLAY) are the ones an
  // X11-only IME stack cannot serve — the log has to name the backend it picked.
  assert.match(details, /ozone=wayland/)
  assert.match(details, /im-module=ibus/)
})

test('describeLinuxInputMethod counts an installed GTK im-module as a bridge without D-Bus', () => {
  const { details, warning } = describeLinuxInputMethod({
    platform: 'linux',
    argv: [],
    env: { DISPLAY: ':0', GTK_IM_MODULE: 'fcitx', XMODIFIERS: '@im=fcitx' },
    readdir: fakeReaddir({
      '/usr/lib': ['x86_64-linux-gnu'],
      '/usr/lib/x86_64-linux-gnu': ['gtk-3.0', 'gtk-4.0'],
      '/usr/lib/x86_64-linux-gnu/gtk-3.0': ['3.0.0'],
      '/usr/lib/x86_64-linux-gnu/gtk-3.0/3.0.0/immodules': ['im-fcitx5.so', 'im-simple.so'],
      '/usr/lib/x86_64-linux-gnu/gtk-4.0': ['4.0.0'],
      '/usr/lib/x86_64-linux-gnu/gtk-4.0/4.0.0/immodules': []
    })
  })

  assert.match(details, /session-dbus=no/)
  assert.match(details, /gtk-im-modules=fcitx\(gtk3\)/)
  assert.equal(warning, null)
})

test('describeLinuxInputMethod warns with a fix when neither bridge exists', () => {
  const { details, warning } = describeLinuxInputMethod({
    platform: 'linux',
    argv: [],
    env: { DISPLAY: ':0', GTK_IM_MODULE: 'fcitx', LANG: 'zh_CN.UTF-8', XMODIFIERS: '@im=fcitx' },
    readdir: fakeReaddir({})
  })

  assert.match(details, /gtk-im-modules=none/)
  assert.match(String(warning), /no input-method bridge/)
  assert.match(String(warning), /DBUS_SESSION_BUS_ADDRESS/)
  assert.match(String(warning), /fcitx5-frontend-gtk/)
})

test('describeLinuxInputMethod does not report XIM as a missing module', () => {
  const { details, warning } = describeLinuxInputMethod({
    platform: 'linux',
    argv: [],
    env: {
      DISPLAY: ':0',
      GTK_IM_MODULE: 'xim',
      LANG: 'zh_CN.UTF-8',
      QT_IM_MODULE: 'gtk-im-context-simple',
      XMODIFIERS: '@im=xim'
    },
    readdir: fakeReaddir({})
  })

  // `xim` / `*-simple` have no client module to install, so they can never make
  // the "not installed" verdict. A CJK locale still earns the facts line, so
  // support can see what the session actually asked for.
  assert.match(details, /im-module=-/)
  assert.equal(warning, null)
})
