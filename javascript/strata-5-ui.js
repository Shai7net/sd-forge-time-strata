/* Time Strata - the page: the bar, the 3D view with its timeline, and the panels. Everything is drawn here,
 * inside the one empty block the tab holds; nothing of Gradio's is used.
 */
(function () {
    'use strict';
    const Core = window.StrataCore, S = window.Strata, E = S.engine, T = S.T;

    const UI = S.ui = { root: null, tab: 'chains', current: null, files: null, busy: null, message: null, preview: 0.75,
                        started: false, needsDraw: true, worlds: null };

    /* ---- building blocks ---- */

    function h(tag, props, ...children) {
        const el = document.createElement(tag);
        for (const [key, value] of Object.entries(props || {})) {
            if (value == null || value === false) continue;
            if (key === 'class') el.className = value;
            else if (key === 't') el.textContent = T(value);
            else if (key === 'tt') el.title = T(value);
            else if (key === 'on') for (const [event, fn] of Object.entries(value)) el.addEventListener(event, fn);
            else if (key === 'style') el.style.cssText = value;
            else if (key in el && key !== 'list') el[key] = value;
            else el.setAttribute(key, value);
        }
        for (const child of children.flat()) if (child != null && child !== false) el.append(child.nodeType ? child : document.createTextNode(child));
        return el;
    }

    function guarded(fn) {
        return async event => {
            try { await fn(event); } catch (e) {
                const text = String(e && e.message || e);
                if (text === 'cancelled') say(T('Cancelled'), 'warn'); else say(T(text), 'error');
                console.warn('[Time Strata]', e);
            }
        };
    }

    /* children into a parent, leaving out the empty ones (append would write "null" for them) */
    const put = (parent, ...children) => parent.append(...children.flat().filter(c => c != null && c !== false));

    const button = (text, onClick, extra) => h('button', Object.assign({ type: 'button', class: 'ts-btn', t: text, on: { click: guarded(onClick) } }, extra || {}));
    const field = (label, control, hint) => h('label', { class: 'ts-field', tt: hint }, h('span', { class: 'ts-label', t: label }), control);
    const row = (...children) => h('div', { class: 'ts-row' }, ...children);
    const section = (title, open, ...children) => h('details', { class: 'ts-section', open: !!open }, h('summary', { t: title }), h('div', { class: 'ts-section-body' }, ...children));
    const note = (text, ...values) => h('div', { class: 'ts-note' }, T(text, ...values));

    function changed(after, value) { E.touch(); UI.needsDraw = true; if (after) after(value); }

    function number(object, key, options, after) {
        options = options || {};
        const input = h('input', { type: 'number', class: 'ts-input', value: object[key] == null ? '' : object[key], min: options.min, max: options.max, step: options.step || 'any', placeholder: options.placeholder || '' });
        input.addEventListener('change', () => {
            if (input.value === '' && options.empty !== undefined) { object[key] = options.empty; changed(after, options.empty); return; }
            let value = parseFloat(input.value);
            if (!isFinite(value)) value = options.fallback != null ? options.fallback : 0;
            if (options.min != null) value = Math.max(options.min, value);
            if (options.max != null) value = Math.min(options.max, value);
            if (options.scale) value /= options.scale;
            object[key] = value; input.value = options.scale ? +(value * options.scale).toFixed(4) : value;
            changed(after, value);
        });
        if (options.scale && object[key] != null) input.value = +(object[key] * options.scale).toFixed(4);
        return input;
    }

    function slider(object, key, options, after) {
        const shown = h('span', { class: 'ts-value' }, String(object[key]));
        const input = h('input', { type: 'range', class: 'ts-range', min: options.min, max: options.max, step: options.step || 0.01, value: object[key] });
        input.addEventListener('input', () => {
            object[key] = parseFloat(input.value); shown.textContent = String(object[key]);
            E.touch(); UI.needsDraw = true; if (after) after(object[key]);
        });
        return h('span', { class: 'ts-slider' }, input, shown);
    }

    function select(object, key, choices, after) {
        const el = h('select', { class: 'ts-input' });
        for (const choice of choices) {
            const [value, label] = Array.isArray(choice) ? choice : [choice, choice];
            el.append(h('option', { value: String(value), selected: String(object[key]) === String(value) }, T(String(label))));
        }
        el.addEventListener('change', () => {
            const original = choices.map(c => Array.isArray(c) ? c[0] : c).find(v => String(v) === el.value);
            object[key] = original;
            changed(after, original);
        });
        return el;
    }

    function check(object, key, after) {
        const el = h('input', { type: 'checkbox', class: 'ts-check', checked: !!object[key] });
        el.addEventListener('change', () => { object[key] = el.checked; changed(after, el.checked); });
        return el;
    }

    function colour(object, key, after) {
        const el = h('input', { type: 'color', class: 'ts-colour', value: object[key] || '#888888' });
        el.addEventListener('input', () => { object[key] = el.value; E.touch(); UI.needsDraw = true; if (after) after(el.value); });
        return el;
    }

    function text(object, key, after, placeholder) {
        const el = h('input', { type: 'text', class: 'ts-input', value: object[key] || '', placeholder: placeholder ? T(placeholder) : '' });
        el.addEventListener('change', () => { object[key] = el.value; changed(after, el.value); });
        return el;
    }

    function say(message, kind) {
        UI.message = { text: message, kind: kind || 'info', at: Date.now() };
        const bar = UI.root && UI.root.querySelector('.ts-message');
        if (bar) { bar.textContent = message; bar.className = 'ts-message ts-' + (kind || 'info'); }
    }

    const fmt = (v, d) => (v == null || !isFinite(v)) ? '-' : (+v).toFixed(d == null ? 2 : d);

    /* ---- the page ---- */

    function build() {
        const host = document.getElementById('strata_host');
        if (!host) return false;
        const mount = host.querySelector('.strata-mount') || host;
        mount.innerHTML = '';
        const root = UI.root = h('div', { class: 'ts-app hebrew-ui-skip', dir: S.hebrew() ? 'rtl' : 'ltr' });
        mount.append(root);
        root.append(topBar(), h('div', { class: 'ts-main' }, h('div', { class: 'ts-panel' }), stage()), h('div', { class: 'ts-message' }));
        renderPanel();
        return true;
    }

    function topBar() {
        const projects = h('select', { class: 'ts-input ts-projects' });
        const fill = async () => {
            const list = (await E.api('projects')).projects;
            projects.innerHTML = '';
            if (!list.length) projects.append(h('option', { value: '' }, T('(no project yet)')));
            for (const p of list) projects.append(h('option', { value: p.name, selected: p.name === E.project }, p.name));
        };
        fill().catch(() => null);
        UI.fillProjects = fill;
        projects.addEventListener('change', guarded(async () => { if (projects.value) { await E.open(projects.value); renderPanel(); } }));
        return h('div', { class: 'ts-bar' },
            h('span', { class: 'ts-title', t: 'Time Strata' }),
            field('Project', projects),
            button('New project', async () => {
                const name = prompt(T('Name of the new project:'), T('My strata'));
                if (!name) return;
                await E.create(name); await fill(); UI.current = null; renderPanel();
            }),
            button('Open the project folder', async () => { await E.api('open-folder', { project: E.project || '' }); }),
            h('span', { class: 'ts-saved' }));
    }

    function stage() {
        const canvas = h('canvas', { class: 'ts-canvas' });
        const time = h('input', { type: 'range', class: 'ts-time', min: 0, max: 1000, step: 1, value: 0 });
        const clock = h('span', { class: 'ts-clock' }, '0.00');
        const play = h('button', { type: 'button', class: 'ts-btn ts-play' }, '▶');
        const info = h('div', { class: 'ts-info' });
        play.addEventListener('click', () => { E.playing = !E.playing; play.textContent = E.playing ? '❚❚' : '▶'; UI.lastTick = performance.now(); });
        time.addEventListener('input', () => { if (!E.doc) return; E.time = time.value / 1000 * E.doc.shot.duration; UI.needsDraw = true; });
        const quality = h('select', { class: 'ts-input ts-quality', tt: 'How sharp the view is drawn while working (recording always draws at full size)' },
            ...[[0.5, 'View: fast'], [0.75, 'View: good'], [1, 'View: sharp']].map(([v, l]) => h('option', { value: v, selected: v === UI.preview }, T(l))));
        quality.addEventListener('change', () => { UI.preview = +quality.value; fit(); });
        const wrap = h('div', { class: 'ts-stage-view' }, canvas, h('div', { class: 'ts-overlay' }));
        const el = h('div', { class: 'ts-stage' }, wrap,
            h('div', { class: 'ts-transport' }, play, time, clock, quality,
              button('Back to the keys', () => { E.free = null; UI.needsDraw = true; }, { tt: 'Leave looking around and see what the camera keys show' })),
            info);
        UI.canvas = canvas; UI.timeSlider = time; UI.clock = clock; UI.info = info; UI.playButton = play; UI.view = wrap;
        if (!E.renderer || E.renderer.canvas !== canvas) {
            try { E.renderer = window.StrataGL.create(canvas); } catch (e) { setTimeout(() => say(String(e.message || e), 'error'), 0); }
        }
        attachMouse(canvas);
        return el;
    }

    /* the canvas keeps the shot's shape inside the space it has */
    function fit() {
        if (!UI.canvas || !E.doc || !UI.view) return;
        const box = UI.view.getBoundingClientRect();
        const W = Math.max(50, box.width), H = Math.max(50, Math.min(window.innerHeight * 0.74, 900));
        const aspect = E.doc.shot.width / E.doc.shot.height;
        let w = W, hh = W / aspect;
        if (hh > H) { hh = H; w = H * aspect; }
        UI.canvas.style.width = Math.round(w) + 'px'; UI.canvas.style.height = Math.round(hh) + 'px';
        const dpr = window.devicePixelRatio || 1;
        if (E.renderer && !E.recording) E.renderer.resize(Math.max(2, Math.round(w * dpr * UI.preview)), Math.max(2, Math.round(hh * dpr * UI.preview)));
        UI.needsDraw = true;
    }

    /* drag on the picture to look around the chain; the wheel comes closer; a double click goes back to the keys */
    function attachMouse(canvas) {
        let drag = null;
        canvas.addEventListener('mousedown', e => {
            if (!E.doc) return;
            if (!E.free) {
                const cam = E.cameraAt(E.time);
                const d = Core.sub(cam.eye, cam.target), r = Core.len(d) || 1;
                E.free = { target: cam.target, distance: r, yaw: Math.atan2(d[0], d[2]) * 180 / Math.PI, pitch: Math.asin(Core.clamp(d[1] / r, -1, 1)) * 180 / Math.PI };
            }
            drag = { x: e.clientX, y: e.clientY, yaw: E.free.yaw, pitch: E.free.pitch, pan: e.button === 2 || e.shiftKey, target: E.free.target.slice() };
            e.preventDefault();
        });
        window.addEventListener('mousemove', e => {
            if (!drag || !E.free) return;
            const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
            if (drag.pan) {
                const cam = E.cameraAt(E.time), right = Core.norm(Core.cross(cam.forward, Core.UP));
                const k = E.free.distance / 400;
                E.free.target = Core.add(Core.add(drag.target, Core.mul(right, -dx * k)), Core.mul(Core.UP, dy * k));
            } else {
                E.free.yaw = drag.yaw - dx * 0.35;
                E.free.pitch = Core.clamp(drag.pitch + dy * 0.3, -85, 85);
            }
            UI.needsDraw = true;
        });
        window.addEventListener('mouseup', () => { drag = null; });
        canvas.addEventListener('contextmenu', e => e.preventDefault());
        canvas.addEventListener('wheel', e => {
            if (!E.free) return;
            E.free.distance = Core.clamp(E.free.distance * Math.exp(e.deltaY * 0.0012), 0.2, 200);
            UI.needsDraw = true; e.preventDefault();
        }, { passive: false });
        canvas.addEventListener('dblclick', () => { E.free = null; UI.needsDraw = true; });
    }

    /* ---- the panel ---- */

    const TABS = [['chains', 'Chains'], ['generate', 'Generate'], ['world', 'World'], ['camera', 'Camera'], ['knife', 'Knife'], ['record', 'Record']];

    function renderPanel() {
        if (!UI.root) return;
        const panel = UI.root.querySelector('.ts-panel');
        const scroll = panel.querySelector('.ts-panel-body');
        const kept = scroll ? scroll.scrollTop : 0;
        panel.innerHTML = '';
        if (!E.doc) {
            panel.append(h('div', { class: 'ts-empty' }, h('p', { t: 'No project yet. Create one to begin.' }),
                button('Create a project', async () => {
                    const name = prompt(T('Name of the new project:'), T('My strata'));
                    if (name) { await E.create(name); await UI.fillProjects(); renderPanel(); }
                })));
            return;
        }
        const tabs = h('div', { class: 'ts-tabs' }, ...TABS.map(([id, label]) =>
            h('button', { type: 'button', class: 'ts-tab' + (UI.tab === id ? ' ts-on' : ''), t: label, on: { click: () => { UI.tab = id; renderPanel(); } } })));
        const body = h('div', { class: 'ts-panel-body' });
        ({ chains: chainsPanel, generate: generatePanel, world: worldPanel, camera: cameraPanel, knife: knifePanel, record: recordPanel })[UI.tab](body);
        panel.append(tabs, body);
        body.scrollTop = kept;
        fit();
    }
    UI.render = renderPanel;

    /* -- chains -- */

    function chainsPanel(body) {
        const doc = E.doc;
        if (!UI.current || !E.chain(UI.current)) UI.current = doc.chains.length ? doc.chains[0].id : null;
        put(body, h('div', { class: 'ts-chips' },
            ...doc.chains.map(c => h('button', { type: 'button', class: 'ts-chip' + (c.id === UI.current ? ' ts-on' : ''),
                                                  on: { click: () => { UI.current = c.id; renderPanel(); } } }, c.name + (c.frames ? ` (${c.frames})` : ''))),
            button('+ Add a chain', () => { const c = E.addChain(); UI.current = c.id; renderPanel(); })));
        const c = E.chain(UI.current);
        if (!c) { put(body, note('A chain is a figure\'s frames standing one behind the other. Add one, then give it a video or pictures.')); return; }

        put(body, row(field('Name', text(c, 'name', () => renderPanel()))));

        // the source and the cut
        const files = h('input', { type: 'file', class: 'ts-file', multiple: true, accept: 'video/*,image/*,.zip' });
        files.addEventListener('change', () => { UI.files = files.files; });
        const progress = h('div', { class: 'ts-progress' });
        const cut = c.cut;
        const allModels = E.options && E.options.models || [];
        const models = allModels.filter(m => m.kind !== 'video').map(m => [m.name, m.name + (m.heavy ? T(' (too big for this card: very slow)') : m.ready ? '' : T(' (downloads first)'))]);
        const videoModels = allModels.filter(m => m.kind === 'video' && m.ready).map(m => [m.name, m.name === 'rvm' ? T('RVM (best)') : T('RVM (fast)')]);
        put(body, section('Source and cut', !c.make,
            note('A video of one figure, or its frames as pictures (PNG with transparency is used as it is). The figure is cut out, cleaned so that hundreds of frames stack without fog, and held in the middle on one ground line.'),
            row(field('Video or pictures', files)),
            row(field('From second', number(cut, 'start', { min: 0 })), field('To second', number(cut, 'end', { min: 0, empty: null, placeholder: T('end') })),
                field('Frames a second', number(cut, 'fps', { min: 1, max: 120, empty: null, placeholder: T('all') }), 'How many frames of each second are taken (empty: every frame). Fewer frames: a shorter chain, faster passing.'),
                field('At most', number(cut, 'max_frames', { min: 2, max: 2000, step: 1 }))),
            row(field('Background', select(cut, 'matte', [['auto', 'Decide by itself'], ...(videoModels.length ? [['rvm', 'People in a video, fast (RVM)']] : []),
                                                           ['model', 'Remove with a model'], ['key', 'A flat colour'], ['alpha', 'Already transparent']], () => { cut.model = null; renderPanel(); }),
                      'Decide by itself: its own transparency, a flat backdrop, otherwise the best picture model (BiRefNet-lite). RVM is ten times faster but leaves holes where a figure has the background\'s colour.'),
                cut.matte === 'model' ? field('Model', select(cut, 'model', [[null, T('the best one here')], ...models])) : null,
                cut.matte === 'rvm' ? field('Model', select(cut, 'model', [[null, T('RVM (best)')], ...videoModels.filter(m => m[0] !== 'rvm')])) : null,
                cut.matte === 'key' ? field('Colour', h('span', {}, colour(cut, 'key_colour'), button('From the edges', () => { cut.key_colour = null; renderPanel(); }, { tt: 'Take the colour of the picture\'s edges' }))) : null),
            row(field('Hold the figure', select(cut, 'align', [['centre', 'Body held in the middle'], ['sway', 'In the middle, with its sway'], ['keep', 'Where it was filmed']]),
                      'Held: the chain runs straight through the body and a shaking camera is taken out. With its sway: only slow drifting is taken out.'),
                field('Size', select(cut, 'scale', [['steady', 'One size for all'], ['follow', 'Every frame the same height']]), 'One size keeps growing and shrinking as filmed (a baby growing up stays visible)'),
                field('Frame height', select(cut, 'height', [512, 640, 768, 1024, 1280].map(v => [v, v + ' px'])))),
            row(button(c.make ? 'Cut out again' : 'Cut out and make the chain', async () => {
                    if (!UI.files || !UI.files.length) {
                        if (!c.source) throw new Error('Choose a video or pictures first');
                        await run(progress, p => E.cutChain(c.id, false, p));
                    } else await run(progress, p => E.makeChain(c.id, UI.files, p));
                    UI.files = null; say(T('The chain is ready: {0} frames', c.frames), 'ok'); renderPanel();
                }, { class: 'ts-btn ts-primary' }),
                c.make ? button('Place again', async () => { await run(progress, p => E.cutChain(c.id, true, p)); say(T('Placed again'), 'ok'); renderPanel(); },
                                { tt: 'Change how the frames are held and their size, without cutting them out again' }) : null,
                UI.busy ? button('Cancel', async () => { if (UI.busy) await E.api('job/cancel', { id: UI.busy }); }) : null),
            progress));
        if (c.make) {
            const suspects = (c.suspects || []).length;
            put(body, note('{0} frames, {1}x{2}, {3} a second. Background: {4}.', c.frames, c.width, c.height, fmt(c.fps, 1),
                             T({ model: 'a model', key: 'a flat colour', alpha: 'its own transparency' }[c.method && c.method.matte] || '-')),
                        suspects ? h('div', { class: 'ts-warn' }, T('{0} frames look wrongly cut: {1}', suspects, c.suspects.slice(0, 12).join(', ') + (suspects > 12 ? '…' : ''))) : null);
        }

        // where it stands
        const sp = c.spine;
        const length = Core.chainLength(E.cardGeometry(c), Math.max(1, c.frames));
        put(body, section('Where it stands', true,
            row(field('Shape', select(sp, 'shape', [['line', 'Straight'], ['arc', 'A bend'], ['s', 'An S'], ['rise', 'Rising'], ['spiral', 'A spiral']], () => renderPanel())),
                field('Spacing (cm)', number(sp, 'spacing', { min: 0.2, max: 200, scale: 100 }, () => renderPanel()), 'How far apart the frames stand. Closer: a solid body; farther: separate frames.'),
                field('Figure height (m)', number(c, 'size', { min: 0.1, max: 50 }))),
            note('The chain is {0} m long.', fmt(length, 2)),
            row(sp.shape === 'arc' || sp.shape === 's' ? field('Bend (°)', number(sp, 'bend', { min: -720, max: 720 })) : null,
                sp.shape !== 'spiral' ? field('Rise (m)', number(sp, 'rise', { min: -50, max: 200 })) : null,
                sp.shape !== 'spiral' && sp.rise ? field('Rising from', slider(sp, 'rise_from', { min: 0, max: 0.95, step: 0.05 })) : null),
            sp.shape === 'spiral' ? row(field('Radius (m)', number(sp, 'radius', { min: 0.3, max: 100 })), field('Rounds', number(sp, 'turns', { min: 0.1, max: 50 })),
                                        field('Climb (m)', number(sp, 'climb', { min: -100, max: 100 }))) : null,
            row(field('Heading (°)', number(sp, 'heading', {})), field('X (m)', number(sp, 'x', {})), field('Z (m)', number(sp, 'z', {})),
                field('Height (m)', number(sp, 'y', {}))),
            row(field('Twist (°)', number(sp, 'twist', {}), 'The frames turn about the spine along the chain'),
                field('Lean with the spine', check(sp, 'tilt'), 'Frames lean as the spine rises (off: they stay upright)'),
                field('Shown', check(c, 'visible', () => E.loadFrames()))),
            row(field('First frame', number(c, 'from', { min: 0, step: 1 })), field('Last frame', number(c, 'to', { min: 0, step: 1, empty: null, placeholder: T('last') })),
                field('Start after (m)', number(c, 'offset', {}))),
            row(button('Remove this chain', async () => {
                if (!confirm(T('Remove the chain "{0}"? (Its frames are moved to the _deleted folder.)', c.name))) return;
                await E.removeChain(c.id); UI.current = null; renderPanel();
            }, { class: 'ts-btn ts-danger' }))));

        // its look
        const L = c.look;
        put(body, section('Look', false,
            row(field('Fade to the far end', slider(L, 'fade', { min: 0, max: 1 })), field('Turn it over', check(L, 'reverse'), 'The fade, tint and glow grow towards the first frame instead')),
            row(field('Tint', colour(L, 'tint')), field('Tint amount', slider(L, 'tint_amount', { min: 0, max: 1 }))),
            row(field('Glow', colour(L, 'glow_color')), field('Glow amount', slider(L, 'glow', { min: 0, max: 3 }))),
            row(field('Darker edge-on', slider(L, 'rib', { min: 0, max: 1 }), 'Frames seen from the side are darker, so the stack reads as a ribbed body'),
                field('Shadow', slider(L, 'shadow', { min: 0, max: 1 }))),
            row(field('Dissolve near the lens (m)', number(E.doc.look, 'far', { min: 0.02, max: 5 }), 'A frame starts to dissolve this close to the camera'),
                field('Gone at (m)', number(E.doc.look, 'near', { min: 0, max: 5 })))));

        // time along the chain
        const TM = c.time;
        const rate = TM.rate || c.fps || 24;
        const used = Math.round(rate * E.doc.shot.duration);
        put(body, section('Time along the chain', TM.mode !== 'all',
            row(field('Time', select(TM, 'mode', [['all', 'Every frame stands there'], ['future', 'The present eats the chain'], ['past', 'The chain grows behind the present']],
                                     () => { E.touch(); renderPanel(); }))),
            TM.mode === 'future' ? note('The present plays at the front of the chain and what has passed is gone; the frames still to come wait behind it, running off into the distance (the reel\'s opening).') : null,
            TM.mode === 'past' ? note('The present is the newest frame and everything that has been trails behind it; the chain grows as the shot goes on.') : null,
            TM.mode !== 'all' ? row(field('Starts at frame', number(TM, 'start', { min: 0, step: 1 })),
                                    field('Frames a second', number(TM, 'rate', { min: 0.1, max: 240, empty: null, placeholder: String(c.fps || 24) }, () => renderPanel()),
                                          'How fast the present goes through the frames (empty: as they were filmed)'),
                                    field('Fade over (frames)', number(TM, 'fade', { min: 0.05, max: 50 })),
                                    field('Hold on the last frame', check(TM, 'hold'), 'When the present reaches the end of the chain it stays on the last frame')) : null,
            TM.mode !== 'all' && c.frames ? (used > c.frames - (TM.start || 0)
                ? h('div', { class: 'ts-warn' }, T('The shot uses {0} frames but the chain has {1}: the present runs out at {2} s.', used, c.frames - (TM.start || 0), fmt((c.frames - (TM.start || 0)) / rate, 1)))
                : note('The shot uses {0} of the chain\'s {1} frames.', used, c.frames)) : null));
    }

    /* a job's progress shown under its buttons, with the frame it is on */
    async function run(box, work) {
        if (UI.busyWork) throw new Error('Something is already being made; wait for it');
        const label = h('div', { class: 'ts-progress-text' }), bar = h('div', { class: 'ts-bar-fill' }), picture = h('img', { class: 'ts-progress-img' });
        box.innerHTML = ''; box.append(h('div', { class: 'ts-bar-track' }, bar), label, picture);
        UI.busyWork = true;
        try {
            return await work(job => {
                if (job.id) UI.busy = job.id;
                label.textContent = T(job.stage || job.status || '') + (job.position ? ' · ' + T('waiting, {0} before it', job.position) : '');
                if (job.progress != null) bar.style.width = (job.progress * 100).toFixed(1) + '%';
                if (job.preview) picture.src = job.preview;
            });
        } finally { UI.busyWork = false; UI.busy = null; }
    }

    /* an editable list of keys: one row each, a field per column */
    function keysTable(keys, columns, after) {
        const table = h('table', { class: 'ts-keys' });
        table.append(h('tr', {}, ...columns.map(([, label]) => h('th', { t: label })), h('th')));
        keys.sort((a, b) => a.t - b.t);
        for (const key of keys) {
            table.append(h('tr', {}, ...columns.map(([name]) => h('td', {}, number(key, name, { step: 'any' }))),
                h('td', {}, h('button', { type: 'button', class: 'ts-x', tt: 'Remove this key', on: { click: () => {
                    keys.splice(keys.indexOf(key), 1); E.touch(); UI.needsDraw = true; if (after) after();
                } } }, '×'))));
        }
        return table;
    }

    /* -- generate -- */

    function generatePanel(body) {
        const doc = E.doc;
        if (!UI.deforum) {
            UI.deforum = {};
            E.api('deforum/options').then(info => { UI.deforum = info; if (UI.tab === 'generate') renderPanel(); }).catch(e => { UI.deforum = { error: String(e.message || e) }; });
        }
        const info = UI.deforum || {}, last = info.last || {};
        const G = doc.generate = doc.generate || {};
        G.options = Object.assign({ prompt: '', stages: [], negative: 'blurry, deformed, extra limbs, text, watermark, nsfw, nude', prefix: '<lora:LCM_SD15:1>',
                                    sampler: last.sampler || 'LCM', steps: last.steps || 8, cfg: last.cfg || 1.5, strength: 0.3, pose: 0.9, seed: 1234,
                                    background: '#808080', first: 0, last: null, every: 1 }, G.options);
        const O = G.options;
        const motions = doc.chains.filter(c => c.make && !c.generated);
        if (!G.source || !E.chain(G.source)) G.source = motions.length ? motions[0].id : null;
        const drawn = doc.chains.filter(c => c.generated && c.generated.from === G.source);
        if (G.target && !E.chain(G.target)) G.target = null;

        put(body, note('Deforum draws a new figure over the motion of a chain: every frame is drawn where the motion chain has its figure, on a flat backdrop, with a still camera, the same seed, and the pose from ControlNet. The new chain is then cut by the backdrop\'s colour and stands where the motion chain stood.'));
        if (info.error) put(body, h('div', { class: 'ts-warn' }, info.error));
        if (info.deforum === false) put(body, h('div', { class: 'ts-warn' }, T('Deforum is not installed in this Forge.')));
        if (info.deforum && !info.pose_model) put(body, h('div', { class: 'ts-warn' }, T('No OpenPose ControlNet model was found: the frames follow the motion through the picture only.')));
        if (!motions.length) { put(body, note('First make a chain from a video in the Chains tab: its frames are the motion.')); return; }

        put(body,
            row(field('Motion', select(G, 'source', motions.map(c => [c.id, `${c.name} (${c.frames})`]), () => renderPanel())),
                field('Draw into', select(G, 'target', [[null, T('a new chain')], ...drawn.map(c => [c.id, c.name])]))),
            field('Who is drawn', (() => {
                const el = h('textarea', { class: 'ts-input ts-text', rows: 3, placeholder: T('e.g. a dancer made of glowing glass, full body, plain background') }, O.prompt || '');
                el.addEventListener('change', () => { O.prompt = el.value; E.touch(); });
                return el;
            })()));

        // stages along the chain
        const stages = h('div', { class: 'ts-stages' });
        O.stages.forEach((stage, i) => {
            const textEl = h('input', { type: 'text', class: 'ts-input ts-stage-text', value: stage.text || '' });
            textEl.addEventListener('change', () => { stage.text = textEl.value; E.touch(); });
            stages.append(h('div', { class: 'ts-stage-row' },
                number(stage, 'at', { min: 0, step: 'any' }), textEl,
                h('button', { type: 'button', class: 'ts-x', tt: 'Remove this stage', on: { click: () => { O.stages.splice(i, 1); E.touch(); renderPanel(); } } }, '×')));
        });
        put(body, section('Stages along the chain', O.stages.length > 0,
            note('Each stage starts at a place along the chain (0 = its first frame, 1 = its last, or a frame number) and Deforum blends each into the next. Empty: the prompt above for every frame.'),
            stages,
            h('div', { class: 'ts-chips' },
                button('+ A stage', () => { O.stages.push({ at: O.stages.length ? 1 : 0, text: O.prompt || '' }); E.touch(); renderPanel(); }),
                button('A life: a baby to old age', () => {
                    const who = (O.prompt || 'a person, full body, plain background').trim();
                    O.stages = [[0, 'a baby'], [0.22, 'a small child'], [0.45, 'a young adult'], [0.7, 'a middle-aged adult'], [1, 'a very old person']]
                        .map(([at, age]) => ({ at, text: `${who}, ${age}` }));
                    E.touch(); renderPanel();
                }))));

        put(body, section('Drawing', true,
            row(field('Before the prompt', text(O, 'prefix'), 'A LoRA or words put before every stage (LCM needs its LoRA)'),
                field('Not wanted', text(O, 'negative'))),
            row(field('Sampler', text(O, 'sampler')), field('Steps', number(O, 'steps', { min: 1, max: 150, step: 1 })),
                field('CFG', number(O, 'cfg', { min: 0, max: 30 })), field('Seed', number(O, 'seed', { step: 1 }))),
            row(field('The motion frame kept', slider(O, 'strength', { min: 0.1, max: 0.9, step: 0.02 }), 'How much of the motion frame stays (Deforum\'s strength): less keeps the person, more lets the prompt draw a new one'),
                field('Pose', slider(O, 'pose', { min: 0, max: 1.5, step: 0.05 }), 'How strongly ControlNet holds the pose')),
            row(field('Backdrop', colour(O, 'background'), 'The flat colour the figure is drawn on, and cut away by'),
                field('First frame', number(O, 'first', { min: 0, step: 1 })), field('Last frame', number(O, 'last', { min: 0, step: 1, empty: null, placeholder: T('last') })),
                field('Every', number(O, 'every', { min: 1, step: 1 }), 'Draw every n-th frame of the motion (fewer frames, faster)')),
            last.from ? note('Sampler, steps and CFG start from your last Deforum render.') : null));

        const from = E.chain(G.source);
        const count = Math.max(0, Math.floor(((O.last == null ? from.frames - 1 : O.last) - (O.first || 0)) / Math.max(1, O.every)) + 1);
        const W = Math.ceil(from.width / 64) * 64, H = Math.ceil(from.height / 64) * 64;
        const progress = h('div', { class: 'ts-progress' });
        put(body, note('Deforum draws {0} frames of {1}×{2}: about {3} minutes here.', count, W, H, fmt(count * (W * H / (768 * 768)) * O.steps * 0.32 / 60, 0)),
            row(button('Generate with Deforum', async () => {
                if (!(O.prompt || '').trim() && !O.stages.length) throw new Error('Say who is drawn first');
                const c = await run(progress, p => E.generate(G.source, O, G.target, p));
                G.target = c.id;
                say(T('The drawn chain is ready: {0} frames', c.frames), 'ok'); renderPanel();
            }, { class: 'ts-btn ts-primary' }),
                UI.busy ? button('Cancel', async () => { if (UI.busy) await E.api('job/cancel', { id: UI.busy }); }) : null),
            progress);
    }

    /* -- world -- */

    function worldPanel(body) {
        const W = E.doc.world;
        const pano = h('input', { type: 'file', class: 'ts-file', accept: 'image/*' });
        pano.addEventListener('change', guarded(async () => {
            if (!pano.files.length) return;
            say(T('Uploading…'));
            const up = await E.upload(pano.files[0]);
            W.kind = 'panorama'; W.panorama = up.path; E.touch(); await E.loadWorld(); say(T('The world is in place'), 'ok'); renderPanel();
        }));
        put(body,
            row(field('World', select(W, 'kind', [['sky', 'A sky and a ground'], ['panorama', 'A 360 panorama']], () => { E.loadWorld(); renderPanel(); }))),
            W.kind === 'panorama' ? row(field('Panorama from the computer', pano)) : null,
            W.kind === 'panorama' && W.panorama ? note('Now: {0}', W.panorama.split('/').pop()) : null,
            row(field('The panorama was seen from (m)', number(W, 'eye', { min: 0.05, max: 50 }), 'How high above the ground the panorama was taken: the ground is put that far below its middle'),
                field('Size of the world (m)', number(W, 'radius', { min: 5, max: 2000 })),
                field('Turn (°)', number(W, 'turn', {}))),
            row(field('Haze', slider(W, 'fog', { min: 0, max: 2 }))),
            W.kind === 'sky' ? row(field('Sky above', colour(W, 'sky_top')), field('At the horizon', colour(W, 'sky_horizon')), field('Ground', colour(W, 'ground'))) : null);
        if (E.options && E.options.sim360) {
            const grid = h('div', { class: 'ts-worlds' });
            put(body, section('A world from Simulation 360', !!UI.worlds,
                row(button(UI.worlds ? 'Look again' : 'Show its worlds', async () => { UI.worlds = (await E.api('sim360/worlds')).worlds; renderPanel(); })),
                grid));
            for (const w of UI.worlds || []) {
                const thumb = w.thumb ? `./time-strata/sim360/thumb/${encodeURIComponent(w.project)}/${encodeURIComponent(w.world)}/${encodeURIComponent(w.thumb)}` : '';
                grid.append(h('button', { type: 'button', class: 'ts-world', title: `${w.project} / ${w.name}`, on: { click: guarded(async () => {
                    const got = await E.api('sim360/take', { project: E.project, from_project: w.project, world: w.world, file: w.file });
                    W.kind = 'panorama'; W.panorama = got.path;
                    if (w.eye != null && w.eye > 0.3) W.eye = w.eye;
                    E.touch(); await E.loadWorld(); say(T('The world is in place'), 'ok'); renderPanel();
                }) } }, thumb ? h('img', { src: thumb, loading: 'lazy' }) : null, h('span', {}, w.name), h('small', {}, w.project)));
            }
        }
    }

    /* -- camera -- */

    function cameraPanel(body) {
        const doc = E.doc, cam = doc.camera;
        put(body,
            row(field('The shot (seconds)', number(doc.shot, 'duration', { min: 0.5, max: 600 }, () => renderPanel())),
                field('Follow the chain', select(cam, 'follow', doc.chains.map(c => [c.id, c.name]))),
                field('Ride with the present', check(cam, 'ride'), 'The keys\' places along the chain are measured from the chain\'s present, so the camera travels with it')),
            note('Ready-made moves (they replace the keys):'),
            h('div', { class: 'ts-chips' }, ...[['opening', 'The reel\'s opening'], ['through', 'Fly through'], ['side', 'Beside it'], ['front', 'From the front'], ['orbit', 'Around it']]
                .map(([id, label]) => button(label, () => { E.applyPreset(id); renderPanel(); }))),
            note('Drag on the picture to look around (right button or Shift: move), the wheel comes closer, a double click goes back to the keys. "A key here" keeps what is seen now at this moment.'),
            row(button('A key here', () => { E.keyHere(); renderPanel(); }, { class: 'ts-btn ts-primary' }),
                h('span', { class: 'ts-rate' })),
            keysTable(cam.keys, [['t', 'Second'], ['s', 'Along (m)'], ['side', 'Side'], ['up', 'Up'], ['look', 'Look ahead'], ['look_up', 'Look up'], ['look_side', 'Look side'], ['fov', 'Lens °'], ['roll', 'Roll °']],
                      () => renderPanel()),
            !cam.keys.length ? note('No keys yet: the reel\'s opening is shown.') : null);

        // the planner
        const P = doc.plan, plan = E.plan();
        put(body, section('Plan a flight through', true,
            note('How many frames a flight needs, how far apart they stand, and how sharp they must be.'),
            row(field('Seconds of flying', number(P, 'seconds', { min: 0.5, max: 600 }, () => renderPanel())),
                field('Speed (m/s)', number(P, 'speed', { min: 0.05, max: 50 }, () => renderPanel())),
                field('Frames passing a second', number(P, 'rate', { min: 1, max: 240 }, () => renderPanel())),
                field('Chain ahead at the end (m)', number(P, 'ahead', { min: 0, max: 100 }, () => renderPanel()))),
            h('div', { class: 'ts-plan' },
                T('Make {0} frames, {1} cm apart: a chain of {2} m. To be sharp up close a frame needs about {3} px of height.',
                  plan.frames, fmt(plan.spacing * 100, 1), fmt(plan.length, 1), plan.texture)),
            row(button('Use this plan', () => { E.usePlan(); renderPanel(); }, { tt: 'Sets the chain\'s spacing and flies the camera through it at this speed' }))));
    }

    /* -- knife -- */

    function knifePanel(body) {
        const K = E.doc.knife;
        const c = E.followed();
        const L = c ? Core.chainLength(E.cardGeometry(c), Math.max(1, c.frames)) : 4;
        put(body,
            note('The knife cuts the chain with a plane and takes away everything in front of it: what is left shows its cut face, every strip of it a different moment (past and present in one slice, as in strata-cut).'),
            row(field('Cut', check(K, 'on'))),
            h('div', { class: 'ts-chips' },
                button('Sweep along the chain', () => { K.on = true; K.keys = [{ t: 0, s: 0, yaw: 0, pitch: 0 }, { t: E.doc.shot.duration, s: L, yaw: 0, pitch: 0 }]; E.touch(); renderPanel(); }),
                button('A slanted slice', () => { K.on = true; K.keys = [{ t: 0, s: L * 0.1, yaw: 55, pitch: 0 }, { t: E.doc.shot.duration, s: L * 0.9, yaw: 55, pitch: 0 }]; E.touch(); renderPanel(); }),
                button('A slice from above', () => { K.on = true; K.keys = [{ t: 0, s: L * 0.2, yaw: 0, pitch: 50 }, { t: E.doc.shot.duration, s: L * 0.8, yaw: 0, pitch: 50 }]; E.touch(); renderPanel(); })),
            keysTable(K.keys, [['t', 'Second'], ['s', 'Along (m)'], ['yaw', 'Turn °'], ['pitch', 'Tilt °']], () => renderPanel()));
    }

    /* -- record -- */

    function recordPanel(body) {
        const R = E.doc.record;
        const music = h('input', { type: 'file', class: 'ts-file', accept: 'audio/*,video/*' });
        music.addEventListener('change', guarded(async () => {
            if (!music.files.length) return;
            const up = await E.upload(music.files[0]); E.doc.music = up.path; E.touch(); say(T('The music is in place'), 'ok'); renderPanel();
        }));
        const progress = h('div', { class: 'ts-progress' });
        put(body,
            row(field('Size', select(R, 'size', [['1080x1920', '1080×1920 (upright, reels)'], ['1920x1080', '1920×1080 (wide)'], ['1080x1080', '1080×1080 (square)'], ['720x1280', '720×1280 (upright, quick)'], ['1280x720', '1280×720 (wide, quick)']],
                    () => { const [w, hh] = R.size.split('x').map(Number); E.doc.shot.width = w; E.doc.shot.height = hh; E.touch(); fit(); })),
                field('Frames a second', select(R, 'fps', [24, 25, 30, 60]))),
            row(field('Kind', select(R, 'kind', [['mp4-h264', 'MP4 (plays everywhere)'], ['mp4-nvenc', 'MP4 by the NVIDIA card (faster)'], ['webm-vp9', 'WebM']])),
                field('Quality', select(R, 'quality', [[14, 'Very high'], [17, 'High'], [21, 'Good'], [25, 'Small file']])),
                field('Drawn larger', select(R, 'supersample', [[1, 'No'], [2, 'Twice (smoother edges, slower)']]))),
            row(field('Name', text(R, 'name', null, E.project))),
            row(field('Music', music), E.doc.music ? h('span', { class: 'ts-note' }, E.doc.music.split('/').pop(), ' ',
                h('button', { type: 'button', class: 'ts-x', tt: 'No music', on: { click: () => { E.doc.music = null; E.touch(); renderPanel(); } } }, '×')) : null,
                E.doc.music ? field('Music from second', number(R, 'music_start', { min: 0 })) : null),
            row(button('Record', async () => {
                    const label = h('div', { class: 'ts-progress-text' }), bar = h('div', { class: 'ts-bar-fill' });
                    progress.innerHTML = ''; progress.append(h('div', { class: 'ts-bar-track' }, bar), label);
                    E.playing = false; UI.playButton.textContent = '▶';
                    const result = await E.record(p => {
                        bar.style.width = (p.frame / p.total * 100).toFixed(1) + '%';
                        label.textContent = T('Frame {0} of {1}', p.frame, p.total) + ` · ${fmt(p.seconds, 0)} s` + (p.jpeg ? ' · JPEG' : '');
                    });
                    progress.innerHTML = '';
                    progress.append(h('div', { class: 'ts-ok' }, T('Saved: {0} ({1} frames, {2} s)', result.name, result.frames, result.seconds)),
                                    h('video', { class: 'ts-result', src: result.url, controls: true, loop: true }));
                    say(T('Saved: {0} ({1} frames, {2} s)', result.name, result.frames, result.seconds), 'ok');
                }, { class: 'ts-btn ts-primary' }),
                button('Stop', () => { if (E.recording) E.recording.cancel = true; }),
                button('Open the videos folder', async () => { await E.api('open-folder', { exports: true }); })),
            progress);
    }

    /* ---- drawing ---- */

    function tick(now) {
        requestAnimationFrame(tick);
        if (!E.doc || !E.renderer || E.recording || !UI.root || !UI.root.isConnected || !UI.canvas.offsetParent) return;
        const D = E.doc.shot.duration;
        if (E.playing) {
            const dt = Math.min(0.1, (now - (UI.lastTick || now)) / 1000);
            E.time = (E.time + dt) % D;
            UI.needsDraw = true;
        }
        UI.lastTick = now;
        if (E.loading) UI.needsDraw = true;
        if (!UI.needsDraw) return;
        UI.needsDraw = false;
        E.draw();
        UI.timeSlider.value = Math.round(E.time / D * 1000);
        UI.clock.textContent = fmt(E.time, 2) + ' / ' + fmt(D, 1);
        const rate = E.passRate(E.time);
        const parts = [];
        if (E.loading) parts.push(T('Loading frames {0} of {1}', E.loading.done, E.loading.total));
        parts.push(T('{0} frames drawn', E.renderer.drawn));
        if (E.renderer.texH) parts.push(T('frames on the card: {0}×{1}', E.renderer.texW, E.renderer.texH));
        if (E.sharp.slots) parts.push(T('sharp up close: {0} at {1}×{2}', E.sharp.ready.filter(Boolean).length, E.renderer.sharpW, E.renderer.sharpH));
        parts.push(T('{0} frames pass a second', fmt(rate, 1)));
        if (E.free) parts.push(T('looking around'));
        UI.info.textContent = parts.join(' · ');
        const rateBox = UI.root.querySelector('.ts-rate');
        if (rateBox) rateBox.textContent = T('{0} frames pass a second', fmt(rate, 1));
    }

    function start() {
        if (UI.started) return;
        if (!build()) return;
        UI.started = true;
        E.on(what => {
            if (what === 'project') { renderPanel(); UI.fillProjects && UI.fillProjects(); }
            if (what === 'saved') { const s = UI.root.querySelector('.ts-saved'); if (s) { s.textContent = T('Saved'); setTimeout(() => { s.textContent = ''; }, 1500); } }
            UI.needsDraw = true;
        });
        E.start().then(() => { renderPanel(); }).catch(e => say(String(e.message || e), 'error'));
        new ResizeObserver(() => fit()).observe(UI.view);
        new MutationObserver(() => {
            const dir = S.hebrew() ? 'rtl' : 'ltr';
            if (UI.root && UI.root.dir !== dir) { UI.root.dir = dir; renderPanel(); const bar = UI.root.querySelector('.ts-bar'); if (bar) bar.replaceWith(topBar()); }
        }).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
        window.addEventListener('beforeunload', () => { if (E.dirty) E.saveNow(); });
        requestAnimationFrame(tick);
    }
    S.start = start;

    if (typeof onUiLoaded === 'function') onUiLoaded(start);
})();
