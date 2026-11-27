/**
 * OKUL PANELİ — Google Apps Script web uygulaması
 * Giriş: uygulamanın kendi şifresi (Gmail girişi gerekmez)
 * Veriler: Google Drive > "Okul Paneli" klasörü
 *   - veri.json          → program, ajanda, defter
 *   - Dosyalar/          → yüklediğin dosyalar
 *   - Yedekler/          → her gün otomatik bir yedek (son 30 gün)
 */

const APP_FOLDER = 'Okul Paneli';
const FILES_FOLDER = 'Dosyalar';
const BACKUP_FOLDER = 'Yedekler';
const DATA_FILE = 'veri.json';
const TZ = 'Europe/Istanbul';
const SALT = 'okulpaneli-v1';
// İlk şifrenin özeti (şifrenin kendisi kodda yok). Uygulamada Ayarlar'dan değiştirilir.
const DEFAULT_HASH = 'ibOqysJb1CP4gsJCMGSfVp3gQorCFpR32PQozCbkacY=';
const ICON = 'https://raw.githubusercontent.com/tahsinketmez-maker/englishwithtahsin/okul-panel-logo/okul-panel/okul-panel-icon-192.png';

function doGet() {
  return HtmlService.createHtmlOutputFromFile('index')
    .setTitle('Okul Paneli')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .addMetaTag('mobile-web-app-capable', 'yes')
    .setFaviconUrl(ICON);
}

/* ---------- Şifre ---------- */

function hash_(s) {
  return Utilities.base64Encode(
    Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, SALT + s, Utilities.Charset.UTF_8));
}

function yetki_(pass) {
  const cache = CacheService.getScriptCache();
  const hatali = Number(cache.get('hatali') || 0);
  if (hatali >= 10) throw new Error('Çok fazla hatalı deneme. 15 dakika sonra tekrar dene.');
  const dogru = PropertiesService.getScriptProperties().getProperty('PASS_HASH') || DEFAULT_HASH;
  if (!pass || hash_(String(pass)) !== dogru) {
    cache.put('hatali', String(hatali + 1), 900);
    throw new Error('Şifre yanlış.');
  }
}

function girisKontrol(pass) { yetki_(pass); return true; }

function sifreDegistir(pass, yeni) {
  yetki_(pass);
  yeni = String(yeni || '');
  if (yeni.length < 8) throw new Error('Yeni şifre en az 8 karakter olmalı.');
  PropertiesService.getScriptProperties().setProperty('PASS_HASH', hash_(yeni));
  return true;
}

/* ---------- Klasör / dosya yardımcıları (ID'ler önbelleğe alınır) ---------- */

function klasor_(key, name, parent) {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty(key);
  if (id) {
    try {
      const f = DriveApp.getFolderById(id);
      if (!f.isTrashed()) return f;
    } catch (e) { /* silinmiş, yeniden oluştur */ }
  }
  const p = parent || DriveApp.getRootFolder();
  const it = p.getFoldersByName(name);
  const f = it.hasNext() ? it.next() : p.createFolder(name);
  props.setProperty(key, f.getId());
  return f;
}

function appFolder_()    { return klasor_('APP_FOLDER_ID', APP_FOLDER); }
function filesFolder_()  { return klasor_('FILES_FOLDER_ID', FILES_FOLDER, appFolder_()); }
function backupFolder_() { return klasor_('BACKUP_FOLDER_ID', BACKUP_FOLDER, appFolder_()); }

function dataFile_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('DATA_FILE_ID');
  if (id) {
    try {
      const f = DriveApp.getFileById(id);
      if (!f.isTrashed()) return f;
    } catch (e) { /* yeniden oluştur */ }
  }
  const folder = appFolder_();
  const it = folder.getFilesByName(DATA_FILE);
  const f = it.hasNext() ? it.next() : folder.createFile(DATA_FILE, '{}', MimeType.PLAIN_TEXT);
  props.setProperty('DATA_FILE_ID', f.getId());
  return f;
}

function evrakRoot_() { return klasor_('EVRAK_ROOT_ID', 'Evraklar', appFolder_()); }

const VARSAYILAN_EVRAK = ['Zümre', 'Yıllık Plan', 'Yılsonu Evrakları', 'Yazılılar', 'Kulüp'];

function kategoriKlasoru_(ad, olustur) {
  ad = String(ad || '').trim();
  if (!ad) throw new Error('Bölüm adı boş olamaz.');
  const root = evrakRoot_();
  const it = root.getFoldersByName(ad);
  if (it.hasNext()) return it.next();
  if (olustur) return root.createFolder(ad);
  throw new Error('Bölüm bulunamadı: ' + ad);
}

// Dosya ya Dosyalar klasöründe ya da Evraklar altındaki bir bölüm klasöründe olmalı
function panelDosyasi_(id) {
  const f = DriveApp.getFileById(id);
  const dosyalarId = filesFolder_().getId(), evrakId = evrakRoot_().getId();
  const parents = f.getParents();
  while (parents.hasNext()) {
    const p = parents.next();
    if (p.getId() === dosyalarId) return f;
    const ust = p.getParents();
    while (ust.hasNext()) if (ust.next().getId() === evrakId) return f;
  }
  throw new Error('Bu dosya Okul Paneli klasöründe değil.');
}

function hedefKlasor_(kategori) {
  return kategori ? kategoriKlasoru_(kategori, false) : filesFolder_();
}

/* ---------- Veri ---------- */

function loadData(pass) {
  yetki_(pass);
  return dataFile_().getBlob().getDataAsString('UTF-8') || '{}';
}

function saveData(pass, json) {
  yetki_(pass);
  JSON.parse(json); // bozuk veri asla kaydedilmez
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const file = dataFile_();
    gunlukYedek_(file);
    file.setContent(json);
    return new Date().toISOString();
  } finally {
    lock.releaseLock();
  }
}

