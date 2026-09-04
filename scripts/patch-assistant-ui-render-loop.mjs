#!/usr/bin/env node
/**
 * Local workaround for an @assistant-ui/core render loop (Hermes desktop).
 *
 * SYMPTOM (desktop.log, repeatedly, and takes down the workspace pane behind a
 * "“workspace” failed to render" error boundary):
 *
 *   Maximum update depth exceeded. The result of getSnapshot should be cached
 *   to avoid an infinite loop.
 *
 * ROOT CAUSE (third-party, not Hermes code):
 * `LazyMemoizeSubject.getState` in @assistant-ui/core <= 0.2.23 overwrites its
 * own cache with a freshly built object on every rebuild, even when nothing
 * moved. Two consecutive getState() calls therefore return different
 * references, so @assistant-ui/tap's hand-rolled useSyncExternalStore (which
 * keeps `value` in its effect deps and hard-throws at depth 50) force-updates
 * forever.
 *
 * The library fixed this in 0.3.x by only replacing the cached state when it is
 * not shallow-equal (`shallowEqualOrUndefined`). This script backports exactly
 * that one-line guard, using the `shallowEqual` helper already present in the
 * same file, so the pinned 0.2.x line stops looping.
 *
 * Proof it is the right lever: with only this line changed, the 5 desktop test
 * files that reproduce the loop go from 20 failed / 17 passed to 37 passed.
 *
 * DROP THIS once apps/desktop pins @assistant-ui/core >= 0.3 — the script
 * detects the upstream fix and becomes a no-op.
 *
 * Wired into the root `postinstall` so it survives `npm install` and
 * `hermes update`. It never fails the install: an unrecognized file shape
 * prints a loud warning instead, because blocking dependency installation (and
 * with it security updates) is worse than a visible, actionable notice.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const MARKER = '[hermes-render-loop-patch]'
const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

const VULNERABLE = '\t\t\tif (newState !== SKIP_UPDATE) this._previousState = newState;'
const PATCHED =
	`\t\t\t// ${MARKER} keep the cached reference when a rebuild is shallow-equal\n` +
	'\t\t\tif (newState !== SKIP_UPDATE && (this._previousState === void 0 || ' +
	'!shallowEqual(newState, this._previousState))) this._previousState = newState;'

/** Candidate install locations: workspace root first (npm hoists), then local. */
function resolveTarget() {
	const roots = [join(ROOT, 'node_modules'), join(ROOT, 'apps', 'desktop', 'node_modules')]

	for (const root of roots) {
		// Built directly: the package's `exports` map does not expose
		// ./package.json, so require.resolve on a subpath would throw here.
		const file = join(root, '@assistant-ui', 'core', 'dist', 'subscribable', 'subscribable.js')

		try {
			readFileSync(file, 'utf8')

			return file
		} catch {
			// try the next root
		}
	}

	return null
}

const file = resolveTarget()

if (!file) {
	// Not installed yet (e.g. a partial install). Nothing to do, nothing broken.
	console.log('· assistant-ui render-loop patch: @assistant-ui/core not found, skipped')
	process.exit(0)
}

const source = readFileSync(file, 'utf8')

if (source.includes(MARKER)) {
	console.log('· assistant-ui render-loop patch: already applied')
	process.exit(0)
}

// Upstream fixed it (0.3.x). Stop patching — this workaround is now obsolete.
if (source.includes('shallowEqualOrUndefined')) {
	console.log('· assistant-ui render-loop patch: upstream fix detected, no-op (this script can be removed)')
	process.exit(0)
}

const hits = source.split(VULNERABLE).length - 1

if (hits !== 1) {
	console.warn(
		[
			'',
			`⚠  assistant-ui render-loop patch: EXPECTED 1 vulnerable line in ${file}, found ${hits}.`,
		'⚠  The library file shape changed and this workaround was NOT applied.',
		'⚠  The desktop "workspace failed to render" render loop may be back.',
		'⚠  Re-check scripts/patch-assistant-ui-render-loop.mjs against the installed',
		'⚠  @assistant-ui/core, or drop the workaround if the fix is upstream.',
		''
	].join('\n')
	)
	process.exit(0)
}

writeFileSync(file, source.replace(VULNERABLE, PATCHED), 'utf8')
console.log('✓ assistant-ui render-loop patch: applied to @assistant-ui/core')
