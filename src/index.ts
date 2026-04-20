/// <reference types="node" />
import * as fs from 'fs'
import * as geolib from 'geolib'
import * as path from 'path'
import { Plugin, Position, ServerAPI as PluginServerApp } from '@signalk/server-api'

const captureRadiusMeters = 5000
const sampleResolutionMs = 15_000
const saveDebounceMs = 1000
const minPointsForFeatures = 4
const defaultWindowMs = 10 * 60 * 1000

type TrackLabelValue = 'normal_anchored' | 'dragging_event'

interface Configuration {
  recordingRetentionHours?: number
}

interface PositionTrack {
  position: Position
  time: number
}

interface VesselHistory {
  id: string
  safeId: string
  name: string
  mmsi?: string
  lastPosition?: Position
  lastPositionTime?: number
  track: PositionTrack[]
}

interface TrackLabel {
  id: string
  safeId: string
  startTime: number
  endTime: number
  label: TrackLabelValue
  createdAt: number
  note?: string
}

interface FeatureWindow {
  safeId: string
  label: TrackLabelValue
  startTime: number
  endTime: number
  features: number[]
}

interface ModelMetrics {
  sampleCount: number
  classCounts: Record<TrackLabelValue, number>
  accuracy: number
  precision: number
  recall: number
  f1: number
}

interface TrainedModel {
  version: number
  trainedAt: number
  featureNames: string[]
  means: number[]
  stds: number[]
  weights: number[]
  bias: number
  threshold: number
  metrics: ModelMetrics
}

interface PersistedState {
  buddies: Record<string, VesselHistory>
  labels: TrackLabel[]
  model?: TrainedModel
}

