'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const cookieSession = require('cookie-session');
const db = require('./db');
const { JOBS, TYPES } = require('./constants');

const PORT = Number(process.env.PORT) || 3000;
const IS_PROD = process.env.NODE_ENV === 'production' || Boolean(process.env.RAILWAY_ENVIRONMENT);
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const TIME_ZONE = 'Europe/Istanbul';

let SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET) {
  SESSION_SECRET = crypto.randomBytes(32).toString('hex');
  console.warn('[uyarı] SESSION_SECRET tanımlı değil. Rastgele üretildi, yeniden başlatmada oturumlar düşer.');
}
if (!ADMIN_USERNAME || !ADMIN_PASSWORD) {
  console.warn('[uyarı] ADMIN_USERNAME / ADMIN_PASSWORD tanımlı değil. Admin girişi devre dışı.');
}
if (process.env.RAILWAY_ENVIRONMENT && !process.env.RAILWAY_VOLUME_MOUNT_PATH && !process.env.DATA_DIR) {
  console.warn('[uyarı] Railway volume bağlı değil! Her deploy\'da veriler silinir. Bir volume ekleyin.');
}

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1);
app.disable('x-powered-by');

/* ---------- Güvenlik başlıkları ---------- */
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
    'Content-Security-Policy':
      "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'; base-uri 'self'",
  });
  next();
});

app.get('/healthz', (req, res) => res.type('text').send('ok'));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: IS_PROD ? '7d' : 0 }));
app.use(express.urlencoded({ extended: false, limit: '100kb' }));
app.use(
  cookieSession({
    name: 'ra_sess',
    keys: [SESSION_SECRET],
    maxAge: 7 * 24 * 60 * 60 * 1000,
    httpOnly: true,
    sameSite: 'lax',
    secure: IS_PROD,
  })
);

// Başka sitelerden gelen form gönderimlerini reddet (CSRF koruması)
app.use((req, res, next) => {
  if (req.method === 'POST' && req.get('sec-fetch-site') === 'cross-site') {
    return res.status(403).send('Geçersiz istek');
  }
  next();
});

/* ---------- Yardımcılar ---------- */
const ASSET_VERSION = Date.now().toString(36);
const EVENT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

function nowLocalString() {
  // "YYYY-MM-DDTHH:MM" biçiminde İstanbul saati
  return new Date()
    .toLocaleString('sv-SE', { timeZone: TIME_ZONE, hour12: false })
    .slice(0, 16)
    .replace(' ', 'T');
}

