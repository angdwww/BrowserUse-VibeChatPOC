# Architecture Notes

This project is a terminal browser proof of concept built to validate VibeChat-driven local development.

## Entrypoints

- `bin/term-browser-tui.js` is the main TUI application.
- `bin/term-browser.js` is the older classic CLI entrypoint.

## Main components

### Playwright browser layer

Playwright launches and controls the browser page. Commands such as `goto`, `click`, `type`, `press`, `links`, `buttons`, `inputs`, `context`, and `screenshot` are translated into Playwright operations.

### Blessed TUI layer

Blessed renders the terminal interface. The UI contains:

- Left controls/logs/errors pane.
- Command input area.
- Main page content pane.
- Buttons/inputs/control list pane.

### Shot/image mode

Shot mode captures a screenshot and maps terminal mouse coordinates back into browser viewport coordinates. This is experimental and terminal-dependent.

### Command parser

The command parser accepts one-line commands and command chains. It is designed for quick manual testing rather than a stable public API.

### Smoke test mode

`--smoke-test` runs non-interactive command coverage and checks that major commands still parse and run. This should be used after every meaningful change.

## VibeChat proof-of-concept workflow

The project was built by repeatedly sending VibeChat JSON operation blocks that:

- patched source files,
- added features,
- fixed runtime errors,
- ran syntax checks,
- ran smoke tests,
- cleaned temporary files.

The development method is as important as the tool itself: this repo demonstrates VibeChat as a local development control layer.
