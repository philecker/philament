# App icon

The same spool logo as the app header (outer ring, translucent filament disc, solid hub, center hole), in white on the app's emerald gradient. The 16 and 32 px sizes use slightly thicker lines so the shape stays clear. Drawn on Apple's macOS icon grid: an 824 px rounded "squircle" centered in a 1024 px canvas with a soft drop shadow, like other macOS app icons.

| File | Use |
| --- | --- |
| `icon.svg` | Source artwork |
| `icon.icns` | Mac app icon used by the build (every size, 1x and 2x) |
| `icon.iconset/` | Every size at 1x and 2x (16–512 pt) |
| `icon.png` | 1024 px master, also used as the window icon |
| `icon-16.png` … `icon-512.png` | Single sizes |

The 16 px and 32 px versions use a simplified drawing (rim, filament, hub) so they stay sharp in Finder lists and menus.

To regenerate everything after editing the artwork: `pip install cairosvg pillow`, then `python3 assets/make_icon.py assets`.

## Dark mode

- `icon-dark.png` / `icon-dark.svg`: the dark version (dark slate outside the spool, emerald filament, light hub). The app switches its Dock icon to it while running in dark mode.
- `Philament.icon`: an Icon Composer bundle with both looks (light and dark), used by `npm run build:mac:tahoe` so macOS 26+ picks the right one everywhere. It can be opened and tweaked in Apple's Icon Composer.

All of these are produced by `make_icon.py`.
