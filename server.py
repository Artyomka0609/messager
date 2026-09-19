# -*- coding: utf-8 -*-
"""
Мессенджер — локальный сервер (чистый Python stdlib).
HTTP (статик + REST) + WebSocket (реал-тайм) + SQLite.
Вход по номеру телефона и SMS-коду (демо-режим: код показывается на экране).
"""
import socket, threading, sqlite3, json, hashlib, base64, os, sys, time
import re, secrets, struct, urllib.parse, datetime, traceback

try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass

BASE = os.path.dirname(os.path.abspath(__file__))
PUBLIC = os.path.join(BASE, 'public')
DB_PATH = os.path.join(BASE, 'messager.db')
LOG_PATH = os.path.join(BASE, 'server.log')
PIDFILE = os.path.join(BASE, 'server.pid')

HOST = os.environ.get('HOST', '0.0.0.0')
try:
    PORT = int(os.environ.get('PORT', '3000'))
except ValueError:
    PORT = 3000
# Если задан адрес облачной базы (Neon/Supabase/Render PostgreSQL) —
# данные сохраняются между перезапусками. Иначе используется локальный SQLite.
DATABASE_URL = (os.environ.get('DATABASE_URL') or '').strip()
IS_PG = DATABASE_URL.startswith('postgres')
MAX_USERS = 50
MAX_MSG = 4000

MAX_FILE = 50 * 1024 * 1024  # не больше 50 МБ за вложение (фото/видео/файл)
BLOCKED_MIME = ('text/html',)  # html не принимаем
WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

BOT_ID = 1          # id встроенного бота «Мессенджер»
BOT_PHONE = '+79990000001'


def log(msg):
    try:
        with open(LOG_PATH, 'a', encoding='utf-8') as f:
            f.write('[%s] %s\n' % (datetime.datetime.now().strftime('%d.%m %H:%M:%S'), msg))
    except Exception:
        pass
    # дублируем в stdout — это видно в Render Logs
    try:
        print('[%s] %s' % (datetime.datetime.now().strftime('%d.%m %H:%M:%S'), msg), flush=True)
    except Exception:
        pass


# --------------------------------------------------------------------------
#  База данных
# --------------------------------------------------------------------------
class DBC:
    """Небольшая обёртка: одинаковый доступ к SQLite и PostgreSQL."""

    def __init__(self, raw, is_pg):
        self.raw = raw
        self.is_pg = is_pg

    def execute(self, sql, params=()):
        if self.is_pg:
            sql = sql.replace('?', '%s')
        cur = self.raw.cursor()
        cur.execute(sql, params)
        return cur

    def executescript(self, script):
        if self.is_pg:
            cur = self.raw.cursor()
            cur.execute(script)
        else:
            self.raw.executescript(script)

    def commit(self):
        self.raw.commit()

    def close(self):
        try:
            self.raw.close()
        except Exception:
            pass


def db():
    if IS_PG:
        try:
            import psycopg2
            import psycopg2.extras
        except ImportError:
            log('Нет модуля psycopg2 (нужен для DATABASE_URL) — использую SQLite')
            c = sqlite3.connect(DB_PATH, timeout=15)
            c.row_factory = sqlite3.Row
            return DBC(c, False)
        conn = psycopg2.connect(DATABASE_URL, cursor_factory=psycopg2.extras.RealDictCursor)
        return DBC(conn, True)
    c = sqlite3.connect(DB_PATH, timeout=15)
    c.row_factory = sqlite3.Row
    return DBC(c, False)


SQLITE_SCHEMA = '''
    CREATE TABLE IF NOT EXISTS users (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        phone         TEXT UNIQUE NOT NULL,
        name          TEXT DEFAULT '',
        surname       TEXT DEFAULT '',
        username      TEXT UNIQUE,
        password_hash TEXT,
        password_salt TEXT,
        avatar        TEXT,
        online        INTEGER DEFAULT 0,
        created_at    INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS codes (
        phone   TEXT PRIMARY KEY,
        code    TEXT NOT NULL,
        expires INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
        token  TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        created INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        sender_id    INTEGER NOT NULL,
        recipient_id INTEGER NOT NULL,
        text         TEXT NOT NULL,
        image        BLOB,
        image_mime   TEXT,
        image_name   TEXT,
        created_at   INTEGER NOT NULL,
        read         INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_msg_pair ON messages (sender_id, recipient_id);
    CREATE INDEX IF NOT EXISTS idx_msg_rec ON messages (recipient_id, read);
    CREATE TABLE IF NOT EXISTS chat_hidden (
        user_id INTEGER NOT NULL,
        peer_id INTEGER NOT NULL,
        PRIMARY KEY (user_id, peer_id)
    );
'''

