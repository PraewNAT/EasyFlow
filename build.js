// Build script for EasyFlow plugin.
// Bundles src/code.ts -> dist/code.js and copies src/ui.html -> dist/ui.html.
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const watch = process.argv.includes('--watch');

if (!fs.existsSync('dist')) fs.mkdirSync('dist');

const copyUi = () => {
  fs.copyFileSync(path.join('src', 'ui.html'), path.join('dist', 'ui.html'));
  console.log('[easyflow] copied ui.html');
};

const buildOptions = {
  entryPoints: ['src/code.ts'],
  bundle: true,
  outfile: 'dist/code.js',
  target: 'es2017',
  platform: 'browser',
  format: 'iife',
  logLevel: 'info',
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
    copyUi();
    console.log('[easyflow] build complete');
  }
})();
