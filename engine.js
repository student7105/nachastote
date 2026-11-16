'use strict';
/* Движок прототипа «На частоте». История читается из stories/<ночь>.json — код под новую ночь не меняется. */

const CATALOG_URL = 'stories/catalog.json';   // список историй и ночей для главного меню
const PROGRESS_KEY = 'na-chastote-progress';  // пройденные ночи (только в браузере игрока)
const QS = new URLSearchParams(location.search);
const TEST = QS.has('test');   // ?test в адресе — клавиша F (ускорение) для проверки
const TICK = 0.1;            // шаг цикла, секунды
const SPEED_BUSY = 0.1;      // игровых минут за настоящую секунду, когда что-то происходит (1 мин = 6 игровых)
const SPEED_IDLE = 0.8;      // когда тихо — время бежит быстрее
const COLORS = ['#f2b25a', '#6aa7d8', '#5fd08a', '#d88ad8', '#e0573f', '#7fd6d0', '#c9c06a'];
const MORSE = { '0': '-----', '1': '.----', '2': '..---', '3': '...--', '4': '....-', '5': '.....', '6': '-....', '7': '--...', '8': '---..', '9': '----.' };

const $ = s => document.querySelector(s);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

let D = null, S = null, A = null, START = 0, END = 0;
let VOICE = {}, BUF = {};   // озвучка: manifest.json и раскодированные записи

/* ---------- время ---------- */
function toAbs(t) { const [h, m] = t.split(':').map(Number); return h * 60 + m + (h < 12 ? 1440 : 0); }
function rel(t) { return toAbs(t) - START; }
function clock(gm = S.gm) { const x = (START + gm) % 1440; return String(Math.floor(x / 60)).padStart(2, '0') + ':' + String(Math.floor(x % 60)).padStart(2, '0'); }
const fmtF = f10 => (f10 / 10).toFixed(1);
function plural(n, one, few, many) { const a = n % 10, b = n % 100; return a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 12 || b > 14) ? few : many; }

/* ---------- состояние ---------- */
function initState() {
  START = toAbs(D.start); END = rel(D.end);
  S = {
    gm: 0, real: 0, f10: Math.round(D.startFreq * 10), noiseOff: false, boost: false, debug: 1, muted: false,
    hint: null, hintUntil: 0, bgNow: null, morseLive: null, morseHeard: false, ninaMorseAsked: false,
    notes: [], clues: {}, clueOrder: [], marker: null, wasted: 0, ended: false, endAt: null,
    brig: { x: D.brigade.base.x, y: D.brigade.base.y, state: 'base' },
    room: D.roomSounds.map(r => ({ ...r, gm: rel(r.at), done: false })),
    scenes: D.scenes.map(d => ({
      d, status: 'wait', at: rel(d.at), f10: d.freq ? Math.round(d.freq * 10) : null,
      queue: [], timer: 0, waitChoice: null, calloutT: 0,
      battery: d.battery ? d.battery.start : 0, listen: false, lost: false, outcome: null,
      connected: false, asked: new Set(), autoDone: new Set(), heardBg: new Set(), lowSaid: false,
    })),
    nina: { d: { kind: 'door', who: 'Нина Петровна' }, queue: [], timer: 0, waitChoice: null },
  };
}

/* ---------- эфир ---------- */
function quality(f10) { if (f10 == null) return 2; const d = Math.abs(S.f10 - f10); return d <= 1 ? 2 : d <= 3 ? 1 : 0; }
function garble(t, p) { return [...t].map(c => /[А-Яа-яЁёA-Za-z0-9]/.test(c) && Math.random() < p ? '·' : c).join(''); }
function lineDur(t) { return Math.min(9, Math.max(2.2, (t || '').length / 15)); }
function activeSignals() {
  return S.scenes.filter(s => s.f10 != null && (
    s.status === 'calling' || s.status === 'playing' ||
    ((s.status === 'running' || s.status === 'active') && !s.lost && !s.outcome)));
}
function closeness() {
  let best = 0;
  for (const s of activeSignals()) best = Math.max(best, Math.max(0, 1 - Math.abs(S.f10 - s.f10) / 6));
  return best;
}

/* ---------- журнал и записи ---------- */
function log(who, text, kind = 'line') {
  const el = document.createElement('div');
  el.className = 'ln ' + kind;
  el.innerHTML = `<span class="t">${clock()}</span>` + (who ? `<b>${esc(who)}:</b> ` : '') + esc(text);
  const box = $('#log'); box.appendChild(el); box.scrollTop = 1e9;
  if (kind !== 'bg' && kind !== 'miss') showLast(who, text, kind);
}
function showLast(who, text, kind) {
  // последняя реплика — крупными субтитрами под комнатой
  const el = $('#sub'); if (!el) return;
  el.className = 'sub ' + kind;
  el.innerHTML = (who ? `<b>${esc(who)}:</b> ` : '') + esc(text);
}
function addNote(t) { S.notes.push(t); dirty.notes = true; log(null, 'Записано: ' + t, 'sys'); }
function addClue(c) {
  if (S.clues[c.id]) return;
  S.clues[c.id] = { label: c.label, src: null, color: COLORS[S.clueOrder.length % COLORS.length] };
  S.clueOrder.push(c.id);
  dirty.notes = true;
  log(null, 'Улика в записях: ' + c.label, 'sys');
}
function setHint(t, secs) { S.hint = t; S.hintUntil = secs ? S.real + secs : Infinity; }

/* ---------- сцены ---------- */
function startScene(sc) {
  const k = sc.d.kind;
  if (k === 'door') { sc.status = 'running'; sc.queue = [...sc.d.steps]; sc.timer = 0; return; }
  if (k === 'morse') { startMorse(sc); return; }
  sc.status = 'calling'; sc.calloutT = 0;
  setHint(sc.d.tutorial || `В эфире кто-то вызывает. Покрути ручку и найди его.`);
}

function sndVol(id) { const s = D.sounds && D.sounds[id]; return s && s.vol != null ? s.vol : 0.5; }
function voiceDur(who, text) { const v = VOICE[who + '|' + text]; return v ? v.dur + 0.35 : lineDur(text); }
function voice(who, text, mode, vol) {
  if (!A || S.debug > 1) return;            // при ускорении голоса наложились бы друг на друга
  const b = BUF[who + '|' + text]; if (b) A.playVoice(b, mode, vol);
}

// Возвращает, сколько секунд занимает реплика
function emit(sc, st) {
  const hero = st.who === 'Ты';
  const door = sc.d.kind === 'door' && sc !== S.nina;
  const always = sc.d.kind === 'door' || hero;
  if (st.sfx) {
    if (always || quality(sc.f10) === 2) {
      log(null, '[' + st.sfx + ']', 'sfx');
      if (A) {
        const route = sc.d.kind === 'door' ? 'clean' : 'radio';
        let played = false;
        (st.sound || []).forEach((id, i) => setTimeout(() => { A.play(id, route, sndVol(id)); }, i * 500));
        if (st.sound) played = st.sound.some(id => A.has(id));
        if (!played) A.sfx(st.sfx);
      }
    }
    return 1.6;
  }
  const dur = voiceDur(st.who, st.text);
  const where = hero ? 'hero' : door ? 'door' : sc === S.nina ? 'nina' : 'radio';
  let text = st.text, q = always ? 2 : quality(sc.f10);
  if (sc.d.battery && !hero && sc.battery < sc.d.battery.low) text = garble(text, 0.15);
  if (q === 2) {
    log(st.who, text, hero ? 'hero' : (sc === S.nina ? 'nina' : 'line'));
    if (!always) A && A.click();
    voice(st.who, st.text, where === 'radio' || where === 'nina' ? 'radio' : 'clean', hero ? 0.8 : 1);
    S.speaking = { who: st.who, where, until: S.real + dur };
    if (st.clue) addClue(st.clue);
    if (st.addNote) addNote(st.addNote);
  } else if (q === 1) {
    log(st.who + ' (помехи)', garble(text, 0.55), 'line');
    voice(st.who, st.text, 'radio', 0.22);
    S.speaking = { who: st.who + ' (помехи)', where, until: S.real + dur };
  } else {
    log(null, `[на ${fmtF(sc.f10)} кто-то говорит — ты не на той частоте]`, 'miss');
  }
  return dur;
}

function runQueue(sc, dt) {
  if (sc.waitChoice) return;
  sc.timer -= dt;
  if (sc.timer > 0) return;
  const st = sc.queue.shift();
  if (!st) { sc.timer = 0; return; }
  if (st.choice) { sc.waitChoice = st.choice; dirty.actions = true; return; }
  if (st.note) { addNote(st.note); sc.timer = 0; return; }
  if (st.hint) { setHint(st.hint, 14); sc.timer = 0; return; }
  sc.timer = emit(sc, st);
  dirty.actions = true;
}

function choose(sc, opt) {
  sc.waitChoice = null;
  sc.queue.unshift({ who: 'Ты', text: opt.text }, ...opt.reply);
  sc.timer = 0;
  dirty.actions = true;
}

function updateScene(sc, dt) {
  switch (sc.status) {
    case 'wait':
      if (S.gm >= sc.at) startScene(sc);
      break;
    case 'calling': {
      if (sc.d.timeout && S.gm >= rel(sc.d.timeout)) {
        sc.status = 'done'; log(null, `[на ${fmtF(sc.f10)} стихло]`, 'miss'); S.hint = null; break;
      }
      sc.calloutT -= dt;
      if (sc.calloutT <= 0) {
        const co = sc.d.callout, dur = voiceDur(sc.d.who, co.text);
        sc.calloutT = Math.max(co.every, dur + 2);
        if (quality(sc.f10) === 1) {
          log(sc.d.who + ' (помехи)', garble(co.text, 0.5), 'line');
          voice(sc.d.who, co.text, 'radio', 0.22);
          S.speaking = { who: sc.d.who + ' (помехи)', where: 'radio', until: S.real + dur };
        }
      }
      if (quality(sc.f10) === 2) {
        sc.status = 'running'; sc.connected = true; sc.queue = [...sc.d.steps]; sc.timer = 0.4; S.hint = null;
        dirty.actions = true;
      }
      break;
    }
    case 'running':
    case 'active':
      runQueue(sc, dt);
      if (sc.d.kind === 'caller') updateCaller(sc, dt);
      if (sc.status === 'running' && !sc.queue.length && sc.timer <= 0 && !sc.waitChoice) {
        if (sc.d.kind === 'caller') {
          sc.status = 'active';
          setHint('Задавай вопросы (каждый тратит батарею Сергея) или включи «Слушать фон». Услышанные звуки попадают в «Мои записи»: выбери, что это за звук, и на карте появится зона. Где зоны пересекаются — там он.', 25);
        } else sc.status = 'done';
        dirty.actions = true;
      }
      break;
    case 'playing':
      updateMorse(sc, dt);
      break;
  }
}