function gunlukYedek_(file) {
  const folder = backupFolder_();
  const ad = 'yedek-' + Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd') + '.json';
  if (folder.getFilesByName(ad).hasNext()) return;
  folder.createFile(ad, file.getBlob().getDataAsString('UTF-8'), MimeType.PLAIN_TEXT);
  const list = [];
  const it = folder.getFiles();
  while (it.hasNext()) list.push(it.next());
  list.sort((a, b) => b.getName().localeCompare(a.getName()));
  list.slice(30).forEach(f => f.setTrashed(true));
}

/* ---------- Dosyalar ---------- */

/* ---------- Evraklar ---------- */

function listEvrak(pass) {
  yetki_(pass);
  const props = PropertiesService.getScriptProperties();
  const root = evrakRoot_();
  if (!props.getProperty('EVRAK_KURULDU')) {
    VARSAYILAN_EVRAK.forEach(ad => { if (!root.getFoldersByName(ad).hasNext()) root.createFolder(ad); });
    props.setProperty('EVRAK_KURULDU', '1');
  }
  const out = [];
  const it = root.getFolders();
  while (it.hasNext()) {
    const k = it.next();
    let sayi = 0; const fi = k.getFiles(); while (fi.hasNext()) { fi.next(); sayi++; }
    out.push({ ad: k.getName(), sayi: sayi, tarih: k.getDateCreated().toISOString() });
  }
  const sira = ad => { const i = VARSAYILAN_EVRAK.indexOf(ad); return i < 0 ? 99 : i; };
  out.sort((a, b) => sira(a.ad) - sira(b.ad) || a.tarih.localeCompare(b.tarih));
  return out;
}

function evrakKategoriEkle(pass, ad) {
  yetki_(pass);
  ad = String(ad || '').trim().replace(/[\/\\]/g, '-').slice(0, 40);
  if (!ad) throw new Error('Bölüm adı boş olamaz.');
  if (evrakRoot_().getFoldersByName(ad).hasNext()) throw new Error('Bu isimde bir bölüm zaten var.');
  kategoriKlasoru_(ad, true);
  return listEvrak(pass);
}

function evrakKategoriSil(pass, ad) {
  yetki_(pass);
  const k = kategoriKlasoru_(ad, false);
  if (k.getFiles().hasNext()) throw new Error('Bölümde dosya var. Önce dosyaları sil.');
  k.setTrashed(true);
  return listEvrak(pass);
}

/* ---------- Dosyalar ---------- */

function listFiles(pass, kategori) {
  yetki_(pass);
  const out = [];
  const it = hedefKlasor_(kategori).getFiles();
  while (it.hasNext()) {
    const f = it.next();
    out.push({
      id: f.getId(),
      name: f.getName(),
      size: f.getSize(),
      date: f.getLastUpdated().toISOString(),
      mime: f.getMimeType(),
      etiket: f.getDescription() || ''
    });
  }
  out.sort((a, b) => b.date.localeCompare(a.date));
  return out;
}

function uploadFile(pass, name, mime, base64, etiket, kategori) {
  yetki_(pass);
  const blob = Utilities.newBlob(
    Utilities.base64Decode(base64),
    mime || 'application/octet-stream',
    name
  );
  const f = hedefKlasor_(kategori).createFile(blob);
  if (etiket) f.setDescription(etiket);
  return listFiles(pass, kategori);
}

function getFile(pass, id) {
  yetki_(pass);
  const f = panelDosyasi_(id);
  let blob;
  try { blob = f.getBlob(); } catch (e) { throw new Error('Bu dosya türü panelden açılamıyor.'); }
  return { name: f.getName(), mime: blob.getContentType(), b64: Utilities.base64Encode(blob.getBytes()) };
}

// Word / Excel / PowerPoint dosyalarını önizleme için PDF'e çevirir
const DONUSUM = {
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': MimeType.GOOGLE_DOCS,
  'application/msword': MimeType.GOOGLE_DOCS,
  'application/vnd.oasis.opendocument.text': MimeType.GOOGLE_DOCS,
  'application/rtf': MimeType.GOOGLE_DOCS,
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': MimeType.GOOGLE_SHEETS,
  'application/vnd.ms-excel': MimeType.GOOGLE_SHEETS,
  'application/vnd.oasis.opendocument.spreadsheet': MimeType.GOOGLE_SHEETS,
  'text/csv': MimeType.GOOGLE_SHEETS,
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': MimeType.GOOGLE_SLIDES,
  'application/vnd.ms-powerpoint': MimeType.GOOGLE_SLIDES,
  'application/vnd.oasis.opendocument.presentation': MimeType.GOOGLE_SLIDES
};

function getPreview(pass, id) {
  yetki_(pass);
  const f = panelDosyasi_(id);
  const mime = f.getMimeType();
  if (mime.indexOf('application/vnd.google-apps.') === 0) {
    return { b64: Utilities.base64Encode(f.getAs('application/pdf').getBytes()) };
  }
  const hedef = DONUSUM[mime];
  if (!hedef) return null;
  const kopya = Drive.Files.copy({ name: 'onizleme-gecici', mimeType: hedef }, id);
  try {
    return { b64: Utilities.base64Encode(DriveApp.getFileById(kopya.id).getAs('application/pdf').getBytes()) };
  } finally {
    DriveApp.getFileById(kopya.id).setTrashed(true);
  }
}

function deleteFile(pass, id, kategori) {
  yetki_(pass);
  panelDosyasi_(id).setTrashed(true); // Drive çöp kutusuna gider, 30 gün geri alınabilir
  return listFiles(pass, kategori);
}
