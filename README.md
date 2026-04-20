# Signal K Anchor Drag ML Plugin

Anchor Drag ML records nearby vessel GPS history, lets you label track ranges as normal vs dragging, and trains a local drag-event model directly in the plugin.

## What it does

- Captures nearby vessel tracks continuously and persists them in `state.json`.
- Keeps history until it ages past the configured retention window.
- Provides a timeline UI to:
  - select vessel + time range,
  - play/pause through the selected interval,
  - mark range as `normal_anchored` or `dragging_event`.
- Trains a local logistic-regression model from labeled ranges when you click retrain.
- Generates drag probability windows over a selected time range.

## Configuration

Only one setting is exposed:

- `recordingRetentionHours` — number of hours of track history to retain (default `240`, minimum `1`).

## HTTP API

- `GET /plugins/anchor-drag-ml/settings`
- `GET /plugins/anchor-drag-ml/history?vessel=<safeId>&start=<ms>&end=<ms>`
- `GET /plugins/anchor-drag-ml/labels`
- `POST /plugins/anchor-drag-ml/labels`
- `DELETE /plugins/anchor-drag-ml/labels/:id`
- `GET /plugins/anchor-drag-ml/model/status`
- `POST /plugins/anchor-drag-ml/model/retrain`
- `GET /plugins/anchor-drag-ml/predictions?vessel=<safeId>&start=<ms>&end=<ms>&windowMs=<ms>`

## Build

```bash
npm install
npm run build
```