/* ---------- звонящий с батареей ---------- */
function replying(sc) { return sc.queue.length > 0 || sc.timer > 0; }
function updateCaller(sc, dt) {
  if (sc.outcome) { S.bgNow = null; return; }
  const b = sc.d.battery;
  if (!sc.lost) {
    let drain = b.idlePerMin / 60 * dt;
    if (sc.listen) drain += b.listenPer10s / 10 * dt;
    sc.battery = Math.max(0, sc.battery - drain);
    if (!sc.lowSaid && sc.battery <= b.low) { sc.lowSaid = true; sc.queue.push(sc.d.lowLine); }
    if (sc.battery <= 0) {
      sc.lost = true; sc.listen = false; sc.queue = []; sc.timer = 0;
      log(null, `[${fmtF(sc.f10)}: связь потеряна]`, 'sys');
      setHint('Связь с Сергеем пропала. Бригаду ещё можно отправить — он там же, где был.', 15);
      dirty.actions = true;
    }
  }
  // подсказки Нины, если игрок долго не может найти человека (секунды настоящего времени, пока бригада стоит)
  if (sc.status === 'active' && S.brig.state !== 'travel') {
    sc.stuckT = (sc.stuckT || 0) + dt;
    for (const hnt of sc.d.ninaHints || []) {
      if (sc.hintsDone && sc.hintsDone.has(hnt)) continue;
      if (sc.stuckT >= hnt.after) { (sc.hintsDone = sc.hintsDone || new Set()).add(hnt); S.nina.queue.push({ who: 'Нина Петровна', text: hnt.text }); }
    }
  }
  for (const a of sc.d.auto || []) {
    if (sc.autoDone.has(a) || S.gm < rel(a.at)) continue;
    sc.autoDone.add(a);
    if (sc.lost || (a.ifNoClue && S.clues[a.ifNoClue])) continue;
    sc.battery = Math.max(0, sc.battery - (a.cost || 0));
    const steps = a.steps.map(s => ({ ...s }));
    if (a.clue) steps[steps.length - 1].clue = a.clue;
    sc.queue.push(...steps);
  }
  // фон слышен, только пока он держит кнопку (говорит или ты попросил слушать)
  const transmitting = !sc.lost && (sc.listen || replying(sc));
  if (transmitting && quality(sc.f10) === 2) {
    const list = [];
    if (!S.noiseOff) list.push({ id: 'static', text: 'треск помех' });
    for (const bg of sc.d.background) {
      if (bg.from && (S.gm < rel(bg.from) || S.gm >= rel(bg.to))) continue;
      if (bg.needs && !bg.needs.every(n => (n === 'noise' ? S.noiseOff : S.boost))) continue;
      if (bg.every && (S.real % bg.every) >= bg.show) continue;
      list.push(bg);
      if (!sc.heardBg.has(bg.id)) { sc.heardBg.add(bg.id); log(null, `[фон у ${sc.d.who === 'Сергей' ? 'Сергея' : sc.d.who}: ${bg.text}]`, 'bg'); }
      if (bg.clue) addClue(bg.clue);
    }
    S.bgNow = list;
  } else S.bgNow = null;
}

function ask(sc, q) {
  if (sc.lost || replying(sc)) return;
  sc.battery = Math.max(0, sc.battery - q.cost);
  sc.asked.add(q.id);
  const reply = q.reply.map(s => ({ ...s }));
  const last = reply[reply.length - 1];
  if (q.clue) last.clue = q.clue;
  if (q.note) last.addNote = q.note;
  sc.queue.push({ who: 'Ты', text: q.text }, ...reply);
  dirty.actions = true;
}

/* ---------- морзянка ---------- */
function startMorse(sc) {
  const U = 0.14, tl = []; let t = 0.5;
  for (let r = 0; r < sc.d.repeat; r++) {
    for (const dg of sc.d.digits) {
      for (const sym of MORSE[dg]) {
        const j = 0.75 + Math.random() * 0.5; // стучат от руки — неровно
        const dur = (sym === '.' ? 1 : 3) * U * j;
        tl.push({ start: t, dur, sym, rep: r });
        t += dur + U * (0.8 + Math.random() * 0.4);
      }
      t += U * 3.5;
    }
    t += 3;
  }
  Object.assign(sc, { status: 'playing', tl, mt: 0, total: t, heardSyms: 0, idx: 0, everNear: false });
  S.morseLive = '';
}
function updateMorse(sc, dt) {
  sc.mt += dt;
  const q = quality(sc.f10);
  if (q > 0) sc.everNear = true;
  let on = false;
  while (sc.idx < sc.tl.length && sc.tl[sc.idx].start + sc.tl[sc.idx].dur <= sc.mt) {
    const s = sc.tl[sc.idx];
    if (q === 2) sc.heardSyms++;
    if (q > 0) {
      const prev = sc.tl[sc.idx - 1];
      let sep = '';
      if (prev && prev.rep !== s.rep) sep = '\n';
      else if (prev && s.start - (prev.start + prev.dur) > 0.3) sep = '  ';
      S.morseLive = (S.morseLive || '') + sep + (s.sym === '.' ? '·' : '−');
    }
    sc.idx++;
  }
  const cur = sc.tl[sc.idx];
  if (cur && cur.start <= sc.mt) on = true;
  A && A.setMorse(on && q > 0 ? (q === 2 ? 0.12 : 0.035) : 0);
  if (sc.mt >= sc.total) {
    sc.status = 'done'; A && A.setMorse(0); S.morseLive = null;
    const per = sc.d.digits.split('').reduce((n, d) => n + MORSE[d].length, 0);
    if (sc.heardSyms >= per) {
      S.morseHeard = true;
      const pattern = sc.d.digits.split('').map(d => MORSE[d].replace(/\./g, '·').replace(/-/g, '−')).join('   ');
      addNote(sc.d.note + ' Знаки: ' + pattern + ' (расшифровка — в Блокноте деда).');
      dirty.actions = true;
    } else if (sc.everNear) log(null, `[на ${fmtF(sc.f10)} что-то пищало — не разобрал]`, 'miss');
  }
}

/* ---------- бригада ---------- */
function caller() { return S.scenes.find(s => s.d.kind === 'caller'); }
function sendBrigade() {
  if (!S.marker || S.brig.state === 'travel' || S.ended) return;
  const from = { x: S.brig.x, y: S.brig.y }, to = { ...S.marker };
  const mins = D.brigade.minFixed + D.brigade.minPerKm * dist(from, to);
  Object.assign(S.brig, { state: 'travel', from, to, start: S.gm, mins });
  S.nina.queue.push({ ...D.brigadeLines.send }, { ...D.brigadeLines.ack });
  log(null, `Бригада выехала, в пути примерно ${Math.round(mins)} мин.`, 'sys');
  dirty.actions = dirty.map = true;
}
function updateBrigade() {
  const b = S.brig;
  if (b.state !== 'travel') return;
  const k = Math.min(1, (S.gm - b.start) / b.mins);
  b.x = b.from.x + (b.to.x - b.from.x) * k; b.y = b.from.y + (b.to.y - b.from.y) * k;
  if (k >= 1) arrive();
}
function arrive() {
  const b = S.brig; b.state = 'idle'; b.x = b.to.x; b.y = b.to.y;
  const sc = caller(), d = sc && sc.d;
  let text;
  if (sc && sc.connected && !sc.outcome && dist(b, d.target) <= d.target.r) {
    sc.outcome = 'saved'; sc.savedAt = clock(); sc.listen = false; sc.queue = []; sc.timer = 0; sc.status = 'done';
    text = d.arrival.correct; S.endAt = S.real + 9;
  } else {
    S.wasted++;
    if (!sc || !sc.connected) text = d.arrival.noCall;
    else if (sc.outcome) text = d.arrival.done;
    else { const n = d.arrival.near.find(p => dist(b, p) <= p.r); text = n ? n.text : d.arrival.other; }
  }
  S.nina.queue.push({ who: 'Нина Петровна', text });
  dirty.actions = dirty.map = true;
}

/* ---------- конец ночи ---------- */
function endNight() {
  S.ended = true; A && A.stopAll(); fxStop();
  const sc = caller(), saved = sc && sc.outcome === 'saved';
  if (saved) markPassed(D.id, sc.savedAt);
  const out =sc ? (saved ? sc.d.outcome.saved.replace('{time}', sc.savedAt) : sc.d.outcome.lost) : '';
  const endPic = saved ? 'img/end_win.jpg' : 'img/end_lose.jpg';
  $('#endCard').innerHTML = `
    <img class="endPic" src="${endPic}" alt="" onerror="this.remove()">
    <h1>${esc(D.title)} — конец</h1>
    <p class="result ${saved ? 'good' : 'bad'}">Спасено: ${saved ? 1 : 0} из 1</p>
    <p>${esc(out)}</p>
    <p>Бригада съездила впустую: ${S.wasted} ${plural(S.wasted, 'раз', 'раза', 'раз')}.</p>
    <p>${esc(D.ending.unsolved)}${S.morseHeard ? '' : ' (ты его даже не услышал)'}</p>
    <p class="endSound"><i>[${esc(D.ending.lastSound)}]</i></p>
    ${D.ending.teaser ? `<div class="teaser"><p>${esc(D.ending.teaser)}</p><p class="next">${esc(D.ending.next || '')}</p></div>` : ''}
    <div class="share"><h2>Поделиться результатом</h2>
      <img id="shareImg" alt="Картинка с результатом ночи" hidden>
      <div class="endBtns"><button class="big" id="shareSend" hidden>Поделиться</button><button class="big" id="shareDl" disabled>Скачать картинку</button></div>
      <div class="note" id="shareNote">Рисую картинку…</div></div>
    ${(D.feedback || []).length ? feedbackForm() : ''}
    <div class="endBtns"><button class="big" id="endAgain">Сыграть ещё раз</button><button class="big" id="endMenu">В меню</button></div>`;
  $('#endAgain').onclick = () => goTo(D.id);
  $('#endMenu').onclick = () => goTo(null);
  $('#endScreen').hidden = false;
  const stats = { night: D.id, saved: !!saved, foundAt: saved ? sc.savedAt : null, wasted: S.wasted, morseHeard: S.morseHeard, minutes: Math.round(S.real / 6) / 10 };
  bindFeedback(stats);
  makeShareCard({ ...stats, who: sc ? sc.d.who : '', pic: endPic });
  if (A) A.lastMorse();
}

