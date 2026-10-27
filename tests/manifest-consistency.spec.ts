/**
 * Manifest consistency guards (mirrors better-sidebar's
 * manifest-consistency.spec.ts): dsh.plugin.json must agree with
 * package.json, the client bundle ids must match their channels, and the
 * built artifacts must exist after `pnpm build`.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { extname, join, resolve, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(__dirname, '..')

function readJson(rel: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(ROOT, rel), 'utf8'))
}

/** A locale dictionary's file stem: the language id the metadata reader keys on. */
const LANGUAGE_ID = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u
/** The four media types `icon` accepts; anything else fails the whole read. */
const ICON_EXTENSIONS = new Set(['.svg', '.png', '.jpg', '.jpeg', '.webp'])
/** The reader's own icon ceiling, from app-boot's package-meta.ts. */
const MAX_ICON_BYTES = 256 * 1024

/** Whether one npm glob entry (`files`, `exports`) names a path: `*` stays inside a segment, `**` crosses them. */
function globMatches(entry: string, path: string): boolean {
  const pattern = entry.replace(/^\.\//u, '').replace(/\/+$/u, '')
    .replace(/[.+^${}()|[\]\\]/gu, '\\$&')
    .replace(/\*\*/gu, '\u0000')
    .replace(/\*/gu, '[^/]*')
    .replace(/\u0000/gu, '.*')
  return new RegExp(`^${pattern}$`, 'u').test(path)
}

describe('manifest consistency', () => {
  const pkg = readJson('package.json')
  const manifest = readJson('dsh.plugin.json')

  it('manifest id uses the dsh-external/ two-segment convention', () => {
    expect(manifest.id).toMatch(/^dsh-external\/[a-z][a-z0-9-]*$/)
  })

  it('manifest version equals package.json version', () => {
    expect(manifest.version).toBe(pkg.version)
  })

  it('manifest main points at the built host entry', () => {
    expect(manifest.main).toBe('./lib/index.js')
    expect(existsSync(join(ROOT, 'lib/index.js'))).toBe(true)
  })

  it('client bundle ids match their install channels', () => {
    // The official profile channel registers with the package name; the
    // registry channel with the manifest id. Assert the built bundles carry
    // the right __ModuleLoader__.load({ id }) heads.
    const client = readFileSync(join(ROOT, 'lib/client.js'), 'utf8')
    const registry = readFileSync(join(ROOT, 'lib/client-registry.js'), 'utf8')
    expect(client).toContain(`id: ${JSON.stringify(pkg.name)}`)
    expect(registry).toContain(`id: ${JSON.stringify(manifest.id)}`)
  })

  it('client bundles exist and are lazy-CJS factories', () => {
    for (const f of ['lib/client.js', 'lib/client-registry.js']) {
      const src = readFileSync(join(ROOT, f), 'utf8')
      expect(src).toContain('window.__ModuleLoader__.load(')
      expect(src).toContain('factory: (require) =>')
    }
  })

  it('cordis.patch.yml mounts the package by name', () => {
    const patch = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8')
    expect(patch).toContain(`name: '${pkg.name}'`)
  })
})

/**
 * Plugin card metadata: what the Plugins page draws on a bundle's card, its
 * detail page, and its row. app-boot's `readPluginMeta()` supplies it WITHOUT
 * evaluating plugin code — `package.json.icon` plus the `./locale/*.json`
 * dictionaries, each resolved through the package's own `exports`. Every rule
 * below is the reader's (packages/boot/app-boot/src/package-meta.ts), because
 * a manifest that drifts from them degrades silently: the card falls back to
 * the package name, the English description, and the built-in artwork.
 */
describe('plugin card metadata', () => {
  const pkg = readJson('package.json')
  const files: string[] = Array.isArray(pkg.files)
    ? pkg.files.filter((entry): entry is string => typeof entry === 'string')
    : []
  const dictionaries = readdirSync(join(ROOT, 'locale')).filter(name => name.endsWith('.json'))
  const icon = typeof pkg.icon === 'string' ? pkg.icon.replace(/^\.\//u, '') : undefined

  it('declares an icon the reader accepts', () => {
    expect(icon).toBeDefined()
    // Relative (absolute paths and URL schemes are refused), one of the four
    // media types, inside the package, and within the size ceiling.
    expect(icon).not.toMatch(/^(?:[A-Za-z][A-Za-z\d+.-]*:|\/|[A-Za-z]:)/u)
    expect(ICON_EXTENSIONS.has(extname(icon ?? '').toLowerCase())).toBe(true)
    const file = resolve(ROOT, icon ?? '')
    expect(file.startsWith(ROOT + sep)).toBe(true)
    expect(existsSync(file)).toBe(true)
    expect(readFileSync(file).byteLength).toBeLessThanOrEqual(MAX_ICON_BYTES)
  })

  it('reaches every locale dictionary through package.json exports', () => {
    // This package declares `exports`, which closes every subpath it does not
    // name: an unexported `./locale/en.json` fails resolution with
    // ERR_PACKAGE_PATH_NOT_EXPORTED and reads as "no locale at all".
    const keys = Object.keys(pkg.exports as Record<string, unknown>)
    const unreachable = [`en.json`, ...dictionaries].map(name => `locale/${name}`)
      .filter(path => !keys.some(key => globMatches(key, path)))
    expect(unreachable).toEqual([])
  })

  it('publishes the icon and every dictionary', () => {
    // metadata is read from the INSTALLED package, so a `files` list that
    // omits them publishes nothing for the reader to find.
    const unpublished = [icon ?? '', ...dictionaries.map(name => `locale/${name}`)]
      .filter(path => !files.some(entry => globMatches(entry, path)))
    expect(unpublished).toEqual([])
  })

  it('keys the dictionaries on language ids, with English present', () => {
    // The reader enumerates every *.json beside the resolved en.json: a stem
    // that is not a language id throws, and a duplicate loses the whole card
    // its title and description rather than just that one file.
    expect(dictionaries).toContain('en.json')
    const ids = dictionaries.map(name => name.slice(0, -'.json'.length))
    expect(ids.filter(id => !LANGUAGE_ID.test(id))).toEqual([])
    expect(new Set(ids.map(id => id.toLowerCase())).size).toBe(ids.length)
  })

  it('carries the display text each dictionary renders', () => {
    const empty: string[] = []
    for (const name of dictionaries) {
      const meta = readJson(`locale/${name}`).meta
      expect(typeof meta).toBe('object')
      for (const field of ['title', 'description'] as const) {
        const value = (meta as Record<string, unknown>)[field]
        if (value === undefined) continue
        // An empty or blank string is refused upstream, which drops the card
        // back to the package name instead of the intended copy.
        if (typeof value !== 'string' || value.trim() === '') empty.push(`${name}: meta.${field}`)
      }
    }
    expect(empty).toEqual([])
  })
})