PG_SCHEMA = '''
    CREATE TABLE IF NOT EXISTS users (
        id            SERIAL PRIMARY KEY,
        phone         TEXT UNIQUE NOT NULL,
        name          TEXT DEFAULT '',
        surname       TEXT DEFAULT '',
        username      TEXT UNIQUE,
        password_hash TEXT,
        password_salt TEXT,
        avatar        TEXT,
        online        INTEGER DEFAULT 0,
        created_at    BIGINT DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS codes (
        phone   TEXT PRIMARY KEY,
        code    TEXT NOT NULL,
        expires BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
        token   TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        created BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
        id           SERIAL PRIMARY KEY,
        sender_id    INTEGER NOT NULL,
        recipient_id INTEGER NOT NULL,
        text         TEXT NOT NULL,
        image        BYTEA,
        image_mime   TEXT,
        image_name   TEXT,
        created_at   BIGINT NOT NULL,
        read         INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_msg_pair ON messages (sender_id, recipient_id);
    CREATE INDEX IF NOT EXISTS idx_msg_rec ON messages (recipient_id, read);
    CREATE TABLE IF NOT EXISTS chat_hidden (
        user_id INTEGER NOT NULL,
        peer_id INTEGER NOT NULL,
        PRIMARY KEY (user_id, peer_id)
    );
'''


def init_db():
    c = db()
    c.executescript(PG_SCHEMA if c.is_pg else SQLITE_SCHEMA)
    if not c.is_pg:
        # миграция для старых SQLite-баз
        cols = [r[1] for r in c.execute("PRAGMA table_info(users)").fetchall()]
        if 'password_hash' not in cols:
            c.execute("ALTER TABLE users ADD COLUMN password_hash TEXT")
        if 'password_salt' not in cols:
            c.execute("ALTER TABLE users ADD COLUMN password_salt TEXT")
        # старые SQLite-базы могут не иметь колонки avatar (создавались до аватарок)
        if 'avatar' not in cols:
            c.execute("ALTER TABLE users ADD COLUMN avatar TEXT")
    else:
        # Neon/PostgreSQL: CREATE TABLE IF NOT EXISTS не добавляет колонку
        # в уже существующую таблицу — поэтому нужен отдельный ALTER.
        got = None
        try:
            cols = c.execute("SELECT column_name FROM information_schema.columns "
                             "WHERE table_name='users'").fetchall()
            got = set(r['column_name'] for r in cols)
            log('PG users columns: ' + ', '.join(sorted(got or [])))
        except Exception as e:
            log('ERR pg columns inspect: ' + str(e))
        if got is None or 'avatar' not in got:
            try:
                c.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar TEXT")
            except Exception as e:
                log('ERR alter avatar IF NOT EXISTS: ' + str(e))
                try:
                    c.execute("ALTER TABLE users ADD COLUMN avatar TEXT")
                except Exception as e2:
                    log('ERR alter avatar plain: ' + str(e2))
    # миграция таблицы messages: колонки фото (для старых баз, где их ещё нет)
    try:
        c.execute("ALTER TABLE messages ADD COLUMN image " + ("BYTEA" if c.is_pg else "BLOB"))
    except Exception:
        pass
    try:
        c.execute("ALTER TABLE messages ADD COLUMN image_mime TEXT")
    except Exception:
        pass
    try:
        c.execute("ALTER TABLE messages ADD COLUMN image_name TEXT")
    except Exception:
        pass
    try:
        c.execute("ALTER TABLE users ADD COLUMN avatar TEXT")
    except Exception:
        pass
    c.commit()
    # бот
    row = c.execute("SELECT id FROM users WHERE id=?", (BOT_ID,)).fetchone()
    if row is None:
        c.execute("INSERT INTO users (id, phone, name, surname, username, online, created_at) "
                  "VALUES (?,?,?,?,?,0,0) ON CONFLICT DO NOTHING",
                  (BOT_ID, BOT_PHONE, 'Мессенджер', '', 'messenger',))
        c.commit()
    if c.is_pg:
        # подтягиваем счётчик id, чтобы новые пользователи не столкнулись с ботом
        try:
            c.execute("SELECT setval(pg_get_serial_sequence('users','id'), "
                      "GREATEST((SELECT COALESCE(MAX(id),1) FROM users), 1))")
            c.commit()
        except Exception:
            pass
    c.close()


def norm_phone(raw):
    digits = re.sub(r'\D', '', raw or '')
    if not digits.startswith('+'):
        pass
    return digits


def user_dict(row):
    keys = row.keys() if hasattr(row, 'keys') else []
    return {
        'id': row['id'],
        'phone': row['phone'],
        'name': (row['name'] or '') if 'name' in keys else '',
        'surname': (row['surname'] or '') if 'surname' in keys else '',
        'username': (row['username'] or '') if 'username' in keys else '',
        'avatar': (row['avatar'] or '') if 'avatar' in keys else '',
        'online': bool(row['online'] if 'online' in keys else 0),
        'created_at': row['created_at'] if 'created_at' in keys else 0,
    }


def get_user_by_token(token):
    if not token:
        return None
    c = db()
    row = c.execute("SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=?", (token,)).fetchone()
    c.close()
    return user_dict(row) if row else None


def get_user(uid):
    c = db()
    row = c.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
    c.close()
    return user_dict(row) if row else None


