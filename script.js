// ===== Konfigurasi =====
// URL Web App Google Apps Script (berakhiran /exec). ISI DI SINI.
const GAS_URL = 'https://script.google.com/macros/s/AKfycbwCZmzDEwg07Pj65l2T6tD-HWwbbEkcaEM5LwwAW1yetcGnW6mQCbSqACZrGHVT7nM9/exec';

// Kanvas 4R portrait (rasio 2:3). Semua koordinat di bawah memakai ruang 1200x1800 ini.
const CANVAS_W = 1200;
const CANVAS_H = 1800;
const PHOTO_BORDER = 22;   // tebal bingkai putih di sekeliling tiap foto (px kanvas)
const IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp'];   // ekstensi yang dicoba untuk file template

/* ===== Konfigurasi Template =====
   id          : pengenal unik
   imageSrc    : file desain (taruh sejajar dengan index.html)
   maxPhotos   : jumlah jepretan (harus sama dengan jumlah item coords)
   name        : nama tema yang tampil di Home
   frameOnTop  : true  -> PNG digambar DI ATAS foto (butuh PNG dengan lubang transparan)
                 false -> PNG jadi latar, foto digambar DI ATAS PNG (untuk file tanpa transparansi)
   coords      : posisi tiap foto { x, y, width, height } dalam piksel kanvas 1200x1800
   Nilai coords di bawah adalah perkiraan dari ukuran lubang pada file saat ini. Silakan sesuaikan. */
const TEMPLATES = [
    {
        id: 'kora',
        name: "Kora's Birthday",
        imageSrc: '1_FOTO.png',
        maxPhotos: 1,
        frameOnTop: true,   // PNG punya lubang transparan -> digambar di atas foto
        // Lubang pada file: x178 y178 w1144 h1846 (skala 1500x2250) -> skala kanvas 1200x1800.
        // Diperlebar sedikit (tertutup bingkai) agar tidak ada celah di tepi.
        coords: [
            { x: 140, y: 140, width: 920, height: 1481 }
        ]
    }
];

// Peringatan dini jika jumlah koordinat tidak cocok dengan maxPhotos
TEMPLATES.forEach(t => {
    if (t.coords.length !== t.maxPhotos) {
        console.warn(`Template ${t.id}: maxPhotos=${t.maxPhotos} tapi coords berisi ${t.coords.length} item`);
    }
});

// ===== Elemen =====
const screens = {
    home:   document.getElementById('screen-home'),
    camera: document.getElementById('screen-camera'),
    final:  document.getElementById('screen-final'),
    ending: document.getElementById('screen-ending')
};
const stage          = document.getElementById('stage');
const stageOverlay   = document.getElementById('stageOverlay');
const shotIndicator  = document.getElementById('shotIndicator');
const startBtn       = document.getElementById('startBtn');
const homeError      = document.getElementById('homeError');
const videoElement   = document.getElementById('videoFeed');
const shotNumberEl   = document.getElementById('shotNumber');
const shotTotalEl    = document.getElementById('shotTotal');
const captureBtn     = document.getElementById('captureBtn');
const captureActions = document.getElementById('captureActions');
const reviewActions  = document.getElementById('reviewActions');
const retakeBtn      = document.getElementById('retakeBtn');
const nextBtn        = document.getElementById('nextBtn');
const countdownEl    = document.getElementById('countdown');
const photoCanvas    = document.getElementById('photoCanvas');
const saveBtn        = document.getElementById('saveBtn');
const saveStatus     = document.getElementById('saveStatus');
const qrModal        = document.getElementById('qrModal');
const printBtn       = document.getElementById('printBtn');
const endingBtn      = document.getElementById('endingBtn');
const endingCountdown = document.getElementById('endingCountdown');
const qrContainer    = document.getElementById('qrcode');

// ===== State =====
const state = {
    currentScreen: 'home',
    stream: null
};

let activeTemplate = TEMPLATES[0];   // template terpilih (objek dari TEMPLATES)

