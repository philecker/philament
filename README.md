# Philament

A companion app for 3D printing on macOS and Windows: a model library with 3D preview, saved models from any site, your MakerWorld uploads, a filament guide with inventory, and a unit converter.

Version 0.1.0

## Screenshots

![The Library: model folders, a 3D preview, the unit converter and the filament guide](docs/screenshots/library.png)

| Uploads | Saved |
| --- | --- |
| ![Uploads: MakerWorld profile, uploads with stats and trends](docs/screenshots/uploads.png) | ![Saved: models saved from different sites](docs/screenshots/saved.png) |

| Dark mode | Settings |
| --- | --- |
| ![The Library in dark mode](docs/screenshots/library-dark.png) | ![Settings](docs/screenshots/settings.png) |

## Features

### Models
- Add one or more folders with the + button, or drag a folder onto the Models section. Every subfolder shows, up to 12 levels deep, including symlinked folders and folders that don't have model files yet.
- Lists STL, 3MF and sliced files (`.gcode.3mf`, `.gcode`), newest first, with search.
- Fusion designs (`.f3d`) are listed too. They open in Autodesk Fusion (button, double-click or Enter) and show the picture saved in the file when there is one. Fusion's format is closed, so there's no 3D preview, and Fusion imports a local .f3d into one of your cloud projects when it opens it.
- Click a file for a 3D preview you can rotate and zoom, with its size in mm. Bambu Studio and OrcaSlicer projects, including multi-object plates, are supported; project and sliced files also show their plate thumbnail.
- Open any file in your slicer with one click, a double-click, or Enter. Bambu Studio, OrcaSlicer, PrusaSlicer, Cura and others are found automatically; change it from the slicer chip or Settings.
- Files keep their folder structure: each added folder is a tree you can open and close, and Philament remembers which folders are open. Searching opens the folders that contain matches.
- Hide files or whole folders you don't want to see (the eye button, or right-click → Hide from Philament). Hidden items stay on disk; the "N hidden" button shows them again so you can unhide them.
- Drag a file onto a folder (or onto any file in it) to move it there. Hover over a closed folder to open it while dragging. If a file with that name is already there, choose Keep Both or Replace (the old one goes to the Trash). **Undo** puts it back.
- Delete a file with the trash button, right-click → Move to Trash, or ⌘⌫ (Ctrl+Delete on Windows). It goes to the Trash (the Recycle Bin on Windows), so you can put it back.
- The list rescans when you switch back to the app, so new slices show up.

