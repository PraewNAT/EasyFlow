// Build script for EasyFlow plugin.
// Bundles src/code.ts -> dist/code.js and copies src/ui.html -> dist/ui.html.
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const watch = process.argv.includes('--watch');

if (!fs.existsSync('dist')) fs.mkdirSync('dist');

// When running inside a .claude/worktrees/* worktree, also mirror dist/ back
// to the main repo's dist/ so Figma (which loads the plugin from the main
// repo path) sees the latest build without a manual copy step.
const cwd = process.cwd();
const worktreeMatch = cwd.match(/^(.*)\/\.claude\/worktrees\/[^/]+$/);
const mirrorDist = worktreeMatch ? path.join(worktreeMatch[1], 'dist') : null;
const mirror = (file) => {
  if (!mirrorDist) return;
  try {
    if (!fs.existsSync(mirrorDist)) fs.mkdirSync(mirrorDist, { recursive: true });
    fs.copyFileSync(path.join('dist', file), path.join(mirrorDist, file));
  } catch (err) {
    console.warn(`[easyflow] mirror ${file} failed:`, err.message);
  }
};

const copyUi = () => {
  fs.copyFileSync(path.join('src', 'ui.html'), path.join('dist', 'ui.html'));
  mirror('ui.html');
  console.log('[easyflow] copied ui.html' + (mirrorDist ? ' (+ mirrored)' : ''));
};

const buildOptions = {
  entryPoints: ['src/code.ts'],
  bundle: true,
  outfile: 'dist/code.js',
  target: 'es2017',
  platform: 'browser',
  format: 'iife',
  logLevel: 'info',
  plugins: mirrorDist ? [{
    name: 'mirror-code',
    setup(build) {
      build.onEnd((result) => {
        if (result.errors && result.errors.length) return;
        mirror('code.js');
      });
    },
  }] : [],
};

(async () => {
  if (watch) {
    const ctx = await esbuild.context(buildOptions);
    await ctx.watch();
    copyUi();
    fs.watch(path.join('src', 'ui.html'), () => copyUi());
    console.log('[easyflow] watching for changes...');
  } else {
    await esbuild.build(buildOptions);
    mirror('code.js');
    copyUi();
    console.log('[easyflow] build complete' + (mirrorDist ? ` (mirrored to ${mirrorDist})` : ''));
  }
})();