let fotos = [];        // hasil foto (base64 JPEG), diisi saat tombol 'Lanjut'
let currentStep = 1;   // foto ke-berapa (1..activeTemplate.maxPhotos)

// Canvas 4R portrait (rasio 2:3)
photoCanvas.width = CANVAS_W;
photoCanvas.height = CANVAS_H;

// ===== Manajemen layar: hanya satu layar aktif =====
function showScreen(name) {
    Object.entries(screens).forEach(([key, el]) => {
        el.classList.toggle('active', key === name);
    });
    state.currentScreen = name;
    // Latar bg_landing hanya untuk landing (home) dan ending
    document.body.classList.toggle('landing-bg', name === 'home' || name === 'ending');
}

// ===== Kamera =====
function stopStream() {
    if (state.stream) {
        state.stream.getTracks().forEach(track => track.stop());
        state.stream = null;
    }
    videoElement.srcObject = null;
}

async function startStream() {   // memakai kamera default perangkat
    stopStream();
    const stream = await navigator.mediaDevices.getUserMedia({
        video: {
            width: { ideal: 1920 },
            height: { ideal: 1080 }
        }
    });
    state.stream = stream;
    videoElement.srcObject = stream;
    await videoElement.play();
}

// ===== Mulai Foto: Screen 1 -> nyalakan kamera -> Screen 2 =====
startBtn.addEventListener('click', async () => {
    homeError.classList.add('hidden');
    startBtn.disabled = true;

    try {
        await loadTemplateImage(activeTemplate);          // pastikan file template ada
        stageOverlay.src = encodeURI(activeTemplate.imageSrc);
        resetCaptureFlow();

        await startStream();                     // kamera menyala dulu
        showScreen('camera');                    // baru pindah layar
    } catch (err) {
        console.error('Gagal menyalakan kamera:', err);
        homeError.textContent = err.message.startsWith('File template')
            ? err.message
            : 'Kamera tidak bisa dinyalakan. Periksa izin kamera di browser.';
        homeError.classList.remove('hidden');
    } finally {
        startBtn.disabled = false;
    }
});

// ===== Alur 4 foto di Screen 2 =====
// Dua mode tombol: 'live' (Ambil Foto) dan 'review' (Ulangi Foto Ini + Lanjut)
function setMode(mode) {
    captureActions.classList.toggle('is-hidden', mode !== 'live');
    reviewActions.classList.toggle('is-hidden', mode !== 'review');
}

function updateIndicator() {
    shotNumberEl.textContent = currentStep;
}

let countdownTimer = null;
const COUNTDOWN_SECONDS = 3;

function cancelCountdown() {
    clearInterval(countdownTimer);
    countdownTimer = null;
    countdownEl.classList.add('is-hidden');
    captureBtn.disabled = false;
}

// Slot foto untuk step saat ini, beserta rasionya (lebar / tinggi)
function currentSlot() { return activeTemplate.coords[currentStep - 1]; }
function currentRatio() { const c = currentSlot(); return c.width / c.height; }

// Letakkan video + hitung mundur tepat di lubang template (dalam persen dari panggung)
function applyVideoRatio() {
    const c = currentSlot();
    const box = {
        left:   (c.x / CANVAS_W * 100) + '%',
        top:    (c.y / CANVAS_H * 100) + '%',
        width:  (c.width / CANVAS_W * 100) + '%',
        height: (c.height / CANVAS_H * 100) + '%'
    };
    Object.assign(videoElement.style, box);
    Object.assign(countdownEl.style, box);
    stageOverlay.classList.toggle('is-hidden', !activeTemplate.frameOnTop);   // PNG di atas video
}

function resetCaptureFlow() {
    cancelCountdown();
    fotos = [];
    currentStep = 1;
    shotTotalEl.textContent = activeTemplate.maxPhotos;
    shotIndicator.classList.toggle('is-hidden', activeTemplate.maxPhotos === 1);
    applyVideoRatio();
    updateIndicator();
    setMode('live');
}