/* ---------- картинка итога «поделиться» (1080×1350, для TikTok/сторис/чатов) ---------- */
function vinit(name) {   // Сергей → Сергея (для мужских имён на согласный; иначе как есть)
  if (/[бвгдзклмнпрстфхцчшщж]$/i.test(name)) return name + 'а';
  if (/й$/i.test(name)) return name.slice(0, -1) + 'я';
  return name;
}
async function makeShareCard(st) {
  const W = 1080, H = 1350, cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const g = cv.getContext('2d');
  try { await Promise.all(['700 80px "PT Sans"', '700 80px Caveat', '80px "PT Mono"'].map(f => document.fonts.load(f))); } catch (e) { /* запасные шрифты */ }
  // фон: картинка финала (если есть), иначе комната деда; обрезана по центру, затемнена
  const load = src => new Promise((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = bad; i.src = src; });
  try {
    let img, center = 620;
    try { img = await load(st.pic); center = img.width / 2; } catch (e) { img = await load('img/room.jpg'); }
    const k = H / img.height, w = img.width * k, cx = center * k;
    g.drawImage(img, Math.max(W - w, Math.min(0, W / 2 - cx)), 0, w, H);
  } catch (e) { g.fillStyle = '#0d0b0a'; g.fillRect(0, 0, W, H); }
  const grd = g.createLinearGradient(0, 0, 0, H);
  grd.addColorStop(0, 'rgba(5,4,3,.82)'); grd.addColorStop(.45, 'rgba(5,4,3,.62)'); grd.addColorStop(1, 'rgba(5,4,3,.92)');
  g.fillStyle = grd; g.fillRect(0, 0, W, H);
  g.textAlign = 'center'; g.textBaseline = 'alphabetic';
  const text = (s, y, font, color, glow) => {
    g.font = font; g.fillStyle = color; g.shadowColor = glow || 'transparent'; g.shadowBlur = glow ? 30 : 0; g.fillText(s, W / 2, y); g.shadowBlur = 0;
  };
  if ('letterSpacing' in g) g.letterSpacing = '14px';
  text('НА ЧАСТОТЕ', 150, '700 84px "PT Sans", sans-serif', '#f2b25a', 'rgba(242,178,90,.45)');
  if ('letterSpacing' in g) g.letterSpacing = '0px';
  text(D.title, 240, '700 70px Caveat, cursive', '#e6d8b8');
  const name = st.who || 'человека';
  if (st.saved) {
    text(`Нашёл ${vinit(name)}`, 470, '700 76px "PT Sans", sans-serif', '#ecdfca');
    text(st.foundAt, 680, '170px "PT Mono", monospace', '#ff9d3a', 'rgba(255,140,40,.7)');
  } else {
    text(`Не успел найти ${vinit(name)}`, 470, '700 66px "PT Sans", sans-serif', '#ecdfca');
    text('до рассвета', 640, '700 110px Caveat, cursive', '#e0573f', 'rgba(224,87,63,.5)');
  }
  const lines = [
    `Поездок впустую: ${st.wasted}`,
    `Сигнал 4-1-7: ${st.morseHeard ? 'услышал' : 'пропустил'}`,
  ];
  lines.forEach((s, i) => text(s, 840 + i * 74, '44px "PT Sans", sans-serif', '#d8c9b0'));
  g.strokeStyle = 'rgba(242,178,90,.5)'; g.lineWidth = 3; g.beginPath(); g.moveTo(340, 1035); g.lineTo(740, 1035); g.stroke();
  text(st.saved ? 'А ты найдёшь быстрее?' : 'А ты успеешь?', 1140, '700 92px Caveat, cursive', '#f2b25a');
  text('#начастоте   12+', 1250, '38px "PT Mono", monospace', '#a8977f');

  const blob = await new Promise(r => cv.toBlob(r, 'image/png'));
  const note = $('#shareNote'); if (!note) return;   // экран уже закрыт
  if (!blob) { note.textContent = 'Не получилось нарисовать картинку.'; return; }
  const url = URL.createObjectURL(blob), fname = `na-chastote-${D.id}.png`;
  $('#shareImg').src = url; $('#shareImg').hidden = false;
  const caption = st.saved ? `${D.title}: нашёл ${vinit(name)} в ${st.foundAt}. А ты найдёшь быстрее? #начастоте` : `${D.title}: не успел найти ${vinit(name)}. А ты успеешь? #начастоте`;
  const dl = $('#shareDl'); dl.disabled = false;
  dl.onclick = () => { const a = document.createElement('a'); a.href = url; a.download = fname; document.body.appendChild(a); a.click(); a.remove(); };
  note.textContent = 'Сохрани картинку и выложи в TikTok, сторис или в чат.';
  // «Поделиться» — системное меню телефона (TikTok, Telegram и т.д.); на компьютере обычно его нет
  try {
    const file = new File([blob], fname, { type: 'image/png' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      const b = $('#shareSend'); b.hidden = false;
      b.onclick = async () => { try { await navigator.share({ files: [file], text: caption }); } catch (e) { /* игрок закрыл меню */ } };
    }
  } catch (e) { /* без кнопки «Поделиться» */ }
}

/* ---------- вопросы игроку в конце ночи ---------- */
// Пока ответы хранятся только в браузере игрока и копируются кнопкой. Отправку на сервер подключим при выкладке.
function feedbackForm() {
  return '<form id="fb" class="fb"><h2>Пара вопросов (помогут сделать игру лучше)</h2>' + D.feedback.map(f => `
    <div class="fbq"><div class="fbl">${esc(f.q)}</div>${f.options
      ? `<div class="fbo">${f.options.map(o => `<label><input type="radio" name="${f.id}" value="${esc(o)}"> ${esc(o)}</label>`).join('')}</div>`
      : `<textarea name="${f.id}" rows="2" maxlength="600"></textarea>`}</div>`).join('') +
    '<div class="fbErr" id="fbErr" hidden>Ответь хотя бы на один вопрос.</div>' +
    '<button type="submit" class="big">Сохранить ответы</button></form>' +
    '<div id="fbDone" hidden><p>Спасибо! Ответы сохранены.</p><button type="button" id="fbCopy" class="big">Скопировать ответы</button> <span id="fbCopied" hidden>Скопировано — отправь их разработчику.</span></div>';
}
// Отправка ответов в форму из config.json (Google Форма). Ответ формы прочитать нельзя (чужой сайт),
// поэтому «отправлено» = запрос ушёл без ошибки сети. Копия всё равно лежит в браузере и копируется кнопкой.
let CONFIG = {};
async function sendFeedback(stats, answers) {
  const fc = CONFIG.feedbackForm, el = $('#fbDone p');
  if (!fc || !fc.action) return;   // форма не подключена — остаётся кнопка «Скопировать»
  const body = new URLSearchParams(), f = fc.fields || {};
  const result = `${D.id}; спасён: ${stats.saved ? 'да, ' + stats.foundAt : 'нет'}; впустую: ${stats.wasted}; морзянка: ${stats.morseHeard ? 'да' : 'нет'}; минут: ${stats.minutes}`;
  if (f.result) body.append(f.result, result);
  for (const [id, v] of Object.entries(answers)) if (f[id]) body.append(f[id], v);
  try {
    await fetch(fc.action, { method: 'POST', mode: 'no-cors', body });
    if (el) { el.textContent = 'Спасибо! Ответы отправлены разработчику.'; el.classList.add('fbSent'); }
    const c = $('#fbCopy'); if (c) c.hidden = true;
  } catch (e) {
    if (el) el.textContent = 'Не получилось отправить (нет интернета?). Ответы сохранены — скопируй их и пришли разработчику.';
  }
}
function bindFeedback(stats) {
  const form = $('#fb'); if (!form) return;
  form.addEventListener('input', () => { $('#fbErr').hidden = true; });
  form.onsubmit = e => {
    e.preventDefault();
    const answers = {};
    for (const f of D.feedback) {
      const v = f.options ? (form.querySelector(`input[name="${f.id}"]:checked`) || {}).value : form.querySelector(`textarea[name="${f.id}"]`).value.trim();
      if (v) answers[f.id] = v;
    }
    if (!Object.keys(answers).length) { $('#fbErr').hidden = false; return; }
    const rec = { when: new Date().toISOString(), ...stats, answers };
    try { const all = JSON.parse(localStorage.getItem('na-chastote-feedback') || '[]'); all.push(rec); localStorage.setItem('na-chastote-feedback', JSON.stringify(all)); } catch (err) { /* без сохранения — останется кнопка копирования */ }
    form.hidden = true; $('#fbDone').hidden = false;
    sendFeedback(stats, answers);
    const text =[`Ночь: ${D.title}`, `Спасён: ${stats.saved ? 'да, ' + stats.foundAt : 'нет'}`, `Впустую: ${stats.wasted}`, `Морзянку услышал: ${stats.morseHeard ? 'да' : 'нет'}`, `Минут игры: ${stats.minutes}`]
      .concat(D.feedback.filter(f => answers[f.id]).map(f => `${f.q} — ${answers[f.id]}`)).join('\n');
    $('#fbCopy').onclick = async () => { try { await navigator.clipboard.writeText(text); $('#fbCopied').hidden = false; } catch (err) { prompt('Скопируй ответы:', text); } };
  };
}

/* ---------- главный цикл ---------- */
function tick() {
  if (S.ended || S.paused) return;
  const dt = TICK * S.debug;
  // после потери связи ждать нечего — время бежит быстрее, пока бригада стоит
  let busy = S.scenes.some(s => ['calling', 'running', 'active', 'playing'].includes(s.status) && !s.outcome &&
      !(s.lost && S.brig.state !== 'travel' && !s.queue.length)) ||
    S.nina.queue.length > 0;
  // «Ждать бригаду»: время бежит быстро, пока бригада едет и никто не говорит
  if (S.waitFast) {
    const cl = caller();
    if (S.brig.state !== 'travel' || S.nina.queue.length || (cl && (replying(cl) || cl.listen))) { S.waitFast = false; dirty.actions = true; }
    else busy = false;
  }
  S.speedBusy = busy;
  S.gm += dt * (busy ? SPEED_BUSY : SPEED_IDLE);
  S.real += dt;
  for (const r of S.room) if (!r.done && S.gm >= r.gm) {
    r.done = true; log(null, '[' + r.text + ']', 'room');
    const abs = (START + r.gm) % 1440, m = abs % 60, h = Math.floor(abs / 60) % 12 || 12;
    const strikes = m === 30 ? 1 : h;
    if (A && r.sound && A.has(r.sound)) for (let i = 0; i < Math.min(strikes, 12); i++) setTimeout(() => A.play(r.sound, 'clean', sndVol(r.sound), 2.6), i * 2400);
    else A && A.bell(strikes);
  }
  for (const sc of S.scenes) updateScene(sc, dt);
  if (!S.scenes.some(s => s.d.kind === 'caller' && (s.status === 'active' || s.status === 'running'))) S.bgNow = null;
  runQueue(S.nina, dt);
  updateBrigade();
  if (S.hint && S.real > S.hintUntil) S.hint = null;
  fxTick();
  if ((S.endAt && S.real >= S.endAt) || S.gm >= END) { render(); endNight(); return; }
  render();
}

/* ---------- отрисовка ---------- */
const dirty = { actions: true, notes: true, map: true };
let lastActionsKey = '';

function render() {
  $('#clock').textContent = clock();
  $('#speed').textContent = (S.speedBusy ? '' : S.waitFast ? '⏩ ждём бригаду' : '⏩ тихо') + (S.debug > 1 ? ` ×${S.debug} тест` : '');
  $('#freq').textContent = fmtF(S.f10);
  $('#slider').value = S.f10;
  $('#knob').style.transform = `rotate(${(S.f10 - 1400) * 3.6}deg)`;
  const c = closeness(), q = activeSignals().reduce((m, s) => Math.max(m, quality(s.f10)), 0);
  const nb = Math.round(c * 5);
  document.querySelectorAll('#bars i').forEach((el, i) => el.classList.toggle('on', i < nb));
  $('#bars').classList.toggle('clear', q === 2);
  $('#sigText').textContent = q === 2 ? 'сигнал чистый' : q === 1 ? 'голос сквозь помехи' : c > 0 ? 'где-то рядом что-то есть' : 'тишина';
  $('#fNoise').classList.toggle('on', S.noiseOff);
  $('#fBoost').classList.toggle('on', S.boost);
  const hint = $('#hint'); hint.hidden = !S.hint; if (S.hint) hint.textContent = S.hint;
  const mo = $('#morse'); mo.hidden = S.morseLive == null; if (S.morseLive != null) mo.textContent = S.morseLive || '…';
  $('#bgNow').textContent = S.bgNow ? (S.bgNow.length ? S.bgNow.map(b => '[' + b.text + ']').join('  ') : '—') : '— (никто не передаёт)';

  const sc = caller();
  const bat = $('#battery');
  if (sc && sc.connected && !sc.outcome) {
    bat.hidden = false;
    $('#batName').textContent = 'Рация ' + (sc.d.who === 'Сергей' ? 'Сергея' : sc.d.who);
    $('#batFill').style.width = sc.battery + '%';
    $('#batPct').textContent = Math.ceil(sc.battery) + '%';
    bat.classList.toggle('low', sc.battery < sc.d.battery.low);
  } else bat.hidden = true;
  const b = S.brig;
  $('#brig').textContent = 'Бригада: ' + (b.state === 'base' ? 'в части' : b.state === 'travel' ? `едет, ещё ~${Math.max(1, Math.ceil(b.start + b.mins - S.gm))} мин` : 'на месте, ждёт новую точку');

  if (A) renderAudio(c);

  const key = JSON.stringify([S.scenes.map(s => [s.status, !!s.waitChoice, quality(s.f10), s.lost, s.outcome, replying(s), s.listen, s.asked.size]),
    S.brig.state, !!S.marker, S.morseHeard, S.ninaMorseAsked, S.nina.queue.length > 0]);
  if (dirty.actions || key !== lastActionsKey) { lastActionsKey = key; dirty.actions = false; renderActions(); }
  if (dirty.notes) { dirty.notes = false; renderNotes(); }
  updateRoom();
  if (dirty.map || S.brig.state === 'travel') { dirty.map = false; renderMap(); }
}

// Какие звуки сейчас должны звучать и насколько громко
function renderAudio(c) {
  const hiss = (S.noiseOff ? 0.015 : 0.06) * (1 - 0.75 * c);
  A.setHiss(hiss);
  const want = {};
  const boost = S.boost ? 1.5 : 1;
  for (const id of D.roomAmbience || []) want[id + '|clean'] = sndVol(id);
  if (A.has('static')) want['static|radio'] = hiss * 2 * sndVol('static');
  const ids = new Set();
  for (const bg of S.bgNow || []) {
    ids.add(bg.id);
    for (const id of bg.sound || []) want[id + '|radio'] = sndVol(id) * boost;
    if (bg.pulse && S.real - (S.lastPulse || -99) >= bg.pulse.every) {
      S.lastPulse = S.real;
      if (!A.play(bg.pulse.sound, 'radio', sndVol(bg.pulse.sound))) { A.setHorn(0.05); setTimeout(() => A.setHorn(0), 2000); }
    }
  }
  const mi = S.scenes.find(s => s.d.bgSounds && s.status === 'running' && quality(s.f10) === 2);
  if (mi) for (const id of mi.d.bgSounds) want[id + '|radio'] = sndVol(id) * boost;
  for (const id of Object.keys(D.sounds || {})) for (const route of ['clean', 'radio']) A.setLoop(id, route, want[id + '|' + route] || 0);
  // заглушка воды, если записи нет
  A.setWater(ids.has('water') && !A.has('spillway') ? (S.boost ? 0.16 : 0.08) : 0);
  A.music(tensionNow(), !!(S.speaking && S.real < S.speaking.until));
}

// Насколько сейчас тревожно (0…1): от этого зависит музыка
function tensionNow() {
  let t = 0.15;
  for (const s of S.scenes) {
    if (s.status === 'calling') t = Math.max(t, 0.3);
    if (s.status === 'playing') t = Math.max(t, 0.55);
    if (s.d.kind === 'door' && s.status === 'running') t = Math.max(t, 0.25);
    if (s.d.kind === 'caller' && s.connected && !s.outcome) t = Math.max(t, s.lost ? 0.8 : 0.35 + 0.55 * (1 - s.battery / 100));
  }
  if (S.brig.state === 'travel') t += 0.08;
  const cl = caller();
  if (cl && cl.outcome) t = 0.05;   // спасли — отпускает
  return Math.min(1, t);
}

function btn(html, onClick, cls = '', disabled = false) {
  const el = document.createElement('button');
  el.innerHTML = html; el.className = cls; el.disabled = disabled; el.onclick = onClick; return el;
}

function renderActions() {
  const box = $('#actions'); box.innerHTML = '';
  for (const sc of S.scenes) {
    if (sc.waitChoice && (sc.d.kind === 'door' || quality(sc.f10) === 2)) {
      box.insertAdjacentHTML('beforeend', `<div class="who">${sc.d.kind === 'door' ? 'У двери: ' : 'Ответить: '}${esc(sc.d.who)}</div>`);
      for (const opt of sc.waitChoice) box.appendChild(btn('Ты: ' + esc(opt.text), () => choose(sc, opt), 'choice'));
    }
    if (sc.d.kind === 'caller' && sc.status === 'active' && !sc.outcome) {
      if (sc.lost) { box.insertAdjacentHTML('beforeend', `<div class="who">${esc(sc.d.who)}: связь потеряна</div>`); continue; }
      if (quality(sc.f10) !== 2) { box.insertAdjacentHTML('beforeend', `<div class="who">${esc(sc.d.who)} — на ${fmtF(sc.f10)}. Вернись на его частоту.</div>`); continue; }
      box.insertAdjacentHTML('beforeend', `<div class="who">Спросить ${esc(sc.d.who === 'Сергей' ? 'Сергея' : sc.d.who)} (вопрос тратит батарею):</div>`);
      const busy = replying(sc);
      box.appendChild(btn((sc.listen ? '■ Хватит, отпустите кнопку' : '▶ Подержите кнопку, я послушаю фон') +
        `<span class="cost">${sc.d.battery.listenPer10s}% / 10 с</span>`, () => { sc.listen = !sc.listen; dirty.actions = true; }, sc.listen ? 'toggle on' : 'toggle'));
      for (const q of sc.d.questions) {
        if (q.needsBrigade && S.brig.state !== 'travel') continue;
        box.appendChild(btn((sc.asked.has(q.id) ? '✓ ' : '') + esc(q.text) + `<span class="cost">−${q.cost}%</span>`, () => ask(sc, q), '', busy));
      }
    }
  }
  const nb = $('#ninaActions'); nb.innerHTML = '';
  const talking = S.nina.queue.length > 0;
  nb.appendChild(btn(S.brig.state === 'travel' ? 'Бригада в пути…' : S.marker ? 'Отправить бригаду в точку на карте' : 'Поставь точку на карте, чтобы отправить бригаду',
    sendBrigade, '', !S.marker || S.brig.state === 'travel' || talking));
  if (S.brig.state === 'travel' && !S.ended) {
    nb.appendChild(btn(S.waitFast ? '■ Хватит ждать' : '⏩ Ждать, пока бригада доедет', () => { S.waitFast = !S.waitFast; dirty.actions = true; }, 'wait'));
  }
  const morse = S.scenes.find(s => s.d.kind === 'morse');
  if (S.morseHeard && !S.ninaMorseAsked && morse) {
    nb.appendChild(btn('Спросить про морзянку на 144.0', () => {
      S.ninaMorseAsked = true; S.nina.queue.push(...morse.d.askNina); dirty.actions = true;
    }, '', talking));
  }
}

function renderNotes() {
  const box = $('#notes'); box.innerHTML = '';
  if (!S.notes.length && !S.clueOrder.length) box.innerHTML = '<div class="note" style="color:var(--muted)">Пока пусто. Сюда попадает всё важное, что ты услышал.</div>';
  if (S.clueOrder.length) box.insertAdjacentHTML('beforeend', '<div class="label">Улики: что это за звук или что видно?</div>');
  for (const id of S.clueOrder) {
    const c = S.clues[id];
    const div = document.createElement('div'); div.className = 'clue';
    div.innerHTML = `<span class="swatch" style="background:${c.color}"></span>${esc(c.label)}`;
    const sel = document.createElement('select');
    sel.innerHTML = '<option value="">— это что? —</option>' + D.map.sources.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
    sel.value = c.src || '';
    sel.onchange = () => { c.src = sel.value || null; dirty.map = true; };
    div.appendChild(sel); box.appendChild(div);
  }
  if (S.notes.length) box.insertAdjacentHTML('beforeend', '<div class="label" style="margin-top:10px">Заметки</div>');
  for (const n of S.notes) box.insertAdjacentHTML('beforeend', `<div class="note">${esc(n)}</div>`);
}

function renderBook() {
  let h = '';
  for (const s of D.grandpaNotebook) h += `<h3>${esc(s.title)}</h3>` + s.lines.map(l => `<p>${esc(l)}</p>`).join('');
  h += '<h3>Морзянка (цифры)</h3><table>' + Object.entries(MORSE).map(([d, m]) =>
    `<tr><td>${d}</td><td>${m.replace(/\./g, '·').replace(/-/g, '−')}</td></tr>`).join('') + '</table>';
  $('#book').innerHTML = h;
}

/* ---------- карта ---------- */
const K = 110, PAD = 30;
let MW, MH;
function mx(x) { return PAD + (x - D.map.bounds.x[0]) * K; }
function my(y) { return PAD + (D.map.bounds.y[1] - y) * K; }
function poly(pts) { return pts.map(p => mx(p[0]).toFixed(1) + ',' + my(p[1]).toFixed(1)).join(' '); }

// --- карта деда: неподвижная часть рисуется один раз, поверх — зоны, точка, бригада ---
const INK = '#2b231a', INK2 = '#5a4a36', RED = '#8a2d1d';
function segDist(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], l = dx * dx + dy * dy;
  let t = l ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l : 0; t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}