def bot_canned(text):
    t = (text or '').lower()
    if any(w in t for w in ('привет', 'hello', 'hi ', 'здравств', 'ку')):
        return 'Привет! 👋 Рад тебя видеть!'
    if any(w in t for w in ('как дела', 'как ты', 'дела')):
        return 'У меня всё отлично! 🤖 А у тебя как?'
    if any(w in t for w in ('кто ты', 'бот', 'бот?')):
        return 'Я — встроенный бот «Мессенджер» 🤖 Создан, чтобы ты не скучал один.'
    if any(w in t for w in ('спасибо', 'спс', 'благодар')):
        return 'Всегда пожалуйста! 😊'
    if any(w in t for w in ('пока', 'до свида', 'до связи')):
        return 'Пока! Буду ждать твоего сообщения 👋'
    return secrets.choice([
        'Интересно! Расскажи ещё 😊',
        'Хорошо. А что ещё нового?',
        'Понял тебя 👍',
        'Да, согласен с тобой!',
        'Напиши кому-нибудь из друзей, им будет приятно 😉',
    ])


def bot_welcome(user_id):
    txt = ('Привет! 👋 Добро пожаловать в Мессенджер!\n'
           'Здесь можно общаться с друзьями в реальном времени.\n'
           '— Заполни профиль: имя, фамилию и уникальный ник.\n'
           '— Выбери контакт слева и пиши.\n'
           '— Статус «в сети» и уведомления работают автоматически.\n\n'
           'Я — бот. Можешь написать мне в любое время 🙂')
    now = int(time.time() * 1000)
    c = db()
    c.execute("INSERT INTO messages (sender_id, recipient_id, text, created_at, read) VALUES (?,?,?,?,0)",
              (BOT_ID, user_id, txt, now))
    c.commit()
    c.close()


def send_message(sender_id, recipient_id, text, image=None, image_mime=None, image_name=None):
    now = int(time.time() * 1000)
    c = db()
    cur = c.execute("INSERT INTO messages (sender_id, recipient_id, text, image, image_mime, image_name, created_at, read) "
                    "VALUES (?,?,?,?,?,?,?,0) RETURNING id",
                    (sender_id, recipient_id, text, image if image is not None else None,
                     image_mime if image is not None else None,
                     image_name if image is not None else None, now))
    mid = cur.fetchone()['id']
    c.commit()
    c.close()
    return mid, now


def msg_json(r):
    img = r['image'] if 'image' in r.keys() else None
    if img is not None:
        try:
            blob = bytes(img)
        except Exception:
            blob = img
        b64 = base64.b64encode(blob).decode('ascii')
        return {'id': r['id'], 'from': r['sender_id'], 'to': r['recipient_id'],
                'text': r['text'], 'created_at': r['created_at'], 'read': r['read'],
                'image': b64, 'image_mime': r['image_mime'] or 'application/octet-stream',
                'image_name': r['image_name'] if 'image_name' in r.keys() else None}
    return {'id': r['id'], 'from': r['sender_id'], 'to': r['recipient_id'],
            'text': r['text'], 'created_at': r['created_at'], 'read': r['read'],
            'image': None, 'image_mime': None, 'image_name': None}


# --------------------------------------------------------------------------
#  Хаб WebSocket соединений
# --------------------------------------------------------------------------
class Hub:
    def __init__(self):
        self.lock = threading.RLock()
        self.conns = {}  # user_id -> [WSConn]

    def add(self, uid, conn):
        with self.lock:
            for old in self.conns.get(uid, []):
                old.close()
            self.conns.setdefault(uid, []).append(conn)

    def remove(self, uid, conn):
        with self.lock:
            lst = self.conns.get(uid, [])
            if conn in lst:
                lst.remove(conn)
            if not lst:
                self.conns.pop(uid, None)

    def send_to(self, uid, obj):
        with self.lock:
            for cn in list(self.conns.get(uid, [])):
                try:
                    cn.send_json(obj)
                except Exception:
                    pass

    def broadcast(self, obj, exclude=None):
        with self.lock:
            for uid, lst in list(self.conns.items()):
                if uid == exclude:
                    continue
                for cn in list(lst):
                    try:
                        cn.send_json(obj)
                    except Exception:
                        pass


HUB = Hub()


