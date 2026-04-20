"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
/// <reference types="node" />
const fs = __importStar(require("fs"));
const geolib = __importStar(require("geolib"));
const path = __importStar(require("path"));
const captureRadiusMeters = 5000;
const sampleResolutionMs = 15_000;
const saveDebounceMs = 1000;
const minPointsForFeatures = 4;
const defaultWindowMs = 10 * 60 * 1000;
const load = function (app) {
    const plugin = {};
    let configuration = {};
    let statePath = '';
    let loadedStateFrom = '';
    let startupError = '';
    let state = { buddies: {}, labels: [] };
    let syncInterval;
    let saveStateDebounce;
    const lastSampleAt = {};
    plugin.id = 'anchor-drag-ml';
    plugin.name = 'Anchor Drag ML';
    plugin.description =
        'Capture nearby vessel tracks, label dragging events, and train a local model.';
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
    };
    plugin.start = function (props) {
        configuration = props;
        configuration.recordingRetentionHours = Math.max(1, configuration.recordingRetentionHours ?? 240);
        try {
            statePath = path.join(app.getDataDirPath(), 'state.json');
            loadState();
            syncTracks();
            syncInterval = setInterval(syncTracks, sampleResolutionMs);
        }
        catch (error) {
            startupError = String(error);
            app.error(`Failed starting plugin: ${error}`);
            return error;
        }
    };
    plugin.stop = function () {
        if (syncInterval)
            clearInterval(syncInterval);
        if (saveStateDebounce) {
            clearTimeout(saveStateDebounce);
            saveStateDebounce = undefined;
        }
        saveState();
    };
    plugin.registerWithRouter = function (router) {
        router.get('/settings', (_req, res) => {
            const resolvedStatePath = statePath || path.join(app.getDataDirPath(), 'state.json');
            res.json({
                recordingRetentionHours: configuration.recordingRetentionHours ?? 240,
                captureRadiusMeters,
                statePath: resolvedStatePath,
                loadedStateFrom: loadedStateFrom || resolvedStatePath,
                startupError: startupError || null
            });
        });
        router.get('/debug/state-shape', (_req, res) => {
            try {
                const resolvedStatePath = statePath || path.join(app.getDataDirPath(), 'state.json');
                if (!fs.existsSync(resolvedStatePath)) {
                    return res.json({
                        statePath: resolvedStatePath,
                        exists: false
                    });
                }
                const rawText = fs.readFileSync(resolvedStatePath, 'utf8');
                const raw = JSON.parse(rawText);
                const buddies = raw && raw.buddies && typeof raw.buddies === 'object'
                    ? raw.buddies
                    : {};
                const buddyKeys = Object.keys(buddies);
                const sample = buddyKeys.slice(0, 3).map((k) => {
                    const v = buddies[k];
                    return {
                        key: k,
                        hasSafeId: typeof v?.safeId === 'string',
                        id: typeof v?.id === 'string' ? v.id : null,
                        streamContext: typeof v?.streamContext === 'string' ? v.streamContext : null,
                        trackType: Array.isArray(v?.track) ? 'array' : typeof v?.track,
                        trackLength: Array.isArray(v?.track) ? v.track.length : 0
                    };
                });
                return res.json({
                    statePath: resolvedStatePath,
                    exists: true,
                    topLevelKeys: Object.keys(raw || {}),
                    buddiesCount: buddyKeys.length,
                    sample
                });
            }
            catch (error) {
                return res.status(500).json({
                    statePath: statePath || path.join(app.getDataDirPath(), 'state.json'),
                    error: String(error)
                });
            }
        });
        router.get('/history', (req, res) => {
            ensureStateLoadedFromDisk();
            const safeId = typeof req.query.vessel === 'string' && req.query.vessel.trim()
                ? req.query.vessel.trim()
                : undefined;
            const start = parseOptionalNumber(req.query.start);
            const end = parseOptionalNumber(req.query.end);
            const buddies = Object.values(state.buddies)
                .filter((v) => !safeId || v.safeId === safeId)
                .map((v) => ({
                ...v,
                track: v.track.filter((point) => {
                    if (start != null && point.time < start)
                        return false;
                    if (end != null && point.time > end)
                        return false;
                    return true;
                })
            }));
            res.json({ buddies });
        });
        router.get('/debug/runtime-state', (_req, res) => {
            ensureStateLoadedFromDisk();
            const buddies = Object.values(state.buddies);
            const sample = buddies.slice(0, 5).map((b) => ({
                safeId: b.safeId,
                name: b.name,
                trackLength: Array.isArray(b.track) ? b.track.length : 0,
                lastTrackTime: Array.isArray(b.track) && b.track.length
                    ? b.track[b.track.length - 1].time
                    : null
            }));
            const totalTrackPoints = buddies.reduce((sum, b) => sum + (Array.isArray(b.track) ? b.track.length : 0), 0);
            res.json({
                buddiesCount: buddies.length,
                totalTrackPoints,
                sample
            });
        });
        router.get('/labels', (_req, res) => {
            res.json({ labels: state.labels.slice().sort((a, b) => b.createdAt - a.createdAt) });
        });
        router.post('/labels', (req, res) => {
            const body = req.body || {};
            const safeId = String(body.safeId || '').trim();
            const label = body.label;
            const startTime = Number(body.startTime);
            const endTime = Number(body.endTime);
            if (!safeId || !state.buddies[safeId])
                return res.status(400).json({ error: 'Unknown vessel' });
            if (label !== 'normal_anchored' && label !== 'dragging_event')
                return res.status(400).json({ error: 'Invalid label value' });
            if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime <= startTime)
                return res.status(400).json({ error: 'Invalid time range' });
            const entry = {
                id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                safeId,
                startTime,
                endTime,
                label,
                createdAt: Date.now(),
                note: typeof body.note === 'string' ? body.note : undefined
            };
            state.labels.push(entry);
            queueSaveState();
            res.json({ ok: true, label: entry });
        });
        router.delete('/labels/:id', (req, res) => {
            const before = state.labels.length;
            state.labels = state.labels.filter((label) => label.id !== req.params.id);
            if (state.labels.length === before)
                return res.status(404).json({ error: 'Label not found' });
            queueSaveState();
            res.json({ ok: true });
        });
        router.get('/model/status', (_req, res) => {
            const classCounts = {
                normal_anchored: state.labels.filter((l) => l.label === 'normal_anchored').length,
                dragging_event: state.labels.filter((l) => l.label === 'dragging_event').length
            };
            res.json({
                hasModel: Boolean(state.model),
                trainedAt: state.model?.trainedAt ?? null,
                metrics: state.model?.metrics ?? null,
                classCounts
            });
        });
        router.post('/model/retrain', (_req, res) => {
            const windows = buildLabeledFeatureWindows(state);
            if (windows.length < 8) {
                return res.status(400).json({ error: 'Need at least 8 labeled windows for training' });
            }
            const positives = windows.filter((w) => w.label === 'dragging_event').length;
            const negatives = windows.length - positives;
            if (positives === 0 || negatives === 0) {
                return res.status(400).json({ error: 'Need both normal and dragging labels for training' });
            }
            const trained = trainLogisticRegression(windows);
            state.model = trained;
            queueSaveState();
            res.json({ ok: true, model: trained });
        });
        router.get('/predictions', (req, res) => {
            if (!state.model)
                return res.status(400).json({ error: 'Model not trained' });
            const safeId = String(req.query.vessel || '').trim();
            const vessel = state.buddies[safeId];
            if (!vessel)
                return res.status(404).json({ error: 'Vessel not found' });
            const start = parseOptionalNumber(req.query.start) ?? 0;
            const end = parseOptionalNumber(req.query.end) ?? Date.now();
            const windowMs = Math.max(60_000, parseOptionalNumber(req.query.windowMs) ?? defaultWindowMs);
            const predictions = predictWindowsForVessel(vessel, state.model, start, end, windowMs);
            res.json({ vessel: safeId, predictions });
        });
    };
    function loadState() {
        const resolvedStatePath = statePath || path.join(app.getDataDirPath(), 'state.json');
        if (!statePath)
            statePath = resolvedStatePath;
        const currentDataDir = path.dirname(resolvedStatePath);
        const legacyCandidates = [
            path.join(currentDataDir, 'buddywatch', 'state.json'),
            path.join(currentDataDir, 'buddywatch', 'stage.json'),
            path.join(currentDataDir, 'signalk-buddywatch-plugin', 'state.json')
        ];
        const loadFromPath = (candidatePath) => {
            if (!fs.existsSync(candidatePath))
                return null;
            try {
                const parsed = JSON.parse(fs.readFileSync(candidatePath, 'utf8'));
                const buddies = parsed?.buddies && typeof parsed.buddies === 'object' ? parsed.buddies : {};
                const migratedBuddies = {};
                Object.entries(buddies).forEach(([buddyKey, raw]) => {
                    if (!raw || typeof raw !== 'object')
                        return;
                    const inferredSafeId = typeof raw.safeId === 'string' && raw.safeId.trim()
                        ? raw.safeId.trim()
                        : safePathId(String(raw.id || buddyKey));
                    if (!inferredSafeId)
                        return;
                    const track = Array.isArray(raw.track) ? raw.track : [];
                    migratedBuddies[inferredSafeId] = {
                        id: String(raw.id || buddyKey || inferredSafeId),
                        safeId: inferredSafeId,
                        name: String(raw.name || raw.id || buddyKey || inferredSafeId),
                        mmsi: raw.mmsi != null ? String(raw.mmsi) : undefined,
                        lastPosition: isValidPosition(raw.lastPosition) ? raw.lastPosition : undefined,
                        lastPositionTime: Number.isFinite(raw.lastPositionTime) ? raw.lastPositionTime : undefined,
                        track: track
                            .filter((point) => point && Number.isFinite(point.time) && isValidPosition(point.position))
                            .map((point) => ({ position: point.position, time: point.time }))
                            .sort((a, b) => a.time - b.time)
                    };
                });
                return {
                    buddies: migratedBuddies,
                    labels: Array.isArray(parsed?.labels)
                        ? parsed.labels
                            .filter((label) => label &&
                            typeof label.id === 'string' &&
                            typeof label.safeId === 'string' &&
                            Number.isFinite(label.startTime) &&
                            Number.isFinite(label.endTime) &&
                            (label.label === 'normal_anchored' || label.label === 'dragging_event'))
                            .map((label) => ({
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
                };
            }
            catch (error) {
                app.error(`Could not parse state file ${candidatePath}: ${error}`);
                return null;
            }
        };
        const countTrackPoints = (s) => Object.values(s.buddies).reduce((sum, buddy) => sum + (Array.isArray(buddy.track) ? buddy.track.length : 0), 0);
        const currentState = loadFromPath(resolvedStatePath);
        if (currentState) {
            state = currentState;
            loadedStateFrom = resolvedStatePath;
        }
        const hasCurrentData = currentState && countTrackPoints(currentState) > 0;
        if (!hasCurrentData) {
            const legacyPath = legacyCandidates.find((legacyPath) => fs.existsSync(legacyPath));
            if (legacyPath) {
                const legacyState = loadFromPath(legacyPath);
                if (legacyState && countTrackPoints(legacyState) > 0) {
                    state = legacyState;
                    loadedStateFrom = legacyPath;
                    saveState();
                }
            }
        }
        if (!currentState && !loadedStateFrom)
            return;
        pruneHistory();
    }
    function ensureStateLoadedFromDisk() {
        if (Object.keys(state.buddies).length > 0)
            return;
        try {
            loadState();
        }
        catch (error) {
            app.error(`Failed on-demand state reload: ${error}`);
        }
    }
    function syncTracks() {
        const selfPos = getSelfPosition();
        if (!selfPos)
            return;
        const vessels = (app.getPath('vessels') || {});
        const now = Date.now();
        Object.entries(vessels).forEach(([key, vessel]) => {
            if (!vessel || key === 'self')
                return;
            const position = vessel.navigation?.position?.value ?? vessel.navigation?.position;
            if (!isValidPosition(position))
                return;
            const d = calcDistance(selfPos.latitude, selfPos.longitude, position.latitude, position.longitude);
            if (d > captureRadiusMeters)
                return;
            const id = vesselUrnFromKey(key, vessel);
            const safeId = safePathId(id);
            if (!safeId)
                return;
            const existing = state.buddies[safeId];
            const name = String(vessel.name?.value ?? vessel.name ?? vessel.communication?.callsign?.value ?? id);
            const buddy = existing ?? {
                id,
                safeId,
                name,
                mmsi: vessel.mmsi != null ? String(vessel.mmsi) : undefined,
                track: []
            };
            buddy.name = name;
            if (!buddy.mmsi && vessel.mmsi != null)
                buddy.mmsi = String(vessel.mmsi);
            buddy.lastPosition = { latitude: position.latitude, longitude: position.longitude };
            buddy.lastPositionTime = now;
            const last = lastSampleAt[safeId] ?? 0;
            if (!last || now - last >= sampleResolutionMs) {
                buddy.track.push({ position: buddy.lastPosition, time: now });
                lastSampleAt[safeId] = now;
            }
            state.buddies[safeId] = buddy;
        });
        pruneHistory();
        queueSaveState();
    }
    function pruneHistory(now = Date.now()) {
        const retentionMs = (configuration.recordingRetentionHours ?? 240) * 60 * 60 * 1000;
        const cutoff = now - retentionMs;
        Object.values(state.buddies).forEach((buddy) => {
            buddy.track = buddy.track.filter((point) => point.time >= cutoff);
        });
        state.labels = state.labels.filter((label) => label.endTime >= cutoff);
    }
    function getSelfPosition() {
        const v = app.getSelfPath('navigation.position.value');
        return isValidPosition(v) ? v : undefined;
    }
    function queueSaveState() {
        if (saveStateDebounce)
            return;
        saveStateDebounce = setTimeout(() => {
            saveStateDebounce = undefined;
            saveState();
        }, saveDebounceMs);
    }
    function saveState() {
        fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
    }
    return plugin;
};
function parseOptionalNumber(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
}
function vesselUrnFromKey(vesselKey, vessel) {
    if (!vesselKey || vesselKey === 'self')
        return '';
    if (String(vesselKey).startsWith('urn:'))
        return vesselKey;
    const mmsi = vessel?.mmsi;
    if (mmsi != null && String(mmsi).trim())
        return `urn:mrn:imo:mmsi:${String(mmsi).trim()}`;
    return String(vesselKey);
}
function safePathId(input) {
    return String(input || '')
        .replace(/[^a-zA-Z0-9_]/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_+|_+$/g, '')
        .toLowerCase();
}
function isValidPosition(value) {
    return (value &&
        typeof value.latitude === 'number' &&
        Number.isFinite(value.latitude) &&
        typeof value.longitude === 'number' &&
        Number.isFinite(value.longitude));
}
function calcDistance(lat1, lon1, lat2, lon2) {
    return geolib.getDistance({ latitude: lat1, longitude: lon1 }, { latitude: lat2, longitude: lon2 }, 0.1);
}
function buildLabeledFeatureWindows(state) {
    const windows = [];
    state.labels.forEach((label) => {
        const vessel = state.buddies[label.safeId];
        if (!vessel)
            return;
        const points = vessel.track.filter((point) => point.time >= label.startTime && point.time <= label.endTime);
        if (points.length < minPointsForFeatures)
            return;
        const features = extractTrackFeatures(points);
        windows.push({
            safeId: label.safeId,
            label: label.label,
            startTime: label.startTime,
            endTime: label.endTime,
            features
        });
    });
    return windows;
}
function extractTrackFeatures(points) {
    const sorted = points.slice().sort((a, b) => a.time - b.time);
    const centroid = {
        latitude: sorted.reduce((sum, p) => sum + p.position.latitude, 0) / sorted.length,
        longitude: sorted.reduce((sum, p) => sum + p.position.longitude, 0) / sorted.length
    };
    let pathLength = 0;
    let maxSpeed = 0;
    const speeds = [];
    const radial = [];
    for (let i = 0; i < sorted.length; i += 1) {
        radial.push(calcDistance(sorted[i].position.latitude, sorted[i].position.longitude, centroid.latitude, centroid.longitude));
        if (i === 0)
            continue;
        const prev = sorted[i - 1];
        const cur = sorted[i];
        const d = calcDistance(prev.position.latitude, prev.position.longitude, cur.position.latitude, cur.position.longitude);
        const dt = Math.max(1, (cur.time - prev.time) / 1000);
        const speed = d / dt;
        pathLength += d;
        speeds.push(speed);
        maxSpeed = Math.max(maxSpeed, speed);
    }
    const displacement = calcDistance(sorted[0].position.latitude, sorted[0].position.longitude, sorted[sorted.length - 1].position.latitude, sorted[sorted.length - 1].position.longitude);
    const straightness = pathLength > 0 ? displacement / pathLength : 0;
    const radialMean = radial.reduce((a, b) => a + b, 0) / Math.max(1, radial.length);
    const radialVar = radial.reduce((acc, r) => {
        const delta = r - radialMean;
        return acc + delta * delta;
    }, 0) / Math.max(1, radial.length);
    const meanSpeed = speeds.length > 0 ? speeds.reduce((a, b) => a + b, 0) / speeds.length : 0;
    const radialMax = radial.length > 0 ? Math.max(...radial) : 0;
    let totalTurn = 0;
    for (let i = 2; i < sorted.length; i += 1) {
        const p1 = sorted[i - 2].position;
        const p2 = sorted[i - 1].position;
        const p3 = sorted[i].position;
        const a = Math.atan2(p2.latitude - p1.latitude, p2.longitude - p1.longitude);
        const b = Math.atan2(p3.latitude - p2.latitude, p3.longitude - p2.longitude);
        totalTurn += Math.abs(normalizeAngle(b - a));
    }
    const windowSecs = Math.max(1, (sorted[sorted.length - 1].time - sorted[0].time) / 1000);
    const radiusGrowth = radial.length > 1 ? (radial[radial.length - 1] - radial[0]) / windowSecs : 0;
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
    ];
}
function trainLogisticRegression(windows) {
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
    ];
    const x = windows.map((w) => w.features);
    const y = windows.map((w) => (w.label === 'dragging_event' ? 1 : 0));
    const dims = featureNames.length;
    const means = new Array(dims).fill(0);
    const stds = new Array(dims).fill(1);
    for (let j = 0; j < dims; j += 1) {
        means[j] = x.reduce((sum, row) => sum + row[j], 0) / x.length;
        const variance = x.reduce((sum, row) => {
            const delta = row[j] - means[j];
            return sum + delta * delta;
        }, 0) / x.length;
        stds[j] = Math.sqrt(variance) || 1;
    }
    const xn = x.map((row) => row.map((v, j) => (v - means[j]) / stds[j]));
    let weights = new Array(dims).fill(0);
    let bias = 0;
    const learningRate = 0.12;
    const iterations = 500;
    for (let iter = 0; iter < iterations; iter += 1) {
        const gradW = new Array(dims).fill(0);
        let gradB = 0;
        for (let i = 0; i < xn.length; i += 1) {
            const p = sigmoid(dot(weights, xn[i]) + bias);
            const err = p - y[i];
            gradB += err;
            for (let j = 0; j < dims; j += 1)
                gradW[j] += err * xn[i][j];
        }
        const invN = 1 / xn.length;
        bias -= learningRate * gradB * invN;
        weights = weights.map((w, j) => w - learningRate * gradW[j] * invN);
    }
    const predictions = xn.map((row) => sigmoid(dot(weights, row) + bias));
    const metrics = computeMetrics(predictions, y, 0.5);
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
    };
}
function predictWindowsForVessel(vessel, model, start, end, windowMs) {
    const points = vessel.track.filter((point) => point.time >= start && point.time <= end);
    if (points.length < minPointsForFeatures)
        return [];
    const out = [];
    let cursor = start;
    while (cursor + windowMs <= end) {
        const slice = points.filter((p) => p.time >= cursor && p.time <= cursor + windowMs);
        if (slice.length >= minPointsForFeatures) {
            const feat = extractTrackFeatures(slice);
            const z = feat.map((v, i) => (v - model.means[i]) / (model.stds[i] || 1));
            const p = sigmoid(dot(model.weights, z) + model.bias);
            out.push({ startTime: cursor, endTime: cursor + windowMs, probability: p });
        }
        cursor += Math.max(windowMs / 2, 60_000);
    }
    return out;
}
function computeMetrics(probs, truth, threshold) {
    let tp = 0;
    let tn = 0;
    let fp = 0;
    let fn = 0;
    for (let i = 0; i < probs.length; i += 1) {
        const pred = probs[i] >= threshold ? 1 : 0;
        const actual = truth[i];
        if (pred === 1 && actual === 1)
            tp += 1;
        else if (pred === 1 && actual === 0)
            fp += 1;
        else if (pred === 0 && actual === 1)
            fn += 1;
        else
            tn += 1;
    }
    const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
    const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
    const accuracy = probs.length > 0 ? (tp + tn) / probs.length : 0;
    const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
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
    };
}
function dot(a, b) {
    let sum = 0;
    for (let i = 0; i < a.length; i += 1)
        sum += a[i] * b[i];
    return sum;
}
function sigmoid(x) {
    if (x > 35)
        return 1;
    if (x < -35)
        return 0;
    return 1 / (1 + Math.exp(-x));
}
function normalizeAngle(angle) {
    let x = angle;
    while (x > Math.PI)
        x -= 2 * Math.PI;
    while (x < -Math.PI)
        x += 2 * Math.PI;
    return x;
}
function isValidModel(value) {
    return (value &&
        Number.isFinite(value.version) &&
        Number.isFinite(value.trainedAt) &&
        Array.isArray(value.featureNames) &&
        Array.isArray(value.means) &&
        Array.isArray(value.stds) &&
        Array.isArray(value.weights) &&
        Number.isFinite(value.bias) &&
        Number.isFinite(value.threshold) &&
        value.metrics &&
        Number.isFinite(value.metrics.sampleCount));
}
module.exports = load;
exports.default = load;
//# sourceMappingURL=index.js.map