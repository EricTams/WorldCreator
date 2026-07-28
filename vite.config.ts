import { execSync } from 'node:child_process'
import { defineConfig } from 'vite'

/**
 * Which commit this bundle was built from.
 *
 * On screen, not just in the console — see `ui/credits.ts`. A deployed game is
 * reached through a phone's home screen and an aggressive HTTP cache, and "am I
 * looking at the new one?" is otherwise unanswerable from the device you are
 * holding. Seven characters in the corner turn it into a fact.
 *
 * Git first, which covers a local build and Actions alike. `GITHUB_SHA` is the
 * fallback for a checkout with no git directory, and `dev` for neither — a dev
 * server is never the build you are trying to identify.
 */
function buildSha(): string {
  try {
    return execSync('git rev-parse --short=7 HEAD', {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim()
  } catch {
    return (process.env.GITHUB_SHA ?? 'dev').slice(0, 7)
  }
}

// GitHub Pages serves a project site from /<repo>/, so built assets must be
// requested from that prefix. Without this the deployed page is a blank screen
// with 404s on every bundle. The dev server keeps '/'.
//
// `isPreview` as well as `build`, because preview runs with command 'serve' and
// keying on that alone gave it the dev base — so it served a bundle that asks
// for /WorldCreator/assets/ from a server rooted at /, and every request fell
// through to the SPA fallback. `npm run preview` returned index.html with a
// text/html content type for every file including the icons and the service
// worker, which is to say the one command for checking a production build
// locally could not load one.
export default defineConfig(({ command, isPreview }) => ({
  base: command === 'build' || isPreview ? '/WorldCreator/' : '/',
  define: {
    __BUILD_SHA__: JSON.stringify(buildSha()),
    // Date only. A timestamp to the second implies a precision that matters, and
    // the question being answered is "is this today's build".
    __BUILD_DATE__: JSON.stringify(new Date().toISOString().slice(0, 10)),
  },
  build: {
    target: 'es2022',
  },
  worker: {
    format: 'es',
  },
}))
