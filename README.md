# Twitch Tab Manager

Opens Twitch stream tabs for your followed channels, tries to keep them playing, avoids duplicates, and respects a max tab limit.

Main goal: help manage Twitch tabs automatically without messing with tabs you opened yourself.

---

## Table of Contents
- [Features](#features)
- [Requirements](#requirements)
- [Folder Layout](#folder-layout)
- [Quick Start](#quick-start)
- [Settings](#settings)
- [Fetch My Follows](#fetch-my-follows)
- [Get `client_id` & `access_token`](#get-client_id--access_token)
  - [Create a Twitch app](#create-a-twitch-app)
  - [Generate an App Access Token](#generate-an-app-access-token)
- [How It Works](#how-it-works)
- [Usage](#usage)
  - [Popup](#popup)
  - [Options](#options)
- [Troubleshooting](#troubleshooting)
- [Feedback & Support](#feedback--support)
- [FAQ](#faq)
- [Privacy Policy](#privacy-policy)
- [Changelog](#changelog)
- [Roadmap / To Do](#roadmap--to-do)

---

## Features
- Auto-open and auto-close Twitch channel tabs based on **live status**
- **Helix-first** live detection when `client_id` + `access_token` are configured
- HTML fallback/live probing for setups that do not use Helix
- Per-channel **de-duplication**
- Keeps Twitch tabs together in the same browser window where possible
- Respects a strict **max tab cap** (`max_tabs`)
- Background **re-pokes** managed Twitch tabs to help resume playback/unmute when Twitch stalls hidden tabs
- Popup controls for:
  - **On / Off**
  - **Force Poll**
  - **Reload Config**
  - **Open Settings**
  - **Diagnose**
- Options page includes:
  - JSON config editor
  - follows editor
  - priority channels editor
  - **Fetch My Follows**
  - import / export helpers
  - debug tools

---

## Requirements
- **Chrome** or another Chromium-based browser with **Developer Mode**
- For best live detection, a Twitch **Client ID** + **App Access Token**
- Token-less setups can still work through HTML/fallback methods, but Helix is preferred

---

## Folder Layout
```text
/ (extension root)
├─ manifest.json
├─ background.js
├─ bg.core.js
├─ bg.compat.js
├─ bg.live.js
├─ bg.tabs.js
├─ bg.stability.js
├─ content_unmute.js
├─ content_status.js
├─ popup.html
├─ popup.js
├─ options.html
├─ options.js
├─ config.json
└─ icons/
   ├─ icon16.png
   ├─ icon32.png
   └─ icon192.png
````

---

## Quick Start

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select this extension folder
5. Open the popup and turn it **On**
6. Open **Settings**
7. Check your config / follows / priority
8. Use **Fetch My Follows** if needed
9. Use **Force Poll** to test immediately

---

## Settings

Settings are stored locally. Typical example:

```json
{
  "live_source": "auto",
  "client_id": "",
  "access_token": "",
  "check_interval_sec": 60,
  "max_tabs": 4,
  "enabled": true,
  "force_unmute": false,
  "unmute_streams": true,
  "force_resume": false,
  "autoplay_streams": true,
  "follows": [],
  "priority": [],
  "followUnion": [],
  "blacklist": [],
  "soft_wake_tabs": false,
  "soft_wake_only_when_browser_focused": true
}
```

### Notes

* `live_source: "auto"` prefers Helix first, then falls back when needed
* `priority` is separate from `follows`
* `followUnion` is the combined set used internally
* `max_tabs` is always enforced
* `soft_wake_tabs` is meant for harder cases where Twitch background tabs stay paused/muted
* `soft_wake_only_when_browser_focused` is meant to avoid interrupting games or other apps

---

## Fetch My Follows

The Options page supports two fetch modes:

* **Open active tab (auto-scroll)**
  Opens the official `Following → Channels` page, scrolls it, and saves the usernames found there.

* **Use my current Twitch tab**
  Reuses an already-open Twitch tab and moves it to the correct page if needed before scraping.

### Current behavior

* Newly fetched follows are synced into your stored `follows`
* Channels you no longer follow can be removed during sync
* `priority` is left alone
* `followUnion` is rebuilt from `follows + priority`

### Planned improvement

* clearer follow sync changelog in the UI
* better visibility for “added” and “removed” usernames after a fetch

---

## Get `client_id` & `access_token`

### Create a Twitch app

* Go to the Twitch Developer Console
* Register an application
* A placeholder redirect like `http://localhost` is fine for this use
* Copy your **Client ID**
* Keep your **Client Secret** private

### Generate an App Access Token

**PowerShell (Windows)**

```powershell
$client_id = "YOUR_CLIENT_ID_HERE"
$client_secret = "YOUR_CLIENT_SECRET_HERE"
$body = @{
  client_id     = $client_id
  client_secret = $client_secret
  grant_type    = "client_credentials"
}
$response = Invoke-RestMethod -Method Post -Uri "https://id.twitch.tv/oauth2/token" -Body $body
$response | Format-List
```

**curl**

```bash
curl -X POST "https://id.twitch.tv/oauth2/token" \
  -d "client_id=YOUR_CLIENT_ID_HERE" \
  -d "client_secret=YOUR_CLIENT_SECRET_HERE" \
  -d "grant_type=client_credentials"
```

> If Helix starts returning 401 errors, generate a new token.

---

## How It Works

The background worker checks who is live, compares that against already open Twitch tabs, and then opens or closes its own managed tabs as needed.

To help with Twitch being Twitch, managed tabs can also get a few extra nudges after opening to help playback resume or stay active.

It should only auto-close tabs that the extension opened itself.

There is also some extra safety logic so a bad Twitch response or temporary empty live result does not instantly make it close everything.

---

## Usage

### Popup

* **On / Off** — master toggle
* **Force Poll** — run a live check immediately
* **Reload Config** — reload settings in the background worker
* **Open Settings** — jump to Options
* **Diagnose** — quick status/debug info

### Options

* **Settings JSON**

  * Save
  * Apply & Reload
  * Export
  * Import
  * Reset to Packaged
  * Refresh From Storage
* **Follows**

  * Save
  * Export
  * Import
  * Reset to Packaged
  * Refresh From Storage
  * Fetch My Follows
* **Priority Channels**

  * manual list of preferred channels
* **Debug**

  * diagnostics
  * logs
  * helper actions

---

## Troubleshooting

### No tabs open

* Check that the extension is turned **On**
* Check that `follows` or `priority` is not empty
* If using Helix, verify `client_id` and `access_token`
* Try **Force Poll**

### Force Poll finds lives but opens nothing

* Check Diagnostics
* Check `max_tabs`
* Make sure those channels are not already open in duplicate/problem tabs
* Reload the extension and try again

### Tabs open but stay paused or muted

* Twitch background behavior can be inconsistent
* Re-pokes should help, but some cases may still require a visible/focused tab
* `soft_wake_tabs` exists for future / advanced handling, but should stay conservative

### Fetch My Follows misses channels

* Use the official `Following → Channels` page
* Let it scroll fully
* Try the auto-scroll mode first
* Helix/live detection is separate from fetching your follow list

### Tabs close and reopen unexpectedly

This should be better than in older builds, but Twitch can still be weird sometimes.

* Check Diagnostics/logs to see if Twitch returned an empty or inconsistent result
* Make sure manual Twitch tabs are not confusing the manager
* Try **Force Poll** again after a short wait

---

## Feedback & Support

* Bugs and feature requests: [https://github.com/drachescript/Twitch-Tab-Manager/issues/new/choose](https://github.com/drachescript/Twitch-Tab-Manager/issues/new/choose)
* Source code and README: [https://github.com/drachescript/Twitch-Tab-Manager](https://github.com/drachescript/Twitch-Tab-Manager)

---

## FAQ

### Can it run without tokens?

Yes, but Helix is more reliable.

### Does it close my own manually opened Twitch tabs?

It should not. Only manager-opened tabs are supposed to be auto-closed.

### Can I keep certain channels preferred?

Yes. Use `priority`.

### Can it always force hidden tabs to play with sound?

Not perfectly. Browser autoplay/background restrictions still apply, so some cases need retries or a future soft-wake fallback.

### Where is my data stored?

Settings, follows, and related extension state are stored locally in your browser. Exported files such as `config.json` or `follows.txt` are only created when you choose to export them.

---

## Privacy Policy

Twitch Tab Manager runs locally in your browser. It does not use analytics or ads, and it does not collect or sell your data.

Full privacy policy:
[https://docs.google.com/document/d/1SkvBWapQawvzuhaYT-iHOoUSV0go4PgFhtxi6Z6nwjA/edit?tab=t.0](https://docs.google.com/document/d/1SkvBWapQawvzuhaYT-iHOoUSV0go4PgFhtxi6Z6nwjA/edit?tab=t.0)

---

## Changelog

All notable changes use `DD/MM/YYYY`.

### [1.0.10] — in dev

* Further improve managed Twitch tab recovery while keeping behavior as hands-off as possible
* Avoid forced window focusing during normal recovery / repoke / rotation behavior
* Improve hidden-tab retry handling before any stronger wake action is considered
* Keep soft-wake conservative and optional so gameplay / active windows are not interrupted
* Reduced noisy optional HTML-following fallback errors so non-fatal Twitch fetch failures do not show up like hard extension errors
* Add channel hierarchy support such as favorites, priority, normal follows, rotation, low priority, and blacklist
* Add validation so a channel can only belong to one config bucket at a time
* Add dedicated rotation slots with cooldown tracking
* Add a suggestions feedback form

### [1.0.9] — 22/03/2026

* Removed the annoying tab-based Following Live fallback that could open extra Twitch directory tabs in the background
* Fixed managed live tabs lingering too long after channels went offline
* Tightened offline close behavior so tabs close much sooner when nobody is live anymore
* Improved diagnostics output to show detected live channels and currently open Twitch tabs more clearly
* Improved raid redirect cleanup so unwanted `?referrer=raid` tabs do not linger as long
* Fixed a probe / offline-detection regression that could cause live checks to fail and tabs to close incorrectly
* Improved error logging so probe failures are easier to read and diagnose
* Added a safety net to avoid immediate mass-closing of tabs after a single bad empty live poll
* Kept live checking / recovery more hands-off by avoiding the old tab-based fallback during normal polling
* Kept recovery behavior conservative so the extension is less likely to interrupt gameplay or refocus the browser unexpectedly

### [1.0.8.9] — 21/03/2026

* Massive recovery / fix update after the split broke a lot more than it should have
* Fixed browser config handling so existing saved settings are properly preferred again
* Fixed broken storage / migration logic that could cause empty or reset-looking configs
* Fixed options page loading showing blank / wrong values
* Fixed quick settings and config editor saves so they stop wiping unrelated settings
* Added multiple automatic config backups
* Added easier config restore / export tools in Debug
* Improved overall stability and brought behavior closer to the old working background logic
* Tightened popup config handling to better preserve browser-stored settings during popup-side actions

### [1.0.8.8] — 20/03/2026

* Added a possible fix for newly opened live tabs sometimes staying on Twitch’s starting / standby screen until the tab is focused
* Started cleaning up for 1.0.9 by splitting `background.js` and `options.js` into multiple files for easier debugging and file management

### [1.0.8.7] — 18/03/2026

* Added a changelog tab in settings
* If the extension is off, it should not do anything at all anymore, especially not close Twitch tabs
* Better handling for extra Twitch tabs vs actual raid redirects
* Added popup actions for Twitch tabs
* Added temp whitelist with 12 hours as the default
* More fixes for raid / offline / unfollowed tab stuff

### [1.0.8.6] — 16/03/2026
* Existing open Twitch tabs now get picked back up after an extension reload or restart
* fixed an issue with raided or offline channels not getting closed or being closed very late
* fixed an issue where any value of max tabs wasnt actually used except 4
* potentionally fixed an issue with offline or raided that arent followed wont be closed
* general polish of code
* Added an option to close managed tabs that drift to unfollowed channels
* Reduced delay before closing offline or raided managed tabs

### [1.0.8.5] — 15/03/2026

* Updated popup UI to look cleaner and show more useful status info
* Added popup version display, last update version, and last poll time
* Refreshed the Options page layout to look cleaner and more organized
* Improved Quick Settings / newer settings presentation in Options
* Small UI cleanup and fixes

### [1.0.8.1] — 15/03/2026

* Added notificiations if a new version was installed
* Fixed a bug related to not opening a stream or closing it for no reason
* if you manually open a followed stream it will be added to the extention workflow so it closes after raid/offline
* Small other fixes to make the extention more reliable

### [1.0.8] — 14/03/2026

* More safety around offline closing
* Added delayed offline close instead of closing on first offline report
* Added safer raid/offline timer handling so pending raid close wins over offline close
* Cleared pending offline/raid timers when a managed channel becomes live again
* Managed tab closing now goes through the managed close helper for cleaner state tracking
* Tightened offline detection in `content_status.js` to reduce false positives
* Tightened raid detection in `content_status.js` to rely on more specific Twitch raid signals
* Added Quick Settings to the Options page
* Added Options controls for `enabled`, `live_source`, `check_interval_sec`, and `max_tabs`
* Added Options controls for playback settings like unmute/resume/autoplay
* Added Options controls for `soft_wake_tabs` and `soft_wake_only_when_browser_focused`
* Added Options control for `blacklist`
* Added quick save and save + reload actions in Options
* Added config handling support for soft wake settings in Options
* Small cleanup and fixes

### [1.0.7] — 13/03/2026

* Reworked the background service flow around the modular MV3 setup
* Improved message compatibility for popup / options / diagnostics routing
* Fixed several service worker startup and compatibility problems
* Fixed broken toggle / config reload / force poll paths
* Improved follow fetching from the official `Following → Channels` page
* Fetch now behaves more like a sync and keeps `priority` separate
* Improved Twitch tab grouping so new managed tabs prefer an existing Twitch window
* Improved duplicate-channel handling
* Added repeated background repokes for managed Twitch tabs after opening
* Added player status reporting groundwork for smarter stuck-tab handling
* Added safer protection against temporary empty live results closing everything at once
* Improved diagnostics and general debugging flow
* General cleanup and hardening across the background + tab management flow

### [1.0.6] — 06/11/2025

* Added priority handling so priority streamers are opened before regular follows
* Added Options textarea + popup add/remove tools while on a streamer page
* Better offline detection
* Stricter `max_tabs` handling
* Sturdier polling
* More human-like Twitch interaction timing
* Added Diagnostics for faster debugging

### [1.0.5] — 30/10/2025

* Fetch My Follows ignores sidebar and targets the Following → Channels grid
* More consistent cleanup of tabs for channels that went offline
* Moderator-view aware duplicate handling
* Config auto-migration for new options
* Token helpers in Options → Help

### [1.0.4] — 18/09/2025

* Initial public release with live detection, de-duplication, `max_tabs`, popup controls, and dark styling

### [1.0.3] — 12/09/2025

* HTML scraping prototype
* Basic unmute / resume content script

### [1.0.2] — 10/09/2025

* Stability fixes around opening multiple tabs at once

### [1.0.1] — 08/09/2025

* First working background poller
* Minimal config

### [1.0.0] — 05/09/2025

* Project scaffolding
* Initial commit

---

## Roadmap / To Do

### High priority

* Further improve hands-off recovery for managed Twitch tabs without refocusing the browser
* Keep improving player-state handling so hidden tabs recover more reliably
* Keep `soft_wake_tabs` conservative and optional
* Keep improving live detection resilience when Twitch changes page structure
* Add channel hierarchy support:
  * favorites
  * priority
  * normal follows
  * rotation
  * low priority
  * blacklist
  * Add validation so channels cannot exist in multiple config groups at once

### Medium priority

* Better handling for raids
* Better handling for tab reuse vs manager-owned tabs
* Improved duplicate detection across Twitch windows
* Stronger stuck-tab detection before any wake/focus action
* Add in-tab rotation with cooldown tracking and tab ownership memory
* Add rotation preview in Options
* Add open reason / close reason in diagnostics

### Lower priority / future ideas

* Optional quality control
* Volume memory
* Channel points helper / notifier
* Better ad-aware behavior