function lineDist(p, pts) { let d = Infinity; for (let i = 1; i < pts.length; i++) d = Math.min(d, segDist(p, pts[i - 1], pts[i])); return d; }
function inPoly(p, pts) {
  let c = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++)
    if ((pts[i][1] > p[1]) !== (pts[j][1] > p[1]) && p[0] < (pts[j][0] - pts[i][0]) * (p[1] - pts[i][1]) / (pts[j][1] - pts[i][1]) + pts[i][0]) c = !c;
  return c;
}
function rng(seed) { let s = seed; return () => (s = (s * 16807) % 2147483647) / 2147483647; }
function label(x, y, text, size = 17, extra = '') {
  return `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" style="font-size:${size}px" ${extra}>${esc(text)}</text>`;
}

let MAP_STATIC = '';
function buildMapStatic() {
  const m = D.map, b = m.bounds, R = rng(42);
  const streets = m.streets || (m.roads || []).map(pts => ({ pts, main: true, name: '' }));
  let h = '<defs><filter id="pencil"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="1" seed="2"/><feDisplacementMap in="SourceGraphic" scale="1.6"/></filter></defs>';
  // клетки деда (1 км): буквы сверху, цифры слева
  const cols = 'АБВГДЕ', x0 = Math.ceil(b.x[0]);
  for (let x = x0; x <= b.x[1]; x++) h += `<line x1="${mx(x)}" y1="${PAD}" x2="${mx(x)}" y2="${MH - PAD}" stroke="${INK2}" stroke-width=".6" opacity=".35"/>`;
  for (let y = Math.ceil(b.y[0]); y <= b.y[1]; y++) h += `<line x1="${PAD}" y1="${my(y)}" x2="${MW - PAD}" y2="${my(y)}" stroke="${INK2}" stroke-width=".6" opacity=".35"/>`;
  for (let i = 0, x = Math.floor(b.x[0]); x < b.x[1]; x++, i++) h += label(mx(Math.max(x, b.x[0]) + 0.5 * Math.min(1, b.x[1] - x)), PAD - 4, cols[i] || '', 15, `fill="${INK2}" text-anchor="middle"`);
  for (let i = 1, y = Math.floor(b.y[1]); y > b.y[0]; y--, i++) h += label(PAD - 12, my(y - 0.5) + 5, String(i), 15, `fill="${INK2}"`);
  // лес
  for (const f of m.forests || []) {
    h += `<polygon points="${poly(f)}" fill="#9fae7f" fill-opacity=".45" stroke="#5f7048" stroke-width="1" stroke-dasharray="3 3"/>`;
    const xs = f.map(p => p[0]), ys = f.map(p => p[1]);
    for (let i = 0; i < 140; i++) {
      const p = [Math.min(...xs) + R() * (Math.max(...xs) - Math.min(...xs)), Math.min(...ys) + R() * (Math.max(...ys) - Math.min(...ys))];
      if (!inPoly(p, f)) continue;
      const X = mx(p[0]), Y = my(p[1]);
      h += `<path d="M${X - 4} ${Y + 3} L${X} ${Y - 5} L${X + 4} ${Y + 3} Z" fill="#6f8556" fill-opacity=".7" stroke="#4a5b37" stroke-width=".6"/>`;
    }
  }
  // река: берега и вода
  h += `<polyline points="${poly(m.river)}" fill="none" stroke="#56738a" stroke-width="15" stroke-linecap="round" stroke-linejoin="round" opacity=".85"/>`;
  h += `<polyline points="${poly(m.river)}" fill="none" stroke="#9db8c9" stroke-width="11" stroke-linecap="round" stroke-linejoin="round"/>`;
  if (m.riverName) h += label(mx(m.riverName.x), my(m.riverName.y), m.riverName.text, 18, `fill="#3f5f78" font-style="italic"`);
  h += `<polyline points="${poly(m.dam)}" fill="none" stroke="${INK}" stroke-width="6"/><polyline points="${poly(m.dam)}" fill="none" stroke="#efe3c6" stroke-width="2" stroke-dasharray="3 3"/>`;
  // дома кварталами (там, где нет реки, дорог и путей)
  const avoid = p => lineDist(p, m.river) < 0.14 || streets.some(s => lineDist(p, s.pts) < 0.065) || m.rails.some(r => lineDist(p, r) < 0.08)
    || m.places.some(q => Math.hypot(q.x - p[0], q.y - p[1]) < 0.12) || Math.hypot(m.home.x - p[0], m.home.y - p[1]) < 0.1;
  for (const a of m.townAreas || []) {
    for (let x = a.x0; x < a.x1; x += 0.13) for (let y = a.y0; y < a.y1; y += 0.12) {
      const p = [x + (R() - .5) * .03, y + (R() - .5) * .03];
      if (R() < .14 || avoid(p)) continue;
      const w = (0.06 + R() * 0.04) * K, hh = (0.045 + R() * 0.03) * K;
      h += `<rect x="${(mx(p[0]) - w / 2).toFixed(1)}" y="${(my(p[1]) - hh / 2).toFixed(1)}" width="${w.toFixed(1)}" height="${hh.toFixed(1)}" fill="#c4ad84" stroke="#6b5a40" stroke-width=".7"/>`;
    }
  }
  // дороги и улицы
  for (const s of streets) {
    const w = s.main ? 7 : 5;
    h += `<polyline points="${poly(s.pts)}" fill="none" stroke="#6b5a40" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>`;
    h += `<polyline points="${poly(s.pts)}" fill="none" stroke="#efe3c6" stroke-width="${w - 3}" stroke-linecap="round" stroke-linejoin="round"/>`;
  }
  // железная дорога со шпалами
  for (const r of m.rails) {
    h += `<polyline points="${poly(r)}" fill="none" stroke="${INK}" stroke-width="7" stroke-dasharray="1.4 6"/>`;
    h += `<polyline points="${poly(r)}" fill="none" stroke="${INK}" stroke-width="2"/>`;
  }
  // названия улиц вдоль самого длинного участка
  for (const s of streets) {
    if (!s.name) continue;
    let best = 1, bl = 0;
    for (let i = 1; i < s.pts.length; i++) { const l = Math.hypot(s.pts[i][0] - s.pts[i - 1][0], s.pts[i][1] - s.pts[i - 1][1]); if (l > bl) { bl = l; best = i; } }
    const [a, c] = [s.pts[best - 1], s.pts[best]];
    let ang = Math.atan2(my(c[1]) - my(a[1]), mx(c[0]) - mx(a[0])) * 180 / Math.PI;
    if (ang > 90) ang -= 180; if (ang < -90) ang += 180;
    const X = mx((a[0] + c[0]) / 2), Y = my((a[1] + c[1]) / 2);
    h += label(X, Y - 5, s.name, 15, `fill="${INK2}" text-anchor="middle" transform="rotate(${ang.toFixed(1)} ${X.toFixed(1)} ${Y.toFixed(1)})" class="halo"`);
  }
  // завалы
  for (const z of m.rubble || []) {
    const X = mx(z.x), Y = my(z.y);
    h += `<g stroke="${RED}" stroke-width="2"><line x1="${X - 6}" y1="${Y - 6}" x2="${X + 6}" y2="${Y + 6}"/><line x1="${X - 6}" y1="${Y + 6}" x2="${X + 6}" y2="${Y - 6}"/><line x1="${X + 2}" y1="${Y - 8}" x2="${X + 12}" y2="${Y + 2}"/></g>`;
    h += label(X + 12, Y + 14, z.label, 16, `fill="${RED}" class="halo"`);
  }
  // места со значками
  for (const p of m.places) {
    const X = mx(p.x), Y = my(p.y), ic = p.icon || 'dot';
    if (ic === 'tower') h += `<rect x="${X - 6}" y="${Y - 6}" width="12" height="12" fill="#a8916b" stroke="${INK}" stroke-width="1.2"/><line x1="${X}" y1="${Y - 6}" x2="${X}" y2="${Y - 17}" stroke="${INK}" stroke-width="1.2"/><circle cx="${X}" cy="${Y - 17}" r="3" fill="none" stroke="${INK}"/>`;
    else if (ic === 'building') h += `<rect x="${X - 8}" y="${Y - 5}" width="16" height="10" fill="#a8916b" stroke="${INK}" stroke-width="1.2"/>`;
    else if (ic === 'chimney') h += `<rect x="${X - 10}" y="${Y - 4}" width="20" height="10" fill="#a8916b" stroke="${INK}" stroke-width="1.2"/><rect x="${X + 3}" y="${Y - 20}" width="4" height="16" fill="${INK}"/><circle cx="${X + 5}" cy="${Y - 22}" r="2.2" fill="${RED}"/>`;
    else if (ic === 'bolt') h += `<path d="M${X + 2} ${Y - 9} L${X - 4} ${Y + 1} L${X} ${Y + 1} L${X - 2} ${Y + 9} L${X + 5} ${Y - 2} L${X + 1} ${Y - 2} Z" fill="${INK}"/>`;
    else if (ic === 'cross') h += `<g stroke="${INK}" stroke-width="2"><line x1="${X - 7}" y1="${Y - 7}" x2="${X + 7}" y2="${Y + 7}"/><line x1="${X - 7}" y1="${Y + 7}" x2="${X + 7}" y2="${Y - 7}"/></g>`;
    else if (ic === 'bridge') h += `<g stroke="${INK}" stroke-width="2"><line x1="${X - 9}" y1="${Y - 6}" x2="${X + 7}" y2="${Y - 10}"/><line x1="${X - 7}" y1="${Y + 9}" x2="${X + 9}" y2="${Y + 5}"/></g>`;
    else h += `<circle cx="${X}" cy="${Y}" r="4" fill="${INK}"/>`;
    const left = p.labelLeft;
    h += label(X + (left ? -12 : 12), Y + (left ? 5 : -8), p.name, 18, `fill="${INK}" text-anchor="${left ? 'end' : 'start'}" class="halo"`);
  }
  // свой дом
  const hm = m.home, HX = mx(hm.x), HY = my(hm.y);
  h += `<path d="M${HX - 8} ${HY + 7} L${HX - 8} ${HY - 2} L${HX} ${HY - 10} L${HX + 8} ${HY - 2} L${HX + 8} ${HY + 7} Z" fill="#d98a3a" stroke="${RED}" stroke-width="1.5"/>`;
  h += label(HX + 12, HY + 6, hm.name, 19, `fill="${RED}" class="halo"`);
  // заголовок, роза ветров, масштаб
  h += label(PAD + 8, PAD + 26, 'Сосновый Яр', 30, `fill="${INK}" class="halo" font-weight="700"`);
  h += label(PAD + 10, PAD + 46, 'черчено Громовым', 16, `fill="${INK2}" class="halo"`);
  const CX = MW - PAD - 22, CY = PAD + 30;
  h += `<g stroke="${INK}" stroke-width="1.3"><circle cx="${CX}" cy="${CY}" r="16" fill="none"/><path d="M${CX} ${CY - 20} L${CX + 5} ${CY} L${CX} ${CY + 20} L${CX - 5} ${CY} Z" fill="${INK}" fill-opacity=".25"/></g>`;
  h += label(CX - 5, CY - 23, 'С', 16, `fill="${INK}"`);
  h += `<g stroke="${INK}" stroke-width="2"><line x1="${MW - PAD - 8 - K}" y1="${MH - PAD - 4}" x2="${MW - PAD - 8}" y2="${MH - PAD - 4}"/><line x1="${MW - PAD - 8 - K}" y1="${MH - PAD - 9}" x2="${MW - PAD - 8 - K}" y2="${MH - PAD + 1}"/><line x1="${MW - PAD - 8}" y1="${MH - PAD - 9}" x2="${MW - PAD - 8}" y2="${MH - PAD + 1}"/></g>`;
  h += label(MW - PAD - 8 - K / 2, MH - PAD - 10, '1 км', 16, `fill="${INK}" text-anchor="middle"`);
  MAP_STATIC = `<g filter="url(#pencil)">${h}</g>`;
}

