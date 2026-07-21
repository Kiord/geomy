import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

function git(args, fallback = '') {
  try {
    return execFileSync('git', args, { encoding: 'utf8' }).trim();
  } catch {
    return fallback;
  }
}

function githubBaseUrl(remote) {
  const value = String(remote || '').trim();
  const ssh = value.match(/^git@github\.com:(.+?)(?:\.git)?$/);
  if (ssh) return `https://github.com/${ssh[1]}`;

  const https = value.match(/^https:\/\/github\.com\/(.+?)(?:\.git)?$/);
  if (https) return `https://github.com/${https[1]}`;

  return '';
}

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const commitHash = git(['rev-parse', 'HEAD']);
const shortCommitHash = git(['rev-parse', '--short=8', 'HEAD']);
const githubUrl = githubBaseUrl(git(['config', '--get', 'remote.origin.url']));
const commitUrl = githubUrl && commitHash ? `${githubUrl}/commit/${commitHash}` : '';

export default defineConfig({
  define: {
    __GEOMY_VERSION__: JSON.stringify(pkg.version || ''),
    __GEOMY_COMMIT_HASH__: JSON.stringify(commitHash),
    __GEOMY_COMMIT_SHORT_HASH__: JSON.stringify(shortCommitHash),
    __GEOMY_COMMIT_URL__: JSON.stringify(commitUrl),
  },
});