# --------------------------------------------------------------------------
#  WebSocket соединение
# --------------------------------------------------------------------------
class WSConn:
    def __init__(self, sock, rest, token):
        self.sock = sock
        self.sock.settimeout(600)
        self.buf = rest
        self.send_lock = threading.Lock()
        self.user = get_user_by_token(token)
        self.closed = False

    # --- низкоуровневый приём/отправка кадров ---
    def _recv(self, n):
        while len(self.buf) < n:
            try:
                chunk = self.sock.recv(65536)
            except Exception:
                return None
            if not chunk:
                return None
            self.buf += chunk
        out = self.buf[:n]
        self.buf = self.buf[n:]
        return out

    def _send_bytes(self, data):
        with self.send_lock:
            self.sock.sendall(data)

    def send_frame(self, opcode, payload):
        ln = len(payload)
        head = bytearray([0x80 | opcode])
        if ln < 126:
            head.append(ln)
        elif ln < 65536:
            head.append(126)
            head += struct.pack('>H', ln)
        else:
            head.append(127)
            head += struct.pack('>Q', ln)
        self._send_bytes(bytes(head) + payload)

    def send_json(self, obj):
        self.send_frame(0x1, json.dumps(obj, ensure_ascii=False).encode('utf-8'))

    def recv_frame(self):
        h = self._recv(2)
        if h is None or len(h) < 2:
            return None
        fin = h[0] & 0x80
        op = h[0] & 0x0F
        masked = h[1] & 0x80
        ln = h[1] & 0x7F
        if ln == 126:
            b = self._recv(2)
            if b is None:
                return None
            ln = struct.unpack('>H', b)[0]
        elif ln == 127:
            b = self._recv(8)
            if b is None:
                return None
            ln = struct.unpack('>Q', b)[0]
        mask = None
        if masked:
            mask = self._recv(4)
            if mask is None:
                return None
        payload = b''
        while len(payload) < ln:
            part = self._recv(ln - len(payload))
            if part is None:
                return None
            payload += part
        if mask:
            payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        return fin, op, payload

    def close(self):
        if self.closed:
            return
        self.closed = True
        try:
            self.send_frame(0x8, b'')
        except Exception:
            pass
        try:
            self.sock.close()
        except Exception:
            pass

    # --- логика ---
    def run(self):
        if self.user is None:
            self.close()
            return
        uid = self.user['id']
        HUB.add(uid, self)
        # онлайн
        c = db()
        c.execute("UPDATE users SET online=1 WHERE id=?", (uid,))
        c.commit()
        c.close()
        HUB.broadcast({'type': 'presence', 'user_id': uid, 'online': True}, exclude=uid)
        # неполученные сообщения
        try:
            c = db()
            rows = c.execute("SELECT * FROM messages WHERE recipient_id=? AND read=0 ORDER BY id", (uid,)).fetchall()
            c.close()
            for r in rows:
                self.send_json({'type': 'msg', **msg_json(r)})
        except Exception:
            pass
        try:
            while not self.closed:
                f = self.recv_frame()
                if f is None:
                    break
                fin, op, payload = f
                if op == 0x8:  # close
                    break
                if op == 0x9:  # ping
                    self.send_frame(0xA, payload)
                    continue
                if op != 0x1:
                    continue
                try:
                    msg = json.loads(payload.decode('utf-8'))
                except Exception:
                    continue
                try:
                    self.handle(msg)
                except Exception:
                    log('ERR ws handle: ' + traceback.format_exc(limit=6))
        except Exception:
            pass
        finally:
            self.on_disconnect(uid)

    def on_disconnect(self, uid):
        if self.closed:
            return
        self.closed = True
        HUB.remove(uid, self)
        c = db()
        c.execute("UPDATE users SET online=0 WHERE id=?", (uid,))
        c.commit()
        c.close()
        HUB.broadcast({'type': 'presence', 'user_id': uid, 'online': False}, exclude=uid)
        try:
            self.sock.close()
        except Exception:
            pass

    def handle(self, msg):
        t = msg.get('type')
        uid = self.user['id']
        if t == 'msg':
            text = (msg.get('text') or '').strip()
            to = msg.get('to')
            temp_id = msg.get('temp_id')
            img_b64 = msg.get('image')
            img_mime = (msg.get('image_mime') or 'application/octet-stream').lower()
            img_name = str(msg.get('image_name') or '').replace('\\', '/').split('/')[-1][:150]
            raw = None
            if img_b64:
                img_b64 = str(img_b64).strip()
                if 'base64,' in img_b64:
                    img_b64 = img_b64.split('base64,', 1)[1]
                try:
                    raw = base64.b64decode(img_b64)
                except Exception:
                    self.send_json({'type': 'err', 'error': 'Некорректное вложение'})
                    return
                if not raw or len(raw) > MAX_FILE:
                    self.send_json({'type': 'err', 'error': 'Вложение слишком большое (макс. 50 МБ)'})
                    return
                if img_mime in BLOCKED_MIME:
                    self.send_json({'type': 'err', 'error': 'Недопустимый тип файла'})
                    return
            if ((not text and raw is None) or not isinstance(to, int)
                    or len(text) > MAX_MSG):
                self.send_json({'type': 'err', 'error': 'Некорректное сообщение'})
                return
            target = get_user(to)
            if target is None:
                self.send_json({'type': 'err', 'error': 'Получатель не найден'})
                return
            if to == uid:
                return
            mid, now = send_message(uid, to, text, raw, img_mime if raw is not None else None,
                                    img_name if raw is not None else None)
            self.send_json({'type': 'sent', 'temp_id': temp_id, 'id': mid, 'to': to})
            HUB.send_to(to, {'type': 'msg', 'id': mid, 'from': uid, 'to': to, 'text': text,
                             'created_at': now, 'image': img_b64 if raw is not None else None,
                             'image_mime': img_mime if raw is not None else None,
                             'image_name': img_name if raw is not None else None})
            # если чат был скрыт — новое сообщение возвращает его обоим
            c = db()
            c.execute("DELETE FROM chat_hidden WHERE (user_id=? AND peer_id=?) OR (user_id=? AND peer_id=?)",
                      (uid, to, to, uid))
            c.commit()
            c.close()
            # бот отвечает
            if to == BOT_ID:
                def bot_reply():
                    time.sleep(0.8)
                    reply = bot_canned(text)
                    mid2, now2 = send_message(BOT_ID, uid, reply)
                    # бот «прочитал» сообщения пользователя
                    c = db()
                    c.execute("UPDATE messages SET read=1 WHERE sender_id=? AND recipient_id=? AND read=0", (uid, BOT_ID))
                    c.commit()
                    c.close()
                    HUB.send_to(uid, {'type': 'msg', 'id': mid2, 'from': BOT_ID, 'to': uid, 'text': reply, 'created_at': now2})
                    HUB.send_to(uid, {'type': 'read', 'user_id': BOT_ID})
                threading.Thread(target=bot_reply, daemon=True).start()
        elif t == 'read':
            to = msg.get('to')
            if not isinstance(to, int):
                return
            c = db()
            c.execute("UPDATE messages SET read=1 WHERE sender_id=? AND recipient_id=? AND read=0", (to, uid))
            c.commit()
            c.close()
            HUB.send_to(to, {'type': 'read', 'user_id': uid})
        elif t == 'typing':
            to = msg.get('to')
            is_typing = bool(msg.get('is_typing'))
            if isinstance(to, int) and to != uid:
                HUB.send_to(to, {'type': 'typing', 'from': uid, 'is_typing': is_typing})


