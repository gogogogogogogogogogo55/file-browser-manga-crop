// ==UserScript==
// @name         File Browser Manga Auto Crop v7 (Dual White/Black Mode)
// @namespace    manga-auto-crop
// @version      1.0.0
// @description  白背景・黒背景の余白（スキャン黒枠・黒ベタ）を完全自動判別し、コマ枠やスキャン線を高精度に切り取り
// @match        https://files.example.com/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(() => {
    'use strict';

    /* ==========================================================================
       設定パラメータ
       ========================================================================== */

    // 解析解像度（幅px）。高速性と精度の黄金比
    const ANALYZE_WIDTH = 480;

    // 白背景モード時の色差許容値
    const COLOR_TOLERANCE_WHITE = 36;

    // 黒背景モード時の暗部閾値（これ以下の輝度はすべて黒余白とみなす）
    const BLACK_BG_MAX_LUM = 50;

    // モルフォロジー収縮半径（スキャン線・斑点ゴミを消滅させる強度）
    const ERODE_RADIUS = 2;

    // トリミング後に周囲に残す余白マージン（元画像px換算）
    const KEEP_PADDING = 1;

    // 最低トリミング率（0.5%以上の変化がない画像はスキップ）
    const MIN_TRIM_RATIO = 0.005;

    // 処理対象の画像拡張子
    const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.gif'];

    /* ==========================================================================
       ユーティリティ関数
       ========================================================================== */

    function isImageUrl(url) {
        try {
            const pathname = new URL(url, location.href).pathname.toLowerCase();
            return IMAGE_EXTENSIONS.some(ext => pathname.endsWith(ext));
        } catch {
            return false;
        }
    }

    function colorDist(r1, g1, b1, r2, g2, b2) {
        return Math.abs(r1 - r2) + Math.abs(g1 - g2) + Math.abs(b1 - b2);
    }

    function getLuminance(r, g, b) {
        return 0.299 * r + 0.587 * g + 0.114 * b;
    }

    /*
     * 画像の四辺から真の背景色（白/黒/グレー）を自動推定
     */
    function detectBackgroundColor(data, w, h) {
        const samples = [];
        const push = (x, y) => {
            const i = (y * w + x) * 4;
            if (data[i + 3] < 10) return;
            samples.push([data[i], data[i + 1], data[i + 2]]);
        };

        const steps = 24;
        for (let k = 0; k <= steps; k++) {
            const t = k / steps;
            const x = Math.round(t * (w - 1));
            const y = Math.round(t * (h - 1));
            push(x, 0); push(x, h - 1);       // 上辺・下辺
            push(0, y); push(w - 1, y);       // 左辺・右辺
        }

        if (samples.length === 0) return null;

        // 最多一致クラスタを探索
        let best = samples[0], maxCount = -1;
        for (const s of samples) {
            let count = 0;
            for (const t of samples) {
                if (colorDist(s[0], s[1], s[2], t[0], t[1], t[2]) <= 40) count++;
            }
            if (count > maxCount) {
                maxCount = count;
                best = s;
            }
        }

        let r = 0, g = 0, b = 0, n = 0;
        for (const s of samples) {
            if (colorDist(s[0], s[1], s[2], best[0], best[1], best[2]) <= 40) {
                r += s[0]; g += s[1]; b += s[2]; n++;
            }
        }
        return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
    }

    /*
     * モルフォロジー収縮（Erosion）: スキャン線・斑点ゴミを完全消去
     */
    function morphologyErode(bin, w, h, radius) {
        const out = new Uint8Array(w * h);
        for (let y = radius; y < h - radius; y++) {
            const yBase = y * w;
            for (let x = radius; x < w - radius; x++) {
                const idx = yBase + x;
                if (!bin[idx]) continue;

                let allActive = true;
                for (let dy = -radius; dy <= radius && allActive; dy++) {
                    const checkRow = (y + dy) * w;
                    for (let dx = -radius; dx <= radius; dx++) {
                        if (!bin[checkRow + (x + dx)]) {
                            allActive = false;
                            break;
                        }
                    }
                }
                if (allActive) {
                    out[idx] = 1;
                }
            }
        }
        return out;
    }

    /* ==========================================================================
       画像トリミング・コア処理
       ========================================================================== */

    function processImageCore(img) {
        if (!img || !img.isConnected) return;
        if (img.dataset.mangaCropDone === '1' || img.dataset.mangaCropProcessing === '1') return;
        if (!isImageUrl(img.currentSrc || img.src)) return;
        if (!img.complete || img.naturalWidth === 0) return;

        const origW = img.naturalWidth;
        const origH = img.naturalHeight;

        img.dataset.mangaCropProcessing = '1';

        try {
            // 1. 高速解析用に縮小
            const scale = Math.min(1, ANALYZE_WIDTH / origW);
            const w = Math.max(1, Math.round(origW * scale));
            const h = Math.max(1, Math.round(origH * scale));

            const canvas = document.createElement('canvas');
            canvas.width = w;
            canvas.height = h;
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            if (!ctx) throw new Error('Canvas context failure');

            ctx.drawImage(img, 0, 0, w, h);
            const imgData = ctx.getImageData(0, 0, w, h).data;

            // 2. 背景色推定 & 白/黒モード判定
            const bg = detectBackgroundColor(imgData, w, h);
            if (!bg) {
                img.dataset.mangaCropDone = '1';
                return;
            }
            const [bgR, bgG, bgB] = bg;
            const bgLum = getLuminance(bgR, bgG, bgB);
            const isBlackBg = bgLum < 100; // 背景輝度100未満を黒背景モードと判定

            // 3. モード別二値化（前景=1, 背景=0）
            const binary = new Uint8Array(w * h);

            if (!isBlackBg) {
                // 【白背景モード】白背景と異なる色（線・トーン・ベタ）を前景とする
                for (let i = 0, p = 0; i < w * h; i++, p += 4) {
                    if (imgData[p + 3] < 10) { binary[i] = 0; continue; }
                    binary[i] = colorDist(imgData[p], imgData[p + 1], imgData[p + 2], bgR, bgG, bgB) > COLOR_TOLERANCE_WHITE ? 1 : 0;
                }
            } else {
                // 【黒背景モード】黒余白より明るい領域（漫画の紙地・コマ内）を前景とする
                const thresholdLum = Math.max(BLACK_BG_MAX_LUM, bgLum + 25);
                for (let i = 0, p = 0; i < w * h; i++, p += 4) {
                    if (imgData[p + 3] < 10) { binary[i] = 0; continue; }
                    const lum = getLuminance(imgData[p], imgData[p + 1], imgData[p + 2]);
                    binary[i] = lum > thresholdLum ? 1 : 0;
                }
            }

            // 4. モルフォロジー収縮（スキャン線・ゴミの消滅）
            const eroded = morphologyErode(binary, w, h, ERODE_RADIUS);

            // 5. 生き残ったコンテンツの核（Core）からバウンディングボックスを計算
            let minX = w, minY = h, maxX = -1, maxY = -1;
            let activeCorePixels = 0;

            for (let y = 0; y < h; y++) {
                const row = y * w;
                for (let x = 0; x < w; x++) {
                    if (eroded[row + x]) {
                        activeCorePixels++;
                        if (x < minX) minX = x;
                        if (x > maxX) maxX = x;
                        if (y < minY) minY = y;
                        if (y > maxY) maxY = y;
                    }
                }
            }

            if (activeCorePixels < 80 || maxX < 0) {
                img.dataset.mangaCropDone = '1';
                return;
            }

            // 6. 収縮半径分を外側へ復元
            minX = Math.max(0, minX - ERODE_RADIUS);
            minY = Math.max(0, minY - ERODE_RADIUS);
            maxX = Math.min(w - 1, maxX + ERODE_RADIUS);
            maxY = Math.min(h - 1, maxY + ERODE_RADIUS);

            // 【黒背景モード専用の境界外側探索】
            // コマ枠線（黒）や外側のベタが切り落とされないよう、真の黒余白（完全暗黒部）まで外周を安全に拡張
            if (isBlackBg) {
                const edgeMargin = Math.round(12 * scale); // 探索バッファ
                // 上下左右に少し余裕を持たせてコマ枠線を完全に内包する
                minX = Math.max(0, minX - edgeMargin);
                minY = Math.max(0, minY - edgeMargin);
                maxX = Math.min(w - 1, maxX + edgeMargin);
                maxY = Math.min(h - 1, maxY + edgeMargin);
            }

            // 7. 元解像度座標への高精度変換 & パディング付与
            const invScale = 1 / scale;
            let cropLeft = Math.max(0, Math.floor(minX * invScale) - KEEP_PADDING);
            let cropTop = Math.max(0, Math.floor(minY * invScale) - KEEP_PADDING);
            let cropRight = Math.min(origW - 1, Math.ceil((maxX + 1) * invScale) - 1 + KEEP_PADDING);
            let cropBottom = Math.min(origH - 1, Math.ceil((maxY + 1) * invScale) - 1 + KEEP_PADDING);

            const cropW = cropRight - cropLeft + 1;
            const cropH = cropBottom - cropTop + 1;

            // 切り取り変化が0.5%未満なら元画像を維持
            if (cropW >= origW * (1 - MIN_TRIM_RATIO) && cropH >= origH * (1 - MIN_TRIM_RATIO)) {
                img.dataset.mangaCropDone = '1';
                return;
            }

            // 8. 元解像度から高精細クロップを描画
            const outCanvas = document.createElement('canvas');
            outCanvas.width = cropW;
            outCanvas.height = cropH;
            const outCtx = outCanvas.getContext('2d');
            if (!outCtx) throw new Error('Output context failure');

            outCtx.drawImage(
                img,
                cropLeft, cropTop, cropW, cropH,
                0, 0, cropW, cropH
            );

            // 元DOM要素を維持したままsrc更新
            img.dataset.mangaCropDone = '1';
            img.src = outCanvas.toDataURL('image/png');

            console.log(
                `[MangaCrop v7] 成功: ${origW}x${origH} → ${cropW}x${cropH} (モード: ${isBlackBg ? '黒背景' : '白背景'}, RGB:[${bgR},${bgG},${bgB}], 核画素数: ${activeCorePixels})`
            );

        } catch (err) {
            console.warn('[MangaCrop v7] エラー発生:', err);
        } finally {
            delete img.dataset.mangaCropProcessing;
        }
    }

    /* ==========================================================================
       DOM監視 & ライフサイクル管理
       ========================================================================== */

    function observeImage(img) {
        if (!(img instanceof HTMLImageElement)) return;
        if (img.dataset.mangaCropWatching === '1') return;
        img.dataset.mangaCropWatching = '1';

        if (img.complete && img.naturalWidth > 0) {
            setTimeout(() => processImageCore(img), 80);
        } else {
            img.addEventListener('load', () => setTimeout(() => processImageCore(img), 80), { once: true });
        }
    }

    function scanAllImages() {
        document.querySelectorAll('img').forEach(observeImage);
    }

    const domObserver = new MutationObserver(scanAllImages);

    function init() {
        if (!document.documentElement) {
            setTimeout(init, 50);
            return;
        }
        domObserver.observe(document.documentElement, {
            childList: true,
            subtree: true
        });
        scanAllImages();
    }

    init();

})();