function renderMap() {
  const m = D.map, svg = $('#map');
  if (!MAP_STATIC) buildMapStatic();
  let h = MAP_STATIC;
  for (const id of S.clueOrder) {
    const c = S.clues[id]; if (!c.src) continue;
    const s = m.sources.find(z => z.id === c.src);
    h += `<circle cx="${mx(s.x)}" cy="${my(s.y)}" r="${s.r * K}" fill="${c.color}" fill-opacity="0.16" stroke="${c.color}" stroke-width="3" stroke-dasharray="8 5"/>`;
  }
  const b = S.brig;
  if (b.state === 'travel') h += `<line x1="${mx(b.from.x)}" y1="${my(b.from.y)}" x2="${mx(b.to.x)}" y2="${my(b.to.y)}" stroke="${RED}" stroke-width="2" stroke-dasharray="5 4"/>`;
  if (S.marker) {
    const x = mx(S.marker.x), y = my(S.marker.y);
    h += `<g stroke="#c0281a" stroke-width="4" stroke-linecap="round"><line x1="${x - 9}" y1="${y - 9}" x2="${x + 9}" y2="${y + 9}"/><line x1="${x - 9}" y1="${y + 9}" x2="${x + 9}" y2="${y - 9}"/></g>`;
  }
  h += `<circle cx="${mx(b.x)}" cy="${my(b.y)}" r="9" fill="#c0281a" stroke="#efe3c6" stroke-width="2"/><text x="${mx(b.x)}" y="${my(b.y) + 5}" text-anchor="middle" style="fill:#fff;font:700 14px 'PT Sans',sans-serif">Б</text>`;
  svg.innerHTML = h;
}

function mapClick(e) {
  // точные координаты внутри картинки карты, даже если она ужата и по бокам есть поля
  const svg = $('#map'), pt = svg.createSVGPoint(); pt.x = e.clientX; pt.y = e.clientY;
  const loc = pt.matrixTransform(svg.getScreenCTM().inverse()), px = loc.x, py = loc.y;
  if (px < PAD || py < PAD || px > MW - PAD || py > MH - PAD) return;
  S.marker = { x: D.map.bounds.x[0] + (px - PAD) / K, y: D.map.bounds.y[1] - (py - PAD) / K };
  dirty.map = dirty.actions = true;
}

