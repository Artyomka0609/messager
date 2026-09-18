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
        tip.innerHTML = 'Пока нет чатов.<br>Найдите собеседника по @нику (например @ivan) — напишите ему, и чат появится здесь.';
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
    var txt = document.createElement('div');
    txt.className = 'msg-text';
    txt.innerHTML = linkify(m.text);
    bubble.appendChild(txt);
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

  // --- отправка ---
  function sendCurrent() {
    var inp = $('msg-input');
    var text = inp.value.replace(/\s+$/, '');
    if (!text || activeId == null) return;
    var temp_id = 't' + (++sendSeq);
    var now = Date.now();
    renderMsg({ id: temp_id, from: me.id, to: activeId, text: text, created_at: now, read: false, temp_id: temp_id });
    $('messages').scrollTop = $('messages').scrollHeight;
    inp.value = '';
    autoGrow();
    stopTyping();
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'msg', to: activeId, text: text, temp_id: temp_id }));
    } else {
      toast('Нет соединения с сервером');
    }
  }

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
        touchContact(chatId, m.text, m.created_at, m.from !== me.id);
        if (m.from !== me.id && !isActive) {
          beep();
          var who = contacts.get(m.from);
          if (document.hidden && who) toast(fullName(who) + ': ' + m.text.slice(0, 40));
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