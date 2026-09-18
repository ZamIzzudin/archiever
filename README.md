# Archiever

Website archive sederhana untuk mengunggah, merapikan, dan membaca file **Markdown** (`.md`, `.markdown`) dan **HTML** (`.html`, `.htm`).

## Menjalankan

```bash
npm install
npm start        # http://localhost:3000
# atau
npm run dev      # auto-reload
```

Port bisa diubah: `PORT=8080 npm start`. Preview file disajikan dari port kedua (`PREVIEW_PORT`, default `PORT + 1`).

## Cara kerja

- **Manajemen direktori** — setiap folder di sidebar adalah folder nyata di dalam `storage/`. File tetap tersimpan rapi sesuai struktur folder aslinya.
- **Upload** — tombol *Upload* atau tarik-lepas file ke area drop. Folder upload (drag folder) akan mempertahankan struktur subfolder-nya. Hanya ekstensi `.md`, `.markdown`, `.html`, `.htm` yang diterima.
- **Viewer menyesuaikan tipe file**
  - **Markdown** → dirender jadi layout rapi (heading, list, tabel, code block) dan disanitasi agar aman dari XSS.
  - **HTML** → ditampilkan di dalam `<iframe>` dan **JavaScript-nya berjalan** (interaktif penuh).
- **Kelola file** — buat folder, pindah (dropdown *Pindah* atau drag ke baris folder), dan hapus.
- **Pencarian** — filter cepat berdasarkan nama di folder aktif.

## Deploy dengan Docker

```bash
docker compose up -d --build
```

Archive tersimpan di volume `archiever-data`, jadi data tetap ada saat container di-rebuild.

### Environment

| Variabel | Default | Keterangan |
|---|---|---|
| `PORT` | `3000` | Port app + API |
| `PREVIEW_PORT` | `PORT + 1` | Port origin preview (HTML dengan JavaScript) |
| `STORAGE_DIR` | `storage` | Lokasi penyimpanan archive di container |
| `PUBLIC_URL` | diambil dari request | URL publik app, mis. `https://archive.example.com` |
| `PREVIEW_URL` | diambil dari request | URL publik preview, mis. `https://preview.example.com` |

### Di belakang reverse proxy (HTTPS)

Server otomatis memakai `X-Forwarded-Proto`/`X-Forwarded-Host`, tapi paling aman set `PUBLIC_URL` dan `PREVIEW_URL` secara eksplisit. Tanpa ini, preview HTML akan dicoba dimuat lewat `http` dan diblokir browser sebagai mixed content.

Pastikan **dua port** diproksikan (app dan preview), misalnya dengan dua blok `server` di nginx:

- `archive.example.com` → container `:3000` (app + API)
- `preview.example.com` → container `:3001` (cukup file archive, tanpa API)

```nginx
server {
    server_name archive.example.com;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $host;
        client_max_body_size 30m;   # samakan dengan limit upload (25 MB)
    }
}

server {
    server_name preview.example.com;
    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_set_header Host $host;
    }
}
```

## Struktur

```
server.js          API Express + serving
src/store.js       manajemen filesystem & keamanan path
src/render.js      render + sanitasi Markdown
public/            UI (index.html, styles.css, app.js)
storage/           isi archive (dibuat otomatis, di-gitignore)
```

## Catatan keamanan

Semua path dinormalisasi dan dibatasi di dalam `storage/` untuk mencegah path traversal.

Supaya JavaScript pada file HTML yang diunggah bisa berjalan tanpa membahayakan archive, file disajikan dari **origin terpisah** (port preview):

- HTML berjalan penuh, aset relatif (gambar, CSS, JS, halaman lain) tetap resolve karena disajikan di root origin preview.
- Karena beda origin, script di file HTML **tidak bisa** memanggil API aplikasi (CORS memblokir), dan request yang mengubah data (upload, hapus, pindah, buat folder) ditolak bila datang dari origin preview.
- Konsekuensinya: hanya file `.md`/`.html` yang bisa masuk ke `storage/`, file pendukung seperti `.css`/`.js`/gambar belum bisa diunggah lewat UI.