/* ---------- звук (заглушки из генератора, без файлов) ---------- */
function makeAudio() {
  const Ctx = window.AudioContext || window.webkitAudioContext; if (!Ctx) return null;
  const ctx = new Ctx(), master = ctx.createGain(); master.gain.value = 0.8; master.connect(ctx.destination);
  const nb = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate), ch = nb.getChannelData(0);
  for (let i = 0; i < ch.length; i++) ch[i] = Math.random() * 2 - 1;
  const noise = () => { const s = ctx.createBufferSource(); s.buffer = nb; s.loop = true; s.start(); return s; };
  const chain = (src, ...nodes) => nodes.reduce((a, n) => (a.connect(n), n), src);
  const filt = (type, f, Q = 1) => { const x = ctx.createBiquadFilter(); x.type = type; x.frequency.value = f; x.Q.value = Q; return x; };
  const gain = v => { const g = ctx.createGain(); g.gain.value = v; return g; };
  // три регулятора громкости: голоса, шумы (всё остальное, кроме музыки), музыка. Голоса и шумы идут двумя путями: чисто или через рацию
  const voiceClean = gain(VOL.voice), sfxClean = gain(VOL.sfx);
  voiceClean.connect(master); sfxClean.connect(master);
  const hissG = gain(0), waterG = gain(0), morseG = gain(0), hornG = gain(0);
  chain(noise(), filt('bandpass', 2500, 0.6), hissG, sfxClean);
  chain(noise(), filt('lowpass', 450), waterG, sfxClean);
  const mo = ctx.createOscillator(); mo.frequency.value = 720; chain(mo, morseG, sfxClean); mo.start();
  const hl = filt('lowpass', 1200);
  for (const f of [311, 370]) { const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f; o.connect(hl); o.start(); }
  chain(hl, hornG, sfxClean);
  const set = (g, v, tc = 0.04) => g.gain.setTargetAtTime(v, ctx.currentTime, tc);
  const SFXB = {}, loops = {};

  // ---- тревожная музыка: гул + высокий звон + сердцебиение + редкие «удары» ----
  const musicG = gain(VOL.music); musicG.connect(master);
  const droneF = filt('lowpass', 200, 3);
  const d1 = ctx.createOscillator(), d2 = ctx.createOscillator(), d3 = ctx.createOscillator();
  d1.type = 'sawtooth'; d1.frequency.value = 55;      // ля
  d2.type = 'sawtooth'; d2.frequency.value = 58.27;   // си-бемоль: малая секунда — неприятное «биение»
  d3.type = 'triangle'; d3.frequency.value = 27.5;
  for (const o of [d1, d2, d3]) { o.connect(droneF); o.start(); }
  const droneG = gain(0); chain(droneF, droneG, musicG);
  const lfo = ctx.createOscillator(), lfoG = gain(120); lfo.frequency.value = 0.06; chain(lfo, lfoG); lfoG.connect(droneF.frequency); lfo.start();
  const shF = filt('bandpass', 1800, 6), sh1 = ctx.createOscillator(), sh2 = ctx.createOscillator();
  sh1.frequency.value = 880; sh2.frequency.value = 932.3;
  for (const o of [sh1, sh2]) { o.connect(shF); o.start(); }
  const shG = gain(0); chain(shF, shG, musicG);
  const echo = ctx.createDelay(2), echoFb = gain(0.45), echoOut = gain(0.6);
  echo.delayTime.value = 0.42; echo.connect(echoFb); echoFb.connect(echo); echo.connect(echoOut); echoOut.connect(musicG);
  let tens = 0, nextBeat = 0, nextSting = ctx.currentTime + 25;
  function beat(t, vol) {
    for (const [f, dt, v] of [[58, 0, 1], [50, 0.2, 0.7]]) {
      const o = ctx.createOscillator(), g = gain(0); o.frequency.value = f; chain(o, g, musicG);
      g.gain.setValueAtTime(vol * v, t + dt); g.gain.exponentialRampToValueAtTime(0.0001, t + dt + 0.22); o.start(t + dt); o.stop(t + dt + 0.3);
    }
  }
  function sting(vol) {
    const t = ctx.currentTime + 0.05;
    for (const f of [738, 1043, 1567]) {
      const o = ctx.createOscillator(), g = gain(0); o.frequency.value = f * (0.98 + Math.random() * 0.04);
      o.connect(g); g.connect(musicG); g.connect(echo);
      g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 3.5); o.start(t); o.stop(t + 3.6);
    }
  }
  // голос «через рацию»: узкая полоса и перегруз дешёвого динамика
  const radioIn = gain(1), shaper = ctx.createWaveShaper(), curve = new Float32Array(1024);
  for (let i = 0; i < curve.length; i++) { const x = i / 511.5 - 1; curve[i] = Math.tanh(x * 3) / Math.tanh(3); }
  shaper.curve = curve;
  chain(radioIn, filt('highpass', 320, 0.7), filt('lowpass', 3000, 0.7), shaper, gain(0.75), master);
  const voiceRadio = gain(VOL.voice), sfxRadio = gain(VOL.sfx);
  voiceRadio.connect(radioIn); sfxRadio.connect(radioIn);
  // «уши» для осциллографа на рации: слушает голоса, эфир и шипение (без музыки и звуков комнаты)
  const scopeA = ctx.createAnalyser(); scopeA.fftSize = 512; scopeA.smoothingTimeConstant = 0;
  for (const n of [voiceRadio, voiceClean, sfxRadio, hissG, morseG]) n.connect(scopeA);
  const scopeSink = gain(0); scopeA.connect(scopeSink); scopeSink.connect(ctx.destination);
  const scopeBuf = new Uint8Array(scopeA.fftSize);
  const sfxBus = route => route === 'radio' ? sfxRadio : sfxClean;
  function burst(dur, vol, f) {
    const s = ctx.createBufferSource(); s.buffer = nb; const g = gain(vol);
    chain(s, filt('bandpass', f, 0.8), g, sfxClean);
    g.gain.setTargetAtTime(0, ctx.currentTime + dur * 0.3, dur / 3); s.start(); s.stop(ctx.currentTime + dur * 2);
  }
  function tone(f, t, decay, vol, type = 'sine') {
    const o = ctx.createOscillator(); o.type = type; o.frequency.value = f; const g = gain(0);
    chain(o, g, sfxClean); g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
    o.start(t); o.stop(t + decay + 0.05);
  }
  return {
    ctx,
    setHiss: v => set(hissG, v), setWater: v => set(waterG, v), setHorn: v => set(hornG, v, 0.08),
    setMorse: v => morseG.gain.setTargetAtTime(v, ctx.currentTime, 0.004),
    mute(m) { master.gain.value = m ? 0 : 0.8; },
    scope() { scopeA.getByteTimeDomainData(scopeBuf); return scopeBuf; },
    // гром: низкий рокот из шума с неровным затуханием; far — 0 (близко, с треском) … 1 (далеко, глухо)
    thunder(vol, far) {
      const t = ctx.currentTime + 0.02, len = 5 + Math.random() * 3;
      const s = ctx.createBufferSource(); s.buffer = nb; s.loop = true;
      const lp = filt('lowpass', 260 - 140 * far, 0.7), lp2 = filt('lowpass', 400 - 200 * far, 0.5), g = gain(0);
      chain(s, lp, lp2, g, sfxClean);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol, t + 0.08 + far * 0.5);
      let x = t + 0.3 + far * 0.5;
      while (x < t + len - 1) { g.gain.exponentialRampToValueAtTime(vol * (0.35 + Math.random() * 0.6) * (1 - (x - t) / len), x); x += 0.25 + Math.random() * 0.5; }
      g.gain.exponentialRampToValueAtTime(0.0001, t + len);
      s.start(t, Math.random()); s.stop(t + len + 0.1);
      if (far < 0.4) burst(0.18, vol * 0.5, 2200);   // треск близкого удара
    },
    setVolumes(v) {
      for (const g of [voiceClean, voiceRadio]) set(g, v.voice, 0.05);
      for (const g of [sfxClean, sfxRadio]) set(g, v.sfx, 0.05);
      set(musicG, v.music, 0.05);
    },
    // t — напряжение 0…1; speaking — сейчас кто-то говорит (музыку чуть приглушаем)
    music(t, speaking) {
      tens += (t - tens) * 0.03;
      const duck = speaking ? 0.6 : 1, now = ctx.currentTime;
      droneG.gain.setTargetAtTime((0.025 + 0.07 * tens) * duck, now, 0.4);
      droneF.frequency.setTargetAtTime(150 + 450 * tens, now, 0.5);
      d2.frequency.setTargetAtTime(58.27 + 1.5 * tens, now, 1);
      shG.gain.setTargetAtTime(Math.max(0, tens - 0.4) * 0.035 * duck, now, 0.6);
      if (tens > 0.5) {
        if (nextBeat < now) nextBeat = now + 0.1;
        if (nextBeat - now < 0.25) { beat(nextBeat, 0.25 + 0.3 * tens); nextBeat += 60 / (55 + 70 * (tens - 0.5) * 2); }
      }
      if (now > nextSting && tens > 0.12) { sting(0.012 + 0.02 * tens); nextSting = now + 30 + Math.random() * 50 - 20 * tens; }
    },
    // ---- записанные звуки из stories/*.json → "sounds" ----
    async loadSfx(map, onDone) {
      await Promise.all(Object.entries(map || {}).filter(([, s]) => s && s.file).map(async ([id, s]) => {
        try { const r = await fetch('sfx/' + s.file); SFXB[id] = await ctx.decodeAudioData(await r.arrayBuffer()); } catch (e) { /* нет файла — останется заглушка */ }
        onDone && onDone();
      }));
    },
    has: id => !!SFXB[id],
    // зацикленный звук: громкость меняется плавно; route 'radio' — через эффект рации
    setLoop(id, route, vol) {
      const key = id + '|' + route; let L = loops[key];
      if (!L) {
        if (!vol || !SFXB[id]) return;
        const s = ctx.createBufferSource(); s.buffer = SFXB[id]; s.loop = true; const g = gain(0);
        chain(s, g, sfxBus(route)); s.start(0, Math.random() * SFXB[id].duration * 0.5);
        L = loops[key] = { g };
      }
      set(L.g, vol || 0, 0.12);
    },
    play(id, route, vol, maxDur) {
      const b = SFXB[id]; if (!b) return false;
      const s = ctx.createBufferSource(); s.buffer = b; const g = gain(vol);
      chain(s, g, sfxBus(route)); s.start();
      if (maxDur) { g.gain.setTargetAtTime(0, ctx.currentTime + maxDur, 0.25); s.stop(ctx.currentTime + maxDur + 1.5); }
      return true;
    },
    playVoice(buf, mode, vol) {
      const s = ctx.createBufferSource(); s.buffer = buf; const g = gain(vol);
      chain(s, g, mode === 'radio' ? voiceRadio : voiceClean); s.start();
    },
    click() { burst(0.04, 0.3, 3000); },
    bell(n) { const t0 = ctx.currentTime + 0.1; for (let i = 0; i < Math.min(n, 12); i++) { tone(523, t0 + i * 1.4, 2.5, 0.12); tone(1046, t0 + i * 1.4, 1.2, 0.04); } },
    sfx(name) {
      const t = ctx.currentTime + 0.05;
      if (/стук/.test(name)) for (let i = 0; i < 3; i++) tone(90, t + i * 0.3, 0.18, 0.5);
      else if (/гудок/.test(name)) tone(330, t, 0.9, 0.08, 'square');
      else if (/хлопа/.test(name)) tone(70, t, 0.25, 0.5);
      else if (/кашель/.test(name)) { burst(0.12, 0.35, 900); setTimeout(() => burst(0.12, 0.3, 800), 260); }
    },
    stopAll() { set(droneG, 0, 1.5); set(shG, 0, 1); tens = -1e9; set(hissG, 0); set(waterG, 0); set(hornG, 0); morseG.gain.value = 0; for (const L of Object.values(loops)) set(L.g, 0, 0.5); },
    lastMorse() {
      let t = ctx.currentTime + 1;
      for (const sym of '....- .---- --...') {
        if (sym === ' ') { t += 0.35; continue; }
        const d = sym === '.' ? 0.1 : 0.3; const g = gain(0); const o = ctx.createOscillator(); o.frequency.value = 720;
        chain(o, g, sfxClean); g.gain.setValueAtTime(0.025, t); g.gain.setValueAtTime(0, t + d); o.start(t); o.stop(t + d + 0.02); t += d + 0.1;
      }
    },
  };
}

