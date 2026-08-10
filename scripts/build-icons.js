/*
  Rasterises the Parallax mark into every icon the products need, from the SVG
  sources that are the actual source of truth.

  Chromium does the rendering because this machine has no librsvg or
  ImageMagick, and `sips` cannot read SVG. `iconutil` packages the macOS
  iconset, which is a system tool and needs no dependency.

  Run with `pnpm run icons` from the repository root.
*/

const { mkdirSync, rmSync, writeFileSync, readFileSync } = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { chromium } = require('@playwright/test');

const root = path.join(__dirname, '..');
const desktopBuild = path.join(root, 'app', 'build');
const extensionIcons = path.join(root, 'ext', 'src', 'icons');

// macOS wants both a 1x and a 2x rendering of each nominal size.
const ICNS_SIZES = [
  ['icon_16x16.png', 16], ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32], ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128], ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256], ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512], ['icon_512x512@2x.png', 1024],
];

const EXTENSION_SIZES = [16, 32, 48, 128];

async function render(page, svgPath, size, outPath) {
  const svg = readFileSync(svgPath, 'utf8');
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<style>html,body{margin:0;padding:0;background:transparent}
     svg{display:block;width:${size}px;height:${size}px}</style>${svg}`,
  );
  await page.screenshot({ path: outPath, omitBackground: true });
}

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ deviceScaleFactor: 1 });

  // macOS .icns for the packaged app.
  const iconset = path.join(desktopBuild, 'icon.iconset');
  rmSync(iconset, { recursive: true, force: true });
  mkdirSync(iconset, { recursive: true });
  for (const [name, size] of ICNS_SIZES) {
    await render(page, path.join(desktopBuild, 'icon.svg'), size, path.join(iconset, name));
  }
  const icns = spawnSync('iconutil', ['-c', 'icns', iconset, '-o', path.join(desktopBuild, 'icon.icns')], {
    encoding: 'utf8',
  });
  if (icns.status !== 0) {
    process.stderr.write(icns.stderr || 'iconutil failed\n');
    process.exit(icns.status || 1);
  }
  rmSync(iconset, { recursive: true, force: true });

  // Dock icons swapped at runtime from Settings. 512 is plenty for a dock tile.
  await render(page, path.join(desktopBuild, 'icon.svg'), 512, path.join(desktopBuild, 'icon-dark.png'));
  await render(page, path.join(desktopBuild, 'icon-light.svg'), 512, path.join(desktopBuild, 'icon-light.png'));

  // Chrome extension. Chrome renders these on both light and dark toolbars, so
  // the plate travels with the mark rather than relying on the surface.
  mkdirSync(extensionIcons, { recursive: true });
  for (const size of EXTENSION_SIZES) {
    await render(
      page,
      path.join(desktopBuild, 'icon.svg'),
      size,
      path.join(extensionIcons, `icon-${size}.png`),
    );
  }

  await browser.close();

  writeFileSync(
    path.join(desktopBuild, 'GENERATED.md'),
    '`icon.icns`, `icon-dark.png`, and `icon-light.png` are generated from the\n'
      + 'SVG sources in this directory, along with the extension icons in\n'
      + '`ext/src/icons`. Edit the SVGs, then run `pnpm run icons`.\n',
  );

  console.log('Wrote icon.icns, dock icons, and 4 extension icons.');
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exit(1);
});
