'use strict';

const ExcelJS = require('exceljs');

const TIME_ZONE = 'Europe/Istanbul';
const DATE_FMT = 'dd.mm.yyyy hh:mm';
const EVENT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

// Excel'de saat dilimi yoktur; tarihleri İstanbul saatiyle "duvar saati" olarak yazıyoruz.
function eventDate(value) {
  const m = EVENT_RE.exec(value || '');
  return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5])) : null;
}

function createdDate(value) {
  if (!value) return null;
  const utc = new Date(value.replace(' ', 'T') + 'Z');
  const local = utc.toLocaleString('sv-SE', { timeZone: TIME_ZONE, hour12: false }); // "YYYY-MM-DD HH:MM:SS"
  return new Date(local.replace(' ', 'T') + 'Z');
}

function addSheet(wb, name, columns, rows) {
  const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = columns.map((c) => ({ header: c.header, key: c.key, width: c.width || 18 }));
  for (const c of columns) {
    if (c.date) ws.getColumn(c.key).numFmt = DATE_FMT;
    if (c.wrap) ws.getColumn(c.key).alignment = { wrapText: true, vertical: 'top' };
  }
  ws.addRows(rows);

  const header = ws.getRow(1);
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFC8323C' } };
  header.alignment = { vertical: 'middle' };
  header.height = 22;
  if (rows.length > 0) {
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
  }
  return ws;
}

async function buildWorkbook({ members, announcements }) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'RedApple';
  wb.created = new Date();

  const byType = (t) => announcements.filter((a) => a.type === t);
  const drops = byType('drop');

  // Her üyenin kaç drop'ta bulunduğu
  const dropCount = new Map();
  for (const d of drops) for (const at of d.attendees) {
    if (at.member_id) dropCount.set(at.member_id, (dropCount.get(at.member_id) || 0) + 1);
  }

  addSheet(
    wb,
    'Üyeler',
    [
      { header: 'Ad', key: 'name', width: 24 },
      { header: 'Job', key: 'job', width: 14 },
      { header: 'Bulunduğu drop sayısı', key: 'drops', width: 22 },
      { header: 'Eklenme tarihi', key: 'created', width: 18, date: true },
    ],
    members.map((m) => ({ name: m.name, job: m.job, drops: dropCount.get(m.id) || 0, created: createdDate(m.created_at) }))
  );

  const eventColumns = [
    { header: 'Başlık', key: 'title', width: 36 },
    { header: 'Tarih / saat', key: 'when', width: 18, date: true },
    { header: 'Açıklama', key: 'content', width: 60, wrap: true },
    { header: 'Paylaşım tarihi', key: 'created', width: 18, date: true },
  ];
  const eventRow = (a) => ({ title: a.title, when: eventDate(a.event_at), content: a.content, created: createdDate(a.created_at) });

  addSheet(wb, 'Toplantılar', eventColumns, byType('toplanti').map(eventRow));
  addSheet(wb, 'Etkinlikler', eventColumns, byType('etkinlik').map(eventRow));

  addSheet(
    wb,
    'Droplar',
    [
      { header: 'Başlık', key: 'title', width: 30 },
      { header: 'Item', key: 'item', width: 26 },
      { header: 'Orada olan sayısı', key: 'count', width: 18 },
      { header: 'Orada olanlar', key: 'who', width: 50, wrap: true },
      { header: 'Açıklama', key: 'content', width: 40, wrap: true },
      { header: 'Paylaşım tarihi', key: 'created', width: 18, date: true },
    ],
    drops.map((d) => ({
      title: d.title,
      item: d.drop_item || '',
      count: d.attendees.length,
      who: d.attendees.map((a) => a.name).join(', '),
      content: d.content,
      created: createdDate(d.created_at),
    }))
  );

  // Her satır bir (drop, üye) eşleşmesi: Excel'de filtrelemek ve pivot için kullanışlı
  const participation = [];
  for (const d of drops) for (const a of d.attendees) {
    participation.push({
      created: createdDate(d.created_at),
      title: d.title,
      item: d.drop_item || '',
      name: a.name,
      job: a.job || '',
      status: a.member_id ? 'Clanda' : 'Ayrıldı',
    });
  }
  addSheet(
    wb,
    'Drop Katılımları',
    [
      { header: 'Drop tarihi', key: 'created', width: 18, date: true },
      { header: 'Drop', key: 'title', width: 30 },
      { header: 'Item', key: 'item', width: 26 },
      { header: 'Üye', key: 'name', width: 24 },
      { header: 'Job', key: 'job', width: 14 },
      { header: 'Durum', key: 'status', width: 12 },
    ],
    participation
  );

  addSheet(
    wb,
    'Duyurular',
    [
      { header: 'Başlık', key: 'title', width: 36 },
      { header: 'Açıklama', key: 'content', width: 70, wrap: true },
      { header: 'Paylaşım tarihi', key: 'created', width: 18, date: true },
    ],
    byType('genel').map((a) => ({ title: a.title, content: a.content, created: createdDate(a.created_at) }))
  );

  return wb;
}

module.exports = { buildWorkbook };
