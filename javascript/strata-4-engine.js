/* Time Strata - what the program does: the project, the chains and their frames on the graphics card, the scene
 * at any moment of the shot, playing, and recording. The page (strata-5-ui.js) only shows it and asks for it.
 */
(function () {
    'use strict';
    const Core = window.StrataCore, S = window.Strata = window.Strata || {};

    const E = S.engine = {
        options: null, project: null, doc: null, renderer: null, time: 0, playing: false, dirty: false,
        free: null,                 // a camera the user moves with the mouse, outside the keys: {yaw, pitch, distance, target}
        loading: null,              // {done, total} while frames go to the graphics card
        loaded: {},                 // chain id -> {make, base (first layer), frames}
        budget: 640,                // megabytes of the graphics card the frames may take
        listeners: new Set(),
    };

    E.on = fn => { E.listeners.add(fn); return () => E.listeners.delete(fn); };
    E.emit = what => { for (const fn of E.listeners) { try { fn(what); } catch (e) { console.warn('[Time Strata]', e); } } };

    /* ---- the server ---- */

    E.api = async function (path, body, raw) {
        const init = body === undefined ? {} : raw ? { method: 'POST', body } :
            { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
        const response = await fetch('./time-strata/' + path, init);
        let answer = null;
        try { answer = await response.json(); } catch (e) { /* no body */ }
        if (!response.ok) {
            const detail = answer && answer.detail;
            throw new Error(typeof detail === 'string' ? detail : (detail ? JSON.stringify(detail) : `${response.status} ${response.statusText}`));
        }
        return answer;
    };

    E.fileUrl = path => './time-strata/file/' + encodeURIComponent(E.project) + '/' + path.split('/').map(encodeURIComponent).join('/');

    /* a worker's timer: a hidden page holds back setTimeout, a worker's does not */
    let sleeper = null;
    E.sleep = ms => new Promise(resolve => {
        try {
            if (!sleeper) sleeper = new Worker(URL.createObjectURL(new Blob(['onmessage=e=>setTimeout(()=>postMessage(e.data[0]),e.data[1])'])));
            const id = Math.random();
            const done = e => { if (e.data === id) { sleeper.removeEventListener('message', done); resolve(); } };
            sleeper.addEventListener('message', done);
            sleeper.postMessage([id, ms]);
        } catch (e) { setTimeout(resolve, ms); }
    });

    /* waits for a job, telling `progress` how it goes; returns its result */
    E.waitJob = async function (job, progress) {
        while (true) {
            const now = await E.api('job?id=' + job.id);
            if (progress) progress(now);
            if (now.status === 'done') return now.result;
            if (now.status === 'failed') throw new Error(now.error || 'failed');
            if (now.status === 'cancelled') throw new Error('cancelled');
            await E.sleep(700);
        }
    };

    /* ---- the project ---- */

    E.start = async function () {
        E.options = await E.api('options');
        const list = await E.api('projects');
        let wanted = null;
        try { wanted = localStorage.getItem('time-strata-project'); } catch (e) { /* private window */ }
        const names = list.projects.map(p => p.name);
        if (wanted && names.includes(wanted)) await E.open(wanted);
        else if (names.length) await E.open(names[0]);
        return list.projects;
    };

    E.open = async function (name) {
        await E.saveNow();
        const doc = await E.api('project?name=' + encodeURIComponent(name));
        E.project = name; E.doc = upgrade(doc); E.time = 0; E.free = null; E.loaded = {};
        try { localStorage.setItem('time-strata-project', name); } catch (e) { /* private window */ }
        E.emit('project');
        await E.loadWorld();
        await E.loadFrames();
    };

    E.create = async function (name) {
        const doc = await E.api('project/create', { name });
        await E.open(doc.name);
    };

    function upgrade(doc) {
        doc.shot = Object.assign({ duration: 10, fps: 30, width: 1080, height: 1920 }, doc.shot);
        doc.world = Object.assign({ kind: 'sky', eye: 1.6, radius: 90, turn: 0, fog: 0.25 }, doc.world);
        doc.camera = Object.assign({ follow: null, keys: [] }, doc.camera);
        doc.knife = Object.assign({ on: false, keys: [] }, doc.knife);
        // a frame dissolves before it reaches the lens: inside a chain the frames ahead are then read as slices,
        // instead of the nearest one filling the picture
        doc.look = Object.assign({ near: 0.45, far: 1.2 }, doc.look);
        doc.record = Object.assign({ size: '1080x1920', fps: 30, kind: 'mp4-h264', quality: 17, supersample: 1, name: '', music_start: 0 }, doc.record);
        doc.plan = Object.assign({ seconds: 6, speed: 1.2, rate: 24, ahead: 6 }, doc.plan);
        for (const c of doc.chains || []) fillChain(c);
        return doc;
    }

    function fillChain(c) {
        c.spine = Object.assign({}, Core.SPINE_DEFAULTS, c.spine);
        c.look = Object.assign({ fade: 0.35, tint: '#8fb8ff', tint_amount: 0.0, glow: 0, glow_color: '#5ff2ff', rib: 0.25, reverse: false, shadow: 0.35 }, c.look);
        c.cut = Object.assign({ start: 0, end: null, fps: null, max_frames: 600, matte: 'auto', model: null, key_colour: null,
                                align: 'centre', scale: 'steady', height: 768, figure: 0.84, baseline: 0.95 }, c.cut);
        c.time = Object.assign({}, Core.TIME_DEFAULTS, c.time);
        delete c.grow;
        if (c.size == null) c.size = 1.7;
        if (c.from == null) c.from = 0;
        if (c.offset == null) c.offset = 0;
        if (c.visible == null) c.visible = true;
        return c;
    }

    E.touch = function () {
        E.dirty = true;
        clearTimeout(E._saveTimer);
        E._saveTimer = setTimeout(() => E.saveNow().catch(e => console.warn('[Time Strata] save', e)), 1200);
        E.emit('changed');
    };

    E.saveNow = async function () {
        clearTimeout(E._saveTimer);
        if (!E.dirty || !E.project || !E.doc) return;
        E.dirty = false;
        await E.api('project/save', { name: E.project, doc: E.doc });
        E.emit('saved');
    };

    /* ---- chains ---- */

    E.chain = id => (E.doc.chains || []).find(c => c.id === id) || null;

    E.addChain = function (name) {
        const id = 'c' + Math.random().toString(36).slice(2, 8);
        const n = E.doc.chains.length;
        const c = fillChain({ id, name: name || ('Chain ' + (n + 1)), frames: 0, make: null, width: 512, height: 768, fps: 24,
                              figure: 0.84, baseline: 0.95, source: null });
        // a second chain stands beside the first, so both are seen
        c.spine.x = n * 3.5; c.spine.z = -n * 2;
        E.doc.chains.push(c);
        if (!E.doc.camera.follow) E.doc.camera.follow = id;
        E.touch();
        return c;
    };

    E.removeChain = async function (id) {
        const c = E.chain(id);
        if (!c) return;
        if (c.make) await E.api('chain/delete', { project: E.project, chain: id }).catch(() => null);
        E.doc.chains = E.doc.chains.filter(x => x.id !== id);
        if (E.doc.camera.follow === id) E.doc.camera.follow = E.doc.chains.length ? E.doc.chains[0].id : null;
        E.touch();
        await E.loadFrames();
    };

    /* a file from the computer into the project's uploads -> its path there */
    E.upload = async function (file, folder) {
        const query = `upload?project=${encodeURIComponent(E.project)}&filename=${encodeURIComponent(file.name)}` + (folder ? `&folder=${encodeURIComponent(folder)}` : '');
        return E.api(query, file, true);
    };

    /* Makes a chain from files the user chose: one video, or pictures (or a zip of them).
     * `progress(job)` hears how it goes. */
    E.makeChain = async function (id, files, progress) {
        const c = E.chain(id);
        files = Array.from(files || []);
        if (!files.length) throw new Error('Choose a video or pictures first');
        let source;
        const isVideo = f => /\.(mp4|mov|webm|mkv|avi|m4v|gif)$/i.test(f.name);
        if (files.length === 1 && isVideo(files[0])) {
            const up = await E.upload(files[0]);
            source = { kind: 'video', path: up.path };
            if (up.video && !c.cut.fps) c.source_fps = up.video.fps;
        } else if (files.length === 1 && /\.zip$/i.test(files[0].name)) {
            const up = await E.upload(files[0]);
            source = { kind: 'zip', path: up.path, fps: c.cut.fps || 24 };
        } else {
            const folder = 'pics-' + Date.now().toString(36);
            const sorted = files.filter(f => /\.(png|webp|jpe?g|bmp|tiff?)$/i.test(f.name)).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
            if (!sorted.length) throw new Error('These are neither a video nor pictures');
            for (let i = 0; i < sorted.length; i++) {
                if (progress) progress({ status: 'running', stage: `uploading ${i + 1} of ${sorted.length}`, progress: i / sorted.length * 0.05 });
                await E.upload(sorted[i], folder);
            }
            source = { kind: 'pictures', path: 'uploads/' + folder, fps: c.cut.fps || 24 };
        }
        c.source = source;
        E.touch();
        return E.cutChain(id, false, progress);
    };

    /* cuts a chain's source out again (or only places its frames again: `realign`) */
    E.cutChain = async function (id, realign, progress) {
        const c = E.chain(id);
        if (!c.source) throw new Error('This chain has no source yet');
        const options = Object.assign({}, c.cut);
        const job = await E.api('job/start', { kind: 'chain', params: { project: E.project, chain: id, source: c.source, options, realign: !!realign } });
        const result = await E.waitJob(job, progress);
        Object.assign(c, { frames: result.frames, make: result.make, width: result.width, height: result.height, fps: result.fps,
                           figure: result.figure, baseline: result.baseline, suspects: result.suspects, method: result.method });
        if (c.to != null && c.to >= c.frames) c.to = null;
        E.touch();
        await E.loadFrames();
        return result;
    };

    /* Draws a new chain with Deforum over the motion of chain `sourceId`: the new chain stands where the motion
     * chain stood (which is then hidden) and the camera follows it. `targetId`: a chain drawn before, drawn again. */
    E.generate = async function (sourceId, options, targetId, progress) {
        const from = E.chain(sourceId);
        if (!from || !from.make) throw new Error('Make the motion chain first');
        let c = targetId ? E.chain(targetId) : null;
        if (!c) {
            c = E.addChain(from.name + ' · ' + 'drawn');
            c.spine = JSON.parse(JSON.stringify(from.spine));
            c.size = from.size; c.time = JSON.parse(JSON.stringify(from.time)); c.look = JSON.parse(JSON.stringify(from.look));
        }
        c.generated = { from: sourceId, options: JSON.parse(JSON.stringify(options)) };
        E.touch();
        const job = await E.api('job/start', { kind: 'deforum', params: { project: E.project, source: sourceId, chain: c.id, options } });
        const result = await E.waitJob(job, progress);
        Object.assign(c, { frames: result.frames, make: result.make, width: result.width, height: result.height, fps: result.fps,
                           figure: result.figure, baseline: result.baseline, suspects: result.suspects, method: result.method,
                           source: { kind: 'pictures', path: `chains/${c.id}/source`, fps: result.fps } });
        c.visible = true;
        from.visible = false;
        E.doc.camera.follow = c.id;
        E.touch();
        await E.loadFrames();
        return c;
    };

    /* ---- frames on the graphics card ---- */

    /* the chain whose frames a chain shows: itself, or the one it borrows them from (`uses`: a second life of
     * the same frames, laid out another way, without a second copy of them anywhere) */
    E.ownerOf = c => {
        const owner = c.uses ? E.chain(c.uses) : null;
        return owner && owner.make && owner.frames > 0 ? owner : c;
    };

    E.shownChains = () => (E.doc ? E.doc.chains.filter(c => c.visible && E.ownerOf(c).make && E.ownerOf(c).frames > 0) : []);

    E.loadFrames = async function () {
        const R = E.renderer;
        if (!R || !E.doc) return;
        const chains = E.shownChains();
        // every set of frames once, even when two chains show it (or the one that owns it is hidden)
        const owners = [];
        for (const c of chains) if (!owners.includes(E.ownerOf(c))) owners.push(E.ownerOf(c));
        const layers = owners.reduce((n, c) => n + c.frames, 0);
        E.loaded = {};
        if (!layers) { R.texture && R.gl.deleteTexture(R.texture); R.texture = null; E.prepareSharp([]); E.emit('frames'); return; }
        const aspect = Math.max(...owners.map(c => c.width / c.height));
        const tallest = Math.max(...owners.map(c => c.height));
        const [w, h] = R.textureSize(Math.min(layers, R.maxLayers), aspect, tallest, E.budget);
        R.allocate(layers, w, h);
        E.prepareSharp(owners);
        let base = 0;
        const todo = [], byOwner = {};
        for (const o of owners) {
            byOwner[o.id] = { make: o.make, base, frames: Math.min(o.frames, R.maxLayers - base) };
            for (let k = 0; k < byOwner[o.id].frames; k++) todo.push([base + k, `chains/${o.id}/${o.make}/${String(k).padStart(6, '0')}.webp`]);
            base += o.frames;
            if (base >= R.maxLayers) break;
        }
        for (const c of chains) if (byOwner[E.ownerOf(c).id]) E.loaded[c.id] = byOwner[E.ownerOf(c).id];
        const ticket = E._loadTicket = {};
        E.loading = { done: 0, total: todo.length, size: [w, h] };
        E.emit('loading');
        let next = 0;
        const worker = async () => {
            while (next < todo.length && E._loadTicket === ticket) {
                const [layer, path] = todo[next++];
                try {
                    const blob = await (await fetch(E.fileUrl(path))).blob();
                    if (E._loadTicket !== ticket) return;
                    await R.upload(layer, blob);
                } catch (e) { console.warn('[Time Strata] frame', path, e); }
                E.loading.done++;
                if (E.loading.done % 48 === 0) { R.finishUploads(); E.emit('loading'); }
            }
        };
        await Promise.all(Array.from({ length: 6 }, worker));
        if (E._loadTicket !== ticket) return;
        R.finishUploads();
        E.loading = null;
        E.emit('frames');
    };

    /* ---- the world ---- */

    E.loadWorld = async function () {
        if (!E.renderer || !E.doc) return;
        const W = E.doc.world;
        await E.renderer.setPanorama(W.kind === 'panorama' && W.panorama ? E.fileUrl(W.panorama) : null);
        E.emit('world');
    };

    /* ---- the scene at a moment ---- */

    const pathCache = new Map();
    E.pathOf = function (c) {
        const length = Core.chainLength(c, Math.max(1, E.ownerOf(c).frames || 1)) + 2;
        const key = c.id + JSON.stringify(c.spine) + '|' + length.toFixed(3);
        let path = pathCache.get(key);
        if (!path) {
            path = Core.spinePath(c.spine, length, 0.01);
            pathCache.set(key, path);
            if (pathCache.size > 24) pathCache.delete(pathCache.keys().next().value);
        }
        return path;
    };

    E.cardGeometry = function (c) {
        const o = E.ownerOf(c);         // the frames' own measures, also for a chain that borrows them
        return { size: c.size, figure: o.figure || 0.84, baseline: o.baseline || 0.95, aspect: (o.width || 512) / (o.height || 768),
                 from: c.from || 0, to: c.to, offset: c.offset || 0, spine: c.spine, faces: c.time && c.time.mode === 'past' ? 'end' : 'start' };
    };

    E.followed = function () {
        const doc = E.doc;
        return (doc && (E.chain(doc.camera.follow) || doc.chains[0])) || null;
    };

    /* the present of a chain at time t (a fractional frame), or null when all its frames stand there */
    E.presentOf = (c, t) => Core.presentAt(c.time, t, E.ownerOf(c).fps, c.to != null ? c.to : Math.max(0, (E.ownerOf(c).frames || 1) - 1));

    /* how far along its chain a riding camera's keys are measured from at time t */
    E.shiftAt = function (t) {
        const c = E.followed();
        if (!c || !E.doc.camera.ride) return 0;
        const now = E.presentOf(c, t);
        return now == null ? 0 : Core.presentS(E.cardGeometry(c), now);
    };

    E.defaultKeys = function () {
        const c = E.followed();
        return Core.preset('opening', c ? Core.chainLength(E.cardGeometry(c), c.frames || 120) : 4, E.doc.shot.duration, c ? c.size : 1.7,
                           c && c.time.mode === 'past' ? -1 : 1);
    };

    /* the camera at time t: the keys (or, without keys, the reel's opening) */
    E.cameraAt = function (t) {
        const c = E.followed();
        const path = c ? E.pathOf(c) : Core.spinePath({ shape: 'line' }, 10, 0.01);
        let keys = E.doc.camera.keys, shift = E.shiftAt(t);
        if (!keys || !keys.length) {
            keys = E.defaultKeys();
            const now = c ? E.presentOf(c, t) : null;
            shift = now == null ? 0 : Core.presentS(E.cardGeometry(c), now);
        }
        const cam = Core.cameraAt(keys, path, t, shift);
        if (E.free) {
            // looking around: the camera goes round a point, as the mouse says
            const f = E.free;
            const d = [Math.cos(Core.rad(f.pitch)) * Math.sin(Core.rad(f.yaw)), Math.sin(Core.rad(f.pitch)), Math.cos(Core.rad(f.pitch)) * Math.cos(Core.rad(f.yaw))];
            const eye = Core.add(f.target, Core.mul(d, f.distance));
            return { eye, target: f.target, up: Core.UP, fov: cam.fov, forward: Core.norm(Core.sub(f.target, eye)), values: cam.values };
        }
        return cam;
    };

    E.sceneAt = function (t) {
        const doc = E.doc;
        const camera = E.cameraAt(t);
        const cards = [], shadows = [];
        for (const c of E.shownChains()) {
            const loaded = E.loaded[c.id];
            if (!loaded) continue;
            const path = E.pathOf(c), geometry = E.cardGeometry(c);
            const list = Core.chainCards(geometry, path, loaded.frames);
            const now = E.presentOf(c, t);
            const o = E.ownerOf(c);
            const L = c.look, n = Math.max(1, (c.to == null ? o.frames - 1 : c.to) - (c.from || 0));
            const tint = window.StrataGL.hex(L.tint), glowColor = window.StrataGL.hex(L.glow_color);
            const shown = [];
            for (const card of list) {
                const there = Core.presence(c.time, card.k, now);
                if (there <= 0) continue;
                // age: how far a frame is from the near end (the present, when there is one)
                let age = now == null ? (card.k - (c.from || 0)) / n : Math.min(1, Math.abs(card.k - now) / n);
                if (L.reverse) age = 1 - age;
                cards.push({ bottom: card.bottom, right: card.right, up: card.up, layer: loaded.base + card.k,
                             alpha: there * (1 - L.fade * age), tint, tintAmount: L.tint_amount * age, glow: L.glow * (0.25 + 0.75 * age),
                             glowColor, rib: L.rib, key: o.id + ':' + card.k, path: `chains/${o.id}/${o.make}/${String(card.k).padStart(6, '0')}.webp` });
                shown.push(card);
            }
            if (L.shadow > 0 && shown.length > 1) {
                const strip = [], half = Core.cardSize(geometry).width * 0.32;
                const last = shown[shown.length - 1].s, first = shown[0].s;
                for (let s = first; s <= last + 1e-6; s += Math.max(0.05, (last - first) / 200)) {
                    const p = Core.pointAt(path, s).p;
                    strip.push([p[0], p[2], half, L.shadow * Math.max(0, 1 - p[1] / 0.8)]);
                }
                if (strip.length > 1) shadows.push(strip);
            }
        }
        const follow = E.followed();
        const knife = follow ? Core.knifeAt(doc.knife, E.pathOf(follow), t) : null;
        const waiting = E.assignSharp(cards, camera);
        return { world: doc.world, camera, cards, shadows, knife, near: [doc.look.near, doc.look.far], waiting };
    };

    /* ---- full-size copies of the frames nearest the camera ---- */

    const SHARP_SLOTS = 32;
    E.sharp = { slots: 0, keyOf: [], ready: [], used: [], loading: new Map(), tick: 0 };

    /* after the small copies are made: full-size copies are worth having only when the small ones are smaller */
    E.prepareSharp = function (chains) {
        const R = E.renderer, S = E.sharp;
        const tallest = Math.max(0, ...chains.map(c => c.height || 0));
        const widest = Math.max(0.1, ...chains.map(c => (c.width || 1) / (c.height || 1)));
        const total = chains.reduce((n, c) => n + c.frames, 0);
        const slots = R.texH && tallest > R.texH * 1.15 ? Math.min(SHARP_SLOTS, total) : 0;
        R.allocateSharp(slots, Math.round(tallest * widest / 4) * 4, tallest);
        Object.assign(S, { slots, keyOf: new Array(slots).fill(null), ready: new Array(slots).fill(false),
                           used: new Array(slots).fill(0), loading: new Map(), ticket: {} });
    };

    /* Gives the cards that would be drawn larger than their small copy a full-size one: those already loaded are
     * marked to use it, the others are asked for (into a slot no wanted card uses). Returns the loads still
     * running for this picture (a recording waits for them). */
    E.assignSharp = function (cards, camera) {
        const R = E.renderer, S = E.sharp;
        if (!S.slots || !R) return [];
        S.tick++;
        const eye = camera.eye, fwd = camera.forward || Core.norm(Core.sub(camera.target, camera.eye));
        const pxPerUnit = R.canvas.height / (2 * Math.tan(Core.rad(camera.fov) / 2));
        const wanted = [];
        for (const c of cards) {
            const centre = [c.bottom[0] + c.up[0] * 0.5, c.bottom[1] + c.up[1] * 0.5, c.bottom[2] + c.up[2] * 0.5];
            const ahead = (centre[0] - eye[0]) * fwd[0] + (centre[1] - eye[1]) * fwd[1] + (centre[2] - eye[2]) * fwd[2];
            if (ahead < 0.05) continue;
            const tall = Math.hypot(c.up[0], c.up[1], c.up[2]) / ahead * pxPerUnit;      // its height on screen, in pixels
            if (tall > R.texH * 1.1) wanted.push([tall, c]);
        }
        wanted.sort((a, b) => b[0] - a[0]);
        const keep = new Set(wanted.slice(0, S.slots).map(([, c]) => c.key));
        const waiting = [];
        for (const [, c] of wanted.slice(0, S.slots)) {
            let slot = S.keyOf.indexOf(c.key);
            if (slot >= 0) {
                S.used[slot] = S.tick;
                if (S.ready[slot]) c.sharp = slot;
                else if (S.loading.has(c.key)) waiting.push(S.loading.get(c.key));
                continue;
            }
            // the slot used longest ago by a card not wanted now
            slot = -1;
            for (let i = 0; i < S.slots; i++) if (!keep.has(S.keyOf[i]) && (slot < 0 || S.used[i] < S.used[slot])) slot = i;
            if (slot < 0) break;
            S.keyOf[slot] = c.key; S.ready[slot] = false; S.used[slot] = S.tick;
            const ticket = S.ticket, key = c.key;
            const load = (async () => {
                try {
                    const blob = await (await fetch(E.fileUrl(c.path))).blob();
                    if (S.ticket !== ticket || S.keyOf[slot] !== key) return;
                    await R.uploadSharp(slot, blob);
                    if (S.ticket === ticket && S.keyOf[slot] === key) S.ready[slot] = true;
                } catch (e) { console.warn('[Time Strata] sharp frame', c.path, e); S.keyOf[slot] = null; }
                finally { S.loading.delete(key); E.emit('sharp'); }
            })();
            S.loading.set(key, load);
            waiting.push(load);
        }
        return waiting;
    };

    E.draw = function () {
        if (!E.renderer || !E.doc) return;
        E.renderer.draw(E.sceneAt(E.time));
    };

    /* ---- camera keys ---- */

    E.applyPreset = function (name) {
        const c = E.followed();
        const length = c ? Core.chainLength(E.cardGeometry(c), c.frames || 120) : 4;
        const riding = Core.RIDING.has(name);
        // the reel's opening needs a present to ride with: a chain where every frame stands gets one that eats it
        if (riding && c && c.time.mode === 'all') { c.time.mode = 'future'; c.time.start = c.from || 0; }
        E.doc.camera.ride = riding;
        const dir = c && c.time.mode === 'past' ? -1 : 1;
        const keys = Core.preset(name, length, E.doc.shot.duration, c ? c.size : 1.7, dir);
        if (riding && c && c.time.mode === 'future') {
            // the flight into the frames still to come stays inside them: no deeper than what is left of the chain
            for (const key of keys) {
                if (key.s * dir <= 0) continue;
                const left = length - Core.presentS(E.cardGeometry(c), E.presentOf(c, key.t));
                const room = Math.max(0, left - 0.6);
                key.s = Math.min(key.s, room * (key.t >= E.doc.shot.duration ? 0.85 : 0.6));
            }
        }
        E.doc.camera.keys = keys.map(k => roundKey(k));
        E.free = null;
        E.touch();
    };

    /* how many frames a riding shot uses and how many it needs (the present's frames plus the chain still seen
     * behind it at the end) */
    E.ridingNeeds = function (c) {
        const D = E.doc.shot.duration, rate = c.time.rate || c.fps || 24;
        const used = Math.ceil(D * rate);
        const behind = Math.ceil((E.doc.plan.ahead || 6) / c.spine.spacing);
        return { used, behind, frames: used + behind + (c.time.start || 0), have: c.frames };
    };

    function roundKey(k) {
        const out = {};
        for (const [key, value] of Object.entries(k)) out[key] = typeof value === 'number' ? Math.round(value * 1000) / 1000 : value;
        return out;
    }

    /* a key at the current moment, from what the camera shows now (also when looking around freely) */
    E.keyHere = function () {
        const c = E.followed();
        if (!c) return null;
        const cam = E.cameraAt(E.time);
        if (!E.doc.camera.keys.length) {
            E.doc.camera.keys = E.defaultKeys().map(roundKey);
            E.doc.camera.ride = c.time.mode !== 'all';
        }
        const key = roundKey(Object.assign({ t: E.time }, Core.keyFromView(E.pathOf(c), cam.eye, cam.target, cam.fov, E.shiftAt(E.time))));
        const keys = E.doc.camera.keys.filter(k => Math.abs(k.t - E.time) > 1e-3);
        keys.push(key);
        keys.sort((a, b) => a.t - b.t);
        E.doc.camera.keys = keys;
        E.free = null;
        E.touch();
        return key;
    };

    /* the planner's answer for this project's chain and shot */
    E.plan = function () {
        const c = E.followed();
        const shot = E.doc.shot;
        // the lens is vertical, so the frame's height in the video is what counts
        return Core.plan(Object.assign({}, E.doc.plan, { size: c ? c.size : 1.7, figure: c ? (c.figure || 0.84) : 0.84,
                                                         fov: 50, height: shot.height, near: E.doc.look.far }));
    };

    /* the planner's answer made true: the spacing set, and the camera flown through at its pace */
    E.usePlan = function () {
        const c = E.followed();
        if (!c) return;
        const p = E.plan();
        c.spine.spacing = Math.round(p.spacing * 10000) / 10000;
        const L = Core.chainLength(E.cardGeometry(c), c.frames || p.frames);
        const pace = E.doc.plan.speed;
        const keys = Core.preset('through', L, E.doc.shot.duration, c.size).map(roundKey);
        // flown at the planned speed, starting where the flight would end at the shot's end
        keys[0].s = -1.2; keys[1].s = Math.min(L + 0.3, -1.2 + pace * E.doc.shot.duration);
        E.doc.camera.keys = keys;
        E.touch();
    };

    /* how many frames pass the lens each second at time t */
    E.passRate = function (t) {
        const c = E.followed();
        if (!c) return 0;
        // the camera's own place along the chain, wherever it is measured from
        const along = at => E.cameraAt(at).eye;
        const dt = 0.05, a = Math.max(0, t - dt), b = Math.min(E.doc.shot.duration, t + dt);
        if (E.free) return 0;
        const path = E.pathOf(c);
        const ds = Core.nearestS(path, along(b)) - Core.nearestS(path, along(a));
        return ds / Math.max(1e-6, b - a) / c.spine.spacing;
    };

    /* ---- recording ---- */

    E.recording = null;

    E.record = async function (progress) {
        const doc = E.doc, R = E.renderer, rec = doc.record;
        const [width, height] = String(rec.size).split('x').map(Number);
        const fps = +rec.fps || 30, total = Math.max(1, Math.round(doc.shot.duration * fps));
        if (E.loading) throw new Error('The frames are still loading');
        const session = await E.api('export/start', { project: E.project, name: rec.name || E.project, width, height, fps,
                                                      kind: rec.kind, quality: +rec.quality, supersample: +rec.supersample || 1,
                                                      music: doc.music || '', music_start: +rec.music_start || 0 });
        const canvas = R.canvas, keepW = canvas.width, keepH = canvas.height, keepFree = E.free, keepTime = E.time;
        E.free = null;
        E.recording = { cancel: false };
        let jpeg = false;
        const started = performance.now();
        try {
            R.resize(session.drawn[0], session.drawn[1]);
            for (let i = 0; i < total; i++) {
                if (E.recording.cancel) throw new Error('cancelled');
                E.time = i / fps;
                let scene = E.sceneAt(E.time);
                if (scene.waiting.length) {
                    // the frames this picture shows up close are drawn from their full-size copies, never blurred
                    await Promise.all(scene.waiting);
                    scene = E.sceneAt(E.time);
                }
                R.draw(scene);
                const t0 = performance.now();
                let body;
                if (jpeg) {
                    const url = canvas.toDataURL('image/jpeg', 0.96);
                    const bin = atob(url.slice(url.indexOf(',') + 1));
                    body = new Uint8Array(bin.length);
                    for (let j = 0; j < bin.length; j++) body[j] = bin.charCodeAt(j);
                } else body = R.pixels();
                await E.api(`export/frame?id=${session.id}&jpeg=${jpeg}`, body, true);
                // a browser that sends raw frames slowly sends JPEGs instead (from the third frame on)
                if (!jpeg && i >= 1 && i <= 3 && performance.now() - t0 > 450) jpeg = true;
                if (progress) progress({ frame: i + 1, total, seconds: (performance.now() - started) / 1000, jpeg });
            }
            const result = await E.api('export/finish', { id: session.id });
            return result;
        } catch (e) {
            await E.api('export/cancel', { id: session.id }).catch(() => null);
            throw e;
        } finally {
            R.resize(keepW, keepH);
            E.free = keepFree; E.time = keepTime;
            E.recording = null;
            E.draw();
        }
    };
})();