/* ---------- управление ---------- */
function setF(v) { const nv = Math.max(1400, Math.min(1500, v)); if (nv !== S.f10) S.tuneT = S.real; S.f10 = nv; dirty.actions = true; }
function bindUI() {
  $('#fDown').onclick = () => setF(S.f10 - 1);
  $('#fUp').onclick = () => setF(S.f10 + 1);
  $('#slider').oninput = e => setF(Number(e.target.value));
  $('#radioPanel').addEventListener('wheel', e => { e.preventDefault(); setF(S.f10 + (e.deltaY < 0 ? 1 : -1) * (e.shiftKey ? 10 : 1)); }, { passive: false });
  document.addEventListener('keydown', e => {
    if (!S || S.ended || S.paused) return;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault(); setF(S.f10 + (e.key === 'ArrowRight' ? 1 : -1) * (e.shiftKey ? 10 : 1));
    }
    if (TEST && (e.key === 'f' || e.key === 'F' || e.key === 'а' || e.key === 'А')) S.debug = S.debug === 1 ? 5 : 1;
  });
  // ручка настройки: тянуть мышью или пальцем влево-вправо
  const knob = $('#knob'); let drag = null;
  knob.addEventListener('pointerdown', e => { drag = { x: e.clientX, f: S.f10 }; knob.setPointerCapture(e.pointerId); });
  knob.addEventListener('pointermove', e => { if (drag) setF(drag.f + Math.round((e.clientX - drag.x) / 6)); });
  for (const ev of ['pointerup', 'pointercancel']) knob.addEventListener(ev, () => { drag = null; });
  $('#fNoise').onclick = () => { S.noiseOff = !S.noiseOff; };
  $('#fBoost').onclick = () => { S.boost = !S.boost; };
  $('#mute').onclick = () => { S.muted = !S.muted; A && A.mute(S.muted); $('#mute').textContent = 'Звук: ' + (S.muted ? 'выкл' : 'вкл'); };
  $('#map').addEventListener('click', mapClick);
  document.querySelectorAll('.tab').forEach(t => t.onclick = () => {
    document.querySelectorAll('.tab').forEach(x => x.classList.toggle('on', x === t));
    document.querySelectorAll('.tabBody').forEach(b => b.hidden = b.id !== 'tab-' + t.dataset.tab);
  });
}

/* ---------- громкость: голоса / шумы / музыка (запоминается в браузере игрока) ---------- */
const VOL_KEY = 'na-chastote-volume';
const VOL = (() => {
  const v = { voice: 1, sfx: 1, music: 1 };
  try { const s = JSON.parse(localStorage.getItem(VOL_KEY) || '{}'); for (const k in v) if (typeof s[k] === 'number') v[k] = Math.max(0, Math.min(1.5, s[k])); } catch (e) { /* по умолчанию */ }
  return v;
})();
const VOL_NAMES = [['voice', 'Голоса'], ['sfx', 'Шумы и эфир'], ['music', 'Музыка']];
function volumeHTML() {
  return '<div class="vol">' + VOL_NAMES.map(([k, name]) =>
    `<label class="volRow"><span>${name}</span><input type="range" min="0" max="150" step="5" data-vol="${k}" value="${Math.round(VOL[k] * 100)}"><b>${Math.round(VOL[k] * 100)}%</b></label>`).join('') + '</div>';
}
function bindVolume(root) {
  root.querySelectorAll('input[data-vol]').forEach(inp => inp.oninput = () => {
    VOL[inp.dataset.vol] = Number(inp.value) / 100;
    inp.nextElementSibling.textContent = inp.value + '%';
    document.querySelectorAll(`input[data-vol="${inp.dataset.vol}"]`).forEach(o => { if (o !== inp) { o.value = inp.value; o.nextElementSibling.textContent = inp.value + '%'; } });
    try { localStorage.setItem(VOL_KEY, JSON.stringify(VOL)); } catch (e) { /* без сохранения */ }
    if (A && A.setVolumes) A.setVolumes(VOL);
  });
}

/* ---------- пауза: время ночи и весь звук стоят ---------- */
function canPause() { return S && !S.ended && !S.paused && $('#startScreen').hidden && $('#menu').hidden; }
function setPause(on) {
  if (!S || S.ended) return;
  S.paused = on;
  $('#pauseScreen').hidden = !on;
  if (A && A.ctx) { try { on ? A.ctx.suspend() : A.ctx.resume(); } catch (e) { /* ничего */ } }
  if (on) $('#pauseGo').focus({ preventScroll: true });
}

/* ---------- главное меню ---------- */
let CAT = null, LOADED = null;   // каталог историй; id уже загруженной ночи
function getProgress() { try { return JSON.parse(localStorage.getItem(PROGRESS_KEY) || '{}') || {}; } catch (e) { return {}; } }
function markPassed(id, at) {
  try { const p = getProgress(); p[id] = { passed: true, at: (p[id] && p[id].at) || at }; localStorage.setItem(PROGRESS_KEY, JSON.stringify(p)); } catch (e) { /* без сохранения */ }
}
// Переход с перезагрузкой страницы: ?night=<id> — сразу к ночи, без него — в меню. ?test сохраняется.
function goTo(nightId) {
  const q = new URLSearchParams();
  if (nightId) q.set('night', nightId);
  if (TEST) q.set('test', '');
  const s = q.toString().replace(/=(&|$)/g, '$1');
  location.href = location.pathname + (s ? '?' + s : '');
}
function findNight(id) {
  for (const st of CAT.stories) for (const n of st.nights) if (n.id === id) return { st, n };
  return null;
}
function nightLabel(n, prog) {
  return prog[n.id] && prog[n.id].passed && n.title ? `Ночь ${n.n}. ${n.title}` : `Ночь ${n.n} ???`;
}
function menuShow(id) {
  $('#menu').hidden = false; $('#startScreen').hidden = true;
  document.querySelectorAll('.mScreen').forEach(s => s.hidden = s.id !== id);
  const first = $('#' + id + ' button:not(:disabled)'); if (first) first.focus({ preventScroll: true });
}
function renderStories() {
  const prog = getProgress();
  $('#mStoryList').innerHTML = CAT.stories.map((st, i) => {
    const ready = st.nights.filter(n => n.file).length, passed = st.nights.filter(n => prog[n.id] && prog[n.id].passed).length;
    return `<button class="mStory" data-i="${i}"><b>${esc(st.title)}</b><span class="nm">${esc(st.name || '')}</span>
      <p>${esc(st.about || '')}</p><div class="pr">Ночей: ${st.nights.length} · доступно: ${ready} · пройдено: ${passed}</div></button>`;
  }).join('');
  $('#mStoryList').querySelectorAll('.mStory').forEach(b => b.onclick = () => { renderNights(CAT.stories[+b.dataset.i]); menuShow('mNights'); });
}
function renderNights(st) {
  const prog = getProgress();
  $('#mStoryTitle').textContent = st.title + (st.name ? '. ' + st.name : '');
  $('#mNightList').innerHTML = st.nights.map(n => {
    const p = prog[n.id], open = !!n.file;
    const status = !open ? '🔒 в разработке' : p && p.passed ? `✓ пройдено${p.at ? ', нашёл в ' + esc(p.at) : ''}` : 'играть';
    return `<button class="mNight" data-id="${esc(n.id)}" ${open ? '' : 'disabled'}><span>${esc(nightLabel(n, prog))}</span><span class="st ${p && p.passed ? 'ok' : ''}">${status}</span></button>`;
  }).join('');
  $('#mNightList').querySelectorAll('.mNight:not(:disabled)').forEach(b => b.onclick = () => openNight(b.dataset.id));
}
// звук меню: тихое шипение эфира (браузер разрешает звук только после нажатия)
let MENU_AUDIO = null;
function menuNoise() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
    const ctx = new AC(), len = ctx.sampleRate * 2, buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource(); src.buffer = buf; src.loop = true;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1800; bp.Q.value = 0.6;
    const g = ctx.createGain(); g.gain.value = 0; g.gain.linearRampToValueAtTime(0.035, ctx.currentTime + 1.5);
    src.connect(bp).connect(g).connect(ctx.destination); src.start();
    MENU_AUDIO = ctx;
  } catch (e) { MENU_AUDIO = null; }
}
function stopMenuNoise() { if (MENU_AUDIO) { try { MENU_AUDIO.close(); } catch (e) { /* уже закрыт */ } MENU_AUDIO = null; } }
function bindMenu() {
  $('#mPower').onclick = () => { if (!MENU_AUDIO) menuNoise(); $('.mLamp').classList.add('on'); renderStories(); menuShow('mStories'); };
  $('#mAboutBtn').onclick = () => menuShow('mAbout');
  document.querySelectorAll('input[data-noflash]').forEach(c => c.onchange = () => setNoFlash(c.checked));
  setNoFlash(NOFLASH);
  document.querySelectorAll('.mBack[data-back]').forEach(b => b.onclick = () => menuShow(b.dataset.back));
  // выход в меню посреди ночи: спросить, потому что ночь начнётся заново
  const leave = () => {
    if (S && !S.ended && $('#startScreen').hidden && !confirm('Выйти в меню? Эта ночь начнётся заново.')) return;
    goTo(null);
  };
  $('#toMenu').onclick = leave;
  // пауза: кнопка, клавиши Esc / P, и сама — когда игрок ушёл на другую вкладку или свернул окно
  $('#pauseBtn').onclick = () => { if (canPause()) setPause(true); };
  $('#pauseGo').onclick = () => setPause(false);
  $('#pauseMenu').onclick = leave;
  $('#pauseVol').innerHTML = volumeHTML(); bindVolume($('#pauseVol'));
  $('#briefVol').innerHTML = volumeHTML(); bindVolume($('#briefVol'));
  document.addEventListener('visibilitychange', () => { if (document.hidden && canPause()) setPause(true); });
  document.addEventListener('keydown', e => {
    if (!['Escape', 'p', 'P', 'з', 'З'].includes(e.key)) return;
    if (S && S.paused) { e.preventDefault(); setPause(false); }
    else if (canPause()) { e.preventDefault(); setPause(true); }
  });
  $('#briefBack').onclick =() => { if (LOADED) { const f = findNight(LOADED); if (f) renderNights(f.st); } menuShow('mNights'); };
}

