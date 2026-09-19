(function () {
  'use strict';

  // ---------------- состояние ----------------
  var TOKEN_KEY = 'messager_token';
  var BOT_ID = 1;
  var token = localStorage.getItem(TOKEN_KEY) || '';
  var me = null;
  var contacts = new Map();   // id -> contact объект
  var activeId = null;
  var ws = null;
  var typingTimers = {};      // contactId -> таймер сброса «печатает»
  var myTyping = false;
  var lastTypingSend = 0;
  var sendSeq = 0;            // для temp_id
  var reconnectTries = 0;
  var searchResults = [];   // люди из серверного поиска, которых ещё нет в контактах
  var searchPending = false;
  var searchTimer = null;
  var infoQueue = {};       // uid, для которых уже идёт подгрузка данных

  var $ = function (id) { return document.getElementById(id); };
  var isMobile = function () { return window.matchMedia('(max-width:760px)').matches; };

  // динамическая высота приложения: учитываем клавиатуру, адресную строку
  // и системные кнопки (Home/Назад/Недавние), которых не видно через 100vh
  function setAppHeight() {
    var h = window.visualViewport ? window.visualViewport.height : window.innerHeight;
    document.documentElement.style.setProperty('--apph', h + 'px');
  }
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', setAppHeight);
    window.visualViewport.addEventListener('scroll', setAppHeight);
  } else {
    window.addEventListener('resize', setAppHeight);
  }
  setAppHeight();

  // ---------------- утилиты ----------------
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function linkify(text) {
    var safe = esc(text);
    return safe.replace(/(https?:\/\/[^\s]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
  }
  function fmtTime(ts) {
    if (!ts) return '';
    var d = new Date(ts);
    var now = new Date();
    var hm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    var same = d.toDateString() === now.toDateString();
    if (same) return hm;
    var yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
    if (d.toDateString() === yesterday.toDateString()) return 'вчера';
    return String(d.getDate()).padStart(2, '0') + '.' + String(d.getMonth() + 1).padStart(2, '0');
  }
  function fmtDateTime(ts) {
    var d = new Date(ts);
    return String(d.getDate()).padStart(2, '0') + '.' + String(d.getMonth() + 1).padStart(2, '0')
      + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }
  function initials(u) {
    var n = (u.name || (u.username || '?')).trim();
    return n.charAt(0).toUpperCase();
  }
  function avatarColor(uid) {
    var pal = ['#33b6f7', '#5eb5f7', '#3aa76d', '#e5a03a', '#c4577a', '#7a6fe0', '#33a1a1', '#d98452'];
    return pal[uid % pal.length];
  }
  function avatarHTML(u, size) {
    return '<div class="avatar" style="background:linear-gradient(135deg,' + avatarColor(u.id) + ',#' +
      avatarColor(u.id + 3) + ')">' + esc(initials(u)) + '</div>';
  }
  function fullName(u) {
    return [u.name, u.surname].filter(Boolean).join(' ').trim() || (u.username || '—');
  }
  function toast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(t._h);
    t._h = setTimeout(function () { t.classList.add('hidden'); }, 3200);
  }
  var audioCtx = null;
  function beep() {
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      var ctx = audioCtx;
      if (ctx.state === 'suspended') ctx.resume();
      function tone(f, t, vol) {
        var o = ctx.createOscillator(), g = ctx.createGain();
        o.type = 'sine'; o.frequency.value = f;
        g.gain.setValueAtTime(vol || 0.15, ctx.currentTime + t);
        g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + t + 0.18);
        o.connect(g); g.connect(ctx.destination);
        o.start(t); o.stop(t + 0.2);
      }
      tone(880, 0, 0.14); tone(1180, 0.12, 0.10);
    } catch (e) { /* игнор */ }
  }
  function setTitle(unread) {
    document.title = unread > 0 ? '(' + unread + ') Мессенджер' : 'Мессенджер';
  }
  function totalUnread() {
    var s = 0;
    contacts.forEach(function (c) { s += (c.unread || 0); });
    return s;
  }

  // ---------------- АПИ ----------------
  function api(path, opts) {
    opts = opts || {};
    var headers = opts.headers || {};
    if (token) headers['X-Token'] = token;
    if (opts.body) headers['Content-Type'] = 'application/json';
    return fetch(path, { method: opts.method || 'GET', headers: headers, body: opts.body ? JSON.stringify(opts.body) : undefined })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          if (!r.ok) { var e = new Error(j.error || 'Ошибка сервера'); e.status = r.status; throw e; }
          return j;
        });
      });
  }

  // ---------------- ЭКРАНЫ ----------------
  function show(id) {
    ['login-view', 'setup-view', 'app-view'].forEach(function (v) {
      $(v).classList.toggle('hidden', v !== id);
    });
  }

  // ---------------- ВХОД / РЕГИСТРАЦИЯ ----------------
  function maskPhone(v) {
    var d = v.replace(/\D/g, '');
    if (d.length > 11) d = d.slice(0, 11);
    if (!d) return '';
    var country = d.slice(0, 1), code = d.slice(1, 4), a = d.slice(4, 7), b = d.slice(7, 9), c = d.slice(9, 11);
    var out = '+' + country;
    if (code) out += ' (' + code + ')';
    if (a) out += ' ' + a;
    if (b) out += '-' + b;
    if (c) out += '-' + c;
    return out;
  }

  function bindPhoneMask(el) {
    el.addEventListener('input', function () { this.value = maskPhone(this.value); });
  }
  bindPhoneMask($('phone-input'));
  bindPhoneMask($('reg-phone'));

  function finishAuth(j) {
    token = j.token;
    localStorage.setItem(TOKEN_KEY, token);
    me = j.user;
    if (!me.username || !me.name) enterSetup();
    else enterApp();
  }

  function showLogin() {
    $('step-login').classList.remove('hidden');
    $('step-register').classList.add('hidden');
    $('login-err').textContent = '';
  }
  function showRegister() {
    $('step-login').classList.add('hidden');
    $('step-register').classList.remove('hidden');
    $('reg-err').textContent = '';
  }
  $('go-register-btn').addEventListener('click', showRegister);
  $('go-login-btn').addEventListener('click', showLogin);

  function doLogin() {
    var digits = $('phone-input').value.replace(/\D/g, '');
    var pass = $('pass-input').value;
    if (digits.length < 5) { $('login-err').textContent = 'Проверьте номер телефона'; return; }
    if (!pass) { $('login-err').textContent = 'Введите пароль'; return; }
    $('login-err').textContent = '';
    var btn = $('login-btn');
    btn.disabled = true; btn.textContent = 'Входим…';
    api('/api/login', { method: 'POST', body: { phone: digits, password: pass } })
      .then(finishAuth)
      .catch(function (err) {
        btn.disabled = false; btn.textContent = 'Войти';
        $('login-err').textContent = err.message;
      });
  }
  $('login-btn').addEventListener('click', doLogin);
  $('phone-input').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('pass-input').focus(); });
  $('pass-input').addEventListener('keydown', function (e) { if (e.key === 'Enter') doLogin(); });

  function doRegister() {
    var digits = $('reg-phone').value.replace(/\D/g, '');
    var p1 = $('reg-pass').value, p2 = $('reg-pass2').value;
    if (digits.length < 5) { $('reg-err').textContent = 'Проверьте номер телефона'; return; }
    if (p1.length < 4) { $('reg-err').textContent = 'Пароль должен быть не короче 4 символов'; return; }
    if (p1 !== p2) { $('reg-err').textContent = 'Пароли не совпадают'; return; }
    $('reg-err').textContent = '';
    var btn = $('register-btn');
    btn.disabled = true; btn.textContent = 'Создаём…';
    api('/api/register', { method: 'POST', body: { phone: digits, password: p1 } })
      .then(finishAuth)
      .catch(function (err) {
        btn.disabled = false; btn.textContent = 'Создать аккаунт';
        $('reg-err').textContent = err.message;
      });
  }
  $('register-btn').addEventListener('click', doRegister);
  $('reg-phone').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('reg-pass').focus(); });
  $('reg-pass').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('reg-pass2').focus(); });
  $('reg-pass2').addEventListener('keydown', function (e) { if (e.key === 'Enter') doRegister(); });

  // ---------------- НАСТРОЙКИ ПРОФИЛЯ ----------------
  function enterSetup() {
    if (me) {
      $('set-name').value = me.name || '';
      $('set-surname').value = me.surname || '';
      $('set-username').value = me.username || '';
    }
    show('setup-view');
  }

  $('set-username').addEventListener('input', function () {
    var v = this.value.trim();
    var ok = /^[a-z0-9_]{4,32}$/.test(v);
    $('usr-check').textContent = v ? (ok ? 'Свободно и подходит' : '4–32 символа: латиница (a-z), цифры, _') : '';
    $('usr-check').style.color = v && ok ? 'var(--green)' : 'var(--text3)';
  });

  $('setup-save-btn').addEventListener('click', function () {
    var btn = $('setup-save-btn');
    btn.disabled = true;
    api('/api/profile', {
      method: 'POST',
      body: { name: $('set-name').value, surname: $('set-surname').value, username: $('set-username').value }
    })
      .then(function (j) {
        me = j.user;
        btn.disabled = false;
        enterApp();
      })
      .catch(function (err) {
        btn.disabled = false;
        $('setup-err').textContent = err.message;
      });
  });
  $('set-name').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('setup-save-btn').click(); });
  $('set-surname').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('setup-save-btn').click(); });
  $('set-username').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('setup-save-btn').click(); });

  // ---------------- ОСНОВНОЕ ПРИЛОЖЕНИЕ ----------------
  function enterApp() {
    show('app-view');
    $('my-name').textContent = fullName(me);
    $('my-uname').textContent = '@' + me.username;
    var av = $('my-avatar');
    av.textContent = initials(me);
    av.style.background = 'linear-gradient(135deg,' + avatarColor(me.id) + ',#6759c9)';
    renderContacts();
    connectWS();
  }

  // --- рендер списка контактов ---
  function renderContacts() {
    var wrap = $('contacts');
    wrap.innerHTML = '';
    var q = $('search-input').value.trim().toLowerCase();
    var list = Array.from(contacts.values());
    if (q) {
      list = list.filter(function (c) {
        return fullName(c).toLowerCase().includes(q) || ('@' + c.username).toLowerCase().includes(q);
      });
    }
    var extra = [];
    if (q) {
      searchResults.forEach(function (u) {
        if (!contacts.has(u.id)) extra.push(u);
      });
    }
    var tip = $('empty-contacts');
    if (list.length === 0 && extra.length === 0) {
      tip.classList.remove('hidden');
      if (!q) {
        tip.innerHTML = 'Пока нет чатов.<br>Найдите собеседника по полному @нику (например @ivan) — частичный ввод не покажет, чтобы ники нельзя было подбирать по буквам. Напишите ему, и чат появится здесь.';
      } else if (searchPending) {
        tip.textContent = 'Ищем…';
      } else {
        tip.innerHTML = 'Никого не нашли по запросу «' + esc(q) + '»';
      }
    } else {
      tip.classList.add('hidden');
    }
    list.forEach(function (c) { renderContactRow(wrap, c); });
    extra.forEach(function (u) { renderSearchRow(wrap, u); });
  }

  function renderContactRow(wrap, c) {
    var div = document.createElement('div');
    div.className = 'contact' + (c.id === activeId ? ' active' : '');
    div.setAttribute('data-id', c.id);
    var body = document.createElement('div');
    body.className = 'contact-body';
    var top = document.createElement('div');
    top.className = 'contact-top';
    var name = document.createElement('div');
    name.className = 'contact-name';
    name.textContent = fullName(c);
    var time = document.createElement('div');
    time.className = 'contact-time';
    time.textContent = fmtTime(c.last_at);
    top.appendChild(name); top.appendChild(time);
    var un = document.createElement('div');
    un.className = 'contact-uname';
    un.textContent = '@' + c.username;
    var bottom = document.createElement('div');
    bottom.className = 'contact-bottom';
    var prev = document.createElement('div');
    if (nowTyping(c.id)) {
      prev.className = 'contact-preview typing-preview';
      prev.textContent = 'печатает…';
    } else {
      prev.className = 'contact-preview' + (c.last_by === me.id ? ' me' : '');
      prev.textContent = (c.last_by === me.id ? 'Вы: ' : '') + (c.last_text || '');
    }
    bottom.appendChild(prev);
    if (c.unread > 0) {
      var b = document.createElement('div');
      b.className = 'badge';
      b.textContent = c.unread;
      bottom.appendChild(b);
    }
    body.appendChild(top); body.appendChild(un); body.appendChild(bottom);
    var st = document.createElement('div');
    st.className = 'avatar';
    st.style.background = 'linear-gradient(135deg,' + avatarColor(c.id) + ',#6759c9)';
    st.textContent = initials(c);
    if (c.online) {
      var dot = document.createElement('div');
      dot.className = 'online-dot';
      st.appendChild(dot);
    }
    div.appendChild(st); div.appendChild(body);
    div.addEventListener('click', function () { openChat(c.id); });
    wrap.appendChild(div);
  }

  function renderSearchRow(wrap, u) {
    var div = document.createElement('div');
    div.className = 'contact found-row';
    div.setAttribute('data-id', u.id);
    var st = document.createElement('div');
    st.className = 'avatar';
    st.style.background = 'linear-gradient(135deg,' + avatarColor(u.id) + ',#6759c9)';
    st.textContent = initials(u);
    div.appendChild(st);
    var body = document.createElement('div');
    body.className = 'contact-body';
    var top = document.createElement('div');
    top.className = 'contact-top';
    var name = document.createElement('div');
    name.className = 'contact-name';
    name.textContent = fullName(u);
    top.appendChild(name);
    var ch = document.createElement('div');
    ch.className = 'contact-time found-badge';
    ch.textContent = u.has_history ? 'переписка есть' : 'не в контактах';
    top.appendChild(ch);
    var un = document.createElement('div');
    un.className = 'contact-uname';
    un.textContent = '@' + u.username + (u.online ? ' · в сети' : ' · не в сети');
    body.appendChild(top); body.appendChild(un);
    div.appendChild(st); div.appendChild(body);
    div.addEventListener('click', function () { openSearched(u); });
    wrap.appendChild(div);
  }

  // открыть чат с человеком, найденным через поиск
  function openSearched(u) {
    if (!contacts.has(u.id)) {
      contacts.set(u.id, {
        id: u.id, phone: u.phone || '', name: u.name || '', surname: u.surname || '',
        username: u.username || '', online: !!u.online,
        last_text: '', last_by: null, last_at: null, unread: 0
      });
    }
    openChat(u.id);
  }

  function nowTyping(id) {
    return typingTimers[id] === true;
  }

  function setTyping(id, active) {
    if (active) typingTimers[id] = true;
    else { typingTimers[id] = false; }
    renderContacts();
    if (id === activeId) updateChatStatus();
  }

  // --- открытие чата ---
  function openChat(id, msgs) {
    activeId = id;
    hideChatMenu();
    $('app-view').classList.add('mobile-chat');
    $('chat-empty').classList.add('hidden');
    $('chat-active').classList.remove('hidden');
    var c = contacts.get(id);
    if (c && c.unread) { c.unread = 0; setTitle(totalUnread()); }
    renderContacts();
    updateChatHeader();
    loadHistory(id, msgs);
    markRead(id);
    $('msg-input').focus();
  }

  function updateChatHeader() {
    if (activeId == null) return;
    var c = contacts.get(activeId) || { id: activeId, name: '', username: '', online: false };
    $('chat-avatar').textContent = initials(c);
    $('chat-avatar').style.background = 'linear-gradient(135deg,' + avatarColor(c.id) + ',#6759c9)';
    $('chat-name').textContent = activeId === BOT_ID ? 'Мессенджер' : fullName(c);
    updateChatStatus();
  }

  function updateChatStatus() {
    var el = $('chat-status');
    if (activeId == null) return;
    if (nowTyping(activeId)) {
      el.textContent = 'печатает…';
      el.className = 'chat-status typing';
      return;
    }
    var c = contacts.get(activeId);
    var online = c ? c.online : false;
    var isBot = activeId === BOT_ID;
    if (isBot) { el.textContent = 'бот'; el.className = 'chat-status'; }
    else if (online) { el.textContent = 'в сети'; el.className = 'chat-status online'; }
    else { el.textContent = 'не в сети'; el.className = 'chat-status'; }
  }

  function loadHistory(id, firstMsgs) {
    var box = $('messages');
    box.innerHTML = '';
    lastMsgTs = null;
    if (firstMsgs && firstMsgs.length) {
      firstMsgs.forEach(function (m) { renderMsg(m); return true; });
      box.scrollTop = box.scrollHeight;
      return;
    }
    api('/api/history?with=' + id).then(function (j) {
      j.messages.forEach(function (m) { renderMsg(m); });
      box.scrollTop = box.scrollHeight;
    }).catch(function () {});
  }

  var pendingMsgs = {}; // по id для аck
  var lastMsgTs = null;

  function renderMsg(m) {
    var box = $('messages');
    var mine = m.from === me.id;
    // разделитель даты
    var curDate = new Date(m.created_at);
    if (!lastMsgTs || new Date(lastMsgTs).toDateString() !== curDate.toDateString()) {
      var dd = document.createElement('div');
      dd.className = 'date-divider';
      dd.textContent = fmtDateTime(m.created_at);
      box.appendChild(dd);
    }
    lastMsgTs = m.created_at;
    var row = document.createElement('div');
    row.className = 'msg-row ' + (mine ? 'out' : 'in');
    var msg = document.createElement('div');
    msg.className = 'msg ' + (mine ? 'out' : 'in');
    if (m.temp_id != null) msg.setAttribute('data-temp', m.temp_id);
    msg.setAttribute('data-id', 'm' + m.id);
    msg.setAttribute('data-ts', m.created_at);
    msg.setAttribute('data-read', m.read ? '1' : '0');
    var bubble = document.createElement('div');
    bubble.className = 'bubble';
    if (m.image) {
      var mm = m.image_mime || 'application/octet-stream';
      if (mm.indexOf('image/') === 0) {
        var ph = document.createElement('div');
        ph.className = 'msg-photo';
        var im = document.createElement('img');
        im.src = 'data:' + mm + ';base64,' + m.image;
        im.alt = 'Фото';
        im.addEventListener('click', function () { openLightbox(m.image, mm, m.image_name); });
        ph.appendChild(im);
        bubble.appendChild(ph);
      } else if (mm.indexOf('video/') === 0) {
        var pw = document.createElement('div');
        pw.className = 'msg-video';
        var vid = document.createElement('video');
        vid.controls = true;
        vid.preload = 'metadata';
        vid.src = 'data:' + mm + ';base64,' + m.image;
        vid.addEventListener('click', function (ev) { ev.stopPropagation(); openLightbox(m.image, mm, m.image_name); });
        pw.appendChild(vid);
        bubble.appendChild(pw);
      } else {
        var pf = document.createElement('div');
        pf.className = 'msg-file';
        var ic = document.createElement('div');
        ic.className = 'mf-icon';
        ic.textContent = '\u{1F4C4}';
        var md = document.createElement('div');
        md.className = 'mf-meta';
        var mn = document.createElement('div');
        mn.className = 'mf-name';
        mn.textContent = m.image_name || ('Файл' + fileExtFor(mm));
        var msz = document.createElement('div');
        msz.className = 'mf-size';
        msz.textContent = fmtSize(m.image.length * 3 / 4);
        md.appendChild(mn); md.appendChild(msz);
        var dl = document.createElement('button');
        dl.className = 'mf-dl';
        dl.textContent = '\u{2B07}';
        dl.title = 'Скачать';
        dl.addEventListener('click', function (ev) {
          ev.stopPropagation();
          downloadDataUrl('data:' + mm + ';base64,' + m.image,
                          m.image_name || ('file' + fileExtFor(mm)));
        });
        pf.appendChild(ic); pf.appendChild(md); pf.appendChild(dl);
        pf.addEventListener('click', function () { openLightbox(m.image, mm, m.image_name); });
        bubble.appendChild(pf);
      }
    }
    if (m.text) {
      var txt = document.createElement('div');
      txt.className = 'msg-text';
      txt.innerHTML = linkify(m.text);
      bubble.appendChild(txt);
    }
    var meta = document.createElement('div');
    meta.className = 'msg-meta';
    var tm = document.createElement('span');
    tm.className = 'msg-time';
    tm.textContent = fmtTime(m.created_at);
    meta.appendChild(tm);
    if (mine) {
      var ch = document.createElement('span');
      ch.className = 'checks' + (m.read ? ' readed' : '');
      ch.textContent = '\u2713\u2713';
      meta.appendChild(ch);
    }
    bubble.appendChild(meta);
    msg.appendChild(bubble);
    row.appendChild(msg);
    box.appendChild(row);
    if (mine) pendingMsgs[m.id] = msg;
  }

  function markRead(id) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'read', to: id }));
  }

  // --- отправка и вложения ---
  var attachB64 = null;
  var attachMime = null;
  var attachName = null;

  function attachLabel(m) {
    var mm = (m.image_mime || '');
    if (mm.indexOf('video/') === 0) return '🎬 Видео';
    if (mm.indexOf('audio/') === 0) return '🎵 Аудио';
    if (mm.indexOf('image/') === 0) return '📷 Фото';
    return '📄 Файл';
  }

  function fileExtFor(mime) {
    mime = (mime || '').toLowerCase();
    var sub = (mime.split('/')[1] || 'bin').replace('x-', '');
    if (sub === 'jpeg' || sub === 'jpg') return '.jpg';
    if (sub === 'svg+xml') return '.svg';
    if (sub === 'plain') return '.txt';
    if (sub === 'octet-stream') return '.bin';
    return '.' + sub;
  }

  function imgExtFor(mime) {
    mime = (mime || '').toLowerCase();
    if (mime.indexOf('png') >= 0) return '.png';
    if (mime.indexOf('webp') >= 0) return '.webp';
    if (mime.indexOf('gif') >= 0) return '.gif';
    return '.jpg';
  }

  function fmtSize(n) {
    n = Number(n);
    if (!isFinite(n) || n <= 0) return '';
    if (n < 1024) return n + ' Б';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' КБ';
    return (n / 1048576).toFixed(1) + ' МБ';
  }

  function dataUrlFor(mime, b64) { return 'data:' + (mime || 'application/octet-stream') + ';base64,' + b64; }

  function downloadDataUrl(src, name) {
    var a = document.createElement('a');
    a.href = src;
    a.download = name || 'file_' + Date.now();
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  // --- просмотр вложения на весь экран ---
  var lbSrc = '';
  var lbName = '';
  function openLightbox(b64, mime, name) {
    var mm = mime || 'application/octet-stream';
    lbSrc = dataUrlFor(mm, b64);
    lbName = name || 'photo_' + Date.now() + imgExtFor(mm);
    var img = $('lb-img'), vid = $('lb-video'), fbox = $('lb-file');
    img.classList.add('hidden'); vid.classList.add('hidden'); fbox.classList.add('hidden');
    if (mm.indexOf('image/') === 0) {
      img.src = lbSrc;
      img.classList.remove('hidden');
    } else if (mm.indexOf('video/') === 0) {
      vid.src = lbSrc;
      vid.classList.remove('hidden');
    } else {
      $('lb-file-name').textContent = lbName;
      $('lb-file-size').textContent = fmtSize(b64.length * 3 / 4);
      fbox.classList.remove('hidden');
    }
    $('lightbox').classList.remove('hidden');
  }
  function closeLightbox() {
    $('lightbox').classList.add('hidden');
    $('lb-img').src = '';
    var vid = $('lb-video');
    vid.removeAttribute('src');
    try { vid.load(); } catch (e) {}
    lbSrc = ''; lbName = '';
  }
  $('lb-close').addEventListener('click', closeLightbox);
  $('lb-backdrop').addEventListener('click', closeLightbox);
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    closeLightbox();
    closeAttachPanel();
  });
  $('lb-download').addEventListener('click', function () {
    if (!lbSrc) return;
    downloadDataUrl(lbSrc, lbName);
  });

  function sendCurrent() {
    var inp = $('msg-input');
    var text = inp.value.replace(/\s+$/, '');
    if ((!text && !attachB64) || activeId == null) return;
    var temp_id = 't' + (++sendSeq);
    var now = Date.now();
    renderMsg({ id: temp_id, from: me.id, to: activeId, text: text, created_at: now, read: false,
                temp_id: temp_id, image: attachB64, image_mime: attachMime, image_name: attachName });
    $('messages').scrollTop = $('messages').scrollHeight;
    inp.value = '';
    autoGrow();
    stopTyping();
    if (ws && ws.readyState === 1) {
      var out = { type: 'msg', to: activeId, text: text, temp_id: temp_id };
      if (attachB64) { out.image = attachB64; out.image_mime = attachMime; out.image_name = attachName || ''; }
      ws.send(JSON.stringify(out));
    } else {
      toast('Нет соединения с сервером');
    }
    clearAttach();
  }

  // --- выбор вложения (фото/видео/файл) ---
  var FILE_LIMIT = 50 * 1024 * 1024;

  function fileToJpeg(file, cb) {
    var fr = new FileReader();
    fr.onerror = function () { cb(null); };
    fr.onload = function () {
      var img = new Image();
      img.onerror = function () { cb(null); };
      img.onload = function () {
        var w = img.width, h = img.height;
        if (!w || !h) { cb(null); return; }
        var MAX = 1600;
        var sc = Math.min(1, MAX / Math.max(w, h));
        var c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(w * sc));
        c.height = Math.max(1, Math.round(h * sc));
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        var url = c.toDataURL('image/jpeg', 0.82);
        cb({ url: url, mime: 'image/jpeg', b64: url.split(',')[1], name: file.name || '' });
      };
      img.src = fr.result;
    };
    fr.readAsDataURL(file);
  }

  var MEDIA_EXT = /\.(jpe?g|png|webp|gif|bmp|heic|heif|mp4|webm|mov|mkv|avi|m4v)$/i;
  var IDB_NAME = 'msg-gallery-db';
  var galleryHandle = null;
  var apUrls = [];

  function openGalleryPanel() {
    if (!window.showDirectoryPicker) { pickFromGalleryDialog(); return; }
    showAttachPanelLoading();
    idbLoadGalleryHandle(function (h) {
      if (h) {
        galleryHandle = h;
        requestGalleryPermission(h);
        return;
      }
      window.showDirectoryPicker({ id: 'msg-gallery', mode: 'read', startIn: 'pictures' })
        .then(function (dir) {
          galleryHandle = dir;
          idbSaveGalleryHandle(dir);
          requestGalleryPermission(dir);
        })
        .catch(function (e) {
          if (e && e.name === 'AbortError') closeAttachPanel(); else pickFromGalleryDialog();
        });
    });
  }

  function requestGalleryPermission(dir) {
    var q = dir.queryPermission ? dir.queryPermission({ mode: 'read' }) : Promise.resolve('granted');
    q.then(function (st) {
      if (st === 'granted') { enumerateGallery(dir); return; }
      if (dir.requestPermission) {
        dir.requestPermission({ mode: 'read' }).then(function (s2) {
          if (s2 === 'granted') enumerateGallery(dir); else closeAttachPanel();
        }).catch(closeAttachPanel);
      } else closeAttachPanel();
    }).catch(closeAttachPanel);
  }

  var scannedCount = 0;
  function enumerateGallery(dir) {
    $('attach-panel').classList.remove('hidden');
    clearApGrid();
    scannedCount = 0;
    scanDir(dir, 0);
  }

  function scanDir(dir, depth) {
    var it;
    try { it = dir.values(); } catch (e) { finishScan(); return; }
    var next = function (p) {
      if (!p || p.done) { finishScan(); return; }
      var entry = p.value;
      if (scannedCount >= 400) { finishScan(); return; }
      if (entry.kind === 'file' && MEDIA_EXT.test(entry.name)) {
        scannedCount++;
        queueFileCell(entry);
      } else if (entry.kind === 'directory' && depth < 2) {
        scanDir(entry, depth + 1);
      }
      Promise.resolve(it.next()).then(next).catch(finishScan);
    };
    Promise.resolve(it.next()).then(next).catch(finishScan);
  }

  function finishScan() {
    if (scannedCount === 0 && !$('ap-grid').querySelector('.ap-thumb')) {
      $('ap-grid').innerHTML = '<div class="ap-loading">Галерея пуста — используйте «Отправить файл»</div>';
    }
  }

  function queueFileCell(handle) {
    handle.getFile().then(function (file) {
      var url = URL.createObjectURL(file);
      apUrls.push(url);
      var div = document.createElement('button');
      div.type = 'button';
      div.className = 'ap-thumb';
      var isVideo = (file.type || '').indexOf('video/') === 0;
      if (isVideo) {
        var v = document.createElement('video');
        v.muted = true; v.playsInline = true; v.preload = 'metadata'; v.src = url;
        var tag = document.createElement('span');
        tag.className = 'vidtag';
        tag.textContent = 'video';
        div.appendChild(v); div.appendChild(tag);
      } else {
        var im = document.createElement('img');
        im.src = url; im.alt = ''; im.loading = 'lazy';
        div.appendChild(im);
      }
      div.title = handle.name;
      div.addEventListener('click', function (ev) {
        ev.stopPropagation();
        var t = div;
        Array.prototype.forEach.call($('ap-grid').querySelectorAll('.ap-thumb.sel'), function (o) { o.classList.remove('sel'); });
        t.classList.add('sel');
        handle.getFile().then(function (f) {
          closeAttachPanel();
          handlePicked(f);
        });
      });
      $('ap-grid').appendChild(div);
    }).catch(function () {});
  }

  function showAttachPanelLoading() {
    $('attach-panel').classList.remove('hidden');
    $('ap-grid').innerHTML = '<div class="ap-loading">Загружаем галерею…</div>';
  }

  function clearApGrid() {
    apUrls.forEach(function (u) { try { URL.revokeObjectURL(u); } catch (e) {} });
    apUrls = [];
    $('ap-grid').innerHTML = '';
  }

  function closeAttachPanel() {
    $('attach-panel').classList.add('hidden');
    clearApGrid();
  }

  function idbSaveGalleryHandle(handle) {
    try {
      var req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = function () { req.result.createObjectStore('kv'); };
      req.onsuccess = function () {
        try {
          var db = req.result;
          var tx = db.transaction('kv', 'readwrite');
          tx.objectStore('kv').put(handle, 'gallery');
          tx.oncomplete = function () { db.close(); };
          tx.onerror = function () { db.close(); };
          tx.onabort = function () { db.close(); };
        } catch (e) {}
      };
      req.onerror = function () {};
    } catch (e) {}
  }

  function idbLoadGalleryHandle(cb) {
    try {
      var req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = function () { req.result.createObjectStore('kv'); };
      req.onsuccess = function () {
        var db = req.result;
        var tx = db.transaction('kv', 'readonly');
        var g = tx.objectStore('kv').get('gallery');
        g.onsuccess = function () { db.close(); cb(g.result || null); };
        g.onerror = function () { db.close(); cb(null); };
      };
      req.onerror = function () { cb(null); };
    } catch (e) { cb(null); }
  }

  function pickFromGalleryDialog() {
    closeAttachPanel();
    if (window.showOpenFilePicker) {
      window.showOpenFilePicker({ multiple: false, types: [{
        description: 'Галерея',
        accept: {
          'image/*': ['.jpg', '.jpeg', '.png', '.webp', '.gif'],
          'video/*': ['.mp4', '.webm', '.mov', '.mkv', '.avi']
        }
      }] })
        .then(function (handles) {
          if (handles && handles[0]) handles[0].getFile().then(function (f) { handlePicked(f); });
        })
        .catch(function (e) { if (!e || e.name !== 'AbortError') fallbackGalleryInput(); });
      return;
    }
    fallbackGalleryInput();
  }

  function fallbackGalleryInput() {
    var inp = $('file-input');
    inp.accept = 'image/*,video/*';
    inp.value = '';
    inp.click();
  }

  function pickAnyFile() {
    closeAttachPanel();
    if (window.showOpenFilePicker) {
      window.showOpenFilePicker({ multiple: false })
        .then(function (handles) {
          if (handles && handles[0]) handles[0].getFile().then(function (f) { handlePicked(f); });
        })
        .catch(function (e) { if (!e || e.name !== 'AbortError') fallbackAnyFileInput(); });
      return;
    }
    fallbackAnyFileInput();
  }

  function fallbackAnyFileInput() {
    var inp = $('file-input');
    inp.accept = '*/*';
    inp.value = '';
    inp.click();
  }

  function handlePicked(file) {
    if (!file) return;
    if (file.size > FILE_LIMIT) { toast('Файл больше 50 МБ'); return; }
    var mime = (file.type || '').toLowerCase() || 'application/octet-stream';
    if (mime.indexOf('image/') !== 0) {
      var fr = new FileReader();
      fr.onerror = function () { toast('Не удалось прочитать файл'); };
      fr.onload = function () {
        var url = String(fr.result);
        var b64 = url.indexOf('base64,') >= 0 ? url.split('base64,', 2)[1] : '';
        if (!b64) { toast('Не удалось прочитать файл'); return; }
        attachB64 = b64;
        attachMime = mime;
        attachName = file.name || '';
        showAttachPreview({ url: url, mime: mime, b64: b64, name: attachName });
      };
      fr.readAsDataURL(file);
      return;
    }
    fileToJpeg(file, function (res) {
      if (!res) { toast('Не удалось обработать фото'); return; }
      attachB64 = res.b64;
      attachMime = res.mime;
      attachName = res.name;
      showAttachPreview(res);
    });
  }

  function showAttachPreview(res) {
    var p = $('attach-preview');
    p.innerHTML = '';
    var mime = res.mime || '';
    var thumb = document.createElement('div');
    thumb.className = 'ap-item';
    if (mime.indexOf('image/') === 0) {
      var im = document.createElement('img');
      im.src = res.url;
      thumb.appendChild(im);
    } else if (mime.indexOf('video/') === 0) {
      var vd = document.createElement('video');
      vd.muted = true;
      vd.preload = 'metadata';
      vd.src = res.url;
      vd.addEventListener('loadedmetadata', function () { try { vd.currentTime = 0.1; } catch (e) {} });
      thumb.appendChild(vd);
    } else {
      thumb.classList.add('ap-ico');
      thumb.textContent = '\u{1F4C4}';
    }
    var meta = document.createElement('div');
    meta.className = 'ap-meta';
    var nm = document.createElement('div');
    nm.className = 'ap-name';
    nm.textContent = res.name || 'Вложение прикреплено';
    var sub = document.createElement('div');
    sub.className = 'ap-sub';
    sub.textContent = 'Подпись — в поле сообщения';
    meta.appendChild(nm); meta.appendChild(sub);
    var x = document.createElement('button');
    x.className = 'ap-x';
    x.textContent = '\u2715';
    x.title = 'Убрать вложение';
    x.addEventListener('click', clearAttach);
    p.appendChild(thumb); p.appendChild(meta); p.appendChild(x);
    p.classList.remove('hidden');
    $('msg-input').focus();
  }

  function clearAttach() {
    attachB64 = null;
    attachMime = null;
    attachName = null;
    var p = $('attach-preview');
    p.classList.add('hidden');
    p.innerHTML = '';
  }

  $('attach-btn').addEventListener('click', openGalleryPanel);
  $('ap-close').addEventListener('click', closeAttachPanel);
  $('ap-refresh').addEventListener('click', function () {
    if (galleryHandle) { showAttachPanelLoading(); requestGalleryPermission(galleryHandle); }
    else openGalleryPanel();
  });
  $('ap-file').addEventListener('click', pickAnyFile);
  $('file-input').addEventListener('change', function () {
    var f = this.files && this.files[0];
    this.value = '';
    handlePicked(f);
  });

  $('send-btn').addEventListener('click', sendCurrent);
  $('msg-input').addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendCurrent(); }
  });
  $('msg-input').addEventListener('input', function () {
    autoGrow();
    sendTyping();
  });
  function autoGrow() {
    var inp = $('msg-input');
    inp.style.height = 'auto';
    inp.style.height = Math.min(inp.scrollHeight, 140) + 'px';
  }
  function sendTyping() {
    var now = Date.now();
    if (now - lastTypingSend < 2500) return;
    lastTypingSend = now;
    if (ws && ws.readyState === 1 && activeId != null) {
      ws.send(JSON.stringify({ type: 'typing', to: activeId, is_typing: true }));
    }
    myTyping = true;
    clearTimeout(sendTyping._t);
    sendTyping._t = setTimeout(stopTyping, 3000);
  }
  function stopTyping() {
    if (!myTyping) return;
    myTyping = false;
    if (ws && ws.readyState === 1 && activeId != null) {
      ws.send(JSON.stringify({ type: 'typing', to: activeId, is_typing: false }));
    }
  }

  // --- эмодзи ---
  var EMOJI = ['😀','😄','😂','🤣','😊','😍','🥰','😘','😉','😎','🤔','😅','🙂','😉','🤩','🥳','😢','😭','😡','😴','🤗','🤝','👍','👎','👌','🙏','👏','💪','🤞','🧠','❤️','💙','💚','💜','🔥','✨','⭐','🌟','💯','🎉','🎊','🚀','🎁','☀️','🌙','⛅','💧','🍕','🍔','🍰','☕','🍺','⚽','🎮','🎵','📱','💬','📷','🔒','😇'];
  var emojiVisible = false;
  $('emoji-btn').addEventListener('click', function (e) {
    e.stopPropagation();
    toggleEmoji();
  });
  function toggleEmoji() {
    var p = $('emoji-panel');
    if (!p.childNodes.length) {
      EMOJI.forEach(function (e) {
        var s = document.createElement('span');
        s.textContent = e;
        s.addEventListener('click', function () {
          var inp = $('msg-input');
          inp.value += e;
          inp.focus();
          autoGrow();
          sendTyping();
          toggleEmoji();
        });
        p.appendChild(s);
      });
    }
    emojiVisible = !emojiVisible;
    p.classList.toggle('hidden', !emojiVisible);
  }
  document.addEventListener('click', function () {
    if (emojiVisible) { emojiVisible = false; $('emoji-panel').classList.add('hidden'); }
  });

  // --- поиск ---
  $('search-input').addEventListener('input', function () {
    searchResults = [];
    searchPending = false;
    renderContacts();
    clearTimeout(searchTimer);
    var q0 = this.value.trim();
    if (!q0) return;
    searchPending = true;
    renderContacts();
    searchTimer = setTimeout(function () { runSearch(q0); }, 250);
  });
  function runSearch(q) {
    api('/api/search?q=' + encodeURIComponent(q))
      .then(function (j) {
        if (q !== $('search-input').value.trim()) return;
        searchPending = false;
        searchResults = j.users || [];
        renderContacts();
      })
      .catch(function () { searchPending = false; renderContacts(); });
  }

  // --- настройки ---
  $('settings-btn').addEventListener('click', enterSetup);

  // --- выход из аккаунта ---
  function doLogout() {
    api('/api/logout', { method: 'POST' }).catch(function () {});
    try { if (ws) ws.close(); } catch (e) {}
    localStorage.removeItem(TOKEN_KEY);
    token = '';
    me = null;
    contacts = new Map();
    searchResults = [];
    activeId = null;
    $('app-view').classList.remove('mobile-chat');
    $('chat-active').classList.add('hidden');
    $('chat-empty').classList.remove('hidden');
    $('messages').innerHTML = '';
    $('search-input').value = '';
    hideChatMenu();
    clearAttach();
    closeLightbox();
    show('login-view');
    $('pass-input').value = '';
    $('reg-pass').value = '';
  }
  $('logout-btn').addEventListener('click', doLogout);
  $('setup-exit-btn').addEventListener('click', doLogout);

  // --- меню чата ---
  function hideChatMenu() { $('chat-menu').classList.add('hidden'); }
  $('more-btn').addEventListener('click', function (e) {
    e.stopPropagation();
    $('chat-menu').classList.toggle('hidden');
  });
  $('chat-menu').addEventListener('click', function (e) { e.stopPropagation(); });
  document.addEventListener('click', function () {
    if (!$('chat-menu').classList.contains('hidden')) hideChatMenu();
  });

  $('delete-chat-btn').addEventListener('click', function () {
    var id = activeId;
    hideChatMenu();
    if (id == null || id === BOT_ID) { toast('Этот чат удалить нельзя'); return; }
    if (!window.confirm('Удалить чат? Он исчезнет из вашего списка (у собеседника история останется).')) return;
    api('/api/chat/delete', { method: 'POST', body: { with: id } })
      .then(function () {
        contacts.delete(id);
        delete typingTimers[id];
        activeId = null;
        $('messages').innerHTML = '';
        lastMsgTs = null;
        $('chat-active').classList.add('hidden');
        $('chat-empty').classList.remove('hidden');
        $('app-view').classList.remove('mobile-chat');
        hideChatMenu();
        renderContacts();
        setTitle(totalUnread());
        toast('Чат удалён');
      })
      .catch(function (e) { toast(e.message); });
  });

  // --- мобильная кнопка «назад» (список чатов) ---
  $('back-btn').addEventListener('click', function () {
    $('app-view').classList.remove('mobile-chat');
  });

  // --- установка сайта как приложения ---
  var installPrompt = null;
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    installPrompt = e;
    $('install-btn').classList.remove('hidden');
  });
  $('install-btn').addEventListener('click', function () {
    if (!installPrompt) return;
    installPrompt.prompt();
    installPrompt.userChoice.then(function () {
      installPrompt = null;
      $('install-btn').classList.add('hidden');
    });
  });
  window.addEventListener('appinstalled', function () {
    $('install-btn').classList.add('hidden');
  });

  // --- service worker (доступность и установка) ---
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('/sw.js').catch(function () {});
    });
  }

  // --- чат аватар -> в профиль друга (показываем ник) ---
  $('chat-name').addEventListener('click', function () {
    var c = contacts.get(activeId);
    if (c) toast('@' + c.username + (c.online ? ' · в сети' : ' · не в сети'));
  });

  // ---------------- WebSocket ----------------
  function connectWS() {
    if (!token) return;
    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    var url = proto + '//' + location.host + '/ws?token=' + encodeURIComponent(token);
    try { ws = new WebSocket(url); } catch (e) { }
    if (!ws) { retryWS(); return; }
    ws.onopen = function () {
      reconnectTries = 0;
      if (activeId != null) markRead(activeId);
    };
    ws.onmessage = function (ev) {
      var m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      handleWS(m);
    };
    ws.onclose = function () { retryWS(); };
    ws.onerror = function () { try { ws.close(); } catch (e) {} };
  }
  function retryWS() {
    reconnectTries++;
    var delay = Math.min(3000 + reconnectTries * 1500, 15000);
    setTimeout(connectWS, delay);
  }

  function handleWS(m) {
    var box = $('messages');
    switch (m.type) {
      case 'auth_ok':
        break;
      case 'msg':
        var chatId = (m.from === me.id) ? m.to : m.from;
        var isActive = (chatId === activeId);
        if (m.from === me.id) { // наше сообщение, отправленное с другого устройства
          var ref = box.querySelector('[data-id="m' + m.id + '"]');
          if (ref) ref.remove();
        }
        if (isActive) {
          renderMsg(m);
          var nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
          if (nearBottom) box.scrollTop = box.scrollHeight;
        }
        touchContact(chatId, m.image ? attachLabel(m) : m.text, m.created_at, m.from !== me.id);
        if (m.from !== me.id && !isActive) {
          beep();
          var who = contacts.get(m.from);
          if (document.hidden && who) toast(fullName(who) + ': ' + (m.image ? attachLabel(m) : m.text.slice(0, 40)));
        } else if (m.from !== me.id && isActive) {
          markRead(activeId);
        }
        if (m.from === BOT_ID && !isActive) beep();
        break;
      case 'sent':
        var temp = $('messages').querySelector('[data-temp="' + m.temp_id + '"]');
        if (temp) {
          temp.removeAttribute('data-temp');
          temp.setAttribute('data-id', 'm' + m.id);
          pendingMsgs[m.id] = temp;
          updateMsgReadState(temp, false);
        }
        break;
      case 'read':
        if (m.user_id && m.user_id === activeId) {
          // собеседник прочитал наш чат — отмечаем свои сообщения
          box.querySelectorAll('.msg.out').forEach(function (el) {
            updateMsgReadState(el, true);
          });
        }
        break;
      case 'presence':
        var c = contacts.get(m.user_id);
        if (c) {
          c.online = m.online;
          if (m.user_id !== activeId) renderContacts();
          if (m.user_id === activeId) updateChatStatus();
        }
        break;
      case 'typing':
        if (m.from !== activeId && m.from !== me.id) {
          if (m.is_typing) setTyping(m.from, true);
          else setTyping(m.from, false);
        } else if (m.from === activeId) {
          if (m.is_typing) {
            typingTimers[m.from] = true;
            clearTimeout(typingTimers[m.from + '_t']);
            typingTimers[m.from + '_t'] = setTimeout(function () { setTyping(m.from, false); }, 4000);
            updateChatStatus();
            renderContacts();
          } else {
            setTyping(m.from, false);
          }
        }
        break;
      case 'err':
        toast(m.error || 'Ошибка');
        break;
    }
  }

  function updateMsgReadState(el, readed) {
    var ch = el.querySelector('.checks');
    if (ch) {
      ch.classList.toggle('readed', !!readed);
      el.setAttribute('data-read', readed ? '1' : '0');
    }
  }

  // обновить контакт при новом сообщении (сдвинуть наверх)
  function touchContact(uid, text, at, incUnread) {
    var c = contacts.get(uid);
    if (!c) {
      // первое сообщение от незнакомца — добавляем в список и подгружаем данные
      c = { id: uid, phone: '', name: '', surname: '', username: '', online: false,
            last_text: text, last_by: uid, last_at: at, unread: 0 };
      contacts.set(uid, c);
      queueUserInfo(uid);
      var sorted = Array.from(contacts.values()).sort(function (a, b) { return (b.last_at || 0) - (a.last_at || 0); });
      contacts = new Map(sorted.map(function (x) { return [x.id, x]; }));
      renderContacts();
      setTitle(totalUnread());
      return;
    }
    c.last_text = text;
    c.last_by = uid;
    c.last_at = at;
    if (incUnread && uid !== activeId) c.unread = (c.unread || 0) + 1;
    var sorted = Array.from(contacts.values()).sort(function (a, b) { return (b.last_at || 0) - (a.last_at || 0); });
    contacts = new Map(sorted.map(function (x) { return [x.id, x]; }));
    renderContacts();
    setTitle(totalUnread());
  }

  function markAllRead(uid) {
    var c = contacts.get(uid);
    if (c) { c.unread = 0; renderContacts(); setTitle(totalUnread()); }
  }

  // подгрузить имя/ник/номер незнакомца, от которого пришло сообщение
  function queueUserInfo(uid) {
    if (!uid || infoQueue[uid]) return;
    infoQueue[uid] = true;
    api('/api/user?id=' + uid)
      .then(function (j) {
        var u = j.user;
        var c = contacts.get(u.id);
        if (c) {
          c.name = u.name || '';
          c.surname = u.surname || '';
          c.username = u.username || '';
          c.phone = u.phone || '';
          c.online = !!u.online;
        }
        renderContacts();
        if (activeId === u.id) updateChatHeader();
      })
      .catch(function () {});
  }

  // ---------------- загрузка ----------------
  function boot() {
    if (!token) { show('login-view'); return; }
    api('/api/state')
      .then(function (j) {
        me = j.me;
        contacts = new Map(j.contacts.map(function (c) { return [c.id, c]; }));
        if (!me.username || !me.name) enterSetup();
        else { enterApp(); setTitle(totalUnread()); }
      })
      .catch(function () {
        localStorage.removeItem(TOKEN_KEY);
        token = '';
        show('login-view');
      });
  }

  boot();
})();