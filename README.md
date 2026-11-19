# Browser

A desktop web browser for macOS, built with Electron. Tabs live in a sidebar, organized into spaces, with folders, split view, a shelf, and AI built in.

## Features

**Tabs and organization**
- Sidebar with favorites, pinned tabs, and today's tabs, which are archived automatically after a while
- Spaces, each with its own color, search engine, and optionally separate logins
- Folders, split view (up to 4 pages side by side), and drag and drop for everything
- Live folders that follow an RSS/Atom feed or a GitHub repo's pull requests and issues
- Shelf: a tray for downloads, screenshots, and anything you drop on it

**Browsing**
- Command bar (⌘T) to open sites, search, jump to tabs, and run actions
- Address bar suggestions from open tabs, history, and live search
- Peek (⇧-click a link) to open a page in a floating card
- Little windows for links opened from other apps
- Reader view, read aloud, find in page, zoom, and swipe and mouse gestures
- Web panels: small web apps docked beside the page

**Making the web yours**
- Boosts: per-site dark mode, colors, fonts, custom CSS, and zapping elements
- Highlights saved per page, notes, and easels
- Screenshots of the visible area, the full page, or a selection
- Basic Chrome extension support, including install from the Chrome Web Store

**Privacy and security**
- Shields block ads and trackers, with a privacy report
- Private windows
- Password manager encrypted with the macOS Keychain

**AI (Claude)**
- Ask about or summarize the current page, link previews, tab tidying, and smart download names
- Uses a Claude API key, or your own free server. See [server/README.md](server/README.md).

## Getting started

Requires a recent version of [Node.js](https://nodejs.org).

```sh
npm install
npm start
```

To build a standalone `Browser.app` into `dist/`:

```sh
npm run package
```

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| ⌘T | New tab / command bar |
| ⌘L | Edit address |
| ⌘W | Close tab |
| ⇧⌘T | Reopen closed tab |
| ⌘D | Pin / unpin tab |
| ⇧⌘D | Split view |
| ⌘S | Toggle sidebar |
| ⌘1–9 | Go to tab |
| ⌃1–9 | Go to space |
| ⌥⌘N | Little window |
| ⇧⌘N | Private window |
| ⌥⌘C | Compact mode |
| ⇧⌘R | Reader view |
| ⇧⌘S | Screenshot |
| ⌘F | Find in page |
| ⌘Y | History |
| ⇧⌘J | Downloads |
| ⌘, | Settings |

The full list is in Settings.

## Project layout

```
main.js, main-features.js   Main process: windows, menus, preferences
main/                       Main process: AI, sessions & downloads, screenshots & passwords
renderer.js                 Entry point for the browser window
src/                        Renderer modules (tabs, sidebar, shelf, command bar, …)
index.html, style.css       Browser window markup and styles
newtab.html                 New tab page
mini.html, mini.js          Little window
server/                     Optional self-hosted AI server setup
```
