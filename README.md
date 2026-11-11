# RedApple 🍎

Knight Online **RedApple** clanı için üye listesi ve duyuru sitesi.

- **Duyurular** (anasayfa): Genel duyuru, toplantı, etkinlik ve drop duyuruları.
  Drop duyurularında, drop anında orada olan clan üyeleri işaretlenir.
- **Üyeler**: Clan üyelerinin isimleri ve job'ları (Warrior, Rogue, Mage, Priest, Kurian).
- Sayfaları herkes görebilir. **Düzenleme yalnızca admin girişiyle** yapılır.

Teknoloji: Node.js 24, Express, EJS, SQLite (Node'a gömülü `node:sqlite`).

## Lokal çalıştırma

```bash
npm install
cp .env.example .env   # içindeki kullanıcı adı / şifreyi düzenle
npm run dev
```

Site: http://localhost:3000 · Admin girişi: http://localhost:3000/giris

## Ortam değişkenleri

| Değişken | Açıklama |
| --- | --- |
| `ADMIN_USERNAME` | Admin kullanıcı adı |
| `ADMIN_PASSWORD` | Admin şifresi |
| `SESSION_SECRET` | Oturum çerezini imzalamak için uzun, rastgele bir metin |
| `DATA_DIR` | (Opsiyonel) Veritabanı klasörü. Railway'de volume yolu otomatik algılanır. |

## Railway'e kurulum

1. Bu repoyu GitHub'a push'la.
2. Railway → **New Project** → **Deploy from GitHub repo** → `RedApple` reposunu seç.
3. Servisin **Variables** sekmesine şunları ekle:
   - `ADMIN_USERNAME`
   - `ADMIN_PASSWORD`
   - `SESSION_SECRET`: rastgele bir değer, örneğin `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` çıktısı
4. **Volume ekle (önemli!)**: Servise sağ tıkla → **Attach Volume** → Mount path: `/data`.
   Volume olmazsa her deploy'da tüm üyeler ve duyurular silinir.
5. **Settings → Networking → Custom Domain** → `redapple.enesgunel.com` ekle.
   Railway'in verdiği **CNAME** kaydını domain sağlayıcının DNS ayarlarına gir
   (Host: `redapple`, Value: Railway'in verdiği adres).
6. Deploy bittikten sonra `https://redapple.enesgunel.com/giris` adresinden giriş yap.

Sağlık kontrolü için `/healthz` endpoint'i kullanılabilir.