const fmt = {
  // event_at İstanbul saati olarak, saat dilimi bilgisi olmadan saklanır
  event(value) {
    const m = EVENT_RE.exec(value || '');
    if (!m) return '';
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]));
    return d.toLocaleString('tr-TR', {
      timeZone: 'UTC',
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  },
  // created_at SQLite'ta UTC olarak saklanır
  created(value) {
    if (!value) return '';
    const d = new Date(value.replace(' ', 'T') + 'Z');
    return d.toLocaleString('tr-TR', {
      timeZone: TIME_ZONE,
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  },
  isUpcoming(value) {
    return EVENT_RE.test(value || '') && value >= nowLocalString();
  },
  jobClass(job) {
    return 'job-' + String(job || '').toLowerCase();
  },
};

function clean(value, max, multiline = false) {
  let s = typeof value === 'string' ? value : '';
  s = multiline ? s.replace(/\r\n/g, '\n') : s.replace(/\s+/g, ' ');
  return s.trim().slice(0, max);
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function setFlash(req, type, text) {
  req.session.flash = { type, text };
}

app.use((req, res, next) => {
  res.locals.isAdmin = Boolean(req.session && req.session.admin);
  res.locals.flash = req.session.flash || null;
  if (req.session.flash) req.session.flash = null;
  res.locals.fmt = fmt;
  res.locals.JOBS = JOBS;
  res.locals.TYPES = TYPES;
  res.locals.assetVersion = ASSET_VERSION;
  next();
});

function requireAdmin(req, res, next) {
  if (req.session && req.session.admin) return next();
  setFlash(req, 'error', 'Bu işlem için giriş yapmalısın.');
  res.redirect('/giris');
}

function parseId(req, res, next) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(404).render('error', { title: 'Bulunamadı', message: 'Sayfa bulunamadı.' });
  req.id = id;
  next();
}

function backTo(req, fallback) {
  const ref = req.get('referer');
  try {
    if (ref) {
      const u = new URL(ref);
      if (u.host === req.get('host')) return u.pathname + u.search;
    }
  } catch {}
  return fallback;
}

/* ---------- Giriş / Çıkış ---------- */
const loginAttempts = new Map(); // ip -> { count, until }
const MAX_ATTEMPTS = 5;
const LOCK_MS = 5 * 60 * 1000;

app.get('/giris', (req, res) => {
  if (res.locals.isAdmin) return res.redirect('/');
  res.render('login', { title: 'Giriş', active: '' });
});

app.post('/giris', (req, res) => {
  const ip = req.ip;
  const entry = loginAttempts.get(ip);
  if (entry && entry.until > Date.now()) {
    setFlash(req, 'error', 'Çok fazla hatalı deneme. Birkaç dakika sonra tekrar dene.');
    return res.redirect('/giris');
  }

  const { username = '', password = '' } = req.body;
  const userOk = safeEqual(username, ADMIN_USERNAME);
  const passOk = safeEqual(password, ADMIN_PASSWORD);
  const ok = Boolean(ADMIN_USERNAME && ADMIN_PASSWORD) && userOk && passOk;

  if (!ok) {
    // Süresi dolmuş bir kilit varsa sayaç sıfırlanır
    const prev = entry && entry.until === 0 ? entry.count : 0;
    const count = prev + 1;
    loginAttempts.set(ip, { count, until: count >= MAX_ATTEMPTS ? Date.now() + LOCK_MS : 0 });
    setFlash(req, 'error', 'Kullanıcı adı veya şifre hatalı.');
    return res.redirect('/giris');
  }

  loginAttempts.delete(ip);
  req.session = { admin: true, flash: { type: 'success', text: 'Hoş geldin! Artık düzenleme yapabilirsin.' } };
  res.redirect('/');
});

app.post('/cikis', (req, res) => {
  req.session = null;
  res.redirect('/');
});

/* ---------- Duyurular (anasayfa) ---------- */
function parseAnnouncement(body) {
  const type = Object.hasOwn(TYPES, body.type) ? body.type : null;
  const a = {
    type,
    title: clean(body.title, 120),
    content: clean(body.content, 5000, true),
    event_at: null,
    drop_item: null,
    memberIds: [],
  };
  if (type === 'toplanti' || type === 'etkinlik') {
    a.event_at = EVENT_RE.test(body.event_at || '') ? body.event_at : null;
  }
  if (type === 'drop') {
    a.drop_item = clean(body.drop_item, 120) || null;
    a.memberIds = [].concat(body.members || []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  }
  let error = null;
  if (!type) error = 'Geçerli bir duyuru türü seç.';
  else if (!a.title) error = 'Başlık boş olamaz.';
  return { a, error };
}

app.get('/', (req, res) => {
  const filter = Object.hasOwn(TYPES, req.query.tur) ? req.query.tur : null;
  res.render('announcements', {
    title: 'Duyurular',
    active: 'duyurular',
    filter,
    announcements: db.listAnnouncements(filter),
    counts: db.countAnnouncementsByType(),
    members: res.locals.isAdmin ? db.listMembers() : [],
  });
});

app.post('/duyurular', requireAdmin, (req, res) => {
  const { a, error } = parseAnnouncement(req.body);
  if (error) {
    setFlash(req, 'error', error);
    return res.redirect('/');
  }
  db.createAnnouncement(a);
  setFlash(req, 'success', 'Duyuru paylaşıldı.');
  res.redirect('/');
});

app.get('/duyurular/:id/duzenle', requireAdmin, parseId, (req, res) => {
  const announcement = db.getAnnouncement(req.id);
  if (!announcement) return res.status(404).render('error', { title: 'Bulunamadı', message: 'Duyuru bulunamadı.' });
  res.render('announcement-edit', {
    title: 'Duyuruyu düzenle',
    active: 'duyurular',
    announcement,
    members: db.listMembers(),
  });
});

app.post('/duyurular/:id', requireAdmin, parseId, (req, res) => {
  if (!db.getAnnouncement(req.id)) return res.redirect('/');
  const { a, error } = parseAnnouncement(req.body);
  if (error) {
    setFlash(req, 'error', error);
    return res.redirect(`/duyurular/${req.id}/duzenle`);
  }
  db.updateAnnouncement(req.id, a);
  setFlash(req, 'success', 'Duyuru güncellendi.');
  res.redirect('/');
});

app.post('/duyurular/:id/sil', requireAdmin, parseId, (req, res) => {
  db.deleteAnnouncement(req.id);
  setFlash(req, 'success', 'Duyuru silindi.');
  res.redirect(backTo(req, '/'));
});

/* ---------- Üyeler ---------- */
function parseMember(body) {
  const name = clean(body.name, 40);
  const job = JOBS.includes(body.job) ? body.job : null;
  let error = null;
  if (!name) error = 'Üye adı boş olamaz.';
  else if (!job) error = 'Geçerli bir job seç.';
  return { name, job, error };
}

function isUniqueError(err) {
  return /UNIQUE/i.test(err && err.message);
}

app.get('/uyeler', (req, res) => {
  const all = db.listMembers();
  const filter = JOBS.includes(req.query.job) ? req.query.job : null;
  const jobCounts = Object.fromEntries(JOBS.map((j) => [j, 0]));
  for (const m of all) if (m.job in jobCounts) jobCounts[m.job]++;
  res.render('members', {
    title: 'Üyeler',
    active: 'uyeler',
    filter,
    total: all.length,
    jobCounts,
    members: filter ? all.filter((m) => m.job === filter) : all,
  });
});

app.post('/uyeler', requireAdmin, (req, res) => {
  const { name, job, error } = parseMember(req.body);
  if (error) {
    setFlash(req, 'error', error);
    return res.redirect('/uyeler');
  }
  try {
    db.addMember(name, job);
    setFlash(req, 'success', `${name} eklendi.`);
  } catch (err) {
    if (!isUniqueError(err)) throw err;
    setFlash(req, 'error', `"${name}" isimli bir üye zaten var.`);
  }
  res.redirect(backTo(req, '/uyeler'));
});

app.post('/uyeler/:id', requireAdmin, parseId, (req, res) => {
  const { name, job, error } = parseMember(req.body);
  if (error) {
    setFlash(req, 'error', error);
    return res.redirect('/uyeler');
  }
  try {
    db.updateMember(req.id, name, job);
    setFlash(req, 'success', `${name} güncellendi.`);
  } catch (err) {
    if (!isUniqueError(err)) throw err;
    setFlash(req, 'error', `"${name}" isimli bir üye zaten var.`);
  }
  res.redirect(backTo(req, '/uyeler'));
});

app.post('/uyeler/:id/sil', requireAdmin, parseId, (req, res) => {
  db.deleteMember(req.id);
  setFlash(req, 'success', 'Üye silindi.');
  res.redirect(backTo(req, '/uyeler'));
});

/* ---------- 404 / Hata ---------- */
app.use((req, res) => {
  res.status(404).render('error', { title: 'Bulunamadı', active: '', message: 'Aradığın sayfa bulunamadı.' });
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).render('error', { title: 'Hata', active: '', message: 'Bir şeyler ters gitti. Tekrar dene.' });
});

app.listen(PORT, () => {
  console.log(`RedApple ${PORT} portunda çalışıyor. Veritabanı: ${db.dbPath}`);
});