const load = function (app: PluginServerApp): Plugin {
  const plugin: Plugin = {} as Plugin
  let configuration: Configuration = {}
  let statePath = ''
  let loadedStateFrom = ''
  let startupError = ''
  let state: PersistedState = { buddies: {}, labels: [] }
  let syncInterval: NodeJS.Timeout | undefined
  let saveStateDebounce: NodeJS.Timeout | undefined
  const lastSampleAt: Record<string, number> = {}

  plugin.id = 'anchor-drag-ml'
  plugin.name = 'Anchor Drag ML'
  plugin.description =
    'Capture nearby vessel tracks, label dragging events, and train a local model.'
  plugin.schema = {
    title: 'Anchor Drag ML',
    type: 'object',
    properties: {
      recordingRetentionHours: {
        type: 'number',
        title: 'Track history retention (hours)',
        description: 'How long to keep historical track data before pruning.',
        default: 240,
        minimum: 1
      }
    }
  } as any

  plugin.start = function (props: Configuration): void | Error {
    configuration = props
    configuration.recordingRetentionHours = Math.max(
      1,
      configuration.recordingRetentionHours ?? 240
    )
    try {
      statePath = path.join(app.getDataDirPath(), 'state.json')
      loadState()
      syncTracks()
      syncInterval = setInterval(syncTracks, sampleResolutionMs)
    } catch (error) {
      startupError = String(error)
      app.error(`Failed starting plugin: ${error}`)
      return error as Error
    }
  }

  plugin.stop = function (): void {
    if (syncInterval) clearInterval(syncInterval)
    if (saveStateDebounce) {
      clearTimeout(saveStateDebounce)
      saveStateDebounce = undefined
    }
    saveState()
  }

  plugin.registerWithRouter = function (router: any): void {
    router.get('/settings', (_req: any, res: any) => {
      const resolvedStatePath =
        statePath || path.join(app.getDataDirPath(), 'state.json')
      res.json({
        recordingRetentionHours: configuration.recordingRetentionHours ?? 240,
        captureRadiusMeters,
        statePath: resolvedStatePath,
        loadedStateFrom: loadedStateFrom || resolvedStatePath,
        startupError: startupError || null
      })
    })

    router.get('/debug/state-shape', (_req: any, res: any) => {
      try {
        const resolvedStatePath =
          statePath || path.join(app.getDataDirPath(), 'state.json')
        if (!fs.existsSync(resolvedStatePath)) {
          return res.json({
            statePath: resolvedStatePath,
            exists: false
          })
        }
        const rawText = fs.readFileSync(resolvedStatePath, 'utf8')
        const raw = JSON.parse(rawText) as any
        const buddies =
          raw && raw.buddies && typeof raw.buddies === 'object'
            ? raw.buddies
            : {}
        const buddyKeys = Object.keys(buddies)
        const sample = buddyKeys.slice(0, 3).map((k) => {
          const v = buddies[k]
          return {
            key: k,
            hasSafeId: typeof v?.safeId === 'string',
            id: typeof v?.id === 'string' ? v.id : null,
            streamContext:
              typeof v?.streamContext === 'string' ? v.streamContext : null,
            trackType: Array.isArray(v?.track) ? 'array' : typeof v?.track,
            trackLength: Array.isArray(v?.track) ? v.track.length : 0
          }
        })
        return res.json({
          statePath: resolvedStatePath,
          exists: true,
          topLevelKeys: Object.keys(raw || {}),
          buddiesCount: buddyKeys.length,
          sample
        })
      } catch (error) {
        return res.status(500).json({
          statePath: statePath || path.join(app.getDataDirPath(), 'state.json'),
          error: String(error)
        })
      }
    })

    router.get('/history', (req: any, res: any) => {
      ensureStateLoadedFromDisk()
      const safeId =
        typeof req.query.vessel === 'string' && req.query.vessel.trim()
          ? req.query.vessel.trim()
          : undefined
      const start = parseOptionalNumber(req.query.start)
      const end = parseOptionalNumber(req.query.end)
      const buddies = Object.values(state.buddies)
        .filter((v) => !safeId || v.safeId === safeId)
        .map((v) => ({
          ...v,
          track: v.track.filter((point) => {
            if (start != null && point.time < start) return false
            if (end != null && point.time > end) return false
            return true
          })
        }))
      res.json({ buddies })
    })

    router.get('/debug/runtime-state', (_req: any, res: any) => {
      ensureStateLoadedFromDisk()
      const buddies = Object.values(state.buddies)
      const sample = buddies.slice(0, 5).map((b) => ({
        safeId: b.safeId,
        name: b.name,
        trackLength: Array.isArray(b.track) ? b.track.length : 0,
        lastTrackTime:
          Array.isArray(b.track) && b.track.length
            ? b.track[b.track.length - 1].time
            : null
      }))
      const totalTrackPoints = buddies.reduce(
        (sum, b) => sum + (Array.isArray(b.track) ? b.track.length : 0),
        0
      )
      res.json({
        buddiesCount: buddies.length,
        totalTrackPoints,
        sample
      })
    })

    router.get('/labels', (_req: any, res: any) => {
      res.json({ labels: state.labels.slice().sort((a, b) => b.createdAt - a.createdAt) })
    })

    router.post('/labels', (req: any, res: any) => {
      const body = req.body || {}
      const safeId = String(body.safeId || '').trim()
      const label = body.label as TrackLabelValue
      const startTime = Number(body.startTime)
      const endTime = Number(body.endTime)
      if (!safeId || !state.buddies[safeId]) return res.status(400).json({ error: 'Unknown vessel' })
      if (label !== 'normal_anchored' && label !== 'dragging_event')
        return res.status(400).json({ error: 'Invalid label value' })
      if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime <= startTime)
        return res.status(400).json({ error: 'Invalid time range' })

      const entry: TrackLabel = {
        id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        safeId,
        startTime,
        endTime,
        label,
        createdAt: Date.now(),
        note: typeof body.note === 'string' ? body.note : undefined
      }
      state.labels.push(entry)
      queueSaveState()
      res.json({ ok: true, label: entry })
    })

    router.delete('/labels/:id', (req: any, res: any) => {
      const before = state.labels.length
      state.labels = state.labels.filter((label) => label.id !== req.params.id)
      if (state.labels.length === before) return res.status(404).json({ error: 'Label not found' })
      queueSaveState()
      res.json({ ok: true })
    })

    router.get('/model/status', (_req: any, res: any) => {
      const classCounts: Record<TrackLabelValue, number> = {
        normal_anchored: state.labels.filter((l) => l.label === 'normal_anchored').length,
        dragging_event: state.labels.filter((l) => l.label === 'dragging_event').length
      }
      res.json({
        hasModel: Boolean(state.model),
        trainedAt: state.model?.trainedAt ?? null,
        metrics: state.model?.metrics ?? null,
        classCounts
      })
    })

    router.post('/model/retrain', (_req: any, res: any) => {
      const windows = buildLabeledFeatureWindows(state)
      if (windows.length < 8) {
        return res.status(400).json({ error: 'Need at least 8 labeled windows for training' })
      }
      const positives = windows.filter((w) => w.label === 'dragging_event').length
      const negatives = windows.length - positives
      if (positives === 0 || negatives === 0) {
        return res.status(400).json({ error: 'Need both normal and dragging labels for training' })
      }

      const trained = trainLogisticRegression(windows)
      state.model = trained
      queueSaveState()
      res.json({ ok: true, model: trained })
    })

    router.get('/predictions', (req: any, res: any) => {
      if (!state.model) return res.status(400).json({ error: 'Model not trained' })
      const safeId = String(req.query.vessel || '').trim()
      const vessel = state.buddies[safeId]
      if (!vessel) return res.status(404).json({ error: 'Vessel not found' })
      const start = parseOptionalNumber(req.query.start) ?? 0
      const end = parseOptionalNumber(req.query.end) ?? Date.now()
      const windowMs = Math.max(60_000, parseOptionalNumber(req.query.windowMs) ?? defaultWindowMs)
      const predictions = predictWindowsForVessel(vessel, state.model, start, end, windowMs)
      res.json({ vessel: safeId, predictions })
    })
  }

  function loadState(): void {
    const resolvedStatePath =
      statePath || path.join(app.getDataDirPath(), 'state.json')
    if (!statePath) statePath = resolvedStatePath
    const currentDataDir = path.dirname(resolvedStatePath)
    const legacyCandidates = [
      path.join(currentDataDir, 'buddywatch', 'state.json'),
      path.join(currentDataDir, 'buddywatch', 'stage.json'),
      path.join(currentDataDir, 'signalk-buddywatch-plugin', 'state.json')
    ]

    const loadFromPath = (candidatePath: string): PersistedState | null => {
      if (!fs.existsSync(candidatePath)) return null
      try {
        const parsed = JSON.parse(fs.readFileSync(candidatePath, 'utf8')) as any
        const buddies = parsed?.buddies && typeof parsed.buddies === 'object' ? parsed.buddies : {}
        const migratedBuddies: Record<string, VesselHistory> = {}
        Object.entries(buddies).forEach(([buddyKey, raw]: [string, any]) => {
          if (!raw || typeof raw !== 'object') return
          const inferredSafeId =
            typeof raw.safeId === 'string' && raw.safeId.trim()
              ? raw.safeId.trim()
              : safePathId(String(raw.id || buddyKey))
          if (!inferredSafeId) return
          const track = Array.isArray(raw.track) ? raw.track : []
          migratedBuddies[inferredSafeId] = {
            id: String(raw.id || buddyKey || inferredSafeId),
            safeId: inferredSafeId,
            name: String(raw.name || raw.id || buddyKey || inferredSafeId),
            mmsi: raw.mmsi != null ? String(raw.mmsi) : undefined,
            lastPosition: isValidPosition(raw.lastPosition) ? raw.lastPosition : undefined,
            lastPositionTime: Number.isFinite(raw.lastPositionTime) ? raw.lastPositionTime : undefined,
            track: track
              .filter((point: any) => point && Number.isFinite(point.time) && isValidPosition(point.position))
              .map((point: any) => ({ position: point.position, time: point.time }))
              .sort((a: PositionTrack, b: PositionTrack) => a.time - b.time)
          }
        })
        return {
          buddies: migratedBuddies,
          labels: Array.isArray(parsed?.labels)
            ? parsed.labels
                .filter(
                  (label: any) =>
                    label &&
                    typeof label.id === 'string' &&
                    typeof label.safeId === 'string' &&
                    Number.isFinite(label.startTime) &&
                    Number.isFinite(label.endTime) &&
                    (label.label === 'normal_anchored' || label.label === 'dragging_event')
                )
                .map((label: any) => ({
                  id: label.id,
                  safeId: label.safeId,
                  startTime: label.startTime,
                  endTime: label.endTime,
                  label: label.label,
                  createdAt: Number.isFinite(label.createdAt) ? label.createdAt : Date.now(),
                  note: typeof label.note === 'string' ? label.note : undefined
                }))
            : [],
          model: isValidModel(parsed?.model) ? parsed.model : undefined
        }
      } catch (error) {
        app.error(`Could not parse state file ${candidatePath}: ${error}`)
        return null
      }
    }

    const countTrackPoints = (s: PersistedState): number =>
      Object.values(s.buddies).reduce(
        (sum, buddy) => sum + (Array.isArray(buddy.track) ? buddy.track.length : 0),
        0
      )

    const currentState = loadFromPath(resolvedStatePath)
    if (currentState) {
      state = currentState
      loadedStateFrom = resolvedStatePath
    }

    const hasCurrentData = currentState && countTrackPoints(currentState) > 0
    if (!hasCurrentData) {
      const legacyPath = legacyCandidates.find((legacyPath) => fs.existsSync(legacyPath))
      if (legacyPath) {
        const legacyState = loadFromPath(legacyPath)
        if (legacyState && countTrackPoints(legacyState) > 0) {
          state = legacyState
          loadedStateFrom = legacyPath
          saveState()
        }
      }
    }

    if (!currentState && !loadedStateFrom) return
    pruneHistory()
  }

  function ensureStateLoadedFromDisk(): void {
    if (Object.keys(state.buddies).length > 0) return
    try {
      loadState()
    } catch (error) {
      app.error(`Failed on-demand state reload: ${error}`)
    }
  }

  function syncTracks(): void {
    const selfPos = getSelfPosition()
    if (!selfPos) return
    const vessels = (app.getPath('vessels') || {}) as Record<string, Record<string, any>>
    const now = Date.now()
    Object.entries(vessels).forEach(([key, vessel]) => {
      if (!vessel || key === 'self') return
      const position = vessel.navigation?.position?.value ?? vessel.navigation?.position
      if (!isValidPosition(position)) return
      const d = calcDistance(selfPos.latitude, selfPos.longitude, position.latitude, position.longitude)
      if (d > captureRadiusMeters) return

      const id = vesselUrnFromKey(key, vessel)
      const safeId = safePathId(id)
      if (!safeId) return
      const existing = state.buddies[safeId]
      const name = String(vessel.name?.value ?? vessel.name ?? vessel.communication?.callsign?.value ?? id)
      const buddy: VesselHistory = existing ?? {
        id,
        safeId,
        name,
        mmsi: vessel.mmsi != null ? String(vessel.mmsi) : undefined,
        track: []
      }
      buddy.name = name
      if (!buddy.mmsi && vessel.mmsi != null) buddy.mmsi = String(vessel.mmsi)
      buddy.lastPosition = { latitude: position.latitude, longitude: position.longitude }
      buddy.lastPositionTime = now
      const last = lastSampleAt[safeId] ?? 0
      if (!last || now - last >= sampleResolutionMs) {
        buddy.track.push({ position: buddy.lastPosition, time: now })
        lastSampleAt[safeId] = now
      }
      state.buddies[safeId] = buddy
    })
    pruneHistory()
    queueSaveState()
  }

  function pruneHistory(now: number = Date.now()): void {
    const retentionMs = (configuration.recordingRetentionHours ?? 240) * 60 * 60 * 1000
    const cutoff = now - retentionMs
    Object.values(state.buddies).forEach((buddy) => {
      buddy.track = buddy.track.filter((point) => point.time >= cutoff)
    })
    state.labels = state.labels.filter((label) => label.endTime >= cutoff)
  }

  function getSelfPosition(): Position | undefined {
    const v = app.getSelfPath('navigation.position.value') as Position | undefined
    return isValidPosition(v) ? v : undefined
  }

  function queueSaveState(): void {
    if (saveStateDebounce) return
    saveStateDebounce = setTimeout(() => {
      saveStateDebounce = undefined
      saveState()
    }, saveDebounceMs)
  }

  function saveState(): void {
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2))
  }

  return plugin
}