async function openNight(id) {
  const f = findNight(id);
  if (!f || !f.n.file) { goTo(null); return; }
  if (LOADED && LOADED !== id) { goTo(id); return; }   // другая ночь — начисто, с перезагрузкой
  if (!LOADED) {
    try {
      const r = await fetch(f.n.file, { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      D = await r.json();
    } catch (e) {
      const el = $('#menuErr'); el.hidden = false;
      el.textContent = 'Не удалось загрузить ночь (' + e.message + ').';
      return;
    }
    LOADED = id;
    setupNight();
  }
  $('#briefTitle').textContent = `${f.st.title}. ${D.title}`;
  $('#briefIntro').textContent = f.st.intro || '';
  $('#menu').hidden = true; $('#startScreen').hidden = false;
  $('#startBtn').focus({ preventScroll: true });
}

async function boot() {
  bindMenu();
  try {
    const r = await fetch(CATALOG_URL, { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    CAT = await r.json();
  } catch (e) {
    const el = $('#menuErr'); el.hidden = false;
    el.textContent = 'Не удалось загрузить список историй (' + e.message + '). Игру нужно открывать через локальный сервер, а не двойным кликом по файлу.';
    $('#mPower').disabled = true; return;
  }
  try { const r = await fetch('audio/manifest.json', { cache: 'no-store' }); if (r.ok) VOICE = await r.json(); } catch (e) { VOICE = {}; }
  try { const r = await fetch('config.json', { cache: 'no-store' }); if (r.ok) CONFIG = await r.json(); } catch (e) { CONFIG = {}; }
  const want = QS.get('night');
  if (want && findNight(want) && findNight(want).n.file) { $('.mLamp').classList.add('on'); await openNight(want); }
  else menuShow('mWelcome');
}

function setupNight() {
  $('#title').textContent = D.title;
  if (TEST) $('#testNote').hidden = false;
  MW = (D.map.bounds.x[1] - D.map.bounds.x[0]) * K + PAD * 2;
  MH = (D.map.bounds.y[1] - D.map.bounds.y[0]) * K + PAD * 2;
  $('#map').setAttribute('viewBox', `0 0 ${MW} ${MH}`);
  buildRoom();
  initState(); bindUI(); renderBook(); render();
  $('#startBtn').onclick = async () => {
    const btn = $('#startBtn'); btn.disabled = true; $('#briefBack').hidden = true;
    stopMenuNoise();
    try { A = makeAudio(); if (A && A.ctx.state === 'suspended') await A.ctx.resume(); } catch (e) { A = null; }
    // полоска загрузки: звуки и голоса грузятся одновременно, считаем готовые файлы
    const sfxN = A && D.sounds ? Object.values(D.sounds).filter(s => s && s.file).length : 0;
    const voiceN = A ? Object.keys(VOICE).length : 0, total = sfxN + voiceN;
    let done = 0;
    const bar = $('#loadBar'), fill = $('#loadFill');
    const step = () => { done++; const p = Math.round(done / total * 100); fill.style.width = p + '%'; btn.textContent = `Загружаю звук… ${p}%`; };
    if (total) { bar.hidden = false; btn.textContent = 'Загружаю звук… 0%'; }
    await Promise.all([
      A && D.sounds ? A.loadSfx(D.sounds, step) : null,
      ...(A ? Object.entries(VOICE).map(async ([k, v]) => {
        try { const r = await fetch('audio/' + v.file); BUF[k] = await A.ctx.decodeAudioData(await r.arrayBuffer()); } catch (e) { /* без этой записи — только текст */ }
        step();
      }) : []),
    ]);
    $('#startScreen').hidden = true;
    setInterval(tick, TICK * 1000);
    requestAnimationFrame(fxFrame);
  };
}

/* ---------- эффекты: молния с громом, помехи на картинке, волна голоса, тревога по краям ---------- */
const REDUCED = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
// «Без вспышек»: своя галочка (по совету юриста) — у большинства системная «уменьшить движение» выключена
const NOFLASH_KEY = 'na-chastote-noflash';
let NOFLASH = false;
try { NOFLASH = localStorage.getItem(NOFLASH_KEY) === '1'; } catch (e) { /* по умолчанию вспышки есть */ }
function calm() { return REDUCED || NOFLASH; }
function setNoFlash(on) {
  NOFLASH = on;
  try { localStorage.setItem(NOFLASH_KEY, on ? '1' : '0'); } catch (e) { /* без сохранения */ }
  document.querySelectorAll('input[data-noflash]').forEach(c => { c.checked = on; });
  document.body.classList.toggle('calm', calm());
}
const FX = { nextFlash: 20 + Math.random() * 15, noise: 0, started: false };
// вызывается из tick(): идёт по времени игры, поэтому на паузе стоит
function fxTick() {
  if (S.real >= FX.nextFlash) {
    FX.nextFlash = S.real + 35 + Math.random() * 50;
    const far = Math.random();   // близко — вспышка ярче и гром сразу; далеко — тусклее и позже
    const fl = $('#fxFlash');
    if (!calm()) { fl.style.filter = `brightness(${1.1 - far * 0.6})`; fl.classList.remove('on'); void fl.offsetWidth; fl.classList.add('on'); }
    setTimeout(() => {
      if (!S || S.ended || S.paused) return;
      if (A && A.thunder) A.thunder(0.5 - far * 0.3, far);
      if (far < 0.4 && !calm()) { const r = $('#room'); r.classList.remove('jolt'); void r.getBoundingClientRect(); r.classList.add('jolt'); }
    }, 300 + far * 3500);
  }
  // тревога по краям экрана: батарея звонящего ниже половины или связь потеряна; ритм — как сердце в музыке
  const cl = caller(), dg = $('#fxDanger');
  let lvl = 0;
  if (cl && cl.connected && !cl.outcome) lvl = cl.lost ? 1 : Math.max(0, (50 - cl.battery) / 50);
  dg.style.opacity = (lvl * 0.9).toFixed(2);
  dg.classList.toggle('on', lvl > 0);
  if (lvl > 0) { const tens = tensionNow(); dg.style.setProperty('--beat', (60 / (55 + 70 * Math.max(0, tens - 0.5) * 2)).toFixed(2) + 's'); }
}
function fxStop() { $('#fxDanger').style.opacity = 0; $('#fxDanger').classList.remove('on'); }

// кадр анимации: осциллограф (плавно, 60 раз в секунду)
function fxFrame() {
  requestAnimationFrame(fxFrame);
  if (!S || S.paused) return;
  // волна на рации
  const sc = $('#scope'), g = sc.getContext('2d'), W = sc.width, H = sc.height;
  g.fillStyle = 'rgba(3,18,8,.55)'; g.fillRect(0, 0, W, H);   // след от прошлых кадров, как у старого экрана
  g.strokeStyle = 'rgba(80,200,110,.18)'; g.lineWidth = 1; g.beginPath(); g.moveTo(0, H / 2); g.lineTo(W, H / 2); g.stroke();
  if (A && A.scope && !S.ended) {
    const d = A.scope(), n = d.length;
    g.strokeStyle = '#6dff9a'; g.lineWidth = 2; g.shadowColor = '#3dff7a'; g.shadowBlur = 6; g.beginPath();
    for (let i = 0; i < n; i += 2) { const x = i / (n - 1) * W, y = H / 2 + (d[i] - 128) / 128 * H * 1.6; i ? g.lineTo(x, y) : g.moveTo(x, y); }
    g.stroke(); g.shadowBlur = 0;
  }
  // (рябь на картинке комнаты при настройке убрана по решению Димы 2026-11-16: комната — не экран, это нереалистично)
}

/* ---------- комната: фон нарисован нейросетью (img/room.jpg, img/door.jpg), поверх — живые детали ---------- */
// Координаты в пикселях картинки 1536×640: где шкала рации, лампочка, динамик, окна
const ROOM = {
  w: 1536, h: 640,
  dial: { x0: 524, x1: 722, y0: 252, y1: 372 },     // 140 МГц … 150 МГц
  led: { x: 818, y: 272, r: 30 },
  speaker: { x: 352, y: 250, w: 138, h: 105 },
  rain: [[140, 0, 460, 165], [915, 0, 190, 360], [1450, 0, 86, 330]],
};
function buildRoom() {
  const R = ROOM;
  $('#room').setAttribute('viewBox', `0 0 ${R.w} ${R.h}`);
  let h = '<defs><clipPath id="wclip">' + R.rain.map(([x, y, w, hh]) => `<rect x="${x}" y="${y}" width="${w}" height="${hh}"/>`).join('') + '</clipPath></defs>';
  h += `<image href="img/room.jpg" width="${R.w}" height="${R.h}"/>`;
  h += '<g class="rain" clip-path="url(#wclip)" stroke="#bfe6c8" stroke-width="1.5" opacity=".28">';
  for (let i = 0; i < 70; i++) { const x = (i * 97) % 1536, y = (i * 61) % 380; h += `<line x1="${x}" y1="${y}" x2="${x - 10}" y2="${y + 46}"/>`; }
  h += '</g>';
  const s = R.speaker;
  h += `<rect id="speakerGlow" x="${s.x}" y="${s.y}" width="${s.w}" height="${s.h}" rx="10" fill="#7dffa8" style="mix-blend-mode:screen;fill-opacity:.32"/>`;
  h += `<circle id="led" cx="${R.led.x}" cy="${R.led.y}" r="${R.led.r}" fill="#000" style="mix-blend-mode:screen" opacity=".7"/>`;
  h += `<line id="needleGlow" x1="0" y1="${R.dial.y0}" x2="0" y2="${R.dial.y1}" stroke="#ff5a3c" stroke-width="10" opacity=".25"/>`;
  h += `<line id="needle" x1="0" y1="${R.dial.y0}" x2="0" y2="${R.dial.y1}" stroke="#d8261b" stroke-width="4"/>`;
  h += `<image id="doorImg" href="img/door.jpg" width="${R.w}" height="${R.h}" opacity="0" style="transition:opacity .7s"/>`;
  $('#room').innerHTML = h;
}

function updateRoom() {
  const d = ROOM.dial, x = d.x0 + (S.f10 / 10 - 140) / 10 * (d.x1 - d.x0);
  for (const id of ['#needle', '#needleGlow']) { const n = $(id); n.setAttribute('x1', x); n.setAttribute('x2', x); }
  const q = activeSignals().reduce((m, s) => Math.max(m, quality(s.f10)), 0);
  $('#led').setAttribute('fill', q === 2 ? '#3dff7a' : q === 1 ? '#ffb43a' : '#000');
  const sp = S.speaking && S.real < S.speaking.until ? S.speaking : null;
  const morseOn = S.morseLive != null && quality(S.scenes.find(s => s.d.kind === 'morse').f10) > 0;
  $('#speakerGlow').classList.toggle('talk', !!(sp && (sp.where === 'radio' || sp.where === 'nina')) || morseOn);
  const door = S.scenes.find(s => s.d.kind === 'door' && s.status === 'running');
  $('#doorImg').setAttribute('opacity', door ? 1 : 0);
  const tag = $('#tag'); let t = 'Тишина в эфире', cls = '';
  const cl = caller();
  if (door) { t = 'У двери: ' + door.d.who; cls = 'door'; }
  else if (sp && sp.where === 'hero') { t = 'Ты говоришь в микрофон'; cls = 'radio'; }
  else if (sp) { t = (sp.where === 'nina' ? 'Служебный канал: ' : 'В эфире: ') + sp.who; cls = 'radio'; }
  else if (morseOn) { t = 'В эфире: морзянка, 144.0'; cls = 'radio'; }
  else if (cl && cl.status === 'active' && !cl.lost && !cl.outcome) { t = `На связи: ${cl.d.who} (${fmtF(cl.f10)}) — молчит, бережёт батарею`; cls = 'radio'; }
  else if (activeSignals().some(s => s.status === 'calling')) t = 'Кто-то вызывает… ищи частоту';
  tag.textContent = t; tag.className = cls;
}

boot();