# --------------------------------------------------------------------------
#  HTTP
# --------------------------------------------------------------------------
MIME = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.webmanifest': 'application/manifest+json; charset=utf-8',
    '.ico': 'image/x-icon',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.txt': 'text/plain; charset=utf-8',
    '.wav': 'audio/wav',
}

STATUS_TEXT = {200: 'OK', 201: 'Created', 204: 'No Content', 400: 'Bad Request',
               401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 500: 'Internal Server Error'}


def http_resp(sock, code, ctype='text/plain', body=b'', extra=None):
    status_line = 'HTTP/1.1 %d %s\r\n' % (code, STATUS_TEXT.get(code, 'OK'))
    if isinstance(body, str):
        body = body.encode('utf-8')
    headers = [
        ('Date', datetime.datetime.utcnow().strftime('%a, %d %b %Y %H:%M:%S GMT')),
        ('Server', 'Messenger/1.0'),
        ('Content-Type', ctype),
        ('Content-Length', str(len(body))),
    ]
    if extra:
        headers += extra
    out = status_line.encode('latin1')
    for k, v in headers:
        out += ('%s: %s\r\n' % (k, v)).encode('latin1')
    out += b'\r\n'
    out += body
    try:
        sock.sendall(out)
    except Exception:
        pass


def json_resp(sock, code, obj):
    body = json.dumps(obj, ensure_ascii=False)
    http_resp(sock, code, 'application/json; charset=utf-8', body, extra=[('Cache-Control', 'no-store')])


def read_body(sock, headers, rest, timeout=10):
    clen = int(headers.get('content-length', 0) or 0)
    sock.settimeout(timeout)
    data = rest[:]
    while len(data) < clen:
        try:
            chunk = sock.recv(65536)
        except Exception:
            break
        if not chunk:
            break
        data += chunk
    return data[:clen]


def auth_from(headers, qs):
    token = None
    b = headers.get('x-token') or headers.get('authorization', '')
    if b.startswith('Bearer '):
        token = b[7:].strip()
    if not token:
        token = b.strip()
    if not token and 'token' in qs:
        token = qs['token'][0]
    return token


# --- авторизация по номеру и паролю ---
def hash_password(password, salt=None):
    if salt is None:
        salt = secrets.token_hex(16)
    h = hashlib.pbkdf2_hmac('sha256', password.encode('utf-8'), salt.encode('utf-8'), 120000)
    return h.hex(), salt


def verify_password(password, stored_hash, salt):
    if not stored_hash or not salt:
        return False
    h, _ = hash_password(password, salt)
    return secrets.compare_digest(h, stored_hash)


def issue_token(uid):
    token = secrets.token_hex(20)
    c = db()
    c.execute("INSERT INTO sessions (token, user_id, created) VALUES (?,?,?)", (token, uid, int(time.time())))
    c.commit()
    c.close()
    return token


def api_register(sock, body):
    try:
        js = json.loads(body.decode('utf-8'))
    except Exception:
        return json_resp(sock, 400, {'error': 'Неверный JSON'})
    phone = norm_phone(js.get('phone', ''))
    password = str(js.get('password') or '')
    if len(phone) < 5 or len(phone) > 15:
        return json_resp(sock, 400, {'error': 'Некорректный номер телефона'})
    if len(password) < 4:
        return json_resp(sock, 400, {'error': 'Пароль должен быть не короче 4 символов'})
    c = db()
    u = c.execute("SELECT * FROM users WHERE phone=?", (phone,)).fetchone()
    if u is not None and u['password_hash']:
        c.close()
        return json_resp(sock, 400, {'error': 'Этот номер уже зарегистрирован. Войдите.'})
    if u is not None and not u['password_hash']:
        # старый аккаунт без пароля — задаём пароль
        ph, salt = hash_password(password)
        c.execute("UPDATE users SET password_hash=?, password_salt=? WHERE id=?", (ph, salt, u['id']))
        c.commit()
        uid = u['id']
        created = False
    else:
        count = c.execute("SELECT COUNT(*) AS n FROM users WHERE id<>?", (BOT_ID,)).fetchone()['n']
        if count >= MAX_USERS:
            c.close()
            return json_resp(sock, 400, {'error': 'Достигнут лимит БД: зарегистрировано 50 пользователей'})
        ph, salt = hash_password(password)
        now = int(time.time() * 1000)
        cur = c.execute("INSERT INTO users (phone, name, surname, username, password_hash, password_salt, online, created_at) "
                        "VALUES (?,?,?,?,?,?,0,?) RETURNING id",
                        (phone, '', '', None, ph, salt, now))
        uid = cur.fetchone()['id']
        c.commit()
        created = True
    c.close()
    token = issue_token(uid)
    if created:
        bot_welcome(uid)
    log('Регистрация: %s' % phone)
    json_resp(sock, 200, {'token': token, 'user': get_user(uid), 'created': created})