function parseOptionalNumber(value: unknown): number | undefined {
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

function vesselUrnFromKey(vesselKey: string, vessel: Record<string, any>): string {
  if (!vesselKey || vesselKey === 'self') return ''
  if (String(vesselKey).startsWith('urn:')) return vesselKey
  const mmsi = vessel?.mmsi
  if (mmsi != null && String(mmsi).trim()) return `urn:mrn:imo:mmsi:${String(mmsi).trim()}`
  return String(vesselKey)
}

function safePathId(input: string): string {
  return String(input || '')
    .replace(/[^a-zA-Z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase()
}

function isValidPosition(value: any): value is Position {
  return (
    value &&
    typeof value.latitude === 'number' &&
    Number.isFinite(value.latitude) &&
    typeof value.longitude === 'number' &&
    Number.isFinite(value.longitude)
  )
}

function calcDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  return geolib.getDistance(
    { latitude: lat1, longitude: lon1 },
    { latitude: lat2, longitude: lon2 },
    0.1
  )
}

function buildLabeledFeatureWindows(state: PersistedState): FeatureWindow[] {
  const windows: FeatureWindow[] = []
  state.labels.forEach((label) => {
    const vessel = state.buddies[label.safeId]
    if (!vessel) return
    const points = vessel.track.filter((point) => point.time >= label.startTime && point.time <= label.endTime)
    if (points.length < minPointsForFeatures) return
    const features = extractTrackFeatures(points)
    windows.push({
      safeId: label.safeId,
      label: label.label,
      startTime: label.startTime,
      endTime: label.endTime,
      features
    })
  })
  return windows
}

function extractTrackFeatures(points: PositionTrack[]): number[] {
  const sorted = points.slice().sort((a, b) => a.time - b.time)
  const centroid = {
    latitude: sorted.reduce((sum, p) => sum + p.position.latitude, 0) / sorted.length,
    longitude: sorted.reduce((sum, p) => sum + p.position.longitude, 0) / sorted.length
  }
  let pathLength = 0
  let maxSpeed = 0
  const speeds: number[] = []
  const radial: number[] = []
  for (let i = 0; i < sorted.length; i += 1) {
    radial.push(
      calcDistance(
        sorted[i].position.latitude,
        sorted[i].position.longitude,
        centroid.latitude,
        centroid.longitude
      )
    )
    if (i === 0) continue
    const prev = sorted[i - 1]
    const cur = sorted[i]
    const d = calcDistance(
      prev.position.latitude,
      prev.position.longitude,
      cur.position.latitude,
      cur.position.longitude
    )
    const dt = Math.max(1, (cur.time - prev.time) / 1000)
    const speed = d / dt
    pathLength += d
    speeds.push(speed)
    maxSpeed = Math.max(maxSpeed, speed)
  }
  const displacement = calcDistance(
    sorted[0].position.latitude,
    sorted[0].position.longitude,
    sorted[sorted.length - 1].position.latitude,
    sorted[sorted.length - 1].position.longitude
  )
  const straightness = pathLength > 0 ? displacement / pathLength : 0
  const radialMean = radial.reduce((a, b) => a + b, 0) / Math.max(1, radial.length)
  const radialVar =
    radial.reduce((acc, r) => {
      const delta = r - radialMean
      return acc + delta * delta
    }, 0) / Math.max(1, radial.length)
  const meanSpeed = speeds.length > 0 ? speeds.reduce((a, b) => a + b, 0) / speeds.length : 0
  const radialMax = radial.length > 0 ? Math.max(...radial) : 0

  let totalTurn = 0
  for (let i = 2; i < sorted.length; i += 1) {
    const p1 = sorted[i - 2].position
    const p2 = sorted[i - 1].position
    const p3 = sorted[i].position
    const a = Math.atan2(p2.latitude - p1.latitude, p2.longitude - p1.longitude)
    const b = Math.atan2(p3.latitude - p2.latitude, p3.longitude - p2.longitude)
    totalTurn += Math.abs(normalizeAngle(b - a))
  }
  const windowSecs = Math.max(1, (sorted[sorted.length - 1].time - sorted[0].time) / 1000)
  const radiusGrowth = radial.length > 1 ? (radial[radial.length - 1] - radial[0]) / windowSecs : 0
  return [
    displacement,
    pathLength,
    straightness,
    radialMax,
    Math.sqrt(radialVar),
    meanSpeed,
    maxSpeed,
    totalTurn / Math.max(1, sorted.length - 2),
    radiusGrowth
  ]
}

function trainLogisticRegression(windows: FeatureWindow[]): TrainedModel {
  const featureNames = [
    'displacement_m',
    'path_length_m',
    'straightness',
    'radial_max_m',
    'radial_std_m',
    'mean_speed_mps',
    'max_speed_mps',
    'mean_turn_rad',
    'radius_growth_mps'
  ]
  const x = windows.map((w) => w.features)
  const y = windows.map((w) => (w.label === 'dragging_event' ? 1 : 0))
  const dims = featureNames.length
  const means: number[] = new Array(dims).fill(0)
  const stds: number[] = new Array(dims).fill(1)
  for (let j = 0; j < dims; j += 1) {
    means[j] = x.reduce((sum, row) => sum + row[j], 0) / x.length
    const variance = x.reduce((sum, row) => {
      const delta = row[j] - means[j]
      return sum + delta * delta
    }, 0) / x.length
    stds[j] = Math.sqrt(variance) || 1
  }
  const xn = x.map((row) => row.map((v, j) => (v - means[j]) / stds[j]))

  let weights: number[] = new Array(dims).fill(0)
  let bias = 0
  const learningRate = 0.12
  const iterations = 500
  for (let iter = 0; iter < iterations; iter += 1) {
    const gradW = new Array(dims).fill(0)
    let gradB = 0
    for (let i = 0; i < xn.length; i += 1) {
      const p = sigmoid(dot(weights, xn[i]) + bias)
      const err = p - y[i]
      gradB += err
      for (let j = 0; j < dims; j += 1) gradW[j] += err * xn[i][j]
    }
    const invN = 1 / xn.length
    bias -= learningRate * gradB * invN
    weights = weights.map((w, j) => w - learningRate * gradW[j] * invN)
  }

  const predictions = xn.map((row) => sigmoid(dot(weights, row) + bias))
  const metrics = computeMetrics(predictions, y, 0.5)

  return {
    version: 1,
    trainedAt: Date.now(),
    featureNames,
    means,
    stds,
    weights,
    bias,
    threshold: 0.5,
    metrics
  }
}

function predictWindowsForVessel(
  vessel: VesselHistory,
  model: TrainedModel,
  start: number,
  end: number,
  windowMs: number
): Array<{ startTime: number; endTime: number; probability: number }> {
  const points = vessel.track.filter((point) => point.time >= start && point.time <= end)
  if (points.length < minPointsForFeatures) return []
  const out: Array<{ startTime: number; endTime: number; probability: number }> = []
  let cursor = start
  while (cursor + windowMs <= end) {
    const slice = points.filter((p) => p.time >= cursor && p.time <= cursor + windowMs)
    if (slice.length >= minPointsForFeatures) {
      const feat = extractTrackFeatures(slice)
      const z = feat.map((v, i) => (v - model.means[i]) / (model.stds[i] || 1))
      const p = sigmoid(dot(model.weights, z) + model.bias)
      out.push({ startTime: cursor, endTime: cursor + windowMs, probability: p })
    }
    cursor += Math.max(windowMs / 2, 60_000)
  }
  return out
}

function computeMetrics(probs: number[], truth: number[], threshold: number): ModelMetrics {
  let tp = 0
  let tn = 0
  let fp = 0
  let fn = 0
  for (let i = 0; i < probs.length; i += 1) {
    const pred = probs[i] >= threshold ? 1 : 0
    const actual = truth[i]
    if (pred === 1 && actual === 1) tp += 1
    else if (pred === 1 && actual === 0) fp += 1
    else if (pred === 0 && actual === 1) fn += 1
    else tn += 1
  }
  const precision = tp + fp > 0 ? tp / (tp + fp) : 0
  const recall = tp + fn > 0 ? tp / (tp + fn) : 0
  const accuracy = probs.length > 0 ? (tp + tn) / probs.length : 0
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0
  return {
    sampleCount: probs.length,
    classCounts: {
      normal_anchored: truth.filter((x) => x === 0).length,
      dragging_event: truth.filter((x) => x === 1).length
    },
    accuracy,
    precision,
    recall,
    f1
  }
}

function dot(a: number[], b: number[]): number {
  let sum = 0
  for (let i = 0; i < a.length; i += 1) sum += a[i] * b[i]
  return sum
}

function sigmoid(x: number): number {
  if (x > 35) return 1
  if (x < -35) return 0
  return 1 / (1 + Math.exp(-x))
}

function normalizeAngle(angle: number): number {
  let x = angle
  while (x > Math.PI) x -= 2 * Math.PI
  while (x < -Math.PI) x += 2 * Math.PI
  return x
}

function isValidModel(value: any): value is TrainedModel {
  return (
    value &&
    Number.isFinite(value.version) &&
    Number.isFinite(value.trainedAt) &&
    Array.isArray(value.featureNames) &&
    Array.isArray(value.means) &&
    Array.isArray(value.stds) &&
    Array.isArray(value.weights) &&
    Number.isFinite(value.bias) &&
    Number.isFinite(value.threshold) &&
    value.metrics &&
    Number.isFinite(value.metrics.sampleCount)
  )
}

module.exports = load
export default load
