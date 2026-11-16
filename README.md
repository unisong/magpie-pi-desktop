# magpie-pi-desktop

A [Magpie](https://usemagpie.ai) agent plugin that connects the Pi-Desktop app to Magpie's local gateway, so Pi-Desktop uses the models Magpie offers, with their thinking levels, and follows them when they change in Magpie.

把 Pi-Desktop 接入 Magpie 本地网关的 Magpie Agent 插件：Pi-Desktop 用上 Magpie 的模型和推理等级，Magpie 里调整了模型，Pi-Desktop 重启后跟上。

| Path | What it is |
|---|---|
| [`packages/pi-desktop/`](packages/pi-desktop) | The plugin, laid out as a `magpie-community/plugins` package. Start with its [README](packages/pi-desktop/README.md). |
| [`docs/04-详细接入教程.md`](docs/04-详细接入教程.md) | Step-by-step setup in Chinese, with expected results and troubleshooting |
| [`docs/`](docs) | Extension-point map, design and verification notes (Chinese) |
| [`verify/`](verify) | `pi-hostcore-sandbox.mjs` runs Pi-Desktop's own host process in a throwaway data folder; `codex-invariants.mjs` checks that Magpie's Codex setup is untouched |

```sh
magpie plugin add <path to packages/pi-desktop>
```

Tested with Magpie 0.1.4267 and Pi-Desktop 0.22.0 on Windows 11. MIT.