// Ambil frame video sebagai base64 JPEG, di-crop tengah ke rasio lubang foto pada step ini.
// Rumusnya sama dengan object-fit: cover pada kotak video, jadi hasilnya
// identik dengan yang terlihat di layar (termasuk mirror untuk kamera depan).
function grabFrame() {
    const ratio = currentRatio();
    const vw = videoElement.videoWidth;
    const vh = videoElement.videoHeight;

    let cropW, cropH;
    if (vw / vh > ratio) {      // video lebih lebar -> potong kiri & kanan
        cropH = vh;
        cropW = vh * ratio;
    } else {                          // video lebih tinggi -> potong atas & bawah
        cropW = vw;
        cropH = vw / ratio;
    }
    const sx = (vw - cropW) / 2;
    const sy = (vh - cropH) / 2;

    const c = document.createElement('canvas');
    c.width = Math.round(cropW);
    c.height = Math.round(cropH);
    const cx = c.getContext('2d');

    if (videoElement.classList.contains('scale-x-[-1]')) {
        cx.translate(c.width, 0);
        cx.scale(-1, 1);
    }
    cx.drawImage(videoElement, sx, sy, cropW, cropH, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.92);
}

// Ambil Foto: hitung mundur 3-2-1, lalu bekukan video dan tampilkan Ulangi / Lanjut
captureBtn.addEventListener('click', () => {
    if (countdownTimer) return;          // cegah klik ganda saat hitung mundur berjalan
    captureBtn.disabled = true;

    let count = COUNTDOWN_SECONDS;
    countdownEl.textContent = count;
    countdownEl.classList.remove('is-hidden');

    countdownTimer = setInterval(() => {
        count--;
        if (count > 0) {
            countdownEl.textContent = count;
        } else {
            cancelCountdown();
            videoElement.pause();
            setMode('review');
        }
    }, 1000);
});

// Ulangi Foto Ini: hanya step saat ini, tidak ada akses ke foto sebelumnya
retakeBtn.addEventListener('click', () => {
    videoElement.play();
    setMode('live');
});

// Lanjut: simpan frame ke array, naik ke step berikutnya (tidak bisa kembali)
nextBtn.addEventListener('click', () => {
    nextBtn.disabled = true;
    fotos.push(grabFrame());
    nextBtn.disabled = false;

    if (currentStep < activeTemplate.maxPhotos) {
        currentStep++;
        applyVideoRatio();
        updateIndicator();
        videoElement.play();
        setMode('live');
    } else {
        onAllPhotosTaken();
    }
});

// ===== Screen 3: render hasil akhir =====
function loadImage(src) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error(src.startsWith('data:') ? 'Gagal memuat foto hasil jepretan' : `File tidak ditemukan: ${src}`));
        img.src = src.startsWith('data:') ? src : encodeURI(src);   // aman untuk nama file ber-spasi
    });
}

// Muat file desain template. Jika ekstensi berbeda (jpg/jpeg/png/webp), coba varian lain.
async function loadTemplateImage(tpl) {
    const base = tpl.imageSrc.replace(/\.[^./]+$/, '');
    const candidates = [tpl.imageSrc, ...IMAGE_EXTENSIONS.map(e => `${base}.${e}`)];
    for (const candidate of [...new Set(candidates)]) {
        try {
            const img = await loadImage(candidate);
            tpl.imageSrc = candidate;      // simpan nama file yang ternyata benar
            return img;
        } catch (e) { /* coba kandidat berikutnya */ }
    }
    throw new Error(`File template tidak ditemukan: ${base}.(jpg/jpeg/png/webp) di folder yang sama dengan index.html`);
}

// Muat logo tema; jika tidak ketemu, kembalikan null (hasil foto tetap dibuat tanpa logo)
async function loadLogoImage(logo) {
    const base = logo.src.replace(/\.[^./]+$/, '');
    const candidates = [logo.src, ...IMAGE_EXTENSIONS.map(e => `${base}.${e}`)];
    for (const candidate of [...new Set(candidates)]) {
        try {
            const img = await loadImage(candidate);
            logo.src = candidate;
            return img;
        } catch (e) { /* coba kandidat berikutnya */ }
    }
    console.warn(`Logo tidak ditemukan: ${base}.(png/jpg/jpeg/webp)`);
    return null;
}

