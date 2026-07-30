import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const packageJsonPath = path.join(projectRoot, 'package.json')
const tauriConfigPath = path.join(projectRoot, 'src-tauri', 'tauri.conf.json')
const cargoManifestPath = path.join(projectRoot, 'src-tauri', 'Cargo.toml')

const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'))
const version = packageJson.version

if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error(`Invalid package version: ${version}`)
}

const tauriConfig = JSON.parse(readFileSync(tauriConfigPath, 'utf8'))
tauriConfig.version = version
writeFileSync(tauriConfigPath, `${JSON.stringify(tauriConfig, null, 2)}\n`)

const cargoManifest = readFileSync(cargoManifestPath, 'utf8')
const updatedCargoManifest = cargoManifest.replace(
  /(\[package\][\s\S]*?\nversion\s*=\s*")[^"]+(")/,
  (_match, prefix, suffix) => `${prefix}${version}${suffix}`,
)

if (updatedCargoManifest === cargoManifest && !cargoManifest.includes(`version = "${version}"`)) {
  throw new Error('Could not update the package version in src-tauri/Cargo.toml')
}

writeFileSync(cargoManifestPath, updatedCargoManifest)

if (process.env.npm_lifecycle_event === 'version') {
  execFileSync('git', ['add', tauriConfigPath, cargoManifestPath], {
    cwd: projectRoot,
    stdio: 'inherit',
  })
}

console.log(`Synchronized Tauri version to ${version}`)