def api_login(sock, body):
    try:
        js = json.loads(body.decode('utf-8'))
    except Exception:
        return json_resp(sock, 400, {'error': 'Неверный JSON'})
    phone = norm_phone(js.get('phone', ''))
    password = str(js.get('password') or '')
    if len(phone) < 5:
        return json_resp(sock, 400, {'error': 'Введите номер телефона'})
    c = db()
    u = c.execute("SELECT * FROM users WHERE phone=?", (phone,)).fetchone()
    c.close()
    if u is None:
        return json_resp(sock, 400, {'error': 'Аккаунт не найден. Зарегистрируйтесь.'})
    if not u['password_hash']:
        return json_resp(sock, 400, {'error': 'Для аккаунта не задан пароль. Зарегистрируйтесь заново.'})
    if not verify_password(password, u['password_hash'], u['password_salt']):
        return json_resp(sock, 400, {'error': 'Неверный пароль'})
    token = issue_token(u['id'])
    log('Вход: %s' % phone)
    json_resp(sock, 200, {'token': token, 'user': get_user(u['id']), 'created': False})


def contacts_for(me):
    c = db()
    # показываем только тех, с кем уже есть переписка — остальных можно найти через /api/search
    rows = c.execute(
        "SELECT u.* FROM users u WHERE u.id<>? "
        "AND NOT EXISTS (SELECT 1 FROM chat_hidden h WHERE h.user_id=? AND h.peer_id=u.id) "
        "AND EXISTS ("
        "SELECT 1 FROM messages m WHERE (m.sender_id=? AND m.recipient_id=u.id) "
        "OR (m.sender_id=u.id AND m.recipient_id=?)) ORDER BY u.id",
        (me['id'], me['id'], me['id'], me['id'])).fetchall()
    out = []
    for r in rows:
        u = user_dict(r)
        last = c.execute("SELECT * FROM messages WHERE (sender_id=? AND recipient_id=?) OR (sender_id=? AND recipient_id=?) ORDER BY id DESC LIMIT 1",
                         (me['id'], u['id'], u['id'], me['id'])).fetchone()
        unread = c.execute("SELECT COUNT(*) AS n FROM messages WHERE sender_id=? AND recipient_id=? AND read=0",
                           (u['id'], me['id'])).fetchone()['n']
        if last and last['image'] is not None:
            lm = (last['image_mime'] or '').lower()
            if lm.startswith('image/'):
                prev = '📷 Фото'
            elif lm.startswith('video/'):
                prev = '🎬 Видео'
            elif lm.startswith('audio/'):
                prev = '🎵 Аудио'
            else:
                prev = '📄 Файл'
        else:
            prev = last['text'] if last else ''
        out.append({
            **u,
            'last_text': prev,
            'last_by': last['sender_id'] if last else None,
            'last_at': last['created_at'] if last else None,
            'unread': unread,
        })
    c.close()
    out.sort(key=lambda x: x['last_at'] or 0, reverse=True)
    return out


def api_state(sock, token):
    me = get_user_by_token(token)
    if me is None:
        return json_resp(sock, 401, {'error': 'Сессия недействительна'})
    json_resp(sock, 200, {'me': me, 'contacts': contacts_for(me)})


def api_profile(sock, token, body):
    me = get_user_by_token(token)
    if me is None:
        return json_resp(sock, 401, {'error': 'Сессия недействительна'})
    try:
        js = json.loads(body.decode('utf-8'))
    except Exception:
        return json_resp(sock, 400, {'error': 'Неверный JSON'})
    name = (js.get('name') or '').strip()[:40]
    surname = (js.get('surname') or '').strip()[:40]
    username = (js.get('username') or '').strip().lower()
    if not name:
        return json_resp(sock, 400, {'error': 'Укажите имя'})
    if not re.match(r'^[a-z0-9_]{4,32}$', username):
        return json_resp(sock, 400, {'error': 'Ник: 4–32 символа, латиница, цифры и _'})
    avatar = js.get('avatar')
    if avatar is not None:
        avatar = (avatar or '').strip()
        if avatar and not (avatar.startswith('data:image/') and ';base64,' in avatar):
            return json_resp(sock, 400, {'error': 'Недопустимое изображение'})
        if len(avatar) > 2500000:
            return json_resp(sock, 400, {'error': 'Изображение слишком большое (макс. ~1.8 МБ)'})
    c = db()
    dup = c.execute("SELECT id FROM users WHERE username=? AND id<>?", (username, me['id'])).fetchone()
    if dup:
        c.close()
        return json_resp(sock, 400, {'error': 'Этот ник уже занят, придумайте другой'})
    if avatar is not None:
        c.execute("UPDATE users SET avatar=? WHERE id=?", (avatar or None, me['id']))
    c.execute("UPDATE users SET name=?, surname=?, username=? WHERE id=?", (name, surname, username, me['id']))
    c.commit()
    c.close()
    json_resp(sock, 200, {'user': get_user(me['id'])})