// Gambar img ke kotak (x, y, w, h) dengan center-crop agar tidak gepeng
function drawCover(c, img, x, y, w, h) {
    const scale = Math.max(w / img.width, h / img.height);
    const sw = w / scale;
    const sh = h / scale;
    c.drawImage(img, (img.width - sw) / 2, (img.height - sh) / 2, sw, sh, x, y, w, h);
}

async function renderFinalCanvas() {
    const c = photoCanvas.getContext('2d');
    const tpl = activeTemplate;

    // Muat foto hasil jepretan + file desain template
    const [photoImgs, templateImg, logoImg] = await Promise.all([
        Promise.all(fotos.map(loadImage)),
        loadTemplateImage(tpl),
        tpl.logo ? loadLogoImage(tpl.logo) : Promise.resolve(null)
    ]);

    c.fillStyle = '#FFFFFF';
    c.fillRect(0, 0, CANVAS_W, CANVAS_H);

    // Bingkai putih bergaya foto cetak dengan bayangan lembut, agar foto terpisah rapi dari latar
    const drawPhotoFrame = (slot) => {
        const b = PHOTO_BORDER;
        const fx = slot.x - b, fy = slot.y - b;
        const fw = slot.width + b * 2, fh = slot.height + b * 2;
        c.save();
        c.shadowColor = 'rgba(0, 0, 0, 0.35)';
        c.shadowBlur = 28;
        c.shadowOffsetY = 8;
        c.fillStyle = '#FFFFFF';
        c.beginPath();
        if (c.roundRect) c.roundRect(fx, fy, fw, fh, 10); else c.rect(fx, fy, fw, fh);
        c.fill();
        c.restore();
    };

    const drawPhotos = () => {
        photoImgs.forEach((img, i) => {
            const slot = tpl.coords[i];
            if (!tpl.frameOnTop) drawPhotoFrame(slot);   // bingkai hanya jika desain tidak punya lubang
            drawCover(c, img, slot.x, slot.y, slot.width, slot.height);
        });
    };
    // Logo digambar apa adanya (sudah transparan + border putih), paling akhir agar menimpa tepi foto
    const drawLogo = () => {
        if (!logoImg || !tpl.logo) return;
        const { x, y, size } = tpl.logo;
        const scale = Math.min(size / logoImg.width, size / logoImg.height);
        const w = logoImg.width * scale;
        const h = logoImg.height * scale;
        c.save();
        c.shadowColor = 'rgba(0, 0, 0, 0.3)';   // bayangan tipis mengikuti bentuk logo
        c.shadowBlur = 20;
        c.shadowOffsetY = 6;
        c.drawImage(logoImg, x - w / 2, y - h / 2, w, h);
        c.restore();
    };

    const drawTemplate = () => c.drawImage(templateImg, 0, 0, CANVAS_W, CANVAS_H);

    if (tpl.frameOnTop) {
        drawPhotos();     // foto dulu, PNG transparan membingkai di atasnya
        drawTemplate();
    } else {
        drawTemplate();   // desain sebagai latar, foto mengisi lubangnya
        drawPhotos();
    }
    drawLogo();           // logo selalu terakhir (di atas foto dan desain)
}

// Dipanggil setelah jepretan terakhir tersimpan (fotos.length === activeTemplate.maxPhotos)
async function onAllPhotosTaken() {
    stopStream();
    try {
        resetFinalScreen();
        await renderFinalCanvas();   // render dulu agar Screen 3 tidak tampil kosong
        showScreen('final');         // Screen 2 disembunyikan, Screen 3 tampil
    } catch (err) {
        console.error('Gagal membuat hasil akhir:', err);
        alert('Gagal membuat hasil foto.\n' + err.message + '\nSilakan ulangi sesi.');
        showScreen('home');
    }
}