### Uploads (MakerWorld)
- An **Uploads** tab (or ⌘2) for keeping an eye on your own MakerWorld uploads. Enter your username (or paste your profile link) once; no sign-in is needed.
- Your profile at the top, with totals for downloads, prints, likes, collections, followers and boosts.
- Every upload with its downloads, prints, likes and comments, a 14-day trend line, and the change this week. Each column heading shows the total of what's listed, e.g. Downloads (8,549). Sort by most downloaded, printed, liked, trending this week, newest or title; search; filter to models with new comments or boosts.
- Click a model for a bigger picture, its numbers, downloads per day for the last 30 days, and its latest comments, with an **Edit on MakerWorld** button. Double-click a model (or press Enter) to open it on MakerWorld.
- New comments since you last looked show on the model and on the tab.
- MakerWorld keeps no public history, so Philament saves your numbers once a day on your computer (checking every few hours while it's open). Trends fill in as days go by. Disconnecting in **Settings → MakerWorld** removes that history.
- MakerWorld has no official API. This reads the same public information anyone can see on your profile, using the endpoints MakerWorld's own pages use, so it could stop working if MakerWorld changes them. Editing always happens on makerworld.com.

### Saved models
- A **Saved** tab (switch at the top of the window, or ⌘3) for models you find on any 3D printing site: MakerWorld, Printables, Thingiverse, Cults, Thangs, MyMiniFactory and any other site.
- Paste a link into the box, press ⌘V on the Saved tab, or drag a link in from your browser. Links typed without `https://` work too.
- Each saved model becomes a card with its picture, title, designer (when the site lists one) and the site it came from. **Open on Printables** (or MakerWorld, Thingiverse…) (in that site's own color) and the link button both take you back to the original page. **Copy Link** is in the ··· menu.
- Tag saved models: click **+ Tag** on a card (type several at once, separated by commas; existing tags are suggested). Click the × on a tag to remove it, or press Backspace in an empty tag box to remove the last one.
- Filter by site or by tag (click a tag in the Tags row or on a card; click it again to clear), and search titles, designers and tags. Right-click a tag in the Tags row to remove it from every model.
- Right-click a card (or use the ··· button) to add a tag, rename, choose your own picture, refresh from the site, or remove (with Undo).
- Printables models are read through Printables' own public API, so its bot protection doesn't get in the way.
- Other sites with bot protection turn away quick automated requests. When that happens Philament opens the page in a hidden, locked-down browser window (no access to your files, no popups, downloads or sound), lets it load like a normal visit, and reads the details from there. This takes a few extra seconds. If the site asks you to confirm you're human, that window appears so you can answer it once; the site remembers it for later saves.
- If a site still can't be read, the card still saves with a title taken from the link, and you can try again later. Pictures are kept on your computer, so cards load instantly and work offline.

### Filament
- Nozzle, bed and drying temperature/time for PLA, PETG, ABS, TPU, PA-CF, ASA, PLA-CF and PETG-CF.
- Add, rename or remove filaments and edit every value with **Edit**.
- Track spools with their brand, product line (Basic, Matte, Silk+…), color and quantity. Typing a common color name fills in the color swatch; you can also pick one by hand.
- The Inventory sits at the top of the Filament section, with the nozzle, bed and drying temperatures below it.
- **Add Filament** offers the 10 most common types (PLA, PETG, ABS, TPU, ASA, PLA-CF, PETG-CF, PA, PC, PVA) with typical settings filled in. Choose **Other…** to type your own; it's added to the list for next time (remove it with its ×).
- The Inventory lists one row per brand with its color dots and total; click a brand to see every spool of that brand. Philament remembers which brands you left open.
- An optional buy link shows as a **Buy** button.

### Unit converter
- Millimeters ↔ inches, and fractions ↔ decimals (1/4, 1-1/2, 1 1/2; nearest fraction up to 1/64).
- Click the green result to copy it.

### Updates
- Philament checks GitHub for a newer release when it opens and every 6 hours after that. When there is one, a banner appears at the top with **What's New** (the release notes), **Later** and **Download Update**.
- **Download Update** downloads the right installer for your computer (Mac: Apple silicon or Intel; Windows: x64 or ARM) into your Downloads folder, with progress and Cancel. **Install & Quit** then opens the installer and quits Philament.
  - On a Mac, drag Philament into Applications, choose **Replace**, and open it again.
  - On Windows, the installer updates Philament and opens it again by itself.
- **Skip this version** stops the banner for that release; **Later** hides it until next launch.
- **Philament → Check for Updates…** (Mac) or **Settings → Updates → Check Now** checks right away. Automatic checks can be turned off in Settings.

### General
- Full-window layout: your model library on the left, a large 3D preview in the middle, and the Unit Converter and Filament on the right. Each area scrolls on its own, so nothing is ever cut off at the bottom of the screen.
- Opens large on first launch and remembers its size, position and whether it was maximized or full screen. Double-click the title bar to maximize; View → Enter Full Screen for full screen.
- Below 1200px wide the preview and tools share one scrolling column next to the library; below 860px everything stacks in a single column.
- The Unit Converter and Filament sections collapse with a click on their header.
- Follows your system's light/dark appearance.
- App color: Emerald (default), Ocean, Violet, Rose, Sunset or Graphite, under Settings → Appearance. In light mode the 3D model uses it too; in dark mode the model is a neutral grey on a brighter grid.
- Color Brightness slider (50–100%) to tone the app color down; it applies everywhere the color is used.
- Font size setting (100–150%).
- Backup and restore (to iCloud Drive on a Mac, Documents on Windows): filaments, inventory, model folders, hidden items, saved links and their tags, your own filament types, slicer, app color and brightness, and font size.

## Requirements

- macOS 13 (Ventura) or later, Apple silicon or Intel
- Windows 10 or 11, x64 or ARM
- Node.js 22.12 or later (only to run from source or build). Check with `node --version`.

## Run from source

```bash
cd philament
npm install
npm start
```

## Build the Mac app

```bash
npm run build:mac
```

The `.dmg` and `.zip` are written to `dist/`. The build is not code-signed or notarized, so the first time you open it, right-click the app and choose **Open**. To distribute it to other people without that step you need an Apple Developer ID to sign and notarize it.

## Build for Windows

```bash
npm run build:win
```

This makes two installers in `dist/`: `Philament-0.1.0-x64-setup.exe` for most PCs and `Philament-0.1.0-arm64-setup.exe` for Windows on ARM. It works from a Mac or a Windows PC. On Linux, electron-builder also needs Wine.

The installer puts Philament in your user folder (no administrator needed) and adds Start menu and desktop shortcuts. It isn't code-signed, so Windows SmartScreen may say "Windows protected your PC" the first time: choose **More info → Run anyway**. Signing it needs a Windows code-signing certificate.

On Windows the window buttons sit on the right, Ctrl takes the place of ⌘ in shortcuts, and the Settings shortcut is Ctrl+,.

### Publishing a new version

The update check looks at the latest release of **github.com/philecker/philament** (set under `build.publish` in `package.json`). The repository needs to be public.

1. Raise `version` in `package.json` (for example `0.1.0` → `0.2.0`).
2. Create a GitHub token with permission to write to the repository's contents ([github.com/settings/tokens](https://github.com/settings/tokens)), then run:

   ```bash
   GH_TOKEN=your_token npm run release
   ```

   This builds the Mac installers (`Philament-0.2.0-arm64-mac.dmg`, `Philament-0.2.0-x64-mac.dmg`, plus zips) and the Windows installers (`Philament-0.2.0-x64-setup.exe`, `Philament-0.2.0-arm64-setup.exe`), and uploads them all to a new GitHub release called `v0.2.0`. Each copy of Philament picks the right one when it updates.
3. On GitHub, open the release, write the release notes (they appear under **What's New** in the app), and publish it if it was saved as a draft.

Everyone running an older version sees the banner within 6 hours, or right away when they open Philament.

### App icon in light and dark mode

While Philament is running, its Dock icon follows your Mac's appearance: the green icon in light mode, and a dark version (dark outside, green spool) in dark mode.

To have Finder, Launchpad and the Dock show the dark version even when the app is closed (macOS 26 Tahoe and later), build with:

```bash
npm run build:mac:tahoe
```

This needs Xcode 26 or later installed (electron-builder uses Apple's `actool` to compile `assets/Philament.icon`). Macs older than macOS 26 still get the regular icon. If you don't have Xcode, `npm run build:mac` works as before.

## Keyboard shortcuts

On Windows, use Ctrl wherever these say ⌘.

| Shortcut | Action |
| --- | --- |
| ⌘1 / ⌘2 / ⌘3 | Library / Uploads / Saved |
| ⌘V on the Saved tab | Save the copied link |
| ↑ / ↓ in the file list | Move up / down |
| → / ← on a folder | Open / close it |
| Enter in the file list | Open the selected file in your slicer, or open/close a folder |
| ⌘⌫ in the file list | Move the selected file to the Trash |
| Esc | Close Settings or the filament editor |
| ⌘C / ⌘V / ⌘A | Copy / paste / select all in text fields |
| ⌘M | Minimize |
| ⌘W | Close window |
| ⌃⌘F | Enter / exit full screen |
| ⌘Q | Quit |

## Data

Everything is stored locally on your computer in the app's own storage. Backups are plain JSON files.

Philament only goes online to check GitHub for updates, to read the pages you save in the Saved tab, and, if you connect it, to read your public MakerWorld profile (from makerworld.com and api.bambulab.com). Nothing about you is sent anywhere else.

## Project layout

| File | Purpose |
| --- | --- |
| `main.js` | Electron main process: window, menu, single instance, navigation lock-down |
| `index.html` / `styles.css` | Interface and theme |
| `renderer.js` | Converter, filament guide, settings, backup, window sizing |
| `models.js` | Model library: folders, list, 3D viewer, open in slicer |
| `model-parsers.js` | STL / 3MF / G-code thumbnail parsing (no DOM or file access; testable in Node) |
| `saved.js` | Saved tab: links, cards, filters, pictures |
| `makerworld.js` | MakerWorld profile, uploads, daily history and pictures (main process) |
| `makerworld-ui.js` | Uploads tab (MakerWorld) |
| `updater.js` | Checks GitHub Releases for a newer version and downloads the installer (main process) |
| `update-ui.js` | Update banner and the Updates section in Settings |
| `link-preview.js` | Reads a page's title, picture and designer from its meta tags, using a hidden browser window for sites that block quick requests (runs in the main process) |
| `vendor/three/` | The parts of three.js the 3D viewer uses |

Built with Electron 45 and three.js.

## License

MIT © 2026 Phil Ecker. See [LICENSE](LICENSE).