def api_history(sock, token, qs):
    me = get_user_by_token(token)
    if me is None:
        return json_resp(sock, 401, {'error': 'Сессия недействительна'})
    try:
        with_id = int(qs.get('with', ['0'])[0])
    except Exception:
        return json_resp(sock, 400, {'error': 'bad with'})
    c = db()
    if c.execute("SELECT 1 FROM chat_hidden WHERE user_id=? AND peer_id=?", (me['id'], with_id)).fetchone():
        c.close()
        return json_resp(sock, 200, {'messages': []})
    rows = c.execute(
        "SELECT * FROM messages WHERE (sender_id=? AND recipient_id=?) OR (sender_id=? AND recipient_id=?) ORDER BY id DESC LIMIT 80",
        (me['id'], with_id, with_id, me['id'])).fetchall()
    c.close()
    arr = [msg_json(r) for r in reversed(rows)]
    json_resp(sock, 200, {'messages': arr})


def api_search(sock, token, qs):
    me = get_user_by_token(token)
    if me is None:
        return json_resp(sock, 401, {'error': 'Сессия недействительна'})
    q = (qs.get('q', [''])[0] or '').strip().lower()[:60]
    c = db()
    if not q:
        c.close()
        return json_resp(sock, 200, {'users': []})
    rows = c.execute("SELECT * FROM users WHERE id<>? ORDER BY created_at", (me['id'],)).fetchall()
    digits = re.sub(r'\D', '', q)
    out = []
    for r in rows:
        u = user_dict(r)
        has_h = bool(c.execute(
            "SELECT 1 FROM messages WHERE (sender_id=? AND recipient_id=?) OR (sender_id=? AND recipient_id=?) LIMIT 1",
            (me['id'], u['id'], u['id'], me['id'])).fetchone())
        hidden = bool(c.execute("SELECT 1 FROM chat_hidden WHERE user_id=? AND peer_id=?",
                                (me['id'], u['id'])).fetchone())
        u['has_history'] = has_h and not hidden
        uq = q[1:] if q.startswith('@') else q
        if u['has_history']:
            # свои (уже есть переписка): можно искать по имени, фамилии, нику и номеру
            hay = ' '.join([u['name'], u['surname'], u['username'], u['phone']]).lower()
            ok = bool(uq) and (uq in hay or (digits and digits in u['phone']))
        else:
            # посторонних можно найти только по полному @нику (частичный ввод ничего не выдаёт)
            ok = bool(uq) and uq == (u['username'] or '').lower()
        if ok:
            out.append(u)
            if len(out) >= 20:
                break
    c.close()
    json_resp(sock, 200, {'users': out})


def api_user(sock, token, qs):
    me = get_user_by_token(token)
    if me is None:
        return json_resp(sock, 401, {'error': 'Сессия недействительна'})
    try:
        uid = int(qs.get('id', ['0'])[0])
    except Exception:
        return json_resp(sock, 400, {'error': 'bad id'})
    if uid == me['id']:
        return json_resp(sock, 400, {'error': 'Это вы'})
    c = db()
    row = c.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
    c.close()
    if row is None:
        return json_resp(sock, 404, {'error': 'Пользователь не найден'})
    json_resp(sock, 200, {'user': user_dict(row)})


def api_delete_chat(sock, token, body):
    me = get_user_by_token(token)
    if me is None:
        return json_resp(sock, 401, {'error': 'Сессия недействительна'})
    try:
        js = json.loads(body.decode('utf-8'))
    except Exception:
        return json_resp(sock, 400, {'error': 'Неверный JSON'})
    try:
        peer = int(js.get('with', 0))
    except Exception:
        return json_resp(sock, 400, {'error': 'bad with'})
    if peer == me['id']:
        return json_resp(sock, 400, {'error': 'Нельзя удалить чат с самим собой'})
    c = db()
    c.execute("INSERT INTO chat_hidden (user_id, peer_id) SELECT ?, ? "
              "WHERE NOT EXISTS (SELECT 1 FROM chat_hidden WHERE user_id=? AND peer_id=?)",
              (me['id'], peer, me['id'], peer))
    c.commit()
    c.close()
    json_resp(sock, 200, {'ok': True})


def api_logout(sock, token):
    if not token:
        return json_resp(sock, 401, {'error': 'Сессия недействительна'})
    c = db()
    c.execute("DELETE FROM sessions WHERE token=?", (token,))
    c.commit()
    c.close()
    json_resp(sock, 200, {'ok': True})


