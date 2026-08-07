# my-pi-statusline

Personal statusline package for [Pi](https://github.com/earendil-works/pi). It combines:

- A configurable powerline footer with session, Git, model, token, context, shell, and custom status segments
- Pi Vim mode and pending-command status integration
- Gondolin-aware path coloring
- OpenAI Codex and Anthropic subscription usage-limit reporting

![my-pi-statusline](./statusline.png)

## Install

```sh
pi install git:github.com/cejkajo/my-pi-statusline
```

Or add the package and configuration directly to `~/.pi/agent/settings.json`:

```json
{
  "tuiMode": "fullscreen",
  "packages": ["git:github.com/cejkajo/my-pi-statusline"],
  "powerline": {
    "preset": "default",
    "fixedEditor": false,
    "vim": true,
    "customItems": {
      "usage-limits": {
        "statusKey": "usage-limits",
        "position": "right"
      }
    }
  }
}
```

Pi 0.84.0 owns the sticky editor/status/widget/footer dock in `fullscreen` mode. The extension also works in `regular` mode without terminal or TUI monkey-patching.

`powerline.fixedEditor` is retained for configuration compatibility. When `true`, it enables this package's custom bash-capable editor. When `false`, the extension leaves an editor installed earlier, such as [`pi-vim`](https://github.com/leohenon/pi-vim), in place. Stickiness is controlled by Pi's `tuiMode`, not this setting.

See [USAGE-LIMITS.md](USAGE-LIMITS.md) for usage endpoint details and limitations.

## Validate

```sh
npm run check
npm test
npm run test:e2e
```

The E2E test requires Pi 0.84.0 and tmux. It exercises both fullscreen and regular TUI modes, status updates, narrow/wide resizing, editor input, and clean shutdown.

## Provenance and license

This is an unlicensed personal package derived from earlier statusline work. See [NOTICE.md](NOTICE.md) for source history and permissions. No general license is granted to third parties.
