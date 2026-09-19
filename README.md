# YouTube Auto Native Subtitles

Firefox extension that automatically switches YouTube subtitles to the video's own native language — with per-language rules and a fallback language you control.

## The problem

YouTube remembers your last subtitle language and blindly re-applies it to every new video. Watch a Spanish video with Spanish subs, open an English video next, and the subs stay Spanish.

## How it works

On every video load the extension:

1. Detects the video's native language (auto-generated caption track first, then audio-track info).
2. Looks up your rules (e.g. Spanish video → Spanish subtitles, English video → English subtitles).
3. Falls back to your fallback language when no rule matches — using YouTube's auto-translate of an existing track when the wanted language has no track of its own.
4. Switches the subtitle **track only** — it never turns captions on or off. Your CC button stays yours. It waits for stable playback first, since switching mid-load breaks YouTube's caption module. Selection uses YouTube's player API first, then walks the settings menu exactly as if you clicked it.
5. On multi-audio (dubbed) videos where subtitles still won't apply, switches the audio to the original-language track via the settings menu and retries — captions follow the playing audio.
6. Re-checks once playback starts, in case YouTube restored your previously remembered language over the fresh selection.

No accounts, no network calls, no tracking. Settings live in local extension storage.

## Install

- **AMO (once published):** link coming soon.
- **Temporary (development):** Firefox → `about:debugging#/runtime/this-firefox` → Load Temporary Add-on → pick `manifest.json`.

## Settings

Click the toolbar button (or `about:addons` → Preferences):

- **Rules table** — video language → subtitle language rows, add/remove freely.
- **Fallback language** — used when nothing matches.
- Changes apply to open YouTube tabs automatically.

## Build

```powershell
powershell -ExecutionPolicy Bypass -File build.ps1
```

Validates `manifest.json`, syntax-checks every JS file with node, and writes a versioned zip to `dist/` ready for AMO upload.

## Permissions

- `storage` — saves your language rules.
- YouTube site access — runs the tracker-switcher on video pages only (required because YouTube is a single-page app; homepage → video navigation never reloads the page).

## Project layout

```
manifest.json    Extension manifest (v3)
injected.js      Page-world logic: detection + track switching
content.js       Injects injected.js, bridges settings into the page
defaults.js      Default rules + language list (shared)
options.html/js  Settings page
background.js    Toolbar button → opens settings
icons/           Extension icons
build.ps1        Build + package script
```
