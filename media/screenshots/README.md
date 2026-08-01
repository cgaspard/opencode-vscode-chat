# Screenshots

Referenced by the main `README.md` via absolute `raw.githubusercontent.com`
URLs — the Marketplace serves the README from its own domain and will not
resolve repo-relative image paths. They are committed here but excluded from
the `.vsix` (see `.vscodeignore`), so they cost nothing at install time.

| File | What it shows |
| --- | --- |
| `panel.png` | **Hero shot.** The agent working a task end to end — prompt, tool cards, result. |
| `providers.png` | The providers panel: every configured provider with its enable switch, above the single search that adds either a keyed provider or a local server. |
| `models.png` | The model picker with provider groups collapsed except the current model's, showing context window, price and capability badges. |

## Regenerating

These were captured at 2x from the real compiled webview (`dist/webview/main.js`
plus `media/styles.css`) driven in a headless browser with representative
provider/model data — the UI is exactly what ships; the conversation and the
provider list are examples.

If you re-shoot them from a live session instead, keep the filenames and the
rough aspect ratio so the README table stays balanced. Either way:

- Trim to the panel, not the whole VS Code window.
- 2x (Retina) PNGs look crisp on the Marketplace; keep each under ~500 KB.
- They must be committed and pushed — the Marketplace fetches them from the
  default branch, so a listing update needs the images on `main` first.