// ===== Simpan & Cetak =====
const SAVE_LABEL = '💾 Simpan';
let endingTimer = null;
let awaitingPrint = false;

function resetFinalScreen() {
    clearInterval(endingTimer);
    awaitingPrint = false;
    saveBtn.classList.remove('is-hidden');
    saveBtn.disabled = false;
    saveBtn.innerHTML = SAVE_LABEL;
    saveStatus.classList.add('is-hidden');
    qrModal.classList.add('is-hidden');
    qrContainer.innerHTML = '';
}

function showSaveError(message) {
    saveBtn.disabled = false;
    saveBtn.innerHTML = SAVE_LABEL;
    saveStatus.textContent = message;
    saveStatus.classList.remove('is-hidden');
}

saveBtn.addEventListener('click', async () => {
    saveStatus.classList.add('is-hidden');

    if (!GAS_URL) {
        showSaveError('URL Apps Script belum diisi. Isi konstanta GAS_URL di index.html.');
        return;
    }

    saveBtn.disabled = true;
    saveBtn.textContent = 'Loading...';

    // Batalkan otomatis jika server tidak menjawab dalam 60 detik
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), 60000);

    try {
        const base64Image = photoCanvas.toDataURL('image/jpeg', 0.85);
        const filename = `photobooth_${Date.now()}.jpg`;
        console.log('Mengirim foto, ukuran data:', Math.round(base64Image.length / 1024), 'KB');
        console.time('upload-gas');

        // text/plain menghindari preflight CORS yang tidak didukung Apps Script
        const response = await fetch(GAS_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify({ base64_image: base64Image, filename }),
            signal: controller.signal
        });
        console.timeEnd('upload-gas');
        console.log('Status response:', response.status);
        if (!response.ok) throw new Error(`Server membalas status ${response.status}`);

        const result = await response.json();
        console.log('Response GAS:', result);
        if (!result.success || !result.url) {
            throw new Error(result.error || 'Gagal menyimpan ke Drive.');
        }

        showSuccess(result.url);
    } catch (err) {
        console.error('Gagal menyimpan foto:', err);
        const msg = err.name === 'AbortError'
            ? 'Server tidak menjawab dalam 60 detik. Cek Drive, lalu coba lagi.'
            : 'Gagal menyimpan: ' + err.message;
        showSaveError(msg);
    } finally {
        clearTimeout(abortTimer);
    }
});

// Simpan berhasil: tampilkan popup bubble berisi QR Code + tombol Lanjut Cetak (belum mencetak)
function showSuccess(imageUrl) {
    saveBtn.classList.add('is-hidden');            // loading selesai
    qrContainer.innerHTML = '';
    new QRCode(qrContainer, {
        text: imageUrl,
        width: 220,
        height: 220,
        correctLevel: QRCode.CorrectLevel.M
    });
    qrModal.classList.remove('is-hidden');
}

// Lanjut Cetak: popup ditutup, cetak, lalu ke layar ending
printBtn.addEventListener('click', () => {
    qrModal.classList.add('is-hidden');
    awaitingPrint = true;
    window.print();
    setTimeout(() => { if (awaitingPrint) showEnding(); }, 1500);   // cadangan jika afterprint tidak terpicu
});
window.addEventListener('afterprint', () => { if (awaitingPrint) showEnding(); });

// Layar ending: kembali otomatis ke landing setelah beberapa detik
const ENDING_SECONDS = 10;
function showEnding() {
    awaitingPrint = false;
    showScreen('ending');
    let left = ENDING_SECONDS;
    endingCountdown.textContent = `Kembali ke awal dalam ${left} detik`;
    clearInterval(endingTimer);
    endingTimer = setInterval(() => {
        left--;
        if (left <= 0) { backToHome(); }
        else { endingCountdown.textContent = `Kembali ke awal dalam ${left} detik`; }
    }, 1000);
}

function backToHome() {
    clearInterval(endingTimer);
    resetFinalScreen();
    showScreen('home');
}
endingBtn.addEventListener('click', backToHome);