def handle_http(sock, addr, request_line, headers, rest):
    parts = request_line.split(' ')
    if len(parts) < 3:
        return
    method, path = parts[0], parts[1]
    parsed = urllib.parse.urlparse(path)
    qs = urllib.parse.parse_qs(parsed.query)

    if method == 'GET' and parsed.path == '/healthz':
        return json_resp(sock, 200, {'ok': True})

    if method == 'GET' and parsed.path == '/ws':
        key = headers.get('sec-websocket-key', '')
        tok = (qs.get('token', [''])[0] or '').strip()
        if not key or not tok:
            return http_resp(sock, 400, 'text/plain', b'bad request')
        accept = base64.b64encode(hashlib.sha1((key + WS_GUID).encode()).digest()).decode()
        out = (b'HTTP/1.1 101 Switching Protocols\r\n'
               b'Upgrade: websocket\r\n'
               b'Connection: Upgrade\r\n'
               b'Sec-WebSocket-Accept: ' + accept.encode() + b'\r\n\r\n')
        sock.sendall(out)
        WSConn(sock, rest, tok).run()
        return

    if method == 'GET' and path in ('/', '/index.html'):
        return serve_file(sock, 'index.html')

    if method == 'GET' and parsed.path == '/favicon.ico':
        return serve_file(sock, os.path.join(BASE, 'app.ico'))

    if parsed.path.startswith('/api/'):
        token = auth_from(headers, qs)
        route = parsed.path
        if method == 'POST' and route == '/api/register':
            return api_register(sock, read_body(sock, headers, rest))
        if method == 'POST' and route == '/api/login':
            return api_login(sock, read_body(sock, headers, rest))
        if method == 'GET' and route == '/api/state':
            return api_state(sock, token)
        if method == 'POST' and route == '/api/profile':
            return api_profile(sock, token, read_body(sock, headers, rest))
        if method == 'POST' and route == '/api/chat/delete':
            return api_delete_chat(sock, token, read_body(sock, headers, rest))
        if method == 'POST' and route == '/api/logout':
            return api_logout(sock, token)
        if method == 'GET' and route == '/api/history':
            return api_history(sock, token, qs)
        if method == 'GET' and route == '/api/search':
            return api_search(sock, token, qs)
        if method == 'GET' and route == '/api/user':
            return api_user(sock, token, qs)
        return http_resp(sock, 404, 'text/plain', b'no such api')

    if method == 'GET':
        rel = parsed.path.lstrip('/')
        return serve_file(sock, rel)

    return http_resp(sock, 404, 'text/plain', b'not found')


def serve_file(sock, rel):
    if not rel:
        rel = 'index.html'
    target = os.path.realpath(os.path.join(PUBLIC, rel or 'index.html'))
    pub = os.path.realpath(PUBLIC)
    if not (target.startswith(pub + os.sep) or target == os.path.join(pub, 'index.html')):
        return http_resp(sock, 403, 'text/plain', b'forbidden')
    if not os.path.isfile(target):
        return http_resp(sock, 404, 'text/plain', b'not found')
    ext = os.path.splitext(target)[1].lower()
    ctype = MIME.get(ext, 'application/octet-stream')
    with open(target, 'rb') as f:
        data = f.read()
    http_resp(sock, 200, ctype, data, extra=[('Cache-Control', 'no-cache')])


# --------------------------------------------------------------------------
#  Соединение
# --------------------------------------------------------------------------
class ConnThread(threading.Thread):
    def __init__(self, sock, addr):
        super().__init__(daemon=True)
        self.sock = sock
        self.addr = addr

    def run(self):
        sock = self.sock
        try:
            sock.settimeout(30)
            data = b''
            while b'\r\n\r\n' not in data:
                try:
                    chunk = sock.recv(65536)
                except Exception:
                    return
                if not chunk:
                    return
                data += chunk
                if len(data) > 131072:
                    return
            head, _, rest = data.partition(b'\r\n\r\n')
            lines = head.split(b'\r\n')
            if not lines or not lines[0]:
                return
            request_line = lines[0].decode('latin1', 'replace')
            headers = {}
            for line in lines[1:]:
                if b':' in line:
                    k, v = line.split(b':', 1)
                    headers[k.decode('latin1').strip().lower()] = v.decode('latin1').strip()
            handle_http(sock, self.addr, request_line, headers, rest)
        except Exception:
            log('ERR http: ' + traceback.format_exc(limit=8))
            try:
                print('TRACEBACK http:', flush=True)
                print(traceback.format_exc(), flush=True)
            except Exception:
                pass
        finally:
            try:
                sock.close()
            except Exception:
                pass


# --------------------------------------------------------------------------
#  Запуск
# --------------------------------------------------------------------------
def already_running():
    if os.path.exists(PIDFILE):
        try:
            pid = int(open(PIDFILE).read().strip())
            if pid == os.getpid():
                return True
        except Exception:
            pass
    return False


def main():
    if already_running():
        log('Сервер уже запущен (pid из %s)' % PIDFILE)
        return
    try:
        with open(PIDFILE, 'w') as f:
            f.write(str(os.getpid()))
    except Exception:
        pass
    init_db()
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        srv.bind((HOST, PORT))
    except OSError as e:
        log('Не могу занять порт %d: %s' % (PORT, e))
        return
    srv.listen(64)
    log('Мессенджер запущен на http://localhost:%d (0.0.0.0:%d, БД до %d пользователей)' % (PORT, PORT, MAX_USERS))
    print('Мессенджер запущен: http://localhost:%d  (пользователей максимум: %d)' % (PORT, MAX_USERS))
    try:
        while True:
            try:
                sock, addr = srv.accept()
            except OSError:
                break
            ConnThread(sock, addr).start()
    except KeyboardInterrupt:
        pass
    finally:
        try:
            os.remove(PIDFILE)
        except Exception:
            pass
        try:
            srv.close()
        except Exception:
            pass
        log('Сервер остановлен')


if __name__ == '__main__':
    main()