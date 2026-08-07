# pi-usage-limits

A personal [pi](https://github.com/earendil-works/pi-mono) extension that shows remaining subscription usage in the statusline.

Supported providers:

- OpenAI Codex subscription windows from ChatGPT's usage endpoint
- Anthropic 5-hour and 7-day windows from utilization response headers

Values are displayed as remaining percentages, for example `5h 82% · wk 64%`. Values above 20% use Catppuccin green; values at or below 20% use Catppuccin red.

## Integration

The package entry point loads this extension together with the statusline. It publishes its value through the `usage-limits` status key, which can be configured as a dedicated statusline item:

```json
{
  "powerline": {
    "customItems": {
      "usage-limits": {
        "statusKey": "usage-limits",
        "position": "right"
      }
    }
  }
}
```

## Notes

OpenAI Codex usage is fetched from ChatGPT's private `/backend-api/wham/usage` endpoint. The endpoint is undocumented and may change. Authentication is obtained through pi's model registry and is never persisted by this extension.

Successful direct Codex usage data is authoritative. Provider response headers are used only as a fallback because they can contain incomplete duplicate windows.

## Development

```sh
npm run check
npm test
```
