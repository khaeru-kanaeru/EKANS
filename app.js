const firebaseConfig = {
    apiKey: "AIzaSyCEIdlZtfkniJp2BRDhBrQIeLYNUZBc_qs",
    authDomain: "ekans-uni.firebaseapp.com",
    databaseURL: "https://ekans-uni-default-rtdb.asia-southeast1.firebasedatabase.app",
    projectId: "ekans-uni",
    storageBucket: "ekans-uni.firebasestorage.app",
    messagingSenderId: "710203684602",
    appId: "1:710203684602:web:796b3c2bca6aeb802e3b43"
};

const VALID_LICENSES = {
    'CA111': { name: 'LDR CRIMPING', shift: 'A', line: 'Line Crimping', section: 'STATION MARKER', role: 'leader' },
    'CB111': { name: 'LDR CRIMPING', shift: 'B', line: 'Line Crimping', section: 'STATION MARKER', role: 'leader' },
    'SA111': { name: 'LDR SMV', shift: 'A', line: 'Line SMV', section: 'STATION MARKER', role: 'leader' },
    'SB111': { name: 'LDR SMV', shift: 'B', line: 'Line SMV', section: 'STATION MARKER', role: 'leader' },
    'PA111': { name: 'LDR PROTO', shift: 'A', line: 'Line Proto', section: 'STATION MARKER', role: 'leader' },
    'PB111': { name: 'LDR PROTO', shift: 'B', line: 'Line Proto', section: 'STATION MARKER', role: 'leader' },
    'HA111': { name: 'LDR HA', shift: 'A', line: 'Line HA', section: 'STATION MARKER', role: 'leader' },
    'HB111': { name: 'LDR HA', shift: 'B', line: 'Line HA', section: 'STATION MARKER', role: 'leader' },
    '222': { name: 'GUDANG MARKER', shift: '-', line: 'ALL', section: 'STATION MARKER', role: 'warehouse' }
};

const STATUS_WAITING = 'WAITING';
const STATUS_PROCESSING = 'PROCESSING';
const STATUS_READY = 'READY';
const STATUS_PICKED_UP = 'PICKED_UP';
const STATUS_FINISHED = 'FINISHED';

// Sumber Google Sheets dikunci langsung di kode:
// https://docs.google.com/spreadsheets/d/1OEfUemphqF2fBM55WuchrRUgvLmDSH9vaYZ2TaCIr_4/edit#gid=408912899
const DEFAULT_GSHEET_CONFIG = {
    url: 'https://docs.google.com/spreadsheets/d/1OEfUemphqF2fBM55WuchrRUgvLmDSH9vaYZ2TaCIr_4/edit#gid=408912899',
    sheetId: '1OEfUemphqF2fBM55WuchrRUgvLmDSH9vaYZ2TaCIr_4',
    gid: '408912899',
    customUrl: ''
};

const GSHEET_CONFIG_STORAGE_KEY = 'eks_gsheet_config_v1';
const GSHEET_FIRST_SEEN_KEY = 'eks_gsheet_first_seen_v1';
const LOCAL_DB_STORAGE_KEY = 'eks_local_db_v1';
const LOCAL_COMPLETED_GSHEET_KEY = 'eks_local_completed_gsheet_v1';
const LOCAL_GSHEET_META_KEY = 'eks_local_gsheet_meta_v1';
const LOCAL_HISTORY_STORAGE_KEY = 'eks_local_history_v1';

const FIREBASE_FALLBACK_CDNS = [
    'https://cdn.jsdelivr.net/npm/firebase@10.8.0',
    'https://unpkg.com/firebase@10.8.0'
];

let dbRef = null;
let dbFs = null;
let completedGsheetRef = null;
let gsheetMetaRef = null;
let gsheetConfigRef = null;
let whPresenceRef = null;
let isFirebaseReady = false;
let isRealtimeListenersAttached = false;
let isWhPresenceListenerAttached = false;
let firebaseLoadPromise = null;

let currentUser = null;
let db = { requests: [] };
let tempAssyListMarker = [];
let currentKanbanTypeMarker = 'ALL';
let timeInterval = null;
let clockInterval = null;
let isHistoryOpen = false;
let cancelTargetId = null;
let currentStatTab = 'ALL';
let isLeaderGridView = false;

let whPresenceInterval = null;
let cachedHistoryBuckets = {};
let loadedHistoryData = [];

// ============================================================================
// KONFIGURASI & MEKANIK BACA DATA GOOGLE SHEETS (DETEKSI KOLOM OTOMATIS)
// Mendukung layout terbaru (AG=PIC, AH=PIC PRD, AI=STATUS MARKER, AJ=No BOX)
// maupun layout lama (AF=PIC, AH=STATUS MARKER, AI=No BOX) secara otomatis.
// ============================================================================
let gsheetConfig = { ...DEFAULT_GSHEET_CONFIG };
let gsheetFirstSeenMap = loadGsheetFirstSeenMap();
let completedGsheetSerials = {};
let gsheetMetaMap = {};
let gsheetRawReadyRows = [];
let gsheetReadyRequests = [];
let gsheetPollInterval = null;
let gsheetSyncSeq = 0;
let isFirstGsheetLoad = true;
let knownGsheetSerials = new Set();
let lastGsheetDiag = {
    status: 'IDLE',
    method: '-',
    totalScanned: 0,
    readyCount: 0,
    detectedCols: '-',
    message: 'Belum dilakukan sinkronisasi.',
    updatedAt: null
};

// Indeks kolom fallback (0-based) jika sheet tidak memiliki baris header:
// B=1, E=4, G=6, H=7, K=10, L=11, Y=24 (Closed Process Date),
// AC=28 (TGL PRINT), AG=32 (PIC), AI=34 (STATUS MARKER), AJ=35 (No BOX)
const GSHEET_COL_INDEX = {
    B: 1,
    E: 4,
    G: 6,
    H: 7,
    K: 10,
    L: 11,
    Y: 24,
    AC: 28,
    AF: 31,
    AG: 32,
    AH: 33,
    AI: 34,
    AJ: 35
};

const DEFAULT_FALLBACK_COL_MAP = {
    serialWO: GSHEET_COL_INDEX.B,
    assy: GSHEET_COL_INDEX.E,
    qty: GSHEET_COL_INDEX.G,
    wp: GSHEET_COL_INDEX.H,
    line: GSHEET_COL_INDEX.K,
    lot: GSHEET_COL_INDEX.L,
    closedDate: GSHEET_COL_INDEX.Y,
    tglPrint: GSHEET_COL_INDEX.AC,
    pic: GSHEET_COL_INDEX.AG,
    status: GSHEET_COL_INDEX.AI,
    noBox: GSHEET_COL_INDEX.AJ
};

function colIndexToLetter(index) {
    if (index === null || index === undefined || index < 0) return '-';
    let n = index;
    let letter = '';
    while (n >= 0) {
        letter = String.fromCharCode((n % 26) + 65) + letter;
        n = Math.floor(n / 26) - 1;
    }
    return letter;
}

function normalizeHeaderText(val) {
    return String(val || '')
        .replace(/[\r\n]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .toUpperCase();
}

function scoreHeaderForField(field, rawHeader) {
    const h = normalizeHeaderText(rawHeader);
    if (!h) return 0;

    switch (field) {
        case 'status':
            if (h === 'STATUS MARKER' || h === 'STATUS_MARKER') return 100;
            if (h.includes('STATUS MARKER') || h.includes('STATUS_MARKER')) return 95;
            if (h === 'STAT MARKER' || h.includes('STAT MARKER')) return 85;
            if (h === 'STATUS') return 55;
            if (h.includes('STATUS') && !h.includes('ORDER') && !h.includes('WO') && !h.includes('PRD')) return 35;
            return 0;

        case 'pic':
            // Jangan pernah cocokkan PIC PRD / PIC LINE / PICKER sebagai PIC Gudang/Marker
            if (/\b(PRD|PROD|PRODUKSI|LINE|LEADER|LDR|PICKER|PENGAMBIL)\b/.test(h)) return 0;
            if (h === 'PIC' || h === 'PIC MARKER' || h === 'PIC WH' || h === 'PIC GUDANG') return 100;
            if (h.includes('PIC MARKER') || h.includes('PIC WH') || h.includes('PIC GUDANG')) return 90;
            if (/\bPIC\b/.test(h)) return 65;
            return 0;

        case 'noBox':
            if (h.includes('STATUS') || h.includes('ROOM') || h.includes('RUANG')) return 0;
            if (h === 'NO BOX' || h === 'NO. BOX' || h === 'NO_BOX' || h === 'NOMOR BOX' || h === 'BOX NO' || h === 'BOX') return 100;
            if (h.includes('NO BOX') || h.includes('NO. BOX') || h.includes('NOMOR BOX') || h.includes('BOX NO')) return 90;
            if (/\bBOX\b/.test(h)) return 65;
            return 0;

        case 'serialWO':
            if (h === 'SERIAL WO ID' || h === 'SERIAL WO' || h === 'WO ID' || h === 'SERIAL' || h === 'NO SERIAL' || h === 'NO. SERIAL') return 100;
            if (h.includes('SERIAL WO') || h.includes('WO ID')) return 90;
            if (/\bSERIAL\b/.test(h)) return 75;
            if (h === 'NO WO' || h === 'NO. WO' || h === 'WO NO' || h === 'WORK ORDER') return 60;
            return 0;

        case 'assy':
            if (h.includes('NAME') || h.includes('NAMA')) return 0;
            if (h === 'ASSY NO' || h === 'NO ASSY' || h === 'NO. ASSY' || h === 'ASSY NO.' || h === 'ASSY NUMBER' || h === 'ASSY') return 100;
            if (h.includes('ASSY NO') || h.includes('NO ASSY') || h.includes('NO. ASSY')) return 90;
            if (/\bASSY\b/.test(h)) return 75;
            if (h === 'PART NO' || h === 'NO PART') return 40;
            return 0;

        case 'qty':
            if (h === 'QTY' || h === 'QTY WO' || h === 'QTY ORDER' || h === 'QTY MARKER' || h === 'QUANTITY') return 100;
            if (/\bQTY\b/.test(h) || h.includes('QUANTITY')) return 75;
            if (h === 'JUMLAH' || h === 'JML') return 50;
            return 0;

        case 'wp':
            if (h === 'WP' || h === 'W/P' || h === 'NO WP' || h === 'WORKPLACE' || h === 'WORK PLACE') return 100;
            if (/\bW\/?P\b/.test(h) || h.includes('WORKPLACE') || h.includes('WORK PLACE')) return 75;
            return 0;

        case 'line':
            if (h.includes('DEADLINE') || h.includes('TIMELINE') || h.includes('ONLINE')) return 0;
            if (h === 'LINE' || h === 'PROD LINE' || h === 'LINE PROD' || h === 'PRODUCTION LINE') return 100;
            if (/\bLINE\b/.test(h)) return 75;
            return 0;

        case 'lot':
            if (h === 'LOT' || h === 'LOT NO' || h === 'NO LOT' || h === 'NO. LOT' || h === 'LOT NUMBER') return 100;
            if (/\bLOT\b/.test(h)) return 75;
            return 0;

        case 'closedDate':
            if (h === 'CLOSED PROCESS DATE' || h === 'CLOSE PROCESS DATE') return 100;
            if (h.includes('CLOSED') && h.includes('DATE')) return 80;
            return 0;

        case 'tglPrint':
            if (h === 'TGL PRINT' || h === 'TGL. PRINT' || h === 'TGL.PRINT' || h === 'TANGGAL PRINT' || h === 'PRINT DATE' || h === 'DATE PRINT' || h === 'TGL CETAK') return 100;
            if ((h.includes('TGL') || h.includes('TANGGAL') || h.includes('DATE')) && (h.includes('PRINT') || h.includes('CETAK'))) return 90;
            if (h === 'PRINT' || h === 'WAKTU PRINT') return 55;
            return 0;

        default:
            return 0;
    }
}

function countStatusHitsInColumn(rowCount, getCellAt, colIdx, startRow = 0) {
    let readyCount = 0;
    let statusWordCount = 0;
    for (let r = startRow; r < rowCount; r++) {
        const val = normalizeHeaderText(getCellAt(r, colIdx));
        if (!val) continue;
        if (val === 'READY' || /\bREADY\b/.test(val)) {
            if (!/\b(BELUM|NOT|TIDAK|UNREADY|NON|CLOSED|CLOSE|OPEN)\b/.test(val)) {
                readyCount++;
                statusWordCount++;
            }
        } else if (val === 'OPEN' || val === 'CLOSED' || val === 'CLOSE') {
            statusWordCount++;
        }
    }
    return { readyCount, statusWordCount };
}

function matchHeaderCandidate(headerCells, dataProbe = null) {
    const fields = ['status', 'pic', 'noBox', 'serialWO', 'assy', 'qty', 'wp', 'line', 'lot', 'closedDate', 'tglPrint'];
    const map = {};
    const scores = {};
    let totalScore = 0;
    let matchedCount = 0;

    fields.forEach(field => {
        if (field === 'status') {
            const candidates = [];
            for (let i = 0; i < headerCells.length; i++) {
                const s = scoreHeaderForField('status', headerCells[i]);
                if (s > 0) candidates.push({ idx: i, baseScore: s });
            }
            if (candidates.length === 0) return;

            let bestCand = candidates[0];
            let bestRank = -1;

            candidates.forEach(cand => {
                let rank = cand.baseScore + (cand.idx * 0.01);
                if (dataProbe && candidates.length > 1) {
                    const hits = countStatusHitsInColumn(dataProbe.rowCount, dataProbe.getCellAt, cand.idx, dataProbe.startRow);
                    if (hits.readyCount > 0) rank += 1000 + Math.min(hits.readyCount, 200);
                    else if (hits.statusWordCount > 0) rank += 500 + Math.min(hits.statusWordCount, 100);
                }
                if (rank > bestRank) {
                    bestRank = rank;
                    bestCand = cand;
                }
            });

            map.status = bestCand.idx;
            scores.status = bestCand.baseScore;
            totalScore += bestCand.baseScore;
            matchedCount++;
            return;
        }

        let bestIdx = -1;
        let bestScore = 0;
        for (let i = 0; i < headerCells.length; i++) {
            const s = scoreHeaderForField(field, headerCells[i]);
            if (s > bestScore) {
                bestScore = s;
                bestIdx = i;
            }
        }
        if (bestIdx !== -1 && bestScore > 0) {
            map[field] = bestIdx;
            scores[field] = bestScore;
            totalScore += bestScore;
            matchedCount++;
        }
    });

    return { map, scores, totalScore, matchedCount };
}

function detectStatusColumnByContent(rowCount, getRowLength, getCellAt, startRow = 0) {
    const colStats = {};

    for (let r = startRow; r < rowCount; r++) {
        const len = getRowLength(r);
        for (let c = 0; c < len; c++) {
            const val = normalizeHeaderText(getCellAt(r, c));
            if (!val) continue;
            if (val === 'READY' || val === 'OPEN' || val === 'CLOSED' || val === 'CLOSE') {
                if (!colStats[c]) colStats[c] = { ready: 0, statusWord: 0 };
                colStats[c].statusWord++;
                if (val === 'READY') colStats[c].ready++;
            }
        }
    }

    let bestCol = -1;
    let bestWeight = 0;
    Object.keys(colStats).forEach(colKey => {
        const c = parseInt(colKey, 10);
        const st = colStats[c];
        // Prioritaskan kolom yang memiliki kata READY + OPEN/CLOSED dan berada di area kanan (kolom status)
        let weight = st.ready * 10 + st.statusWord * 3;
        if (c >= 25) weight += 5;
        if (c === GSHEET_COL_INDEX.AI || c === GSHEET_COL_INDEX.AH) weight += 4;
        if (weight > bestWeight) {
            bestWeight = weight;
            bestCol = c;
        }
    });

    return bestCol;
}

function finalizeColumnMap(detectedMap, dataProbe, colLetterLookup) {
    const finalMap = { ...detectedMap };

    // Jika kolom STATUS MARKER belum ditemukan dari nama header, deteksi dari isi sel (READY/OPEN/CLOSED)
    if (finalMap.status === undefined && dataProbe) {
        const inferredStatus = detectStatusColumnByContent(
            dataProbe.rowCount,
            dataProbe.getRowLength,
            dataProbe.getCellAt,
            dataProbe.startRow
        );
        if (inferredStatus !== -1) {
            finalMap.status = inferredStatus;
        }
    }

    // Jika status sudah ditemukan, gunakan posisi relatifnya sebagai fallback cerdas untuk PIC & No BOX
    if (finalMap.status !== undefined) {
        if (finalMap.noBox === undefined) {
            finalMap.noBox = finalMap.status + 1;
        }
        if (finalMap.pic === undefined) {
            if (finalMap.status === GSHEET_COL_INDEX.AI) {
                finalMap.pic = GSHEET_COL_INDEX.AG;
            } else if (finalMap.status === GSHEET_COL_INDEX.AH) {
                finalMap.pic = GSHEET_COL_INDEX.AF;
            } else if (finalMap.status >= 2) {
                finalMap.pic = finalMap.status - 2;
            }
        }
    }

    // Isi sisa kolom yang belum terdeteksi menggunakan fallback default
    Object.keys(DEFAULT_FALLBACK_COL_MAP).forEach(field => {
        if (finalMap[field] === undefined) {
            finalMap[field] = DEFAULT_FALLBACK_COL_MAP[field];
        }
    });

    const getLabel = (idx) => {
        if (colLetterLookup && colLetterLookup[idx]) return colLetterLookup[idx];
        return colIndexToLetter(idx);
    };

    const colLetters = {
        serialWO: getLabel(finalMap.serialWO),
        assy: getLabel(finalMap.assy),
        noBox: getLabel(finalMap.noBox),
        tglPrint: getLabel(finalMap.tglPrint),
        pic: getLabel(finalMap.pic),
        status: getLabel(finalMap.status)
    };
    const summary = `Status:${colLetters.status} | PIC:${colLetters.pic} | Tgl Print:${colLetters.tglPrint} | Box:${colLetters.noBox} | Assy:${colLetters.assy}`;
    return { colMap: finalMap, colLetters, summary };
}

function detectColumnMapFromMatrix(matrix) {
    const scanLimit = Math.min(matrix.length, 15);
    let bestCandidate = { map: {}, scores: {}, totalScore: 0, matchedCount: 0, rowIdx: -1 };

    for (let r = 0; r < scanLimit; r++) {
        const row = matrix[r];
        if (!Array.isArray(row) || row.length < 3) continue;
        const probe = {
            rowCount: matrix.length,
            startRow: r + 1,
            getRowLength: (ri) => Array.isArray(matrix[ri]) ? matrix[ri].length : 0,
            getCellAt: (ri, ci) => (Array.isArray(matrix[ri]) && ci < matrix[ri].length) ? matrix[ri][ci] : ''
        };
        const cand = matchHeaderCandidate(row, probe);
        if (cand.matchedCount >= 2 && (cand.totalScore > bestCandidate.totalScore || (cand.totalScore === bestCandidate.totalScore && cand.matchedCount > bestCandidate.matchedCount))) {
            bestCandidate = { ...cand, rowIdx: r };
        }
    }

    const startRow = bestCandidate.rowIdx >= 0 ? bestCandidate.rowIdx + 1 : 0;
    const fullProbe = {
        rowCount: matrix.length,
        startRow,
        getRowLength: (ri) => Array.isArray(matrix[ri]) ? matrix[ri].length : 0,
        getCellAt: (ri, ci) => (Array.isArray(matrix[ri]) && ci < matrix[ri].length) ? matrix[ri][ci] : ''
    };
    const finalized = finalizeColumnMap(bestCandidate.map, fullProbe, null);
    return { ...finalized, headerRowIdx: bestCandidate.rowIdx, startRow };
}

function detectColumnMapFromGvizTable(table) {
    const cols = (table && Array.isArray(table.cols)) ? table.cols : [];
    const rows = (table && Array.isArray(table.rows)) ? table.rows : [];

    const colLetterLookup = cols.map((col, pos) => (col && col.id) ? String(col.id).trim().toUpperCase() : colIndexToLetter(pos));
    const colLabels = cols.map(col => (col && col.label) ? String(col.label) : '');
    const getGvizCell = (ri, ci) => {
        const r = rows[ri];
        return (r && Array.isArray(r.c) && ci < r.c.length) ? getCellText(r.c[ci]) : '';
    };
    const getGvizRowLen = (ri) => {
        const r = rows[ri];
        return (r && Array.isArray(r.c)) ? r.c.length : 0;
    };

    const labelProbe = {
        rowCount: rows.length,
        startRow: 0,
        getRowLength: getGvizRowLen,
        getCellAt: getGvizCell
    };
    const labelCand = matchHeaderCandidate(colLabels, labelProbe);

    // Periksa 15 baris pertama jika header berada di dalam rows[]
    const rowScanLimit = Math.min(rows.length, 15);
    let bestRowCand = { map: {}, scores: {}, totalScore: 0, matchedCount: 0, rowIdx: -1 };

    for (let r = 0; r < rowScanLimit; r++) {
        const rowCells = (rows[r] && Array.isArray(rows[r].c)) ? rows[r].c.map(cell => getCellText(cell)) : [];
        if (rowCells.length < 3) continue;
        const rowProbe = {
            rowCount: rows.length,
            startRow: r + 1,
            getRowLength: getGvizRowLen,
            getCellAt: getGvizCell
        };
        const cand = matchHeaderCandidate(rowCells, rowProbe);
        if (cand.matchedCount >= 2 && (cand.totalScore > bestRowCand.totalScore || (cand.totalScore === bestRowCand.totalScore && cand.matchedCount > bestRowCand.matchedCount))) {
            bestRowCand = { ...cand, rowIdx: r };
        }
    }

    // Gabungkan deteksi dari cols[].label dan baris header terbaik
    const mergedMap = {};
    let headerRowIdx = -1;
    if (bestRowCand.totalScore > labelCand.totalScore) {
        headerRowIdx = bestRowCand.rowIdx;
        Object.assign(mergedMap, labelCand.map, bestRowCand.map);
    } else {
        Object.assign(mergedMap, bestRowCand.map, labelCand.map);
        if (bestRowCand.matchedCount >= 3 && bestRowCand.map.status !== undefined && bestRowCand.rowIdx <= 5) {
            headerRowIdx = bestRowCand.rowIdx;
        }
    }

    // Pemetaan fallback menggunakan col.id (huruf Excel asli di metadata GViz) jika sebagian kolom tidak punya label
    const colIdToPos = {};
    colLetterLookup.forEach((letter, pos) => {
        if (letter) colIdToPos[letter] = pos;
    });

    const startRow = headerRowIdx >= 0 ? headerRowIdx + 1 : 0;
    const fullProbe = {
        rowCount: rows.length,
        startRow,
        getRowLength: getGvizRowLen,
        getCellAt: getGvizCell
    };
    const finalized = finalizeColumnMap(mergedMap, fullProbe, colLetterLookup);

    // Pastikan jika ada field yang jatuh ke default index, cocokkan dengan colIdToPos jika tersedia
    const defaultLetters = {
        serialWO: 'B', assy: 'E', qty: 'G', wp: 'H', line: 'K', lot: 'L', closedDate: 'Y', tglPrint: 'AC'
    };
    Object.keys(defaultLetters).forEach(field => {
        if (mergedMap[field] === undefined && colIdToPos[defaultLetters[field]] !== undefined) {
            finalized.colMap[field] = colIdToPos[defaultLetters[field]];
        }
    });

    const getLabel = (idx) => colLetterLookup[idx] || colIndexToLetter(idx);
    finalized.colLetters = {
        serialWO: getLabel(finalized.colMap.serialWO),
        assy: getLabel(finalized.colMap.assy),
        noBox: getLabel(finalized.colMap.noBox),
        tglPrint: getLabel(finalized.colMap.tglPrint),
        pic: getLabel(finalized.colMap.pic),
        status: getLabel(finalized.colMap.status)
    };
    finalized.summary = `Status:${finalized.colLetters.status} | PIC:${finalized.colLetters.pic} | Tgl Print:${finalized.colLetters.tglPrint} | Box:${finalized.colLetters.noBox} | Assy:${finalized.colLetters.assy}`;

    return { ...finalized, headerRowIdx, startRow };
}

function loadLocalGsheetConfig() {
    try {
        const raw = localStorage.getItem(GSHEET_CONFIG_STORAGE_KEY);
        if (raw) {
            const parsed = JSON.parse(raw);
            let savedId = String(parsed.sheetId || DEFAULT_GSHEET_CONFIG.sheetId).trim();
            // Perbaiki otomatis typo lama (l kecil -> I besar) yang tersimpan di localStorage
            if (savedId === '1OEfUemphqF2fBM55WuchrRUgvLmDSH9vaYZ2TaClr_4') {
                savedId = DEFAULT_GSHEET_CONFIG.sheetId;
            }
            return {
                sheetId: savedId,
                gid: String(parsed.gid ?? DEFAULT_GSHEET_CONFIG.gid).trim(),
                customUrl: String(parsed.customUrl || '').trim()
            };
        }
    } catch (e) {
        console.warn('Gagal membaca konfigurasi GSheet lokal:', e);
    }
    return { ...DEFAULT_GSHEET_CONFIG };
}

function saveLocalGsheetConfig(cfg) {
    try {
        localStorage.setItem(GSHEET_CONFIG_STORAGE_KEY, JSON.stringify(cfg));
    } catch (e) {
        console.warn('Gagal menyimpan konfigurasi GSheet lokal:', e);
    }
}

function loadGsheetFirstSeenMap() {
    try {
        const raw = localStorage.getItem(GSHEET_FIRST_SEEN_KEY);
        if (raw) return JSON.parse(raw) || {};
    } catch (e) {}
    return {};
}

function getStableFallbackTimestamp(safeKey) {
    if (!safeKey) return Date.now();
    if (!gsheetFirstSeenMap[safeKey]) {
        gsheetFirstSeenMap[safeKey] = Date.now();
        try {
            localStorage.setItem(GSHEET_FIRST_SEEN_KEY, JSON.stringify(gsheetFirstSeenMap));
        } catch (e) {}
    }
    return gsheetFirstSeenMap[safeKey];
}

function sanitizeFirebaseKey(str) {
    return String(str || '').trim().replace(/[.#$\[\]\/]/g, '_');
}

function getCellText(cell) {
    if (cell === null || cell === undefined) return '';
    if (typeof cell !== 'object') return String(cell).trim();
    if (cell.f !== undefined && cell.f !== null && String(cell.f).trim() !== '') return String(cell.f).trim();
    if (cell.v !== undefined && cell.v !== null) return String(cell.v).trim();
    return '';
}

function isStatusReady(rawStatus) {
    const upper = normalizeHeaderText(rawStatus);
    if (!upper) return false;
    if (upper === 'STATUS' || upper === 'STATUS MARKER' || upper === 'STATUS_MARKER') return false;
    // Pastikan status CLOSED / DONE / OPEN / BELUM READY selalu terhapus dari Active Queue
    if (/\b(BELUM|NOT|TIDAK|UNREADY|NON|CLOSED|CLOSE|DONE|OPEN)\b/.test(upper)) return false;
    return upper === 'READY' || /\bREADY\b/.test(upper);
}

function parseGsheetQty(cellOrText) {
    if (cellOrText && typeof cellOrText === 'object' && typeof cellOrText.v === 'number' && !isNaN(cellOrText.v)) {
        return Math.round(cellOrText.v);
    }
    let text = getCellText(cellOrText);
    if (!text) return 0;
    // Hapus pemisah ribuan seperti "1,250" atau "1.250"
    const normalized = text.replace(/(\d)[.,](?=\d{3}(?:\D|$))/g, '$1');
    const match = normalized.match(/-?\d+/);
    return match ? (parseInt(match[0], 10) || 0) : 0;
}

function mapGsheetLine(rawLine) {
    const upper = String(rawLine || '').trim().toUpperCase();
    if (upper.includes('EXPORT') || upper.includes('EXP') || upper.includes('CRIMPING')) return 'Line Crimping';
    if (upper.includes('SVREG') || upper.includes('SMV')) return 'Line SMV';
    if (upper.includes('PROTO') || upper === 'PT' || /\bPT\b/.test(upper)) return 'Line Proto';
    if (upper.includes('HA')) return 'Line HA';
    return 'Line Crimping';
}

const SHORT_MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function formatGsheetDateLabel(dt) {
    if (!dt || isNaN(dt.getTime())) return '-';
    const d = String(dt.getDate()).padStart(2, '0');
    const m = SHORT_MONTH_LABELS[dt.getMonth()] || 'Jan';
    const y = dt.getFullYear();
    return `${d} ${m} ${y}`;
}

function normalizeGsheetYear(rawYearStr, fallbackYear) {
    if (!rawYearStr) return fallbackYear;
    const digits = String(rawYearStr).replace(/\D/g, '');
    if (!digits) return fallbackYear;
    if (digits.length === 2) return 2000 + parseInt(digits, 10);
    if (digits.length === 4) return parseInt(digits, 10);
    if (digits.length === 5) {
        // Perbaiki typo 5-digit seperti "20256" -> 2026 atau "22026" -> 2026
        if (digits.startsWith('202')) return parseInt('202' + digits.slice(-1), 10);
        if (digits.startsWith('220')) return parseInt(digits.slice(1), 10);
        return parseInt(digits.slice(0, 4), 10);
    }
    return parseInt(digits.slice(-4), 10) || fallbackYear;
}

function extractDateFromSerialWO(serialWO) {
    const m = String(serialWO || '').match(/(\d{2})(\d{2})(\d{2})-[A-Z0-9]+$/);
    if (!m) return null;
    const d = parseInt(m[1], 10);
    const mo = parseInt(m[2], 10);
    const yr = 2000 + parseInt(m[3], 10);
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
        const dt = new Date(yr, mo - 1, d);
        if (!isNaN(dt.getTime())) return dt;
    }
    return null;
}

function normalizeNoBoxText(rawBox) {
    return getCellText(rawBox)
        .replace(/\(\s+/g, '(')
        .replace(/\s+\)/g, ')')
        .replace(/\s+/g, ' ')
        .trim()
        .toUpperCase();
}

function parseGsheetDate(cellOrStr, safeKey, options = {}) {
    const serialDate = options.serialWO ? extractDateFromSerialWO(options.serialWO) : null;
    const fallbackYear = options.fallbackYear || (serialDate ? serialDate.getFullYear() : new Date().getFullYear());

    // Tentukan timestamp cadangan kronologis jika TGL PRINT kosong:
    // Closed Process Date (jika valid) -> tanggal dari Serial WO -> first-seen stabil
    let chronoFallbackTs = null;
    if (options.closedDateCell) {
        const closedParsed = parseGsheetDate(options.closedDateCell, safeKey + '_closed', {
            fallbackYear,
            skipFallbackLookup: true
        });
        if (closedParsed && closedParsed.hasExplicitDate) {
            chronoFallbackTs = closedParsed.ts;
        }
    }
    if (!chronoFallbackTs && serialDate) {
        chronoFallbackTs = serialDate.getTime();
    }
    const fallbackTs = chronoFallbackTs || (options.skipFallbackLookup ? Date.now() : getStableFallbackTimestamp(safeKey));

    if (cellOrStr === null || cellOrStr === undefined) {
        return { ts: fallbackTs, label: '-', hasExplicitDate: false };
    }

    const isObj = typeof cellOrStr === 'object';
    const rawV = isObj ? cellOrStr.v : cellOrStr;
    const label = isObj
        ? (cellOrStr.f ? String(cellOrStr.f).trim() : (rawV !== null && rawV !== undefined ? String(rawV).trim() : '-'))
        : (String(cellOrStr).trim() || '-');

    if (label && label !== '-') {
        const cleanLabel = label.replace(/\s+/g, ' ').trim();

        // 1. Format ISO YYYY-MM-DD [HH:mm[:ss]]
        const isoMatch = cleanLabel.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})(?:[\sT](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/);
        if (isoMatch) {
            const dt = new Date(
                parseInt(isoMatch[1], 10),
                parseInt(isoMatch[2], 10) - 1,
                parseInt(isoMatch[3], 10),
                parseInt(isoMatch[4] || '0', 10),
                parseInt(isoMatch[5] || '0', 10),
                parseInt(isoMatch[6] || '0', 10)
            );
            if (!isNaN(dt.getTime())) return { ts: dt.getTime(), label: formatGsheetDateLabel(dt), hasExplicitDate: true };
        }

        // 2. Format Indonesia DD/MM/YYYY atau DD-MM-YYYY [+ jam opsional]
        const dmyMatch = cleanLabel.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,5})(?:\s+(\d{1,2})[:.](\d{1,2})(?:[:.](\d{1,2}))?)?/);
        if (dmyMatch) {
            let d = parseInt(dmyMatch[1], 10);
            let m = parseInt(dmyMatch[2], 10);
            const yr = normalizeGsheetYear(dmyMatch[3], fallbackYear);
            // Jika angka kedua > 12, berarti MM/DD/YYYY (format US)
            if (m > 12 && d <= 12) {
                const tmp = d;
                d = m;
                m = tmp;
            }
            const dt = new Date(
                yr,
                m - 1,
                d,
                parseInt(dmyMatch[4] || '0', 10),
                parseInt(dmyMatch[5] || '0', 10),
                parseInt(dmyMatch[6] || '0', 10)
            );
            if (!isNaN(dt.getTime())) return { ts: dt.getTime(), label: formatGsheetDateLabel(dt), hasExplicitDate: true };
        }

        // 3. Format DD-Mon-YYYY, DD Mon YYYY, 16Sep 2026, 23 Sep2026, 05 Nov, 10 Sep 20256 (ID & EN)
        const monthMap = {
            JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, MEI: 4, JUN: 5, JUL: 6,
            AUG: 7, AGT: 7, AGU: 7, SEP: 8, OCT: 9, OKT: 9, NOV: 10, DEC: 11, DES: 11
        };
        const monMatch = cleanLabel.match(/^(\d{1,2})[\s\-\/.,]*([A-Za-z]{3,})[\s\-\/.,]*(\d{2,5})?(?:\s+(\d{1,2})[:.](\d{1,2})(?:[:.](\d{1,2}))?)?/);
        if (monMatch) {
            const monKey = monMatch[2].slice(0, 3).toUpperCase();
            if (monthMap[monKey] !== undefined) {
                const yr = normalizeGsheetYear(monMatch[3], fallbackYear);
                const dt = new Date(
                    yr,
                    monthMap[monKey],
                    parseInt(monMatch[1], 10),
                    parseInt(monMatch[4] || '0', 10),
                    parseInt(monMatch[5] || '0', 10),
                    parseInt(monMatch[6] || '0', 10)
                );
                if (!isNaN(dt.getTime())) return { ts: dt.getTime(), label: formatGsheetDateLabel(dt), hasExplicitDate: true };
            }
        }

        // 4. Fallback Date.parse umum (hanya jika string mengandung tahun eksplisit 4 digit agar "05 Nov" tidak jadi 2001)
        if (/^\D*\d{1,2}\D+\d{4}(?:\D|$)/.test(cleanLabel) || /\b\d{4}\b/.test(cleanLabel)) {
            const parsed = Date.parse(cleanLabel);
            if (!isNaN(parsed)) {
                const dt = new Date(parsed);
                return { ts: parsed, label: formatGsheetDateLabel(dt), hasExplicitDate: true };
            }
        }
    }

    // Format Google Visualization: Date(2026,10,26) atau Date(2026,10,26,8,30,0)
    if (typeof rawV === 'string' && rawV.startsWith('Date(') && rawV.endsWith(')')) {
        const parts = rawV.slice(5, -1).split(',').map(n => parseInt(n.trim(), 10));
        if (parts.length >= 3 && !isNaN(parts[0]) && !isNaN(parts[1]) && !isNaN(parts[2])) {
            const yr = normalizeGsheetYear(String(parts[0]), fallbackYear);
            const dt = new Date(yr, parts[1], parts[2], parts[3] || 0, parts[4] || 0, parts[5] || 0);
            if (!isNaN(dt.getTime())) return { ts: dt.getTime(), label: formatGsheetDateLabel(dt), hasExplicitDate: true };
        }
    }

    return { ts: fallbackTs, label: label || '-', hasExplicitDate: false };
}

function parseCSV(text) {
    const cleanText = String(text || '').replace(/^\uFEFF/, '');
    const rows = [];
    let currentRow = [];
    let currentField = '';
    let inQuotes = false;

    for (let i = 0; i < cleanText.length; i++) {
        const ch = cleanText[i];
        const next = cleanText[i + 1];

        if (inQuotes) {
            if (ch === '"' && next === '"') {
                currentField += '"';
                i++;
            } else if (ch === '"') {
                inQuotes = false;
            } else {
                currentField += ch;
            }
        } else {
            if (ch === '"') {
                inQuotes = true;
            } else if (ch === ',') {
                currentRow.push(currentField);
                currentField = '';
            } else if (ch === '\r' && next === '\n') {
                currentRow.push(currentField);
                rows.push(currentRow);
                currentRow = [];
                currentField = '';
                i++;
            } else if (ch === '\n' || ch === '\r') {
                currentRow.push(currentField);
                rows.push(currentRow);
                currentRow = [];
                currentField = '';
            } else {
                currentField += ch;
            }
        }
    }

    if (currentField.length > 0 || currentRow.length > 0) {
        currentRow.push(currentField);
        rows.push(currentRow);
    }

    return rows;
}

function normalizeGsheetCustomUrl(url) {
    const trimmed = String(url || '').trim();
    if (!trimmed) return '';
    // Jika link "Publikasikan ke web" masih /pubhtml, otomatis ubah ke CSV agar bisa dibaca bersih
    if (trimmed.includes('/spreadsheets/d/e/') && trimmed.includes('/pubhtml')) {
        const converted = trimmed.replace('/pubhtml', '/pub');
        if (!/[?&]output=/.test(converted)) {
            return converted + (converted.includes('?') ? '&output=csv' : '?output=csv');
        }
        return converted.replace(/output=[^&]+/, 'output=csv');
    }
    if (trimmed.includes('/spreadsheets/d/e/') && trimmed.includes('/pub') && !/[?&]output=/.test(trimmed)) {
        return trimmed + (trimmed.includes('?') ? '&output=csv' : '?output=csv');
    }
    return trimmed;
}

function extractGsheetFromUrl(rawInput) {
    const val = String(rawInput || '').trim();
    if (!val) return null;

    // 1. Link Publish-to-Web (/d/e/2PACX-...) atau Apps Script Web App
    if (val.includes('/spreadsheets/d/e/') || val.includes('script.google.com/macros/')) {
        return {
            customUrl: normalizeGsheetCustomUrl(val),
            sheetId: gsheetConfig.sheetId,
            gid: gsheetConfig.gid
        };
    }

    // 2. Link CSV langsung
    if (/^https?:\/\//i.test(val) && (val.includes('output=csv') || val.includes('format=csv') || val.includes('tqx=out:csv'))) {
        const idM = val.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]{10,})/);
        const gidM = val.match(/[?#&]gid=(\d+)/);
        return {
            customUrl: val,
            sheetId: idM ? idM[1] : gsheetConfig.sheetId,
            gid: gidM ? gidM[1] : gsheetConfig.gid
        };
    }

    // 3. Link standar Google Sheets: https://docs.google.com/spreadsheets/d/<ID>/edit#gid=<GID>
    const idMatch = val.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]{10,})/);
    const gidMatch = val.match(/[?#&]gid=(\d+)/);
    if (idMatch) {
        return {
            customUrl: '',
            sheetId: idMatch[1],
            gid: gidMatch ? gidMatch[1] : '0'
        };
    }

    return null;
}

function buildParsedReadyRow(fields, idx, colLetters = null) {
    const statusMarker = getCellText(fields.status);
    if (!isStatusReady(statusMarker)) return null;

    const serialWO = getCellText(fields.serialWO).toUpperCase();
    const rawAssy = getCellText(fields.assy).toUpperCase();
    if (rawAssy === 'ASSY NO' || rawAssy === 'NO ASSY' || rawAssy === 'NO. ASSY' || rawAssy === 'ASSY') return null;

    const assy = rawAssy || serialWO;
    if (!assy) return null;

    const qtyVal = parseGsheetQty(fields.qty);
    const wp = getCellText(fields.wp).toUpperCase();
    const rawLine = getCellText(fields.line);
    const mappedLine = mapGsheetLine(rawLine);
    const lot = getCellText(fields.lot).toUpperCase();
    const picWh = getCellText(fields.pic).toUpperCase() || '-';
    const noBox = normalizeNoBoxText(fields.noBox);

    const effectiveSerial = serialWO || `GS-${assy}-${wp}-${qtyVal}-${lot}-${noBox}-${idx}`;
    const legacySafeKey = sanitizeFirebaseKey(effectiveSerial);
    const safeKey = sanitizeFirebaseKey(`${effectiveSerial}__${assy}__${wp || '-'}`);
    const tglPrintObj = parseGsheetDate(fields.tglPrint, safeKey, {
        serialWO: effectiveSerial,
        closedDateCell: fields.closedDate
    });

    return {
        safeKey,
        legacySafeKey,
        serialWO: effectiveSerial,
        assy,
        qty: qtyVal,
        wp,
        rawLine,
        line: mappedLine,
        lot,
        tglPrintTs: tglPrintObj.ts,
        tglPrintLabel: tglPrintObj.label,
        hasTglPrint: !!tglPrintObj.hasExplicitDate,
        picWh,
        noBox,
        colLetters: colLetters || {
            serialWO: 'B',
            assy: 'E',
            noBox: 'AJ',
            tglPrint: 'AC',
            pic: 'AG',
            status: 'AI'
        }
    };
}

function extractRowsFromGvizTable(table) {
    const rows = (table && Array.isArray(table.rows)) ? table.rows : [];
    const parsedRows = [];
    const { colMap, colLetters, summary, startRow } = detectColumnMapFromGvizTable(table);

    const pick = (c, field) => {
        const idx = colMap[field];
        return (idx !== undefined && idx >= 0 && idx < c.length) ? c[idx] : null;
    };

    for (let idx = startRow; idx < rows.length; idx++) {
        const r = rows[idx];
        if (!r || !Array.isArray(r.c)) continue;
        const c = r.c;
        const item = buildParsedReadyRow({
            serialWO: pick(c, 'serialWO'),
            assy: pick(c, 'assy'),
            qty: pick(c, 'qty'),
            wp: pick(c, 'wp'),
            line: pick(c, 'line'),
            lot: pick(c, 'lot'),
            closedDate: pick(c, 'closedDate'),
            tglPrint: pick(c, 'tglPrint'),
            pic: pick(c, 'pic'),
            status: pick(c, 'status'),
            noBox: pick(c, 'noBox')
        }, idx, colLetters);
        if (item) parsedRows.push(item);
    }

    return { totalScanned: rows.length, parsedRows, detectedCols: summary };
}

function extractRowsFromMatrix(matrix) {
    const parsedRows = [];
    if (!Array.isArray(matrix) || matrix.length === 0) {
        return { totalScanned: 0, parsedRows, detectedCols: '-' };
    }

    const { colMap, colLetters, summary, startRow } = detectColumnMapFromMatrix(matrix);
    const pick = (row, field) => {
        const idx = colMap[field];
        return (idx !== undefined && idx >= 0 && idx < row.length) ? row[idx] : '';
    };

    for (let idx = startRow; idx < matrix.length; idx++) {
        const row = matrix[idx];
        if (!Array.isArray(row) || row.length <= colMap.status) continue;
        const item = buildParsedReadyRow({
            serialWO: pick(row, 'serialWO'),
            assy: pick(row, 'assy'),
            qty: pick(row, 'qty'),
            wp: pick(row, 'wp'),
            line: pick(row, 'line'),
            lot: pick(row, 'lot'),
            closedDate: pick(row, 'closedDate'),
            tglPrint: pick(row, 'tglPrint'),
            pic: pick(row, 'pic'),
            status: pick(row, 'status'),
            noBox: pick(row, 'noBox')
        }, idx, colLetters);
        if (item) parsedRows.push(item);
    }

    return { totalScanned: matrix.length, parsedRows, detectedCols: summary };
}

function extractRowsFromAppsScriptJson(json) {
    const list = Array.isArray(json) ? json : (Array.isArray(json && json.data) ? json.data : (Array.isArray(json && json.rows) ? json.rows : null));
    if (!list) return null;

    if (list.length > 0 && Array.isArray(list[0])) {
        return extractRowsFromMatrix(list);
    }

    const parsedRows = [];
    list.forEach((obj, idx) => {
        if (!obj || typeof obj !== 'object') return;
        const getVal = (...keys) => {
            for (const k of keys) {
                if (obj[k] !== undefined && obj[k] !== null && String(obj[k]).trim() !== '') return obj[k];
            }
            const lowerKeys = Object.keys(obj);
            for (const k of keys) {
                const found = lowerKeys.find(lk => normalizeHeaderText(lk) === normalizeHeaderText(k));
                if (found && obj[found] !== undefined && obj[found] !== null) return obj[found];
            }
            return '';
        };

        const item = buildParsedReadyRow({
            serialWO: getVal('serialWO', 'serial_wo', 'Serial WO ID', 'WO ID', 'B'),
            assy: getVal('assy', 'ASSY NO', 'NO ASSY', 'E'),
            qty: getVal('qty', 'Qty', 'QTY', 'G'),
            wp: getVal('wp', 'WP', 'W/P', 'H'),
            line: getVal('line', 'Line', 'LINE', 'K'),
            lot: getVal('lot', 'Lot', 'LOT', 'L'),
            closedDate: getVal('closedDate', 'Closed Process Date', 'Y'),
            tglPrint: getVal('tglPrint', 'TGL PRINT', 'Tgl Print', 'AC'),
            pic: getVal('pic', 'PIC', 'PIC MARKER', 'PIC WH', 'AG', 'AF'),
            status: getVal('status', 'STATUS MARKER', 'Status Marker', 'AI', 'AH'),
            noBox: getVal('noBox', 'No BOX', 'NO BOX', 'BOX', 'AJ', 'AI')
        }, idx);
        if (item) parsedRows.push(item);
    });

    return { totalScanned: list.length, parsedRows, detectedCols: 'JSON Keys' };
}

function parseGvizJsonResponseText(text) {
    const trimmed = String(text || '').trim();
    if (!trimmed) throw new Error('EMPTY_RESPONSE');
    if (trimmed.startsWith('<')) {
        if (trimmed.includes('accounts.google.com') || trimmed.includes('ServiceLogin') || trimmed.includes('Sign in')) {
            throw new Error('AUTH_REQUIRED');
        }
        throw new Error('HTML_RESPONSE');
    }
    const startIdx = trimmed.indexOf('{');
    const endIdx = trimmed.lastIndexOf('}');
    if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
        throw new Error('INVALID_RESPONSE');
    }
    return JSON.parse(trimmed.slice(startIdx, endIdx + 1));
}

async function fetchTextWithTimeout(url, timeoutMs = 15000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url, {
            method: 'GET',
            mode: 'cors',
            credentials: 'omit',
            cache: 'no-store',
            signal: controller.signal
        });
        const text = await res.text();
        if (!res.ok) {
            const err = new Error(`HTTP_${res.status}`);
            err.httpStatus = res.status;
            throw err;
        }
        return text;
    } finally {
        clearTimeout(timer);
    }
}

async function fetchGsheetViaGvizCsv(sheetId, gid) {
    const url = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(sheetId)}/gviz/tq?tqx=out:csv&gid=${encodeURIComponent(gid)}&_=${Date.now()}`;
    const text = await fetchTextWithTimeout(url, 15000);
    const trimmed = text.trim();
    if (trimmed.startsWith('<')) {
        throw new Error(trimmed.includes('accounts.google.com') ? 'AUTH_REQUIRED' : 'HTML_RESPONSE');
    }
    return extractRowsFromMatrix(parseCSV(text));
}

async function fetchGsheetViaExportCsv(sheetId, gid) {
    const url = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(sheetId)}/export?format=csv&gid=${encodeURIComponent(gid)}&_=${Date.now()}`;
    const text = await fetchTextWithTimeout(url, 15000);
    const trimmed = text.trim();
    if (trimmed.startsWith('<')) {
        throw new Error(trimmed.includes('accounts.google.com') ? 'AUTH_REQUIRED' : 'HTML_RESPONSE');
    }
    return extractRowsFromMatrix(parseCSV(text));
}

async function fetchGsheetViaGvizFullJson(sheetId, gid) {
    const url = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(sheetId)}/gviz/tq?gid=${encodeURIComponent(gid)}&tqx=out:json&_=${Date.now()}`;
    const text = await fetchTextWithTimeout(url, 15000);
    const json = parseGvizJsonResponseText(text);
    if (!json || json.status === 'error') {
        const detail = (json && json.errors && json.errors[0] && (json.errors[0].detailed_message || json.errors[0].message)) || 'GViz Error';
        throw new Error(detail);
    }
    return extractRowsFromGvizTable(json.table);
}

function fetchGsheetViaJsonp(sheetId, gid) {
    return new Promise((resolve, reject) => {
        const cbName = '__gsheetCb_' + Date.now() + '_' + Math.floor(Math.random() * 100000);
        const scriptId = 'gsheet-jsonp-' + cbName;
        let settled = false;

        const cleanup = () => {
            if (timeoutId) clearTimeout(timeoutId);
            const el = document.getElementById(scriptId);
            if (el) el.remove();
            try { delete window[cbName]; } catch (e) { window[cbName] = undefined; }
        };

        const timeoutId = setTimeout(() => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(new Error('JSONP_TIMEOUT'));
        }, 12000);

        window[cbName] = function(response) {
            if (settled) return;
            settled = true;
            cleanup();
            resolve(response);
        };

        const url = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(sheetId)}/gviz/tq?gid=${encodeURIComponent(gid)}&tqx=out:json;responseHandler:${cbName}&_=${Date.now()}`;

        const script = document.createElement('script');
        script.id = scriptId;
        script.src = url;
        script.async = true;
        script.onerror = function() {
            if (settled) return;
            settled = true;
            cleanup();
            reject(new Error('JSONP_LOAD_ERROR'));
        };
        document.body.appendChild(script);
    });
}

async function fetchGsheetFromCustomUrl(customUrl) {
    const normalizedUrl = normalizeGsheetCustomUrl(customUrl);
    const sep = normalizedUrl.includes('?') ? '&' : '?';
    const text = await fetchTextWithTimeout(`${normalizedUrl}${sep}_=${Date.now()}`, 15000);
    const trimmed = text.trim();

    if (trimmed.startsWith('<')) {
        throw new Error(trimmed.includes('accounts.google.com') ? 'AUTH_REQUIRED' : 'HTML_RESPONSE');
    }

    // Jika respons berupa GViz JSON atau Apps Script JSON
    if (trimmed.includes('google.visualization.Query.setResponse')) {
        const json = parseGvizJsonResponseText(trimmed);
        if (json.status === 'error') throw new Error('GVIZ_ERROR');
        return { method: 'Custom GViz JSON', ...extractRowsFromGvizTable(json.table) };
    }

    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        const json = JSON.parse(trimmed);
        const extracted = extractRowsFromAppsScriptJson(json);
        if (extracted) return { method: 'Custom JSON / Apps Script', ...extracted };
    }

    // Default: CSV (Publikasikan ke Web / Export CSV)
    return { method: 'Published / Direct CSV', ...extractRowsFromMatrix(parseCSV(text)) };
}

function setGsheetStatusUI(state, labelText) {
    const icon = document.getElementById('gsheet-sync-icon');
    const txt = document.getElementById('gsheet-sync-text');
    const btn = document.getElementById('btn-gsheet-sync');

    if (txt && labelText !== undefined) txt.textContent = labelText;

    if (state === 'syncing') {
        if (icon) icon.className = 'fas fa-sync fa-spin text-emerald-600';
    } else if (state === 'ok') {
        if (icon) icon.className = 'fas fa-table text-emerald-600';
        if (btn) btn.className = 'flex items-center gap-1.5 bg-emerald-50 hover:bg-emerald-100 text-emerald-700 px-2.5 py-1 rounded-full border border-emerald-200 text-[10px] font-black transition cursor-pointer';
    } else if (state === 'warn') {
        if (icon) icon.className = 'fas fa-exclamation-circle text-orange-500';
        if (btn) btn.className = 'flex items-center gap-1.5 bg-orange-50 hover:bg-orange-100 text-orange-700 px-2.5 py-1 rounded-full border border-orange-200 text-[10px] font-black transition cursor-pointer';
    } else if (state === 'locked') {
        if (icon) icon.className = 'fas fa-lock text-red-500';
        if (btn) btn.className = 'flex items-center gap-1.5 bg-red-50 hover:bg-red-100 text-red-700 px-2.5 py-1 rounded-full border border-red-200 text-[10px] font-black transition cursor-pointer';
    } else {
        if (icon) icon.className = 'fas fa-exclamation-triangle text-red-500';
        if (btn) btn.className = 'flex items-center gap-1.5 bg-red-50 hover:bg-red-100 text-red-700 px-2.5 py-1 rounded-full border border-red-200 text-[10px] font-black transition cursor-pointer';
    }
}

function updateGsheetDiagUI() {
    const diagEl = document.getElementById('gsheet-diag-text');
    if (!diagEl) return;
    const timeStr = lastGsheetDiag.updatedAt ? new Date(lastGsheetDiag.updatedAt).toLocaleTimeString('id-ID') : '-';
    const statusColor = lastGsheetDiag.status === 'OK' ? 'text-emerald-700' : (lastGsheetDiag.status === 'IDLE' ? 'text-gray-600' : 'text-red-600');
    const colsLine = lastGsheetDiag.detectedCols && lastGsheetDiag.detectedCols !== '-'
        ? `<div class="text-[10px] text-emerald-700 font-mono mt-1">Kolom terdeteksi: <b>${lastGsheetDiag.detectedCols}</b></div>`
        : '';
    diagEl.innerHTML = `
        <div class="font-bold ${statusColor}">${lastGsheetDiag.message}</div>
        <div class="text-[10px] text-gray-500 mt-1">
            Metode: <b>${lastGsheetDiag.method}</b> | Baris dipindai: <b>${lastGsheetDiag.totalScanned}</b> | Status READY: <b>${lastGsheetDiag.readyCount}</b> | Update: <b>${timeStr}</b>
        </div>
        ${colsLine}
    `;
}

let lastGsheetSyncStartedAt = 0;
let currentDetailReqId = null;

function isGsheetRowCompleted(row) {
    if (!completedGsheetSerials || !row) return false;
    if (completedGsheetSerials[row.safeKey]) return true;
    const legacyEntry = row.legacySafeKey ? completedGsheetSerials[row.legacySafeKey] : null;
    if (legacyEntry) {
        return !legacyEntry.assy || legacyEntry.assy === row.assy;
    }
    return false;
}

function applyParsedGsheetResult(result, isManual) {
    const prevActiveIds = new Set(gsheetReadyRequests.map(r => r.id));
    gsheetRawReadyRows = result.parsedRows || [];
    rebuildGsheetRequests();
    const nextActiveIds = new Set(gsheetReadyRequests.map(r => r.id));

    // Hitung item yang sebelumnya READY di Active Queue namun berubah menjadi CLOSED/DONE di GSheet (tanpa masuk history)
    let removedBySheetClose = 0;
    prevActiveIds.forEach(prevId => {
        if (!nextActiveIds.has(prevId)) removedBySheetClose++;
    });

    lastGsheetDiag = {
        status: 'OK',
        method: result.method || 'GViz',
        totalScanned: result.totalScanned || 0,
        readyCount: gsheetRawReadyRows.length,
        detectedCols: result.detectedCols || '-',
        message: `Terhubung! Ditemukan ${gsheetRawReadyRows.length} data READY di GSheet (${gsheetReadyRequests.length} aktif belum diambil).`,
        updatedAt: Date.now()
    };

    setGsheetStatusUI('ok', `GSHEET: ${gsheetReadyRequests.length} READY`);
    updateGsheetDiagUI();
    renderData();

    // Jika tiket GSheet yang sedang dibuka di modal berubah jadi CLOSED/DONE di Sheet, tutup modalnya tanpa masuk history
    const pickerModal = document.getElementById('modal-picker');
    if (pickerModal && !pickerModal.classList.contains('hidden')) {
        const finishId = document.getElementById('finish-req-id')?.value || '';
        if (finishId.startsWith('GS-') && !nextActiveIds.has(finishId)) {
            closeModal('modal-picker');
            showMessage('Item tersebut sudah berstatus CLOSED/DONE di Google Sheets (tidak masuk history).');
        }
    }
    const detailModal = document.getElementById('modal-detail');
    if (detailModal && !detailModal.classList.contains('hidden') && currentDetailReqId && currentDetailReqId.startsWith('GS-')) {
        const stillActive = nextActiveIds.has(currentDetailReqId);
        const inHistory = loadedHistoryData.some(r => r.id === currentDetailReqId);
        if (!stillActive && !inHistory) {
            closeModal('modal-detail');
            showMessage('Item tersebut sudah berganti ke CLOSED/DONE di Google Sheets.');
        }
    }

    if (isManual) {
        const extra = removedBySheetClose > 0 ? ` (${removedBySheetClose} ditutup di Sheet dihapus dari antrian)` : '';
        showMessage(`Sinkronisasi GSheet berhasil (${result.method}): ${gsheetReadyRequests.length} Ready aktif${extra}.`);
    }
}

async function syncGsheetReadyItems(isManual = false) {
    lastGsheetSyncStartedAt = Date.now();
    const mySeq = ++gsheetSyncSeq;
    setGsheetStatusUI('syncing', isManual ? 'GSHEET: SYNC...' : undefined);

    const cfg = gsheetConfig || DEFAULT_GSHEET_CONFIG;
    const errors = [];
    let saw404 = false;
    let sawAuth = false;
    let sawTimeout = false;

    const recordErr = (stage, err) => {
        const msg = String(err && err.message ? err.message : err);
        errors.push(`${stage}: ${msg}`);
        if (msg === 'HTTP_404' || (err && err.httpStatus === 404)) saw404 = true;
        if (msg === 'AUTH_REQUIRED' || msg === 'HTTP_401' || msg === 'HTTP_403') sawAuth = true;
        if ((err && err.name === 'AbortError') || msg === 'JSONP_TIMEOUT') sawTimeout = true;
    };

    try {
        // Jalur Khusus: Jika pengguna memakai Custom URL (Publikasikan ke Web CSV / Apps Script)
        if (cfg.customUrl) {
            const res = await fetchGsheetFromCustomUrl(cfg.customUrl);
            if (mySeq !== gsheetSyncSeq) return;
            applyParsedGsheetResult(res, isManual);
            return;
        }

        const sheetId = String(cfg.sheetId || '').trim();
        const gid = String(cfg.gid ?? '0').trim();
        if (!sheetId) throw new Error('EMPTY_SHEET_ID');

        // Tahap 1: GViz Full CSV (membaca semua kolom & auto-deteksi header STATUS MARKER / PIC / No BOX)
        try {
            const csvRes = await fetchGsheetViaGvizCsv(sheetId, gid);
            if (mySeq !== gsheetSyncSeq) return;
            applyParsedGsheetResult({ method: 'GViz CSV', ...csvRes }, isManual);
            return;
        } catch (err) {
            recordErr('GVizCSV', err);
        }

        // Tahap 2: Export CSV langsung dari Google Sheets
        try {
            const expRes = await fetchGsheetViaExportCsv(sheetId, gid);
            if (mySeq !== gsheetSyncSeq) return;
            applyParsedGsheetResult({ method: 'Export CSV', ...expRes }, isManual);
            return;
        } catch (err) {
            recordErr('ExportCSV', err);
        }

        // Tahap 3: GViz Unfiltered JSON (auto-deteksi dari metadata cols[].label & baris header)
        try {
            const fullJsonRes = await fetchGsheetViaGvizFullJson(sheetId, gid);
            if (mySeq !== gsheetSyncSeq) return;
            applyParsedGsheetResult({ method: 'GViz Full JSON', ...fullJsonRes }, isManual);
            return;
        } catch (err) {
            recordErr('GVizFull', err);
        }

        // Tahap 4: JSONP Fallback (bekerja pada file:// dan memakai sesi login Google di browser)
        try {
            const jsonpData = await fetchGsheetViaJsonp(sheetId, gid);
            if (mySeq !== gsheetSyncSeq) return;
            if (jsonpData && jsonpData.status !== 'error' && jsonpData.table) {
                const parsed = extractRowsFromGvizTable(jsonpData.table);
                applyParsedGsheetResult({ method: 'JSONP Fallback', ...parsed }, isManual);
                return;
            }
            const errMsg = (jsonpData && jsonpData.errors && jsonpData.errors[0] && (jsonpData.errors[0].detailed_message || jsonpData.errors[0].message)) || 'JSONP_ERROR';
            recordErr('JSONP', new Error(errMsg));
        } catch (err) {
            recordErr('JSONP', err);
        }
    } catch (err) {
        recordErr('CustomURL', err);
    }

    if (mySeq !== gsheetSyncSeq) return;
    console.warn('Semua metode sinkronisasi GSheet gagal:', errors);

    if (saw404) {
        lastGsheetDiag = {
            status: 'ERROR',
            method: 'Gagal (HTTP 404)',
            totalScanned: 0,
            readyCount: 0,
            detectedCols: '-',
            message: 'Spreadsheet tidak ditemukan (HTTP 404) atau masih bersifat Privat.',
            updatedAt: Date.now()
        };
        setGsheetStatusUI('error', 'GSHEET: 404');
        updateGsheetDiagUI();
        if (isManual) showMessage('GSheet tidak ditemukan (404) / Privat.');
        return;
    }

    if (sawAuth) {
        lastGsheetDiag = {
            status: 'LOCKED',
            method: 'Gagal (Terkunci)',
            totalScanned: 0,
            readyCount: 0,
            detectedCols: '-',
            message: 'Google Sheets meminta login. Pastikan akses "Siapa saja yang memiliki link (Viewer)".',
            updatedAt: Date.now()
        };
        setGsheetStatusUI('locked', 'GSHEET: TERKUNCI');
        updateGsheetDiagUI();
        if (isManual) showMessage('GSheet terkunci. Pastikan akses "Anyone with the link: Viewer".');
        return;
    }

    if (sawTimeout) {
        lastGsheetDiag = {
            status: 'TIMEOUT',
            method: 'Timeout',
            totalScanned: 0,
            readyCount: 0,
            detectedCols: '-',
            message: 'Koneksi ke Google Sheets melewati batas waktu (Timeout). Coba klik ulang tombol GSHEET.',
            updatedAt: Date.now()
        };
        setGsheetStatusUI('warn', 'GSHEET: TIMEOUT');
        updateGsheetDiagUI();
        if (isManual) showMessage('Koneksi ke Google Sheets terlalu lama (Timeout). Coba klik ulang.');
        return;
    }

    lastGsheetDiag = {
        status: 'ERROR',
        method: 'Gagal',
        totalScanned: 0,
        readyCount: 0,
        detectedCols: '-',
        message: `Gagal membaca Google Sheets (${errors[errors.length - 1] || 'Koneksi terblokir'}).`,
        updatedAt: Date.now()
    };
    setGsheetStatusUI('error', 'GSHEET: GAGAL');
    updateGsheetDiagUI();
    if (isManual) showMessage('Gagal memuat Google Sheets. Coba klik ulang tombol GSHEET.');
}

// Kompatibilitas balik jika ada pemanggil eksternal handleGsheetSync
window.handleGsheetSync = function(response, isManual = false) {
    if (!response || response.status === 'error' || !response.table) {
        setGsheetStatusUI('error', 'GSHEET: ERROR');
        if (isManual) showMessage('Respons Google Sheets tidak valid.');
        return;
    }
    const parsed = extractRowsFromGvizTable(response.table);
    applyParsedGsheetResult({ method: 'External Callback', ...parsed }, isManual);
};


function rebuildGsheetRequests() {
    const activeGsheet = [];
    let newlyReadyForUser = null;

    gsheetRawReadyRows.forEach(row => {
        // Validasi item GSheet: jika sudah ditandai selesai di sistem ini, abaikan meski di GSheet masih READY
        if (isGsheetRowCompleted(row)) {
            return;
        }

        const meta = (gsheetMetaMap && (gsheetMetaMap[row.safeKey] || (row.legacySafeKey ? gsheetMetaMap[row.legacySafeKey] : null))) || {};
        const boxLabel = row.noBox
            ? (/^BOX\b/i.test(row.noBox) ? row.noBox : `BOX: ${row.noBox}`)
            : 'BOX: -';
        const noteText = `GSheet Auto-Ready | Serial WO: ${row.serialWO} | No Box: ${row.noBox || '-'} | Tgl Print: ${row.tglPrintLabel}`;

        const reqObj = {
            id: 'GS-' + row.safeKey,
            displayId: boxLabel,
            isFromGsheet: true,
            gsheetSerial: row.serialWO,
            gsheetSafeKey: row.safeKey,
            gsheetLegacySafeKey: row.legacySafeKey,
            noBox: row.noBox || '-',
            tglPrintLabel: row.tglPrintLabel,
            hasTglPrint: !!row.hasTglPrint,
            colLetters: row.colLetters || null,
            rawLine: row.rawLine,
            systemType: 'STATION MARKER',
            shift: '-',
            type: 'ALL',
            urgent: !!meta.urgent,
            items: [{
                assy: row.assy,
                wp: row.wp,
                qty: row.qty,
                lot: row.lot,
                line: row.line,
                note: noteText,
                pic: row.picWh,
                type: 'ALL',
                typeMarker: 'Wire',
                urgent: !!meta.urgent
            }],
            status: STATUS_READY,
            step: 4,
            timestamp: row.tglPrintTs,
            timeAccepted: row.tglPrintTs,
            timeReady: row.tglPrintTs,
            requestedBy: 'GSHEET',
            supplierBy: row.picWh,
            requestedStation: 'STATION MARKER',
            messages: meta.messages ? Object.values(meta.messages) : []
        };

        activeGsheet.push(reqObj);

        if (!isFirstGsheetLoad && !knownGsheetSerials.has(row.safeKey)) {
            if (currentUser && currentUser.role === 'leader' && (currentUser.line === 'ALL' || currentUser.line === row.line)) {
                newlyReadyForUser = reqObj;
            }
        }
    });

    knownGsheetSerials = new Set(gsheetRawReadyRows.map(r => r.safeKey));
    isFirstGsheetLoad = false;
    gsheetReadyRequests = activeGsheet;

    const txt = document.getElementById('gsheet-sync-text');
    if (
        txt &&
        !txt.textContent.includes('GAGAL') &&
        !txt.textContent.includes('ERROR') &&
        !txt.textContent.includes('TIMEOUT') &&
        !txt.textContent.includes('TERKUNCI') &&
        !txt.textContent.includes('404')
    ) {
        txt.textContent = `GSHEET: ${gsheetReadyRequests.length} READY`;
    }

    if (newlyReadyForUser) {
        playBeep('ready');
        triggerDesktopNotification('Part READY (GSheet)!', `Siap diambil (${newlyReadyForUser.displayId}): ${newlyReadyForUser.items[0].assy}`);
    }
}

function getAllActiveRequests() {
    const manualReqs = (db.requests || []).filter(r => r.systemType === currentUser.section && r.status !== STATUS_FINISHED);
    const gsheetReqs = currentUser.section === 'STATION MARKER' ? gsheetReadyRequests : [];
    return [...manualReqs, ...gsheetReqs];
}

// ============================================================================
// AUDIO, NOTIFIKASI, JAM, & TIMER
// ============================================================================
let announcerAudio = null;
try {
    if (typeof Audio !== 'undefined') {
        announcerAudio = new Audio('announcer.mp3');
        announcerAudio.preload = 'auto';
    }
} catch (e) {
    announcerAudio = null;
}

function initAudio() {
    if (!announcerAudio) return;
    try {
        announcerAudio.volume = 0;
        const playPromise = announcerAudio.play();
        if (playPromise !== undefined) {
            playPromise.then(() => {
                announcerAudio.pause();
                announcerAudio.currentTime = 0;
                announcerAudio.volume = 1;
            }).catch(() => {
                announcerAudio.volume = 1;
            });
        } else {
            announcerAudio.volume = 1;
        }
    } catch (e) {
        announcerAudio.volume = 1;
    }
}

function playBeep(type = 'notification') {
    if (!announcerAudio) return;
    try {
        announcerAudio.currentTime = 0;
        const p = announcerAudio.play();
        if (p && typeof p.catch === 'function') {
            p.catch(e => console.warn('Audio play prevented:', e));
        }
    } catch (e) {
        console.warn('Audio play prevented:', e);
    }
}

function requestNotificationPermission() {
    if ('Notification' in window && Notification.permission !== 'granted' && Notification.permission !== 'denied') {
        Notification.requestPermission();
    }
}

function triggerDesktopNotification(title, body) {
    if ('Notification' in window && Notification.permission === 'granted') {
        new Notification(title, {
            body: body,
            icon: 'https://cdn-icons-png.flaticon.com/512/1034/1034131.png'
        });
    }
}

function updateClock() {
    const now = new Date();
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agt', 'Sep', 'Okt', 'Nov', 'Des'];
    document.getElementById('realtime-clock').textContent = `${String(now.getDate()).padStart(2, '0')}-${months[now.getMonth()]}-${now.getFullYear()} - ${String(now.getHours()).padStart(2, '0')}.${String(now.getMinutes()).padStart(2, '0')}.${String(now.getSeconds()).padStart(2, '0')}`;
}

function calculateSegment(start, end, showDays = false) {
    if (!start || start === 'undefined') return '00:00:00';
    const diffMs = ((end && end !== 'undefined') ? parseInt(end, 10) : Date.now()) - parseInt(start, 10);
    if (diffMs < 0) return '00:00:00';
    const totalSecs = Math.floor(diffMs / 1000);

    const d = Math.floor(totalSecs / 86400);
    if (d > 0) {
        const h = Math.floor((totalSecs % 86400) / 3600);
        return `${d} Hari ${h} Jam`;
    }

    const h = Math.floor(totalSecs / 3600);
    const m = Math.floor((totalSecs % 3600) / 60);
    const s = totalSecs % 60;
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

function updateTimers() {
    document.querySelectorAll('.timer-segment').forEach(el => {
        el.textContent = calculateSegment(el.getAttribute('data-start'), el.getAttribute('data-end'), el.getAttribute('data-days') === 'true');
    });
    document.querySelectorAll('.ping-btn').forEach(btn => {
        const lastPing = parseInt(btn.getAttribute('data-ping-time'), 10) || 0;
        if (lastPing > 0) {
            const diff = Date.now() - lastPing;
            if (diff < 10000) {
                btn.disabled = true;
                btn.innerHTML = `<span class="text-xl font-display font-black">${Math.ceil((10000 - diff) / 1000)}s</span>`;
            } else {
                btn.disabled = false;
                btn.innerHTML = `<i class="fas fa-bell text-2xl animate-pulse"></i>`;
                btn.setAttribute('data-ping-time', '0');
            }
        }
    });
}

function formatDurationMs(ms) {
    if (!ms || ms < 0) return '-';
    const t = Math.floor(ms / 1000);
    const d = Math.floor(t / 86400);
    const h = Math.floor((t % 86400) / 3600);
    const m = Math.floor((t % 3600) / 60);
    const s = t % 60;
    return (d > 0 ? `${d}h ` : '') + (h > 0 || d > 0 ? `${h}j ` : '') + `${m}m ${s}s`;
}

// ============================================================================
// OTENTIKASI LISENSI & INISIALISASI FIREBASE REALTIME DB (DENGAN FALLBACK AMAN)
// ============================================================================
function loadLocalFallbackState() {
    try {
        const savedDb = localStorage.getItem(LOCAL_DB_STORAGE_KEY);
        if (savedDb) {
            const parsed = JSON.parse(savedDb);
            if (parsed && Array.isArray(parsed.requests)) db = parsed;
        }
    } catch (e) {}
    try {
        const savedCompleted = localStorage.getItem(LOCAL_COMPLETED_GSHEET_KEY);
        if (savedCompleted) completedGsheetSerials = JSON.parse(savedCompleted) || {};
    } catch (e) {}
    try {
        const savedMeta = localStorage.getItem(LOCAL_GSHEET_META_KEY);
        if (savedMeta) gsheetMetaMap = JSON.parse(savedMeta) || {};
    } catch (e) {}
}

function saveLocalDbState() {
    try {
        localStorage.setItem(LOCAL_DB_STORAGE_KEY, JSON.stringify(db));
    } catch (e) {}
}

function saveLocalCompletedGsheet() {
    try {
        localStorage.setItem(LOCAL_COMPLETED_GSHEET_KEY, JSON.stringify(completedGsheetSerials));
    } catch (e) {}
}

function saveLocalGsheetMeta() {
    try {
        localStorage.setItem(LOCAL_GSHEET_META_KEY, JSON.stringify(gsheetMetaMap));
    } catch (e) {}
}

function saveLocalHistoryRecord(dateStr, finishedReq) {
    try {
        const all = JSON.parse(localStorage.getItem(LOCAL_HISTORY_STORAGE_KEY) || '{}') || {};
        if (!Array.isArray(all[dateStr])) all[dateStr] = [];
        all[dateStr].push(finishedReq);
        localStorage.setItem(LOCAL_HISTORY_STORAGE_KEY, JSON.stringify(all));
    } catch (e) {}
}

function getLocalHistoryBucket(dateStr) {
    try {
        const all = JSON.parse(localStorage.getItem(LOCAL_HISTORY_STORAGE_KEY) || '{}') || {};
        return Array.isArray(all[dateStr]) ? all[dateStr] : [];
    } catch (e) {
        return [];
    }
}

function initFirebaseServices() {
    if (isFirebaseReady) return true;
    const fb = (typeof window !== 'undefined' && window.firebase) ? window.firebase : (typeof firebase !== 'undefined' ? firebase : null);
    if (!fb || typeof fb.initializeApp !== 'function') {
        return false;
    }
    try {
        if (!fb.apps || fb.apps.length === 0) {
            fb.initializeApp(firebaseConfig);
        }
        if (typeof fb.database === 'function') {
            const rtdb = fb.database();
            dbRef = rtdb.ref('eks_unified_db');
            completedGsheetRef = rtdb.ref('eks_completed_gsheet_serials');
            gsheetMetaRef = rtdb.ref('eks_gsheet_meta');
            gsheetConfigRef = rtdb.ref('eks_gsheet_config');
            whPresenceRef = rtdb.ref('wh_presence_marker');
        }
        if (typeof fb.firestore === 'function') {
            dbFs = fb.firestore();
        }
        isFirebaseReady = !!(dbRef || dbFs);
        return isFirebaseReady;
    } catch (e) {
        console.warn('Gagal menginisialisasi Firebase:', e);
        return false;
    }
}

function loadExternalScript(src) {
    return new Promise((resolve, reject) => {
        if (typeof document === 'undefined' || !document.head) {
            reject(new Error('DOM tidak tersedia'));
            return;
        }
        const script = document.createElement('script');
        script.src = src;
        script.async = false;
        let settled = false;
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            script.remove();
            reject(new Error('Timeout memuat script: ' + src));
        }, 8000);
        script.onload = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve();
        };
        script.onerror = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            script.remove();
            reject(new Error('Gagal memuat script: ' + src));
        };
        document.head.appendChild(script);
    });
}

async function ensureFirebaseLoaded() {
    if (initFirebaseServices()) return true;
    if (firebaseLoadPromise) return firebaseLoadPromise;

    firebaseLoadPromise = (async () => {
        for (const base of FIREBASE_FALLBACK_CDNS) {
            try {
                if (typeof window.firebase === 'undefined') {
                    await loadExternalScript(`${base}/firebase-app-compat.js`);
                }
                if (typeof window.firebase !== 'undefined' && typeof window.firebase.database !== 'function') {
                    await loadExternalScript(`${base}/firebase-database-compat.js`);
                }
                if (typeof window.firebase !== 'undefined' && typeof window.firebase.firestore !== 'function') {
                    await loadExternalScript(`${base}/firebase-firestore-compat.js`);
                }
                if (initFirebaseServices()) {
                    return true;
                }
            } catch (e) {
                console.warn(`Fallback Firebase CDN gagal (${base}):`, e && e.message ? e.message : e);
            }
        }
        return initFirebaseServices();
    })();

    return firebaseLoadPromise;
}

function attachWarehousePresenceListener() {
    if (!whPresenceRef) {
        checkWarehouseOnline(0);
        return;
    }
    if (isWhPresenceListenerAttached) return;
    isWhPresenceListenerAttached = true;
    whPresenceRef.on('value', snap => {
        const ls = snap.val() || 0;
        checkWarehouseOnline(ls);
        if (window.whCheckInterval) clearInterval(window.whCheckInterval);
        window.whCheckInterval = setInterval(() => checkWarehouseOnline(ls), 5000);
    });
}

function initRealtimeDB() {
    if (!initFirebaseServices() || !dbRef) {
        return;
    }
    if (isRealtimeListenersAttached) {
        return;
    }
    isRealtimeListenersAttached = true;

    dbRef.on('value', (snapshot) => {
        const data = snapshot.val();
        if (data) {
            db = data;
            if (!db.requests) db.requests = [];
        } else {
            db = { requests: [] };
            dbRef.set(db);
        }
        saveLocalDbState();
        renderData();
        checkNewNotifications();
    });

    if (completedGsheetRef) {
        completedGsheetRef.on('value', (snapshot) => {
            completedGsheetSerials = snapshot.val() || {};
            saveLocalCompletedGsheet();
            rebuildGsheetRequests();
            renderData();
        });
    }

    if (gsheetMetaRef) {
        gsheetMetaRef.on('value', (snapshot) => {
            gsheetMetaMap = snapshot.val() || {};
            saveLocalGsheetMeta();
            rebuildGsheetRequests();
            renderData();
        });
    }


    if (currentUser && currentUser.role === 'leader') {
        attachWarehousePresenceListener();
    } else if (currentUser && currentUser.role === 'warehouse') {
        updateWarehousePresence();
    }
}

function saveDB() {
    saveLocalDbState();
    if (dbRef) {
        try {
            dbRef.set(db);
        } catch (e) {
            console.warn('Gagal menyimpan data ke Firebase:', e);
        }
    } else {
        renderData();
    }
}

function initApp() {
    loadLocalFallbackState();

    if (initFirebaseServices()) {
        initRealtimeDB();
    } else {
        ensureFirebaseLoaded().then((ready) => {
            if (ready) {
                initRealtimeDB();
            } else {
                console.warn('Firebase SDK tidak tersedia; berjalan dalam mode penyimpanan lokal.');
            }
        });
    }

    try {
        const savedUser = sessionStorage.getItem('eks_unified_user');
        if (savedUser) {
            currentUser = JSON.parse(savedUser);
            const savedView = localStorage.getItem('eks_leader_view');
            if (savedView === 'grid') isLeaderGridView = true;
            showApp();
        }
    } catch (e) {
        console.warn('Gagal membaca sesi user tersimpan:', e);
    }
}

function updateWarehousePresence() {
    if (currentUser && currentUser.role === 'warehouse' && whPresenceRef) {
        try {
            whPresenceRef.set(Date.now());
        } catch (e) {}
    }
}

function checkWarehouseOnline(lastSeenTime) {
    const isOnline = (Date.now() - lastSeenTime) < 15000;
    const dot = document.getElementById('wh-online-dot');
    const txt = document.getElementById('wh-online-text');
    if (!dot || !txt) return;
    if (isOnline) {
        dot.className = 'w-2 h-2 rounded-full bg-green-500 animate-pulse shadow-sm';
        txt.textContent = 'ONLINE';
        txt.className = 'text-green-600 font-black text-[10px] uppercase';
    } else {
        dot.className = 'w-2 h-2 rounded-full bg-red-500 shadow-sm';
        txt.textContent = 'OFFLINE';
        txt.className = 'text-red-500 font-bold text-[10px] uppercase';
    }
}

function openLicenseModal(station) {
    document.getElementById('license-modal-title').textContent = station;
    document.getElementById('license-input').value = '';
    document.getElementById('license-error').classList.add('invisible');
    openModal('modal-license');
    setTimeout(() => document.getElementById('license-input').focus(), 100);
}

function submitLicense() {
    const key = document.getElementById('license-input').value.trim().toUpperCase();
    const errEl = document.getElementById('license-error');
    if (!VALID_LICENSES[key]) {
        errEl.textContent = 'Lisensi tidak valid atau tidak terdaftar!';
        errEl.classList.remove('invisible');
        return;
    }

    initAudio();
    requestNotificationPermission();

    currentUser = { ...VALID_LICENSES[key] };
    sessionStorage.setItem('eks_unified_user', JSON.stringify(currentUser));
    closeModal('modal-license');
    showApp();
}

function handleLogout() {
    sessionStorage.removeItem('eks_unified_user');
    if (currentUser && currentUser.role === 'warehouse' && whPresenceRef) {
        try {
            whPresenceRef.set(0);
        } catch (e) {}
    }
    if (whPresenceRef && isWhPresenceListenerAttached) {
        try {
            whPresenceRef.off('value');
        } catch (e) {}
        isWhPresenceListenerAttached = false;
    }
    currentUser = null;
    selectedBatchIds.clear();
    batchFinishIds = [];
    currentVisibleReadyIds = [];
    if (timeInterval) clearInterval(timeInterval);
    if (clockInterval) clearInterval(clockInterval);
    if (whPresenceInterval) clearInterval(whPresenceInterval);
    if (window.whCheckInterval) clearInterval(window.whCheckInterval);
    if (gsheetPollInterval) clearInterval(gsheetPollInterval);
    document.getElementById('login-page').classList.remove('hidden');
    document.getElementById('main-app').classList.add('hidden');
}

function toggleLeaderView() {
    isLeaderGridView = !isLeaderGridView;
    localStorage.setItem('eks_leader_view', isLeaderGridView ? 'grid' : 'list');
    document.getElementById('btn-toggle-view').innerHTML = isLeaderGridView
        ? '<i class="fas fa-list text-brand-teal"></i>'
        : '<i class="fas fa-th-large text-brand-teal"></i>';
    renderData();
}

function showApp() {
    document.getElementById('login-page').classList.add('hidden');
    document.getElementById('main-app').classList.remove('hidden');
    document.getElementById('lbl-role').textContent = currentUser.role === 'leader' ? 'LINE' : 'WAREHOUSE';
    document.getElementById('hdr-name').textContent = currentUser.name;
    document.getElementById('hdr-shift').textContent = currentUser.shift !== '-' ? 'SHIFT ' + currentUser.shift : 'GUDANG';
    if (currentUser.shift === '-') document.getElementById('hdr-shift').classList.add('hidden');
    else document.getElementById('hdr-shift').classList.remove('hidden');

    if (currentUser.role === 'leader') {
        document.getElementById('dashboard-leader').classList.remove('hidden');
        document.getElementById('dashboard-warehouse').classList.add('hidden');
        document.getElementById('btn-new-kanban').classList.remove('hidden');
        document.getElementById('btn-stats').classList.add('hidden');
        document.getElementById('filter-line').value = currentUser.line;

        document.getElementById('btn-toggle-view').classList.remove('hidden');
        document.getElementById('btn-toggle-view').innerHTML = isLeaderGridView
            ? '<i class="fas fa-list text-brand-teal"></i>'
            : '<i class="fas fa-th-large text-brand-teal"></i>';

        document.getElementById('wh-presence-container').classList.remove('hidden');
        attachWarehousePresenceListener();
    } else {
        document.getElementById('dashboard-leader').classList.add('hidden');
        document.getElementById('dashboard-warehouse').classList.remove('hidden');
        document.getElementById('btn-new-kanban').classList.add('hidden');
        document.getElementById('btn-stats').classList.remove('hidden');
        document.getElementById('btn-toggle-view').classList.add('hidden');
        document.getElementById('wh-presence-container').classList.add('hidden');

        if (whPresenceInterval) clearInterval(whPresenceInterval);
        whPresenceInterval = setInterval(updateWarehousePresence, 5000);
        updateWarehousePresence();
    }

    isHistoryOpen = false;
    updateHistoryPanelCSS();
    if (clockInterval) clearInterval(clockInterval);
    updateClock();
    clockInterval = setInterval(updateClock, 1000);
    if (timeInterval) clearInterval(timeInterval);
    timeInterval = setInterval(updateTimers, 1000);

    syncGsheetReadyItems(false);
    if (gsheetPollInterval) clearInterval(gsheetPollInterval);
    gsheetPollInterval = setInterval(() => syncGsheetReadyItems(false), 10000);

    renderData();
}

function triggerAutoSyncOnReturn() {
    if (!currentUser) return;
    if (typeof document !== 'undefined' && document.hidden) return;
    if (Date.now() - lastGsheetSyncStartedAt > 3000) {
        syncGsheetReadyItems(false);
    }
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('focus', triggerAutoSyncOnReturn);
}
if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('visibilitychange', triggerAutoSyncOnReturn);
}

function showMessage(msg) {
    const el = document.createElement('div');
    el.className = 'fixed bottom-5 left-1/2 transform -translate-x-1/2 bg-gray-800 text-white px-6 py-3 rounded-full shadow-lg z-[100] text-xs font-bold animate-bounce text-center';
    el.innerHTML = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 3500);
}

function openModal(id) {
    document.getElementById(id).classList.remove('hidden');
    document.body.classList.add('modal-active');
}

function closeModal(id) {
    if (id === 'modal-detail') currentDetailReqId = null;
    document.getElementById(id).classList.add('hidden');
    document.body.classList.remove('modal-active');
}

function getLineInit(lineStr) {
    if (lineStr === 'Line Crimping') return 'C';
    if (lineStr === 'Line SMV') return 'S';
    if (lineStr === 'Line Proto') return 'P';
    if (lineStr === 'Line HA') return 'H';
    return 'X';
}

function getLineColor(lineStr) {
    if (lineStr === 'Line Crimping') return 'bg-orange-50 border-orange-200 text-orange-700';
    if (lineStr === 'Line SMV') return 'bg-yellow-50 border-yellow-200 text-yellow-700';
    if (lineStr === 'Line Proto') return 'bg-blue-50 border-blue-200 text-blue-700';
    if (lineStr === 'Line HA') return 'bg-red-50 border-red-200 text-red-700';
    return 'bg-gray-50 border-gray-200 text-gray-700';
}

function generateId() {
    return 'REQ-' + Date.now().toString(36).toUpperCase();
}

function toggleHistory() {
    isHistoryOpen = !isHistoryOpen;
    if (typeof hideHistoryContextMenu === 'function') hideHistoryContextMenu();
    updateHistoryPanelCSS();
    if (isHistoryOpen) {
        if (!document.getElementById('history-date-start').value) {
            const today = new Date().toISOString().split('T')[0];
            document.getElementById('history-date-start').value = today;
            document.getElementById('history-date-end').value = today;
        }
        loadAndRenderHistory();
    }
}

function updateHistoryPanelCSS() {
    const pnl = document.getElementById('history-panel');
    if (isHistoryOpen) {
        pnl.classList.remove('history-closed');
        pnl.classList.add('history-open');
    } else {
        pnl.classList.add('history-closed');
        pnl.classList.remove('history-open');
    }
}

// ============================================================================
// FORM PEMBUATAN KANBAN BARU (ALL & IMPP)
// ============================================================================
function routeNewKanban() {
    openModal('modal-select-type-marker');
}

const ASSY_HISTORY_CACHE_KEY = 'eks_assy_history_cache_v1';
let assyHistoryCache = loadLocalAssyHistoryCache();
let assyHistoryLastFetchAt = 0;
let assyHistoryFetchPromise = null;
let assySuggestionList = [];
let assySuggestionActiveIdx = -1;

function loadLocalAssyHistoryCache() {
    try {
        const raw = localStorage.getItem(ASSY_HISTORY_CACHE_KEY);
        if (raw) return JSON.parse(raw) || {};
    } catch (e) {}
    return {};
}

function saveLocalAssyHistoryCache() {
    try {
        localStorage.setItem(ASSY_HISTORY_CACHE_KEY, JSON.stringify(assyHistoryCache));
    } catch (e) {}
}

function recordAssyEntriesToMap(targetMap, reqList) {
    if (!Array.isArray(reqList)) return;
    reqList.forEach(req => {
        if (!req || req.isFromGsheet) return;
        if (req.systemType && currentUser && req.systemType !== currentUser.section) return;
        const ts = Number(req.timeFinished || req.timestamp || 0);
        (req.items || []).forEach(item => {
            const assy = String(item && item.assy ? item.assy : '').trim().toUpperCase();
            if (!assy) return;
            const prev = targetMap[assy];
            if (!prev || ts >= (prev.lastTs || 0)) {
                targetMap[assy] = {
                    assy,
                    wp: String(item.wp || prev?.wp || '').trim().toUpperCase(),
                    line: item.line || prev?.line || '',
                    typeMarker: item.typeMarker || prev?.typeMarker || '',
                    lastTs: Math.max(ts, prev?.lastTs || 0),
                    count: (prev?.count || 0) + 1
                };
            } else {
                prev.count = (prev.count || 0) + 1;
            }
        });
    });
}

function recordRequestAssyToHistoryCache(req) {
    if (!req) return;
    recordAssyEntriesToMap(assyHistoryCache, [req]);
    saveLocalAssyHistoryCache();
}

function getMergedAssyHistoryMap() {
    const merged = {};
    // 1. Dari cache persisten history kanban
    Object.keys(assyHistoryCache || {}).forEach(k => {
        const entry = assyHistoryCache[k];
        if (entry && entry.assy) merged[k] = { ...entry };
    });
    // 2. Dari localStorage history buckets
    try {
        const allLocalHist = JSON.parse(localStorage.getItem(LOCAL_HISTORY_STORAGE_KEY) || '{}') || {};
        Object.values(allLocalHist).forEach(arr => recordAssyEntriesToMap(merged, arr));
    } catch (e) {}
    // 3. Dari cache Firestore history buckets & loadedHistoryData sesi ini
    Object.values(cachedHistoryBuckets || {}).forEach(arr => recordAssyEntriesToMap(merged, arr));
    recordAssyEntriesToMap(merged, loadedHistoryData);
    // 4. Dari antrian kanban manual aktif yang pernah dibuat
    recordAssyEntriesToMap(merged, db.requests || []);
    return merged;
}

async function ensureAssyHistoryLoaded() {
    if (!dbFs) return;
    if (Date.now() - assyHistoryLastFetchAt < 60000) return;
    if (assyHistoryFetchPromise) return assyHistoryFetchPromise;

    assyHistoryFetchPromise = (async () => {
        try {
            const snap = await dbFs.collection('eks_history_buckets').limit(60).get();
            let updated = false;
            snap.forEach(doc => {
                const data = doc.data();
                const txList = Array.isArray(data && data.transactions) ? data.transactions : [];
                if (doc.id && !cachedHistoryBuckets[doc.id]) {
                    cachedHistoryBuckets[doc.id] = txList;
                }
                if (txList.length > 0) {
                    recordAssyEntriesToMap(assyHistoryCache, txList);
                    updated = true;
                }
            });
            assyHistoryLastFetchAt = Date.now();
            if (updated) {
                saveLocalAssyHistoryCache();
                const assyInput = document.getElementById('form-assy-m');
                if (assyInput && assyInput.value.trim().length >= 2) {
                    renderAssySuggestions(assyInput.value);
                }
            }
        } catch (e) {
            console.warn('Gagal memuat histori No Assy dari Firestore:', e);
        } finally {
            assyHistoryFetchPromise = null;
        }
    })();

    return assyHistoryFetchPromise;
}

function getAssyHistorySuggestions(rawQuery) {
    const query = String(rawQuery || '').trim().toUpperCase();
    // Muncul hanya mulai dari 2 karakter pertama yang sama dengan input user
    if (query.length < 2) return [];
    const merged = getMergedAssyHistoryMap();
    return Object.values(merged)
        .filter(entry => entry.assy.startsWith(query))
        .sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0) || a.assy.localeCompare(b.assy))
        .slice(0, 15);
}

function escapeHtmlAttr(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderAssySuggestions(rawQuery) {
    const dropdown = document.getElementById('assy-suggestion-dropdown');
    if (!dropdown) return;

    const query = String(rawQuery || '').trim().toUpperCase();
    const matches = getAssyHistorySuggestions(query);
    assySuggestionList = matches;
    assySuggestionActiveIdx = -1;

    if (matches.length === 0) {
        dropdown.innerHTML = '';
        dropdown.classList.add('hidden');
        return;
    }

    dropdown.innerHTML = matches.map((item, idx) => {
        const prefix = escapeHtmlAttr(item.assy.slice(0, query.length));
        const rest = escapeHtmlAttr(item.assy.slice(query.length));
        const safeVal = escapeHtmlAttr(item.assy);
        return `
        <button type="button" data-assy-idx="${idx}" onmousedown="event.preventDefault(); selectAssySuggestion('${safeVal}')"
            class="assy-sugg-item w-full text-left px-3 py-2 text-xs border-b border-gray-100 last:border-b-0 hover:bg-blue-50 flex items-center justify-between gap-2 transition-colors">
            <span class="font-display font-black text-gray-800 tracking-wide"><span class="text-brand-teal bg-teal-50 px-0.5 rounded">${prefix}</span>${rest}</span>
            <span class="text-[9px] font-bold text-gray-400 uppercase shrink-0">${item.line ? escapeHtmlAttr(item.line) : 'History'}</span>
        </button>`;
    }).join('');
    dropdown.classList.remove('hidden');
}

function hideAssySuggestionsDelayed() {
    setTimeout(() => {
        const dropdown = document.getElementById('assy-suggestion-dropdown');
        if (dropdown) dropdown.classList.add('hidden');
        assySuggestionActiveIdx = -1;
    }, 150);
}

function selectAssySuggestion(assyVal) {
    const input = document.getElementById('form-assy-m');
    if (input) {
        input.value = String(assyVal || '').toUpperCase();
    }
    const dropdown = document.getElementById('assy-suggestion-dropdown');
    if (dropdown) {
        dropdown.innerHTML = '';
        dropdown.classList.add('hidden');
    }
    assySuggestionList = [];
    assySuggestionActiveIdx = -1;
}

function handleAssyInputChange(el) {
    el.value = el.value.toUpperCase();
    renderAssySuggestions(el.value);
}

function updateAssySuggestionHighlight() {
    const dropdown = document.getElementById('assy-suggestion-dropdown');
    if (!dropdown) return;
    const items = dropdown.querySelectorAll('.assy-sugg-item');
    items.forEach((btn, idx) => {
        if (idx === assySuggestionActiveIdx) {
            btn.classList.add('bg-blue-50');
            if (typeof btn.scrollIntoView === 'function') btn.scrollIntoView({ block: 'nearest' });
        } else {
            btn.classList.remove('bg-blue-50');
        }
    });
}

function handleAssySuggestionKeydown(e, nextFocusFn) {
    const dropdown = document.getElementById('assy-suggestion-dropdown');
    const isOpen = dropdown && !dropdown.classList.contains('hidden') && assySuggestionList.length > 0;

    if (isOpen && e.key === 'ArrowDown') {
        e.preventDefault();
        assySuggestionActiveIdx = (assySuggestionActiveIdx + 1) % assySuggestionList.length;
        updateAssySuggestionHighlight();
        return true;
    }
    if (isOpen && e.key === 'ArrowUp') {
        e.preventDefault();
        assySuggestionActiveIdx = assySuggestionActiveIdx <= 0 ? assySuggestionList.length - 1 : assySuggestionActiveIdx - 1;
        updateAssySuggestionHighlight();
        return true;
    }
    if (isOpen && e.key === 'Escape') {
        e.preventDefault();
        dropdown.classList.add('hidden');
        assySuggestionActiveIdx = -1;
        return true;
    }
    if (isOpen && e.key === 'Enter' && assySuggestionActiveIdx >= 0 && assySuggestionList[assySuggestionActiveIdx]) {
        e.preventDefault();
        selectAssySuggestion(assySuggestionList[assySuggestionActiveIdx].assy);
        return true;
    }
    if (e.key === 'Enter' && typeof nextFocusFn === 'function') {
        if (dropdown) dropdown.classList.add('hidden');
        e.preventDefault();
        nextFocusFn();
        return true;
    }
    return false;
}

function selectKanbanTypeMarker(type) {
    currentKanbanTypeMarker = type;
    document.getElementById('form-type-badge-marker').textContent = type;
    closeModal('modal-select-type-marker');
    tempAssyListMarker = [];
    assySuggestionList = [];
    assySuggestionActiveIdx = -1;
    renderTempListMarker();
    ensureAssyHistoryLoaded();
    if (type === 'ALL') renderFormInputsMarkerALL();
    else renderFormInputsMarkerIMPP();
    openModal('modal-kanban-marker');
    setTimeout(() => {
        document.getElementById('form-assy-m').focus();
    }, 100);
}

function renderFormInputsMarkerALL() {
    document.getElementById('form-inputs-container-marker').innerHTML = `
        <div class="relative">
            <label class="label-stylish">NO ASSY</label>
            <input type="text" id="form-assy-m" autocomplete="off" class="input-stylish w-full uppercase" placeholder="Scan/Ketik Assy (min 2 karakter untuk saran)" oninput="handleAssyInputChange(this)" onfocus="renderAssySuggestions(this.value)" onblur="hideAssySuggestionsDelayed()">
            <div id="assy-suggestion-dropdown" class="hidden absolute left-0 right-0 top-full mt-1 bg-white border border-blue-200 rounded-lg shadow-xl z-50 max-h-48 overflow-y-auto"></div>
        </div>
        <div class="flex gap-3 mt-3">
            <div class="w-1/3"><label class="label-stylish">W/P</label><input type="text" id="form-wp-m" class="input-stylish w-full uppercase" placeholder="07/04" oninput="this.value = this.value.toUpperCase()"></div>
            <div class="w-1/3"><label class="label-stylish">QTY</label><input type="number" min="1" id="form-qty-m" class="input-stylish w-full" placeholder="0"></div>
            <div class="w-1/3"><label class="label-stylish text-purple-600">LOT <span class="text-[8px] text-gray-400 font-normal normal-case">(Opsional)</span></label><input type="text" id="form-lot-m" class="input-stylish w-full text-purple-700 border-purple-200 bg-purple-50 uppercase" placeholder="Cth: A" oninput="this.value = this.value.toUpperCase()"></div>
            <div class="w-1/3"><label class="label-stylish">TIPE MARKER</label><select id="form-type-marker-m" class="input-stylish w-full"><option value="Wire">Wire</option><option value="Tube">Tube</option><option value="Joint">Joint</option></select></div>
        </div>
        <div class="mt-3"><label class="label-stylish">LINE OUTPUT</label><select id="form-line-m" class="input-stylish w-full"><option value="Line Crimping">Line Crimping</option><option value="Line SMV">Line SMV</option><option value="Line Proto">Line Proto</option><option value="Line HA">Line HA</option></select></div>
        <div class="flex gap-3 mt-3">
            <div class="flex-1"><label class="label-stylish">NAMA PIC</label><input type="text" id="form-pic-m" class="input-stylish w-full uppercase" placeholder="Inisial"></div>
            <div class="flex-[2]"><label class="label-stylish">KETERANGAN TAMBAHAN (OPSIONAL)</label><input type="text" id="form-note-m" class="input-stylish w-full" placeholder="Info tambahan..."></div>
        </div>
    `;
    document.getElementById('modal-left-action-container').classList.remove('hidden');
    if (currentUser.line && currentUser.line !== 'ALL') {
        document.getElementById('form-line-m').value = currentUser.line;
    }

    setTimeout(() => {
        const inputs = Array.from(document.getElementById('form-inputs-container-marker').querySelectorAll('input, select'));
        inputs.forEach((input, index) => {
            input.onkeydown = function(e) {
                if (input.id === 'form-assy-m') {
                    const handled = handleAssySuggestionKeydown(e, () => {
                        const nextInput = inputs[index + 1];
                        if (nextInput) nextInput.focus();
                        else addAssyToTempMarker();
                    });
                    if (handled) return;
                }
                if (e.key === 'Enter') {
                    e.preventDefault();
                    const nextInput = inputs[index + 1];
                    if (nextInput) nextInput.focus();
                    else addAssyToTempMarker();
                }
            };
        });
    }, 50);
}

function renderFormInputsMarkerIMPP() {
    document.getElementById('form-inputs-container-marker').innerHTML = `
        <div class="relative">
            <label class="label-stylish">NO ASSY</label>
            <input type="text" id="form-assy-m" autocomplete="off" class="input-stylish w-full uppercase font-black text-brand-blue" placeholder="Scan/Ketik Assy (min 2 karakter untuk saran)" oninput="handleAssyInputChange(this)" onfocus="renderAssySuggestions(this.value)" onblur="hideAssySuggestionsDelayed()">
            <div id="assy-suggestion-dropdown" class="hidden absolute left-0 right-0 top-full mt-1 bg-white border border-blue-200 rounded-lg shadow-xl z-50 max-h-48 overflow-y-auto"></div>
        </div>
        <div class="flex gap-3 mt-3">
            <div class="w-1/2"><label class="label-stylish">W/P</label><input type="text" id="form-wp-m" class="input-stylish w-full uppercase" placeholder="07/04" oninput="this.value = this.value.toUpperCase()"></div>
            <div class="w-1/2"><label class="label-stylish text-purple-600">LOT <span class="text-[8px] text-gray-400 font-normal normal-case">(Opsional)</span></label><input type="text" id="form-lot-m" class="input-stylish w-full text-purple-700 border-purple-200 bg-purple-50 uppercase" placeholder="Cth: A" oninput="this.value = this.value.toUpperCase()"></div>
        </div>
        <div class="flex gap-3 mt-3">
            <div class="flex-1"><label class="label-stylish">LINE OUTPUT</label><select id="form-line-m" class="input-stylish w-full"><option value="Line Crimping">Line Crimping</option><option value="Line SMV">Line SMV</option><option value="Line Proto">Line Proto</option><option value="Line HA">Line HA</option></select></div>
            <div class="flex-1"><label class="label-stylish">NAMA PIC</label><input type="text" id="form-pic-m" class="input-stylish w-full uppercase" placeholder="Inisial"></div>
        </div>
        <div class="mt-3"><label class="label-stylish">KETERANGAN TAMBAHAN (OPSIONAL)</label><input type="text" id="form-note-m" class="input-stylish w-full" placeholder="Info tambahan..."></div>

        <div class="mt-4 pt-4 border-t border-gray-200">
            <label class="label-stylish text-red-500"><i class="fas fa-exclamation-triangle"></i> DEFAULT PROBLEM (OTOMATIS TERISI PADA MARKER)</label>
            <input type="text" id="form-problem-m" list="problem-list" class="input-stylish w-full" placeholder="Pilih atau ketik problem (bisa diubah nanti)...">
        </div>

        <div class="mt-4 bg-indigo-50 border border-indigo-200 p-3 rounded-lg shadow-sm">
            <label class="label-stylish text-brand-blue mb-2"><i class="fas fa-keyboard"></i> KETIK MARKER LALU TEKAN ENTER</label>
            <div class="flex gap-2">
                <input type="text" id="form-marker-input-m" class="input-stylish flex-1 font-mono text-indigo-700" placeholder="Ketik teks marker...">
                <button type="button" onclick="handleIMPMarkerEnter()" class="bg-brand-blue text-white px-4 rounded-lg font-bold shadow hover:bg-blue-800"><i class="fas fa-level-down-alt transform rotate-90"></i></button>
            </div>
        </div>
    `;

    document.getElementById('modal-left-action-container').classList.add('hidden');

    if (currentUser.line && currentUser.line !== 'ALL') {
        document.getElementById('form-line-m').value = currentUser.line;
    }

    setTimeout(() => {
        const assyInput = document.getElementById('form-assy-m');
        if (assyInput) {
            assyInput.onkeydown = function(e) {
                handleAssySuggestionKeydown(e, () => {
                    const wpInput = document.getElementById('form-wp-m');
                    if (wpInput) wpInput.focus();
                });
            };
        }
        document.getElementById('form-marker-input-m').addEventListener('keypress', function(e) {
            if (e.key === 'Enter') {
                e.preventDefault();
                handleIMPMarkerEnter();
            }
        });
    }, 100);
}

function handleIMPMarkerEnter() {
    const assy = document.getElementById('form-assy-m').value.trim().toUpperCase();
    if (!assy) {
        showMessage('Assy No wajib diisi sebelum input marker!');
        return;
    }

    const markerInput = document.getElementById('form-marker-input-m');
    const markerText = markerInput.value.trim().toUpperCase();
    if (!markerText) return;

    const wp = document.getElementById('form-wp-m').value.trim().toUpperCase();
    const lot = document.getElementById('form-lot-m').value.trim().toUpperCase();
    const line = document.getElementById('form-line-m').value;
    const pic = document.getElementById('form-pic-m').value.trim().toUpperCase();
    const note = document.getElementById('form-note-m').value.trim();
    const defProblem = document.getElementById('form-problem-m').value.trim();

    let existingIdx = tempAssyListMarker.findIndex(item =>
        item.type === 'IMPP' &&
        item.assy === assy &&
        item.wp === wp &&
        item.lot === lot &&
        item.line === line &&
        item.pic === pic &&
        item.note === note
    );

    if (existingIdx === -1) {
        tempAssyListMarker.push({
            assy, wp, lot, line, note, pic, type: 'IMPP', urgent: false,
            markers: []
        });
        existingIdx = tempAssyListMarker.length - 1;
    }

    tempAssyListMarker[existingIdx].markers.push({
        text: markerText,
        qty: 0,
        typeMarker: 'Wire',
        problem: defProblem
    });

    markerInput.value = '';
    renderTempListMarker();
    markerInput.focus();
}

function addAssyToTempMarker() {
    const assy = document.getElementById('form-assy-m').value.trim().toUpperCase();
    const qty = document.getElementById('form-qty-m').value;
    if (!assy || !qty) {
        showMessage('Assy No dan QTY wajib diisi!');
        return;
    }

    const item = {
        assy,
        wp: document.getElementById('form-wp-m').value.trim().toUpperCase(),
        qty,
        lot: document.getElementById('form-lot-m').value.toUpperCase(),
        line: document.getElementById('form-line-m').value,
        note: document.getElementById('form-note-m').value.trim(),
        pic: document.getElementById('form-pic-m').value.trim().toUpperCase(),
        type: currentKanbanTypeMarker,
        typeMarker: document.getElementById('form-type-marker-m').value,
        urgent: false
    };

    tempAssyListMarker.push(item);
    renderTempListMarker();
    document.getElementById('form-assy-m').value = '';
    document.getElementById('form-wp-m').value = '';
    document.getElementById('form-qty-m').value = '';
    document.getElementById('form-note-m').value = '';
    document.getElementById('form-assy-m').focus();
}

window.updateMarkerData = function(assyIdx, markerIdx, field, value) {
    tempAssyListMarker[assyIdx].markers[markerIdx][field] = value;
};

window.removeMarkerFromIMPP = function(assyIdx, markerIdx) {
    tempAssyListMarker[assyIdx].markers.splice(markerIdx, 1);
    if (tempAssyListMarker[assyIdx].markers.length === 0) {
        tempAssyListMarker.splice(assyIdx, 1);
    }
    renderTempListMarker();
};

function toggleTempUrgentMarker(idx) {
    tempAssyListMarker[idx].urgent = !tempAssyListMarker[idx].urgent;
    renderTempListMarker();
}

function renderTempListMarker() {
    const listDiv = document.getElementById('temp-assy-list-marker');
    document.getElementById('temp-count-marker').textContent = tempAssyListMarker.length;

    if (tempAssyListMarker.length === 0) {
        listDiv.innerHTML = `<div class="h-full flex flex-col items-center justify-center text-gray-300 py-10"><i class="fas fa-box-open text-4xl mb-2"></i><p class="text-xs font-bold uppercase tracking-wide">Belum ada unit ditambahkan</p></div>`;
        return;
    }

    listDiv.innerHTML = tempAssyListMarker.map((item, idx) => {
        if (item.type === 'ALL') {
            return `
            <div class="flex items-center justify-between bg-white border border-gray-100 p-2.5 rounded-lg shadow-sm mb-2">
                <div class="flex items-start gap-2.5">
                    <div class="bg-blue-50 text-brand-blue font-black px-2 py-1 rounded text-[10px] mt-0.5 w-6 text-center">${idx + 1}</div>
                    <div>
                        <div class="flex items-center gap-1.5 mb-1"><span class="font-display font-black text-sm text-gray-800">${item.assy}</span><span class="bg-gray-800 text-white px-1.5 py-0.5 rounded text-[8px] font-black uppercase shadow-sm">WP: ${item.wp}</span><span class="bg-blue-600 text-white px-1.5 py-0.5 rounded text-[8px] font-black shadow-sm">QTY: ${item.qty}</span>${item.lot ? `<span class="bg-purple-600 text-white px-1.5 py-0.5 rounded text-[8px] font-black shadow-sm">${item.lot}</span>` : ''}</div>
                        <div class="flex flex-wrap gap-1"><span class="text-[8px] font-bold bg-gray-100 text-gray-500 px-1.5 py-0.5 rounded uppercase border">${item.line}</span><span class="text-[8px] font-bold bg-indigo-50 text-indigo-700 px-1.5 py-0.5 rounded uppercase border border-indigo-200">${item.typeMarker}</span></div>
                    </div>
                </div>
                <div class="flex items-center gap-3">
                    <label class="flex items-center cursor-pointer group"><div class="relative flex items-center"><input type="checkbox" class="sr-only toggle-switch-input" onchange="toggleTempUrgentMarker(${idx})" ${item.urgent ? 'checked' : ''}><div class="w-8 h-4 rounded-full transition-colors toggle-switch-bg ${item.urgent ? 'bg-red-400' : 'bg-gray-300'}"><div class="toggle-switch-dot absolute left-0.5 top-0.5 bg-white w-3 h-3 rounded-full transition-transform duration-300 ${item.urgent ? 'translate-x-4' : ''}"></div></div></div><span class="ml-1.5 text-[9px] font-bold uppercase w-12 ${item.urgent ? 'text-red-500' : 'text-gray-400'}">${item.urgent ? 'URGENT' : 'REGULAR'}</span></label>
                    <button onclick="tempAssyListMarker.splice(${idx}, 1); renderTempListMarker()" class="text-red-400 hover:text-red-600 hover:bg-red-50 p-1.5 rounded"><i class="fas fa-trash text-xs"></i></button>
                </div>
            </div>`;
        } else {
            return `
            <div class="bg-white border border-indigo-100 rounded-lg shadow-sm mb-3 overflow-hidden">
                <div class="bg-indigo-50/50 p-2 flex justify-between items-center border-b border-indigo-100">
                    <div class="flex items-center gap-2">
                        <div class="bg-indigo-100 text-indigo-800 font-black px-2 py-1 rounded text-[10px] shrink-0 text-center w-6">${idx + 1}</div>
                        <div>
                            <div class="font-display font-black text-sm text-brand-blue leading-none mb-1">${item.assy}</div>
                            <div class="text-[9px] text-gray-500 font-bold">WP: <span class="text-gray-700">${item.wp || '-'}</span> | LOT: <span class="text-purple-600">${item.lot || '-'}</span> | <span class="uppercase">${item.line}</span></div>
                        </div>
                    </div>
                    <div class="flex items-center gap-3">
                        <label class="flex items-center cursor-pointer group"><div class="relative flex items-center"><input type="checkbox" class="sr-only toggle-switch-input" onchange="toggleTempUrgentMarker(${idx})" ${item.urgent ? 'checked' : ''}><div class="w-8 h-4 rounded-full transition-colors toggle-switch-bg ${item.urgent ? 'bg-red-400' : 'bg-gray-300'}"><div class="toggle-switch-dot absolute left-0.5 top-0.5 bg-white w-3 h-3 rounded-full transition-transform duration-300 ${item.urgent ? 'translate-x-4' : ''}"></div></div></div><span class="ml-1.5 text-[9px] font-bold uppercase w-12 ${item.urgent ? 'text-red-500' : 'text-gray-400'}">${item.urgent ? 'URGENT' : 'REGULAR'}</span></label>
                        <button onclick="tempAssyListMarker.splice(${idx}, 1); renderTempListMarker()" class="text-red-400 hover:text-red-600 p-1 rounded"><i class="fas fa-trash text-sm"></i></button>
                    </div>
                </div>
                <div class="p-2 space-y-1.5 bg-gray-50/30 max-h-48 overflow-y-auto">
                    ${item.markers.map((m, mIdx) => `
                        <div class="flex items-center gap-1.5 bg-white p-1.5 rounded border border-gray-200 shadow-sm">
                            <div class="font-mono font-black text-indigo-800 text-[11px] w-24 truncate px-1" title="${m.text}">${m.text}</div>
                            <input type="number" min="0" value="${m.qty}" onchange="updateMarkerData(${idx}, ${mIdx}, 'qty', this.value)" class="w-12 text-[10px] p-1 border border-gray-300 rounded font-bold text-center outline-none focus:border-brand-blue" placeholder="QTY">
                            <select onchange="updateMarkerData(${idx}, ${mIdx}, 'typeMarker', this.value)" class="w-16 text-[10px] p-1 border border-gray-300 rounded outline-none font-bold text-gray-600 focus:border-brand-blue">
                                <option value="Wire" ${m.typeMarker === 'Wire' ? 'selected' : ''}>Wire</option>
                                <option value="Tube" ${m.typeMarker === 'Tube' ? 'selected' : ''}>Tube</option>
                                <option value="Joint" ${m.typeMarker === 'Joint' ? 'selected' : ''}>Joint</option>
                            </select>
                            <input type="text" list="problem-list" value="${m.problem}" onchange="updateMarkerData(${idx}, ${mIdx}, 'problem', this.value)" class="flex-1 w-20 text-[10px] p-1 border border-gray-300 rounded outline-none focus:border-brand-blue" placeholder="Problem...">
                            <button onclick="removeMarkerFromIMPP(${idx}, ${mIdx})" class="text-gray-400 hover:text-red-500 px-1.5"><i class="fas fa-times"></i></button>
                        </div>
                    `).join('')}
                </div>
            </div>`;
        }
    }).join('');
}

function exportJSON_Marker() {
    if (tempAssyListMarker.length === 0) return showMessage('Antrian kosong!');
    const a = document.createElement('a');
    a.href = 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(tempAssyListMarker));
    a.download = 'kanban_marker_' + Date.now() + '.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
}

function importJSON_Marker(e) {
    const f = e.target.files[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = ev => {
        try {
            tempAssyListMarker = tempAssyListMarker.concat(JSON.parse(ev.target.result));
            renderTempListMarker();
            showMessage('Data di-import!');
        } catch (err) {
            showMessage('JSON tidak valid!');
        }
    };
    r.readAsText(f);
    e.target.value = '';
}

async function checkDuplicatesBeforeConfirm() {
    if (tempAssyListMarker.length === 0) return showMessage('List masih kosong!');

    let invalidQty = false;
    tempAssyListMarker.forEach(item => {
        if (item.type === 'ALL' && (!item.qty || item.qty <= 0)) invalidQty = true;
        if (item.type === 'IMPP') {
            item.markers.forEach(m => {
                if (!m.qty || m.qty <= 0) invalidQty = true;
            });
        }
    });
    if (invalidQty) {
        showMessage('Terdapat Item/Marker dengan QTY 0. Harap isi dengan benar!');
        return;
    }

    const loadingEl = document.getElementById('stat-loading');
    if (loadingEl) {
        loadingEl.querySelector('p').textContent = 'Mengecek Duplikasi Data...';
        loadingEl.classList.remove('hidden');
    }

    const activeReqs = getAllActiveRequests();
    activeReqs.sort((a, b) => a.timestamp - b.timestamp);

    const end = new Date();
    const start = new Date();
    start.setDate(start.getDate() - 7);
    const recentHistory = await fetchHistoryBuckets(start.toISOString().split('T')[0], end.toISOString().split('T')[0]);

    const dupesByTempItem = [];
    tempAssyListMarker.forEach(tempItem => {
        const matches = [];
        const isMatch = (reqItem) => {
            if (reqItem.type !== tempItem.type) return false;
            if (reqItem.assy.toUpperCase() !== tempItem.assy.toUpperCase()) return false;
            if (reqItem.wp !== tempItem.wp) return false;
            if ((reqItem.lot || '').toUpperCase() !== (tempItem.lot || '').toUpperCase()) return false;

            if (tempItem.type === 'ALL') {
                return String(reqItem.qty) === String(tempItem.qty) &&
                    (reqItem.typeMarker || '').toUpperCase() === (tempItem.typeMarker || '').toUpperCase();
            } else {
                return true;
            }
        };

        activeReqs.forEach(req => {
            req.items.forEach(reqItem => {
                if (isMatch(reqItem)) matches.push({ existingReq: req, source: req.isFromGsheet ? 'GSHEET READY' : 'ACTIVE' });
            });
        });
        recentHistory.forEach(req => {
            req.items.forEach(reqItem => {
                if (isMatch(reqItem)) matches.push({ existingReq: req, source: 'HISTORY' });
            });
        });

        if (matches.length > 0) dupesByTempItem.push({ tempItem: tempItem, matches: matches });
    });

    if (loadingEl) {
        loadingEl.classList.add('hidden');
        loadingEl.querySelector('p').textContent = 'Mengambil Data Arsip...';
    }

    if (dupesByTempItem.length > 0) {
        document.getElementById('duplicate-list-details').innerHTML = dupesByTempItem.map(group => {
            const temp = group.tempItem;
            const mList = group.matches;

            const tempHtml = `
                <div class="bg-gray-50 p-2.5 rounded border border-gray-200">
                    <div class="text-[9px] font-black text-gray-400 uppercase tracking-widest mb-1.5"><i class="fas fa-plus-circle text-blue-400"></i> Data Input Baru</div>
                    <div class="font-black text-brand-blue text-sm">${temp.assy}</div>
                    <div class="text-xs font-bold text-gray-600 mt-1">WP: <span class="text-brand-teal">${temp.wp}</span>${temp.type === 'ALL' ? ` | QTY: <span class="text-brand-teal">${temp.qty}</span>` : ''} ${temp.lot ? ` | LOT: <span class="text-purple-600">${temp.lot}</span>` : ''} ${temp.type === 'ALL' ? `| Tipe: <span class="text-indigo-600">${temp.typeMarker || '-'}</span>` : ''}</div>
                </div>
            `;

            if (mList.length === 1) {
                const d = mList[0];
                return `
                    <div class="border p-3 rounded-lg bg-white mb-3 shadow-sm">
                        <div class="flex flex-col md:flex-row gap-3">
                            <div class="flex-1">${tempHtml}</div>
                            <div class="flex-1 ${d.source === 'GSHEET READY' ? 'bg-emerald-50 border-emerald-300' : (d.source === 'ACTIVE' ? 'bg-red-50 border-red-200' : 'bg-gray-100 border-gray-300')} p-2.5 rounded border relative">
                                <div class="absolute top-0 right-0 ${d.source === 'GSHEET READY' ? 'bg-emerald-600' : (d.source === 'ACTIVE' ? 'bg-red-500' : 'bg-gray-500')} text-white px-2 py-0.5 text-[9px] font-black rounded-bl-lg rounded-tr uppercase shadow-sm">${d.source === 'GSHEET READY' ? 'GSHEET ' + d.existingReq.displayId : (d.source === 'ACTIVE' ? 'Active ' + (d.existingReq.displayId || d.existingReq.queueNum) : 'History')}</div>
                                <div class="text-[9px] font-black ${d.source === 'GSHEET READY' ? 'text-emerald-600' : (d.source === 'ACTIVE' ? 'text-red-400' : 'text-gray-500')} uppercase tracking-widest mb-1.5"><i class="fas fa-${d.source === 'GSHEET READY' ? 'table' : (d.source === 'ACTIVE' ? 'copy' : 'history')}"></i> Sudah Ada di ${d.source}</div>
                                <div class="font-black ${d.source === 'GSHEET READY' ? 'text-emerald-800' : (d.source === 'ACTIVE' ? 'text-red-700' : 'text-gray-700')} text-sm">${temp.assy}</div>
                                <div class="text-xs font-bold ${d.source === 'GSHEET READY' ? 'text-emerald-700' : (d.source === 'ACTIVE' ? 'text-red-600' : 'text-gray-600')} mt-1">WP: <span class="${d.source === 'GSHEET READY' ? 'text-emerald-900' : (d.source === 'ACTIVE' ? 'text-red-800' : 'text-gray-800')}">${temp.wp}</span></div>
                                <div class="mt-2 text-[9px] font-bold ${d.source === 'GSHEET READY' ? 'text-emerald-600 border-emerald-200' : (d.source === 'ACTIVE' ? 'text-red-500 border-red-100' : 'text-gray-500 border-gray-200')} border-t pt-1.5">${d.source === 'GSHEET READY' ? 'Siap diambil di Gudang! PIC WH: ' + d.existingReq.supplierBy : 'Oleh: ' + d.existingReq.requestedBy + ' (SHIFT ' + d.existingReq.shift + ')'} ${d.source === 'HISTORY' ? '- ' + new Date(d.existingReq.timeFinished || d.existingReq.timestamp).toLocaleDateString() : ''}</div>
                            </div>
                        </div>
                    </div>
                `;
            } else {
                return `
                    <div class="border p-3 rounded-lg bg-white mb-3 shadow-sm">
                        ${tempHtml}
                        <div class="mt-3 pt-3 border-t border-gray-100 space-y-2">
                            <div class="text-[9px] font-black text-red-500 uppercase tracking-widest"><i class="fas fa-exclamation-triangle"></i> Ditemukan ${mList.length} Data Serupa:</div>
                            ${mList.map(d => `
                                <div class="${d.source === 'GSHEET READY' ? 'bg-emerald-50 border-emerald-300' : (d.source === 'ACTIVE' ? 'bg-red-50 border-red-200' : 'bg-gray-100 border-gray-300')} p-2 rounded border relative">
                                    <div class="absolute top-0 right-0 ${d.source === 'GSHEET READY' ? 'bg-emerald-600' : (d.source === 'ACTIVE' ? 'bg-red-500' : 'bg-gray-500')} text-white px-2 py-0.5 text-[9px] font-black rounded-bl-lg rounded-tr uppercase shadow-sm">${d.source === 'GSHEET READY' ? 'GSHEET ' + d.existingReq.displayId : (d.source === 'ACTIVE' ? 'Active ' + (d.existingReq.displayId || d.existingReq.queueNum) : 'History')}</div>
                                    <div class="flex justify-between items-center pr-16">
                                        <div>
                                            <div class="font-black ${d.source === 'GSHEET READY' ? 'text-emerald-800' : (d.source === 'ACTIVE' ? 'text-red-700' : 'text-gray-700')} text-xs">${temp.assy}</div>
                                            <div class="text-[10px] font-bold ${d.source === 'GSHEET READY' ? 'text-emerald-700' : (d.source === 'ACTIVE' ? 'text-red-600' : 'text-gray-600')}">WP: ${temp.wp}</div>
                                        </div>
                                    </div>
                                    <div class="mt-1.5 text-[8px] font-bold ${d.source === 'GSHEET READY' ? 'text-emerald-600 border-emerald-200' : (d.source === 'ACTIVE' ? 'text-red-500 border-red-100' : 'text-gray-500 border-gray-200')} border-t pt-1">${d.source === 'GSHEET READY' ? 'Siap diambil di Gudang! PIC WH: ' + d.existingReq.supplierBy : 'Oleh: ' + d.existingReq.requestedBy + ' (SHIFT ' + d.existingReq.shift + ')'} ${d.source === 'HISTORY' ? '- ' + new Date(d.existingReq.timeFinished || d.existingReq.timestamp).toLocaleDateString() : ''}</div>
                                </div>
                            `).join('')}
                        </div>
                    </div>
                `;
            }
        }).join('');
        closeModal('modal-kanban-marker');
        openModal('modal-duplicate-warning');
    } else {
        openConfirmModalMarker();
    }
}

function openConfirmModalMarker() {
    document.getElementById('confirm-list-details-marker').innerHTML = tempAssyListMarker.map(item => {
        const totalQ = item.type === 'ALL' ? item.qty : item.markers.reduce((sum, m) => sum + Number(m.qty), 0);
        return `<div class="flex justify-between items-center border-b border-gray-200 py-2"><div><div class="font-bold text-brand-blue text-sm">${item.assy}</div><div class="text-[10px] text-gray-500 mt-0.5">Line: ${item.line} | WP: ${item.wp} | QTY: ${totalQ}</div></div><span class="text-[9px] font-bold px-2 py-1 rounded uppercase ${item.urgent ? 'bg-red-100 text-red-600 border-red-200' : 'bg-gray-200 text-gray-600 border-gray-300'}">${item.urgent ? 'URGENT' : 'REGULAR'}</span></div>`;
    }).join('');
    closeModal('modal-kanban-marker');
    openModal('modal-confirm-marker');
}

function submitRequestMarker() {
    const sysType = 'STATION MARKER';
    const signalStr = 'new_' + Date.now();
    const ts = Date.now();
    const d = new Date(ts);
    const ddmm = String(d.getDate()).padStart(2, '0') + String(d.getMonth() + 1).padStart(2, '0');
    const shift = currentUser.shift || 'X';

    tempAssyListMarker.forEach((item, index) => {
        const lineInit = getLineInit(item.line);
        const rnd = Math.random().toString(36).substring(2, 5).toUpperCase();
        const dispId = `${lineInit}${shift}-${ddmm}-${rnd}`;

        const reqPayload = {
            id: generateId() + '-' + index,
            displayId: dispId,
            systemType: sysType,
            shift: shift,
            type: item.type,
            urgent: item.urgent,
            items: [item],
            status: STATUS_WAITING,
            step: 0,
            timestamp: ts + index,
            requestedBy: currentUser.name,
            requestedStation: currentUser.section,
            messages: [],
            lastSignal: signalStr
        };
        db.requests.push(reqPayload);
        recordRequestAssyToHistoryCache(reqPayload);
    });

    saveDB();
    closeModal('modal-confirm-marker');
    showMessage('Request Marker berhasil dikirim!');
}

// ============================================================================
// RENDER DASHBOARD LEADER & WAREHOUSE
// ============================================================================
const GROUP_COLORS = [
    { border: 'border-blue-400', bg: 'bg-blue-50/40', text: 'text-blue-700' },
    { border: 'border-teal-400', bg: 'bg-teal-50/40', text: 'text-teal-700' },
    { border: 'border-purple-400', bg: 'bg-purple-50/40', text: 'text-purple-700' },
    { border: 'border-orange-400', bg: 'bg-orange-50/40', text: 'text-orange-700' },
    { border: 'border-pink-400', bg: 'bg-pink-50/40', text: 'text-pink-700' },
    { border: 'border-indigo-400', bg: 'bg-indigo-50/40', text: 'text-indigo-700' }
];

function getColorForDate(dateStr) {
    let hash = 0;
    for (let i = 0; i < dateStr.length; i++) hash += dateStr.charCodeAt(i);
    return GROUP_COLORS[hash % GROUP_COLORS.length];
}

function groupRequestsByDate(requests) {
    const groups = {};
    requests.forEach(req => {
        const dateStr = new Date(req.timestamp).toLocaleDateString('id-ID', { day: '2-digit', month: 'long', year: 'numeric' });
        if (!groups[dateStr]) groups[dateStr] = [];
        groups[dateStr].push(req);
    });
    return groups;
}

function getStatusBgClass(req) {
    if (req.urgent) return 'bg-red-50/90 border-red-400 border-2';
    if (req.status === STATUS_WAITING) return 'bg-orange-500/10 border-orange-200';
    if (req.status === STATUS_PROCESSING) return 'bg-blue-500/10 border-blue-200';
    if (req.status === STATUS_READY || req.status === STATUS_PICKED_UP) return 'bg-green-500/10 border-green-200';
    return 'bg-white border-gray-200';
}

function generateCardHTML_Leader(req) {
    const isUrgent = req.urgent;
    const bgClass = getStatusBgClass(req);
    const now = Date.now();
    const lastPing = req.lastPingTime || 0;
    const isCooldown = (now - lastPing) < 10000;
    const secLeft = isCooldown ? Math.ceil((10000 - (now - lastPing)) / 1000) : 0;
    const item = req.items[0];

    const hasNote = req.items.some(i => i.note && i.note.trim() !== '');
    const noteIndicator = hasNote ? `<div class="w-2 h-2 rounded-full bg-yellow-400 ml-1.5 shadow-sm border border-yellow-500 inline-block shrink-0" title="Ada Keterangan Tambahan"></div>` : '';

    const tWait = `<div class="w-[120px] flex flex-col items-center justify-center py-2 px-1 rounded-md transition-all ${req.status === 'WAITING' ? 'bg-orange-50 border border-orange-200 text-orange-600 shadow-sm z-10 scale-105' : 'text-gray-400 bg-white/60 border border-transparent'}"><span class="timer-segment font-black text-[11px] whitespace-nowrap leading-tight px-1" data-start="${req.timestamp}" data-end="${req.timeAccepted || ''}" data-days="false">00:00:00</span><span class="text-[9px] uppercase tracking-wider font-bold mt-1">Wait</span></div>`;
    const tProc = `<div class="w-[120px] flex flex-col items-center justify-center py-2 px-1 rounded-md transition-all ${req.status === 'PROCESSING' ? 'bg-blue-50 border border-blue-200 text-blue-600 shadow-sm z-10 scale-105' : 'text-gray-400 bg-white/60 border border-transparent'}"><span class="timer-segment font-black text-[11px] whitespace-nowrap leading-tight px-1" data-start="${req.timeAccepted || ''}" data-end="${req.timeReady || ''}" data-days="true">00:00:00</span><span class="text-[9px] uppercase tracking-wider font-bold mt-1">Process</span></div>`;
    const tRdy = `<div class="w-[120px] flex flex-col items-center justify-center py-2 px-1 rounded-md transition-all ${req.status === 'READY' ? 'bg-green-50 border border-green-200 text-green-600 shadow-sm z-10 scale-105' : 'text-gray-400 bg-white/60 border border-transparent'}"><span class="timer-segment font-black text-[11px] whitespace-nowrap leading-tight px-1" data-start="${req.timeReady || ''}" data-end="${req.timeFinished || ''}" data-days="false">00:00:00</span><span class="text-[9px] uppercase tracking-wider font-bold mt-1">Ready</span></div>`;

    let actionHTML = '';
    if (req.status === 'WAITING') actionHTML = `<button onclick="event.stopPropagation(); resendNotif('${req.id}')" class="ping-btn w-full h-full flex flex-col items-center justify-center text-brand-blue bg-blue-100 hover:bg-blue-200 rounded-lg shadow-sm border border-blue-200 disabled:opacity-50" data-ping-time="${lastPing}" ${isCooldown ? 'disabled' : ''}>${isCooldown ? `<span class="text-sm font-display font-black">${secLeft}s</span>` : `<i class="fas fa-bell text-xl animate-pulse"></i>`}</button>`;
    else if (req.status === 'READY' || req.status === 'PICKED_UP') actionHTML = `<button onclick="event.stopPropagation(); openFinishModal('${req.id}')" class="w-full h-full flex flex-col items-center justify-center bg-brand-teal hover:bg-teal-700 text-white text-[10px] font-bold rounded-lg uppercase shadow-md p-1"><i class="fas fa-check-double text-lg mb-1"></i>Selesai</button>`;
    else actionHTML = `<div class="w-full h-full flex flex-col items-center justify-center bg-gray-50 border border-gray-100 rounded-lg text-gray-300"><i class="fas fa-spinner fa-spin text-xl"></i></div>`;

    const unread = (req.messages || []).filter(m => m.senderRole !== currentUser.role && !m.isRead).length;
    const badgeHtml = unread > 0 ? `<div class="absolute -top-2 -right-2 bg-red-500 text-white text-[9px] font-black w-5 h-5 flex items-center justify-center rounded-full animate-bounce shadow-md border z-20">${unread}</div>` : '';

    const totalQty = req.type === 'ALL' ? item.qty : item.markers.reduce((sum, m) => sum + Number(m.qty), 0);
    let displayTypeMarker = item.typeMarker || '-';
    if (req.type === 'IMPP') {
        const types = [...new Set(item.markers.map(m => m.typeMarker))];
        displayTypeMarker = types.join(', ');
    }

    return `
    <div onclick="showDetailModal('${req.id}')" oncontextmenu="handleRightClick(event, '${req.id}')" class="cursor-pointer rounded-lg shadow-sm border ${bgClass} p-2.5 flex flex-row items-stretch gap-3 hover:shadow-md hover:border-blue-300 relative min-h-[75px]">
        ${isUrgent ? '<div class="absolute top-0 left-0 bg-red-500 text-white text-[8px] font-bold px-2 py-0.5 rounded-br-lg rounded-tl-lg blink-urgent uppercase z-10">URGENT</div>' : ''}
        ${badgeHtml}
        <div class="flex-1 flex items-center pr-2 ${isUrgent ? 'pt-3' : ''}">
            ${req.isFromGsheet ? `
            <div class="text-center mr-3 w-28 shrink-0 flex flex-col items-center justify-center p-1.5 rounded border-2 border-emerald-500 bg-emerald-50 text-emerald-800 shadow-sm">
                <div class="text-[7px] font-black uppercase bg-emerald-600 text-white px-1.5 py-0.5 rounded-full mb-1 tracking-wider flex items-center gap-1"><i class="fas fa-table"></i> GSHEET</div>
                <div class="text-[7px] font-bold uppercase opacity-75 leading-none">NO BOX</div>
                <div class="font-display font-black text-[11px] leading-tight break-words text-emerald-900 mt-0.5 w-full">${req.noBox || '-'}</div>
            </div>
            ` : `
            <div class="text-center mr-3 w-24 shrink-0 flex flex-col items-center justify-center p-1.5 rounded border shadow-sm ${getLineColor(item.line)}">
                <div class="text-[7px] font-bold uppercase mb-0.5 opacity-80">ID KANBAN</div>
                <div class="font-display font-black text-[11px] leading-none break-all">${req.displayId || req.queueNum}</div>
            </div>
            `}
            <div class="flex-1 pl-3 border-l-2 border-white/60 overflow-hidden">
                <div class="flex flex-wrap items-center gap-2 mb-1.5">
                    <span class="font-display font-black text-lg text-gray-800 uppercase leading-none flex items-center">${item.assy} ${req.type === 'IMPP' ? `<span class="text-[10px] text-gray-400 font-normal italic ml-1">(${item.markers.length} Items)</span>` : ''}${noteIndicator}</span>
                    <span class="bg-gray-800 text-white px-2 py-0.5 rounded text-[10px] font-black uppercase shadow-sm ml-1">WP: ${item.wp || '-'}</span>
                    <span class="bg-blue-600 text-white px-2 py-0.5 rounded text-[10px] font-black shadow-sm">QTY: ${totalQty}</span>
                    ${item.lot ? `<span class="bg-purple-600 text-white px-2 py-0.5 rounded text-[10px] font-black shadow-sm">${item.lot}</span>` : ''}
                </div>
                <div class="flex flex-wrap items-center gap-1.5">
                    ${req.isFromGsheet ? `<span class="text-[8px] font-bold px-1.5 py-0.5 rounded uppercase border ${getLineColor(item.line)}">${item.line}</span>` : ''}
                    <span class="text-[8px] font-bold px-1.5 py-0.5 rounded uppercase border ${req.type === 'ALL' ? 'bg-blue-100 text-blue-700' : 'bg-purple-100 text-purple-700'}">${req.type}</span>
                    <span class="text-[8px] font-bold bg-indigo-50 text-indigo-700 border-indigo-200 px-1.5 py-0.5 rounded uppercase border">${displayTypeMarker}</span>
                    ${req.isFromGsheet ? `<span title="Tanggal Print (GSheet)" class="text-[8px] font-bold px-1.5 py-0.5 rounded uppercase border bg-emerald-100 text-emerald-800 border-emerald-200"><i class="fas fa-print mr-1"></i>TGL PRINT: ${req.tglPrintLabel}</span>` : `<span class="text-[8px] font-bold px-1.5 py-0.5 rounded uppercase border bg-orange-100 text-orange-700">SHIFT ${req.shift || '-'}</span>`}
                    <span class="bg-teal-50 text-brand-teal px-1.5 py-0.5 rounded border border-teal-200 uppercase text-[8px] font-bold truncate max-w-[110px]"><i class="fas fa-user mr-1"></i>${req.isFromGsheet ? 'WH: ' + (req.supplierBy || '-') : (item.pic || req.requestedBy)}</span>
                </div>
            </div>
        </div>
        <div class="shrink-0 border-l-2 border-white/60 pl-3 pr-1 flex items-center justify-center">
            <div class="flex gap-3 w-[380px] shrink-0 justify-end">${tWait}${tProc}${tRdy}</div>
        </div>
        <div class="w-16 shrink-0 pl-1 flex justify-center py-0.5">${actionHTML}</div>
    </div>`;
}

function generateCardHTML_Compact(req, actionBtnHTML, progressHTML, timerHTML) {
    const bgClass = getStatusBgClass(req);
    const unreadCount = (req.messages || []).filter(m => m.senderRole !== currentUser.role && !m.isRead).length;
    const item = req.items[0];

    const hasNote = req.items.some(i => i.note && i.note.trim() !== '');
    const noteIndicator = hasNote ? `<div class="w-1.5 h-1.5 rounded-full bg-yellow-400 ml-1 shadow-sm border border-yellow-500 inline-block shrink-0" title="Ada Keterangan Tambahan"></div>` : '';

    const totalQty = req.type === 'ALL' ? item.qty : item.markers.reduce((sum, m) => sum + Number(m.qty), 0);

    return `
    <div onclick="showDetailModal('${req.id}')" oncontextmenu="handleRightClick(event, '${req.id}')" class="cursor-pointer flex items-stretch gap-1 p-1.5 ${bgClass} rounded-lg shadow-sm hover:shadow relative min-h-[60px]">
        ${req.urgent ? '<div class="absolute left-0 top-0 bottom-0 w-1 bg-red-500 rounded-l-lg blink-urgent z-10"></div>' : ''}
        ${unreadCount > 0 ? `<div class="absolute -top-2 -right-2 bg-red-500 text-white text-[9px] font-black w-5 h-5 flex items-center justify-center rounded-full z-20">${unreadCount}</div>` : ''}
        <div class="w-16 text-center border-r border-white/60 pr-1 shrink-0 flex flex-col items-center justify-center ${req.urgent ? 'pl-2' : ''}">
            ${req.isFromGsheet ? `
            <div class="p-1 rounded border-2 border-emerald-500 bg-emerald-50 text-emerald-800 shadow-sm w-full flex flex-col items-center justify-center">
                <span class="text-[5px] font-black uppercase bg-emerald-600 text-white px-1 rounded mb-0.5">GSHEET</span>
                <span class="text-[5px] font-bold uppercase opacity-75 leading-none">NO BOX</span>
                <span class="font-display font-black text-[8px] leading-tight break-words text-emerald-900 w-full">${req.noBox || '-'}</span>
            </div>
            ` : `
            <div class="p-1 rounded border shadow-sm w-full ${getLineColor(item.line)} flex flex-col items-center justify-center">
                <span class="text-[5px] font-bold uppercase mb-0.5 opacity-80">ID</span>
                <span class="font-display font-black text-[9px] leading-none break-all">${req.displayId || req.queueNum}</span>
            </div>
            `}
        </div>
        <div class="flex-1 flex flex-col justify-center min-w-[40px] overflow-hidden px-1">
            <div class="text-[10px] font-black text-gray-800 truncate flex items-center">${item.assy} ${req.type === 'IMPP' ? `<span class="text-[8px] text-gray-400 italic ml-1">(${item.markers.length})</span>` : ''}${noteIndicator}</div>
            <div class="flex flex-wrap items-center gap-1 mt-1">
                ${req.isFromGsheet ? `<span class="text-[6px] font-bold px-1 rounded uppercase border ${getLineColor(item.line)}">${getLineInit(item.line)}</span>` : ''}
                <span class="text-[6px] font-bold px-1 rounded uppercase border ${req.type === 'ALL' ? 'bg-blue-100 text-blue-700' : 'bg-purple-100 text-purple-700'}">${req.type}</span>
                ${req.isFromGsheet ? `<span title="Tanggal Print (GSheet)" class="text-[6px] font-bold bg-emerald-100 text-emerald-800 px-1 rounded uppercase border border-emerald-200"><i class="fas fa-print mr-0.5"></i>${req.tglPrintLabel}</span>` : `<span class="text-[6px] font-bold bg-orange-100 text-orange-700 px-1 rounded uppercase border">SH-${req.shift || '-'}</span>`}
                <span class="text-[7px] text-brand-teal bg-teal-50 border border-teal-200 px-1 rounded uppercase font-bold truncate max-w-[60px]">${item.pic || req.requestedBy}</span>
                <span class="text-[7px] font-black border border-blue-200 px-1 rounded bg-blue-50 text-blue-600">QTY: ${totalQty}</span>
                ${item.lot ? `<span class="text-[7px] font-black border border-purple-200 bg-purple-50 text-purple-700 px-1 rounded uppercase">L: ${item.lot}</span>` : ''}
            </div>
        </div>
        <div class="shrink-0 border-l border-white/60 pl-1.5 pr-1 flex items-center justify-center">${timerHTML}</div>
        <div class="w-[50px] flex flex-col justify-center shrink-0 border-l border-white/60 pl-1.5 px-0.5">${progressHTML}${actionBtnHTML}</div>
    </div>`;
}

let selectedBatchIds = new Set();
let currentVisibleReadyIds = [];
let batchFinishIds = [];

function isRequestClosableReady(req) {
    return !!(req && (req.status === STATUS_READY || req.status === STATUS_PICKED_UP));
}

function getBatchModalFilteredRequests() {
    const allReady = getAllActiveRequests().filter(isRequestClosableReady);
    const searchVal = (document.getElementById('batch-modal-search')?.value || '').trim().toLowerCase();
    const lineFilter = document.getElementById('batch-modal-line')?.value || 'ALL';
    const sortDateDir = document.getElementById('sort-date')?.value || 'asc';

    const filtered = allReady.filter(req => {
        const matchLine = lineFilter === 'ALL' ? true : req.items.some(i => i.line === lineFilter);
        const matchSearch = !searchVal
            || req.items.some(i => (i.assy || i.item || '').toLowerCase().includes(searchVal) || (i.wp || '').toLowerCase().includes(searchVal))
            || (req.displayId && req.displayId.toLowerCase().includes(searchVal))
            || (req.gsheetSerial && req.gsheetSerial.toLowerCase().includes(searchVal))
            || (req.noBox && req.noBox.toLowerCase().includes(searchVal))
            || (req.tglPrintLabel && req.tglPrintLabel.toLowerCase().includes(searchVal));
        return matchLine && matchSearch;
    });

    filtered.sort((a, b) => {
        if (b.urgent !== a.urgent) return (b.urgent ? 1 : 0) - (a.urgent ? 1 : 0);
        return sortDateDir === 'asc' ? a.timestamp - b.timestamp : b.timestamp - a.timestamp;
    });
    return filtered;
}

function updateBatchToolbarUI() {
    const activeClosableSet = new Set(getAllActiveRequests().filter(isRequestClosableReady).map(r => r.id));
    selectedBatchIds.forEach(id => {
        if (!activeClosableSet.has(id)) selectedBatchIds.delete(id);
    });

    const badgeEl = document.getElementById('batch-ready-badge');
    if (badgeEl) {
        badgeEl.textContent = currentVisibleReadyIds.length;
    }

    const modalEl = document.getElementById('modal-batch-close');
    if (modalEl && !modalEl.classList.contains('hidden')) {
        renderBatchCloseModalList();
    }
}

function updateBatchModalControls(filteredReady) {
    const selectAllBtn = document.getElementById('btn-batch-modal-select-all');
    const selectedBadge = document.getElementById('batch-modal-selected-badge');
    const submitBtn = document.getElementById('btn-submit-batch-close');

    const visibleIds = filteredReady.map(r => r.id);
    const selectedVisibleCount = visibleIds.filter(id => selectedBatchIds.has(id)).length;
    const allVisibleSelected = visibleIds.length > 0 && selectedVisibleCount === visibleIds.length;

    if (selectAllBtn) {
        if (allVisibleSelected) {
            selectAllBtn.className = 'border border-orange-300 bg-orange-50 hover:bg-orange-100 text-orange-700 px-3 py-1.5 rounded-lg text-xs font-black transition flex items-center gap-1.5 cursor-pointer';
            selectAllBtn.innerHTML = `<i class="fas fa-times-circle"></i><span>Batal Pilih (${selectedVisibleCount}/${visibleIds.length})</span>`;
        } else {
            selectAllBtn.className = 'border border-emerald-300 bg-emerald-50 hover:bg-emerald-100 text-emerald-800 px-3 py-1.5 rounded-lg text-xs font-black transition flex items-center gap-1.5 cursor-pointer';
            selectAllBtn.innerHTML = `<i class="far fa-check-square"></i><span>Pilih Semua (${visibleIds.length})</span>`;
        }
    }

    if (selectedBadge) {
        selectedBadge.textContent = `${selectedBatchIds.size} Terpilih`;
    }

    if (submitBtn) {
        submitBtn.disabled = selectedBatchIds.size === 0;
        submitBtn.innerHTML = `<i class="fas fa-check-double"></i><span>Selesaikan Terpilih (${selectedBatchIds.size})</span>`;
    }
}

function renderBatchCloseModalList() {
    const listEl = document.getElementById('batch-modal-list');
    if (!listEl) return;

    const filteredReady = getBatchModalFilteredRequests();
    currentVisibleReadyIds = filteredReady.map(r => r.id);
    updateBatchModalControls(filteredReady);

    if (filteredReady.length === 0) {
        listEl.innerHTML = `<div class="h-48 flex flex-col items-center justify-center text-gray-400"><i class="fas fa-box-open text-3xl mb-2 opacity-50"></i><p class="text-xs font-bold uppercase">Tidak ada item berstatus READY pada filter ini</p></div>`;
        return;
    }

    listEl.innerHTML = filteredReady.map(req => {
        const item = req.items[0] || {};
        const checked = selectedBatchIds.has(req.id);
        const totalQty = req.type === 'ALL'
            ? item.qty
            : (item.markers || []).reduce((sum, m) => sum + Number(m.qty || 0), 0);

        return `
        <label class="flex items-center gap-3 p-2.5 rounded-xl border transition cursor-pointer select-none ${checked ? 'bg-emerald-50/90 border-emerald-400 shadow-sm' : 'bg-white border-gray-200 hover:border-teal-300'}">
            <input type="checkbox" class="batch-select-checkbox accent-emerald-600 w-4 h-4 cursor-pointer shrink-0" data-req-id="${req.id}" onchange="toggleBatchSelect('${req.id}', this.checked)" ${checked ? 'checked' : ''}>
            <div class="w-24 shrink-0 text-center p-1.5 rounded-lg border ${req.isFromGsheet ? 'border-emerald-400 bg-emerald-50 text-emerald-900' : getLineColor(item.line)}">
                <div class="text-[7px] font-black uppercase opacity-75">${req.isFromGsheet ? 'GSHEET • NO BOX' : 'ID KANBAN'}</div>
                <div class="font-display font-black text-[11px] leading-tight break-words mt-0.5">${req.isFromGsheet ? (req.noBox || '-') : (req.displayId || req.queueNum)}</div>
            </div>
            <div class="flex-1 min-w-0">
                <div class="flex flex-wrap items-center gap-1.5">
                    <span class="font-display font-black text-sm text-gray-800 uppercase">${item.assy || '-'}</span>
                    <span class="bg-gray-800 text-white px-1.5 py-0.5 rounded text-[9px] font-black uppercase">WP: ${item.wp || '-'}</span>
                    <span class="bg-blue-600 text-white px-1.5 py-0.5 rounded text-[9px] font-black">QTY: ${totalQty}</span>
                    ${item.lot ? `<span class="bg-purple-600 text-white px-1.5 py-0.5 rounded text-[9px] font-black">${item.lot}</span>` : ''}
                    ${req.urgent ? `<span class="bg-red-500 text-white px-1.5 py-0.5 rounded text-[8px] font-black uppercase">URGENT</span>` : ''}
                </div>
                <div class="flex flex-wrap items-center gap-1.5 mt-1 text-[9px] font-bold text-gray-500">
                    <span class="px-1.5 py-0.5 rounded border ${getLineColor(item.line)} uppercase">${item.line || '-'}</span>
                    ${req.isFromGsheet ? `<span class="px-1.5 py-0.5 rounded border bg-emerald-100 text-emerald-800 border-emerald-200 uppercase"><i class="fas fa-print mr-1"></i>TGL PRINT: ${req.tglPrintLabel || '-'}</span>` : `<span class="px-1.5 py-0.5 rounded border bg-orange-50 text-orange-700 border-orange-200 uppercase">SHIFT ${req.shift || '-'}</span>`}
                    <span class="px-1.5 py-0.5 rounded border bg-teal-50 text-brand-teal border-teal-200 uppercase"><i class="fas fa-user mr-1"></i>${req.isFromGsheet ? 'WH: ' + (req.supplierBy || '-') : (item.pic || req.requestedBy || '-')}</span>
                </div>
            </div>
        </label>`;
    }).join('');
}

function openBatchCloseModal() {
    const mainLine = document.getElementById('filter-line')?.value || 'ALL';
    const mainSearch = document.getElementById('search-input')?.value || '';
    const modalLineEl = document.getElementById('batch-modal-line');
    const modalSearchEl = document.getElementById('batch-modal-search');
    const pickerInput = document.getElementById('batch-picker-name-input');

    if (modalLineEl) modalLineEl.value = mainLine;
    if (modalSearchEl) modalSearchEl.value = mainSearch;
    if (pickerInput) pickerInput.value = '';

    selectedBatchIds.clear();
    renderBatchCloseModalList();
    openModal('modal-batch-close');
    setTimeout(() => {
        if (pickerInput) pickerInput.focus();
    }, 100);
}

function toggleBatchSelect(id, checked) {
    if (!id) return;
    if (checked) selectedBatchIds.add(id);
    else selectedBatchIds.delete(id);
    renderBatchCloseModalList();
}

function toggleSelectAllInBatchModal() {
    const filteredReady = getBatchModalFilteredRequests();
    const visibleIds = filteredReady.map(r => r.id);
    if (visibleIds.length === 0) {
        showMessage('Tidak ada antrian READY yang tampil untuk dipilih.');
        return;
    }
    const allVisibleSelected = visibleIds.every(id => selectedBatchIds.has(id));
    if (allVisibleSelected) {
        visibleIds.forEach(id => selectedBatchIds.delete(id));
    } else {
        visibleIds.forEach(id => selectedBatchIds.add(id));
    }
    renderBatchCloseModalList();
}

function toggleSelectAllReady() {
    toggleSelectAllInBatchModal();
}

function submitBatchCloseModal() {
    const activeClosableMap = new Map(
        getAllActiveRequests()
            .filter(isRequestClosableReady)
            .map(r => [r.id, r])
    );
    const targetIds = Array.from(selectedBatchIds).filter(id => activeClosableMap.has(id));
    if (targetIds.length === 0) {
        return showMessage('Pilih minimal 1 item READY terlebih dahulu!');
    }
    const pName = (document.getElementById('batch-picker-name-input')?.value || '').trim().toUpperCase();
    if (!pName) {
        const pickerInput = document.getElementById('batch-picker-name-input');
        if (pickerInput) pickerInput.focus();
        return showMessage('Nama Pengambil harus diisi!');
    }

    batchFinishIds = targetIds;
    const singlePickerInput = document.getElementById('picker-name-input');
    if (singlePickerInput) singlePickerInput.value = pName;
    const finishIdInput = document.getElementById('finish-req-id');
    if (finishIdInput) finishIdInput.value = targetIds.length === 1 ? targetIds[0] : 'BATCH';

    submitFinishWithPicker();
    closeModal('modal-batch-close');
}

function renderData() {
    if (!currentUser) return;
    const activeReqs = getAllActiveRequests();

    document.getElementById('queue-counter-badge').textContent = activeReqs.length;

    const sortDateDir = document.getElementById('sort-date').value;
    activeReqs.sort((a, b) => sortDateDir === 'asc' ? a.timestamp - b.timestamp : b.timestamp - a.timestamp);

    const searchVal = document.getElementById('search-input').value.toLowerCase();
    const lineFilter = document.getElementById('filter-line').value;
    const shiftFilter = document.getElementById('filter-shift').value;

    const filteredReqs = activeReqs.filter(req => {
        const matchLine = lineFilter === 'ALL' ? true : req.items.some(i => i.line === lineFilter);
        const matchShift = (shiftFilter === 'ALL' || req.isFromGsheet) ? true : req.shift === shiftFilter;
        const matchSearch = req.items.some(i => (i.assy || i.item || '').toLowerCase().includes(searchVal))
            || (req.displayId && req.displayId.toLowerCase().includes(searchVal))
            || (req.gsheetSerial && req.gsheetSerial.toLowerCase().includes(searchVal))
            || (req.noBox && req.noBox.toLowerCase().includes(searchVal))
            || (req.tglPrintLabel && req.tglPrintLabel.toLowerCase().includes(searchVal));
        return matchLine && matchShift && matchSearch;
    });

    currentVisibleReadyIds = filteredReqs.filter(isRequestClosableReady).map(r => r.id);

    if (currentUser.role === 'leader') {
        if (isLeaderGridView) {
            document.getElementById('leader-list-view').classList.add('hidden');
            document.getElementById('leader-grid-view').classList.remove('hidden');
            renderLeaderGrid(filteredReqs);
        } else {
            document.getElementById('leader-grid-view').classList.add('hidden');
            document.getElementById('leader-list-view').classList.remove('hidden');
            renderLeaderQueue(filteredReqs);
        }
    } else {
        renderSupplyDashboard(filteredReqs);
    }

    updateBatchToolbarUI();
}

function renderLeaderQueue(requests) {
    const container = document.getElementById('leader-queue-container');
    container.innerHTML = '';

    if (requests.length === 0) return;

    const grouped = groupRequestsByDate(requests);
    const uniqueDates = [...new Set(requests.map(r => new Date(r.timestamp).toLocaleDateString('id-ID', { day: '2-digit', month: 'long', year: 'numeric' })))];

    let htmlStr = '';
    uniqueDates.forEach(dateStr => {
        const groupColor = getColorForDate(dateStr);
        const reqsInDate = grouped[dateStr] || [];

        const sortDateDir = document.getElementById('sort-date').value;
        reqsInDate.sort((a, b) => {
            if (b.urgent !== a.urgent) return b.urgent - a.urgent;
            return sortDateDir === 'asc' ? a.timestamp - b.timestamp : b.timestamp - a.timestamp;
        });

        htmlStr += `
        <div class="mb-4 border-2 rounded-xl p-2 shadow-sm ${groupColor.border} ${groupColor.bg} relative">
            <div class="sticky top-2 z-20 w-max mb-2">
                <div class="inline-block px-3 py-1 rounded-lg bg-white font-black text-[10px] uppercase tracking-wider border-2 ${groupColor.border} ${groupColor.text} shadow-md">
                    <i class="fas fa-calendar-day mr-1"></i> ${dateStr}
                </div>
            </div>
            <div class="flex flex-col gap-2 relative z-10">`;

        reqsInDate.forEach(req => {
            htmlStr += generateCardHTML_Leader(req);
        });

        htmlStr += `</div></div>`;
    });
    container.innerHTML = htmlStr;
}

function renderLeaderGrid(requests) {
    const dWaiting = document.getElementById('l-grid-wait-container');
    const dProc = document.getElementById('l-grid-proc-container');
    const dReady = document.getElementById('l-grid-ready-container');

    let iCount = 0;
    let pCount = 0;
    let rCount = 0;

    const waitReqs = requests.filter(r => r.status === STATUS_WAITING);
    const procReqs = requests.filter(r => r.status === STATUS_PROCESSING);
    const readyReqs = requests.filter(r => r.status === STATUS_READY || r.status === STATUS_PICKED_UP);

    const getColHTML = (reqs, statType) => {
        if (reqs.length === 0) return '';
        const grouped = groupRequestsByDate(reqs);
        const uniqueDates = [...new Set(reqs.map(r => new Date(r.timestamp).toLocaleDateString('id-ID', { day: '2-digit', month: 'long', year: 'numeric' })))];
        let htmlStr = '';

        uniqueDates.forEach(dateStr => {
            const groupColor = getColorForDate(dateStr);
            const reqsInDate = grouped[dateStr] || [];
            const sortDateDir = document.getElementById('sort-date').value;
            reqsInDate.sort((a, b) => {
                if (b.urgent !== a.urgent) return b.urgent - a.urgent;
                return sortDateDir === 'asc' ? a.timestamp - b.timestamp : b.timestamp - a.timestamp;
            });

            htmlStr += `
            <div class="mb-3 border rounded-lg p-1.5 ${groupColor.border} ${groupColor.bg} relative">
                <div class="sticky top-1 z-20 w-max mb-1.5">
                    <div class="inline-block px-2 py-0.5 rounded bg-white font-black text-[8px] uppercase tracking-wider border ${groupColor.border} ${groupColor.text} shadow-sm">
                        <i class="fas fa-calendar-day"></i> ${dateStr}
                    </div>
                </div>
                <div class="flex flex-col gap-1.5 relative z-10">`;

            reqsInDate.forEach(req => {
                let actionBtnHTML = '';
                const now = Date.now();
                const lastPing = req.lastPingTime || 0;
                const isCooldown = (now - lastPing) < 10000;
                const secLeft = isCooldown ? Math.ceil((10000 - (now - lastPing)) / 1000) : 0;

                if (statType === 'WAITING') {
                    iCount++;
                    actionBtnHTML = `<button onclick="event.stopPropagation(); resendNotif('${req.id}')" class="ping-btn w-full py-1.5 bg-blue-100 text-brand-blue hover:bg-blue-200 border border-blue-200 text-[8px] font-black rounded uppercase shadow" data-ping-time="${lastPing}" ${isCooldown ? 'disabled' : ''}>${isCooldown ? `${secLeft}s` : `<i class="fas fa-bell animate-pulse"></i> Ping`}</button>`;
                } else if (statType === 'PROCESSING') {
                    pCount++;
                    actionBtnHTML = `<div class="text-[7px] font-bold text-blue-600 text-center uppercase py-1 border border-blue-200 bg-blue-50 rounded">Step ${req.step}/4</div>`;
                } else {
                    rCount++;
                    actionBtnHTML = (req.status === STATUS_READY || req.status === STATUS_PICKED_UP)
                        ? `<button onclick="event.stopPropagation(); openFinishModal('${req.id}')" class="w-full py-1.5 bg-brand-teal hover:bg-teal-700 text-white text-[8px] font-black rounded uppercase shadow"><i class="fas fa-check-double mr-1"></i>Selesai</button>`
                        : `<div class="w-full text-center bg-purple-50 text-purple-600 text-[8px] font-bold py-1.5 rounded border border-purple-200">DIAMBIL</div>`;
                }

                const timerHTML = statType === 'WAITING'
                    ? `<div class="w-[70px] flex flex-col items-center justify-center py-1 px-1 rounded-md bg-white/60 border border-transparent shadow-sm"><span class="timer-segment font-black text-[10px] leading-tight whitespace-nowrap" data-start="${req.timestamp}" data-end="${req.timeAccepted || ''}" data-days="false">00:00:00</span></div>`
                    : (statType === 'PROCESSING'
                        ? `<div class="w-[70px] flex flex-col items-center justify-center py-1.5 px-1 rounded-md bg-white/60 border border-transparent shadow-sm"><span class="timer-segment font-black text-[10px] leading-tight whitespace-nowrap" data-start="${req.timeAccepted || ''}" data-end="${req.timeReady || ''}" data-days="true">00:00:00</span></div>`
                        : `<div class="w-[70px] flex flex-col items-center justify-center py-1 px-1 rounded-md bg-white/60 border border-transparent shadow-sm"><span class="timer-segment font-black text-[10px] leading-tight whitespace-nowrap" data-start="${req.timeReady || ''}" data-end="${req.timeFinished || ''}" data-days="false">00:00:00</span></div>`);

                htmlStr += generateCardHTML_Compact(req, actionBtnHTML, '', timerHTML);
            });
            htmlStr += `</div></div>`;
        });
        return htmlStr;
    };

    dWaiting.innerHTML = getColHTML(waitReqs, 'WAITING');
    dProc.innerHTML = getColHTML(procReqs, 'PROCESSING');
    dReady.innerHTML = getColHTML(readyReqs, 'READY');

    document.getElementById('l-grid-wait-count').textContent = iCount;
    document.getElementById('l-grid-proc-count').textContent = pCount;
    document.getElementById('l-grid-ready-count').textContent = rCount;
}

function renderSupplyDashboard(requests) {
    const dWaiting = document.getElementById('supply-incoming-container');
    const dProc = document.getElementById('supply-processing-container');
    const dReady = document.getElementById('supply-ready-container');
    dWaiting.innerHTML = '';
    dProc.innerHTML = '';
    dReady.innerHTML = '';

    let iCount = 0;
    let pCount = 0;
    let rCount = 0;
    let unreadWait = 0;
    let unreadProc = 0;
    let unreadReady = 0;

    const waitReqs = requests.filter(r => r.status === STATUS_WAITING);
    const procReqs = requests.filter(r => r.status === STATUS_PROCESSING);
    const readyReqs = requests.filter(r => r.status === STATUS_READY);

    const getColHTML = (reqs, statType) => {
        if (reqs.length === 0) return '';
        const grouped = groupRequestsByDate(reqs);
        const uniqueDates = [...new Set(reqs.map(r => new Date(r.timestamp).toLocaleDateString('id-ID', { day: '2-digit', month: 'long', year: 'numeric' })))];
        let htmlStr = '';

        uniqueDates.forEach(dateStr => {
            const groupColor = getColorForDate(dateStr);
            const reqsInDate = grouped[dateStr] || [];
            const sortDateDir = document.getElementById('sort-date').value;
            reqsInDate.sort((a, b) => {
                if (b.urgent !== a.urgent) return b.urgent - a.urgent;
                return sortDateDir === 'asc' ? a.timestamp - b.timestamp : b.timestamp - a.timestamp;
            });

            htmlStr += `
            <div class="mb-3 border rounded-lg p-1.5 ${groupColor.border} ${groupColor.bg} relative">
                <div class="sticky top-1 z-20 w-max mb-1.5">
                    <div class="inline-block px-2 py-0.5 rounded bg-white font-black text-[8px] uppercase tracking-wider border ${groupColor.border} ${groupColor.text} shadow-sm">
                        <i class="fas fa-calendar-day"></i> ${dateStr}
                    </div>
                </div>
                <div class="flex flex-col gap-1.5 relative z-10">`;

            reqsInDate.forEach(req => {
                let actionBtnHTML = '';
                let progressHTML = '';
                const unreadCount = (req.messages || []).filter(m => m.senderRole !== currentUser.role && !m.isRead).length;

                if (statType === 'WAITING') {
                    iCount++;
                    unreadWait += unreadCount;
                    actionBtnHTML = `<button onclick="event.stopPropagation(); acceptRequestMarker('${req.id}')" class="w-full py-1.5 bg-brand-blue hover:bg-blue-800 text-white text-[8px] font-black rounded uppercase shadow">Terima</button>`;
                } else if (statType === 'PROCESSING') {
                    pCount++;
                    unreadProc += unreadCount;
                    progressHTML = `<div class="text-[7px] font-bold text-brand-blue uppercase flex justify-between w-full"><span>Step</span><span>${req.step}/4</span></div><div class="w-full bg-gray-200 rounded-full h-1 mt-0.5 mb-1.5"><div class="bg-brand-blue h-1 rounded-full" style="width:${(req.step / 4) * 100}%"></div></div>`;
                    actionBtnHTML = `<button onclick="event.stopPropagation(); openProgressModal('${req.id}')" class="w-full py-1.5 bg-yellow-500 hover:bg-yellow-600 text-white text-[8px] font-black rounded uppercase shadow">Update</button>`;
                } else {
                    rCount++;
                    unreadReady += unreadCount;
                    actionBtnHTML = `<button onclick="event.stopPropagation(); openFinishModal('${req.id}')" class="w-full h-full bg-brand-teal text-white text-[9px] font-bold py-1.5 rounded shadow">SELESAI</button>`;
                }

                const timerHTML = statType === 'WAITING'
                    ? `<div class="w-[100px] flex flex-col items-center justify-center py-1 px-1 rounded-md bg-white/60 border border-transparent shadow-sm"><span class="timer-segment font-black text-[10px] leading-tight whitespace-nowrap" data-start="${req.timestamp}" data-end="${req.timeAccepted || ''}" data-days="false">00:00:00</span></div>`
                    : (statType === 'PROCESSING'
                        ? `<div class="w-[100px] flex flex-col items-center justify-center py-1.5 px-1 rounded-md bg-white/60 border border-transparent shadow-sm"><span class="timer-segment font-black text-[10px] leading-tight whitespace-nowrap" data-start="${req.timeAccepted || ''}" data-end="${req.timeReady || ''}" data-days="true">00:00:00</span></div>`
                        : `<div class="w-[100px] flex flex-col items-center justify-center py-1 px-1 rounded-md bg-white/60 border border-transparent shadow-sm"><span class="timer-segment font-black text-[10px] leading-tight whitespace-nowrap" data-start="${req.timeReady || ''}" data-end="${req.timeFinished || ''}" data-days="false">00:00:00</span></div>`);

                htmlStr += generateCardHTML_Compact(req, actionBtnHTML, progressHTML, timerHTML);
            });
            htmlStr += `</div></div>`;
        });
        return htmlStr;
    };

    dWaiting.innerHTML = getColHTML(waitReqs, 'WAITING');
    dProc.innerHTML = getColHTML(procReqs, 'PROCESSING');
    dReady.innerHTML = getColHTML(readyReqs, 'READY');

    document.getElementById('incoming-count').textContent = iCount;
    document.getElementById('processing-count').textContent = pCount;
    document.getElementById('ready-count').textContent = rCount;

    const bWait = document.getElementById('badge-msg-incoming');
    const bProc = document.getElementById('badge-msg-processing');
    const bRdy = document.getElementById('badge-msg-ready');
    if (unreadWait > 0) { bWait.innerHTML = `${unreadWait} <i class="fas fa-envelope ml-0.5 text-[6px]"></i>`; bWait.classList.remove('hidden'); } else bWait.classList.add('hidden');
    if (unreadProc > 0) { bProc.innerHTML = `${unreadProc} <i class="fas fa-envelope ml-0.5 text-[6px]"></i>`; bProc.classList.remove('hidden'); } else bProc.classList.add('hidden');
    if (unreadReady > 0) { bRdy.innerHTML = `${unreadReady} <i class="fas fa-envelope ml-0.5 text-[6px]"></i>`; bRdy.classList.remove('hidden'); } else bRdy.classList.add('hidden');
}

// ============================================================================
// AKSI TIKET (TERIMA, PROGRESS, SELESAI, BATAL, CHAT, DETAIL)
// ============================================================================
function acceptRequestMarker(id) {
    const idx = db.requests.findIndex(r => r.id === id);
    if (idx > -1) {
        db.requests[idx].status = STATUS_PROCESSING;
        db.requests[idx].step = 1;
        db.requests[idx].timeAccepted = Date.now();
        saveDB();
    }
}

function openProgressModal(id) {
    const req = db.requests.find(r => r.id === id);
    if (!req) return;
    document.getElementById('progress-req-id').value = id;
    document.getElementById('progress-info').textContent = `${req.type} | Total: ${req.items.length} Assy`;
    document.getElementById('step-1').checked = true;
    document.getElementById('step-2').checked = req.step >= 2;
    document.getElementById('step-3').checked = req.step >= 3;
    document.getElementById('step-4').checked = req.step >= 4;
    document.getElementById('progress-supplier-name').value = '';
    checkProgressStatus();
    openModal('modal-progress');
}

function checkProgressStatus() {
    if (document.getElementById('step-4').checked) {
        document.getElementById('step-3').checked = true;
        document.getElementById('step-2').checked = true;
        document.getElementById('supplier-input-container').classList.remove('hidden');
    } else {
        document.getElementById('supplier-input-container').classList.add('hidden');
        if (document.getElementById('step-3').checked) document.getElementById('step-2').checked = true;
    }
}

function saveProgress() {
    const id = document.getElementById('progress-req-id').value;
    const idx = db.requests.findIndex(r => r.id === id);
    if (idx === -1) return;

    let n = 1;
    if (document.getElementById('step-4').checked) n = 4;
    else if (document.getElementById('step-3').checked) n = 3;
    else if (document.getElementById('step-2').checked) n = 2;

    if (n === 4) {
        const supp = document.getElementById('progress-supplier-name').value.trim().toUpperCase();
        if (!supp) return showMessage('Nama MP Warehouse (Supplier) harus diisi manual!');
        db.requests[idx].step = 4;
        db.requests[idx].status = STATUS_READY;
        db.requests[idx].lastSignal = 'ready_' + Date.now();
        db.requests[idx].timeReady = Date.now();
        db.requests[idx].supplierBy = supp;
        showMessage('Unit siap! Menunggu Leader mengambil.');
    } else {
        db.requests[idx].step = n;
    }
    saveDB();
    closeModal('modal-progress');
}

function openFinishModal(id) {
    batchFinishIds = [id];
    document.getElementById('finish-req-id').value = id;
    const titleEl = document.getElementById('picker-modal-title');
    const subEl = document.getElementById('picker-modal-subtitle');
    if (titleEl) titleEl.textContent = 'Selesaikan Tiket?';
    if (subEl) {
        subEl.textContent = '';
        subEl.classList.add('hidden');
    }
    const nameInput = document.getElementById('picker-name-input');
    if (nameInput) nameInput.value = '';
    openModal('modal-picker');
    setTimeout(() => {
        if (nameInput) nameInput.focus();
    }, 100);
}

function openBatchFinishModal() {
    openBatchCloseModal();
}

async function archiveToFirestore(finishedReq) {
    const dateStr = new Date(finishedReq.timeFinished).toISOString().split('T')[0];
    saveLocalHistoryRecord(dateStr, finishedReq);
    recordRequestAssyToHistoryCache(finishedReq);
    if (!dbFs) return;
    const docRef = dbFs.collection('eks_history_buckets').doc(dateStr);
    try {
        const doc = await docRef.get();
        const fb = (typeof window !== 'undefined' && window.firebase) ? window.firebase : (typeof firebase !== 'undefined' ? firebase : null);
        if (doc.exists && fb && fb.firestore && fb.firestore.FieldValue) {
            await docRef.update({ transactions: fb.firestore.FieldValue.arrayUnion(finishedReq) });
        } else {
            await docRef.set({ date: dateStr, transactions: [finishedReq] });
        }
    } catch (e) {
        console.error('Error archiving to Firestore:', e);
    }
}

async function archiveBatchToFirestore(finishedReqs) {
    if (!Array.isArray(finishedReqs) || finishedReqs.length === 0) return;
    if (finishedReqs.length === 1) return archiveToFirestore(finishedReqs[0]);

    const byDate = {};
    finishedReqs.forEach(finishedReq => {
        const dateStr = new Date(finishedReq.timeFinished).toISOString().split('T')[0];
        saveLocalHistoryRecord(dateStr, finishedReq);
        recordRequestAssyToHistoryCache(finishedReq);
        if (!byDate[dateStr]) byDate[dateStr] = [];
        byDate[dateStr].push(finishedReq);
    });

    if (!dbFs) return;
    const fb = (typeof window !== 'undefined' && window.firebase) ? window.firebase : (typeof firebase !== 'undefined' ? firebase : null);
    for (const dateStr of Object.keys(byDate)) {
        const docRef = dbFs.collection('eks_history_buckets').doc(dateStr);
        const batchDocs = byDate[dateStr];
        try {
            const doc = await docRef.get();
            if (doc.exists && fb && fb.firestore && fb.firestore.FieldValue) {
                await docRef.update({ transactions: fb.firestore.FieldValue.arrayUnion(...batchDocs) });
            } else {
                await docRef.set({ date: dateStr, transactions: batchDocs });
            }
        } catch (e) {
            console.error('Error batch archiving to Firestore:', e);
        }
    }
}

function submitFinishWithPicker() {
    const fallbackId = document.getElementById('finish-req-id').value;
    const targetIds = batchFinishIds.length > 0
        ? [...batchFinishIds]
        : (fallbackId && fallbackId !== 'BATCH' ? [fallbackId] : []);
    const pName = document.getElementById('picker-name-input').value.trim().toUpperCase();
    if (!pName) return showMessage('Nama Pengambil harus diisi!');
    if (targetIds.length === 0) {
        closeModal('modal-picker');
        return;
    }

    const finishedAtBase = Date.now();
    const gsReqMap = new Map(gsheetReadyRequests.map(r => [r.id, r]));
    const manualReqMap = new Map((db.requests || []).map((r, i) => [r.id, { req: r, idx: i }]));

    const rtdbUpdates = {};
    const finishedReqsToArchive = [];
    const manualIdsToRemove = new Set();
    let closedGsCount = 0;
    let closedManualCount = 0;
    let skippedStaleGsCount = 0;

    targetIds.forEach((id, seq) => {
        const finishedAt = finishedAtBase + seq;
        const gsReq = gsReqMap.get(id);
        if (gsReq) {
            const finishedReq = {
                ...gsReq,
                status: STATUS_FINISHED,
                timeFinished: finishedAt,
                pickedBy: pName,
                finishedBy: gsReq.supplierBy || '-'
            };
            const completionPayload = {
                serialWO: gsReq.gsheetSerial,
                assy: gsReq.items[0].assy,
                noBox: gsReq.noBox || '-',
                pickedBy: pName,
                supplierBy: gsReq.supplierBy || '-',
                timeFinished: finishedAt
            };
            completedGsheetSerials[gsReq.gsheetSafeKey] = completionPayload;
            rtdbUpdates[gsReq.gsheetSafeKey] = completionPayload;
            finishedReqsToArchive.push(finishedReq);
            selectedBatchIds.delete(id);
            closedGsCount++;
            return;
        }

        if (id && id.startsWith('GS-')) {
            selectedBatchIds.delete(id);
            skippedStaleGsCount++;
            return;
        }

        const manualEntry = manualReqMap.get(id);
        if (manualEntry && manualEntry.req) {
            const finishedReq = {
                ...manualEntry.req,
                status: STATUS_FINISHED,
                timeFinished: finishedAt,
                pickedBy: pName,
                finishedBy: manualEntry.req.supplierBy || '-'
            };
            manualIdsToRemove.add(id);
            finishedReqsToArchive.push(finishedReq);
            selectedBatchIds.delete(id);
            closedManualCount++;
        }
    });

    if (closedGsCount > 0) {
        saveLocalCompletedGsheet();
        if (completedGsheetRef) {
            try {
                completedGsheetRef.update(rtdbUpdates);
            } catch (e) {
                console.warn('Gagal menyimpan validasi GSheet ke Firebase:', e);
            }
        }
        rebuildGsheetRequests();
    }

    if (closedManualCount > 0) {
        db.requests = (db.requests || []).filter(r => !manualIdsToRemove.has(r.id));
        saveDB();
    }

    batchFinishIds = [];
    renderData();
    if (finishedReqsToArchive.length > 0) {
        archiveBatchToFirestore(finishedReqsToArchive);
    }
    closeModal('modal-picker');

    const totalClosed = closedGsCount + closedManualCount;
    if (totalClosed === 0 && skippedStaleGsCount > 0) {
        showMessage('Item tersebut sudah berstatus CLOSED di Google Sheets (tidak masuk history).');
    } else if (totalClosed === 1 && finishedReqsToArchive[0]) {
        const only = finishedReqsToArchive[0];
        showMessage(only.isFromGsheet
            ? `Tiket GSheet (${only.gsheetSerial}) selesai & masuk ke History!`
            : 'Tiket selesai & diarsipkan ke Database Utama.');
    } else if (totalClosed > 1) {
        showMessage(`Batch Selesai: ${totalClosed} tiket diselesaikan (${pName}) & masuk ke History!`);
    }
}

function resendNotif(id, type = 'waiting') {
    const idx = db.requests.findIndex(r => r.id === id);
    if (idx > -1) {
        const req = db.requests[idx];
        const n = Date.now();
        if (req.lastPingTime && (n - req.lastPingTime < 10000)) {
            showMessage('Tunggu 10 detik sebelum kirim Ping lagi.');
            return;
        }
        db.requests[idx].lastSignal = type + '_' + n;
        db.requests[idx].lastPingTime = n;
        saveDB();
        showMessage('Ping terkirim!');
    }
}

function handleRightClick(e, id) {
    e.preventDefault();
    let req = db.requests.find(r => r.id === id);
    if (!req) req = gsheetReadyRequests.find(r => r.id === id);
    if (!req || req.status === STATUS_FINISHED) return;

    if (currentUser.role === 'leader') {
        if (req.isFromGsheet) {
            showMessage('Item Ready dari GSheet tidak bisa dibatalkan. Klik tombol Selesai jika sudah diambil.');
            return;
        }
        cancelTargetId = id;
        document.getElementById('cancel-input').value = '';
        document.getElementById('cancel-error').classList.add('hidden');
        openModal('modal-cancel');
    } else if (currentUser.role === 'warehouse' && req.status === STATUS_READY) {
        openFinishModal(id);
    }
}

function executeCancel() {
    const req = db.requests.find(r => r.id === cancelTargetId);
    if (!req) return;
    const input = document.getElementById('cancel-input').value.trim().toUpperCase();
    if (req.items.some(i => i.assy.toUpperCase() === input)) {
        db.requests = db.requests.filter(r => r.id !== cancelTargetId);
        saveDB();
        closeModal('modal-cancel');
        showMessage('Antrian dibatalkan.');
    } else {
        document.getElementById('cancel-error').classList.remove('hidden');
    }
}

window.copyMarkersToClipboard = function(reqId, itemIdx) {
    let req = (db.requests || []).find(r => r.id === reqId);
    if (!req) req = gsheetReadyRequests.find(r => r.id === reqId);
    if (!req) req = loadedHistoryData.find(r => r.id === reqId);
    if (!req) return;
    const item = req.items[itemIdx];
    if (!item || !item.markers) return;

    const lines = [];
    item.markers.forEach(m => {
        if (typeof m === 'object' && m !== null) {
            const qty = Math.max(1, Number(m.qty) || 0);
            for (let i = 0; i < qty; i++) lines.push(m.text);
        } else {
            const qty = Math.max(1, Number(item.qty) || 1);
            for (let i = 0; i < qty; i++) lines.push(String(m));
        }
    });
    const textToCopy = lines.join('\n');
    fallbackCopyTextToClipboard(textToCopy);
};

function fallbackCopyTextToClipboard(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.top = '0';
    ta.style.left = '0';
    ta.style.position = 'fixed';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    try {
        document.execCommand('copy');
        showMessage('Marker disalin ke Clipboard!');
    } catch (err) {
        console.error('Fallback: Oops, unable to copy', err);
    }
    document.body.removeChild(ta);
}

// ============================================================================
// HISTORY & STATISTIK FIRESTORE
// ============================================================================
async function fetchHistoryBuckets(startStr, endStr) {
    const datesToFetch = [];
    const curr = new Date(startStr);
    const end = new Date(endStr);
    while (curr <= end) {
        datesToFetch.push(curr.toISOString().split('T')[0]);
        curr.setDate(curr.getDate() + 1);
    }

    const allTx = [];
    const todayStr = new Date().toISOString().split('T')[0];

    for (const d of datesToFetch) {
        if (cachedHistoryBuckets[d] && d !== todayStr) {
            allTx.push(...cachedHistoryBuckets[d]);
        } else if (!dbFs) {
            allTx.push(...getLocalHistoryBucket(d));
        } else {
            try {
                const doc = await dbFs.collection('eks_history_buckets').doc(d).get();
                if (doc.exists) {
                    const data = doc.data().transactions || [];
                    if (d !== todayStr) cachedHistoryBuckets[d] = data;
                    allTx.push(...data);
                } else {
                    if (d !== todayStr) cachedHistoryBuckets[d] = [];
                }
            } catch (e) {
                console.error('Fetch bucket error:', e);
                allTx.push(...getLocalHistoryBucket(d));
            }
        }
    }
    return allTx.filter(r => r.systemType === currentUser.section);
}

async function loadAndRenderHistory() {
    const startStr = document.getElementById('history-date-start').value;
    const endStr = document.getElementById('history-date-end').value;
    if (!startStr || !endStr) return;

    document.getElementById('history-container').innerHTML = `<div class="text-center text-brand-teal text-xs font-bold py-10"><i class="fas fa-spinner fa-spin text-2xl mb-2"></i><br>Loading Arsip...</div>`;
    loadedHistoryData = await fetchHistoryBuckets(startStr, endStr);
    filterAndRenderHistory();
}

function filterAndRenderHistory() {
    const h = document.getElementById('history-container');
    const histSearch = (document.getElementById('history-search-input')?.value || '').toLowerCase();
    const histLineFilter = document.getElementById('history-filter-line')?.value || 'ALL';
    const histShiftFilter = document.getElementById('history-filter-shift')?.value || 'ALL';

    const filtered = loadedHistoryData.filter(req => {
        const matchSearch = histSearch === ''
            || req.items.some(i => (i.assy || '').toLowerCase().includes(histSearch))
            || (req.displayId && req.displayId.toLowerCase().includes(histSearch))
            || (req.gsheetSerial && req.gsheetSerial.toLowerCase().includes(histSearch))
            || (req.noBox && req.noBox.toLowerCase().includes(histSearch));
        const matchLine = histLineFilter === 'ALL' ? true : req.items.some(i => i.line === histLineFilter);
        const matchShift = (histShiftFilter === 'ALL' || req.isFromGsheet) ? true : req.shift === histShiftFilter;
        return matchSearch && matchLine && matchShift;
    });

    filtered.sort((a, b) => (b.timeFinished || b.timestamp) - (a.timeFinished || a.timestamp));
    const limitedReqs = filtered.slice(0, 50);

    if (limitedReqs.length === 0) {
        h.innerHTML = `<div class="text-center text-gray-400 text-xs font-bold py-10">Belum ada history</div>`;
        return;
    }
    h.innerHTML = limitedReqs.map(req => {
        const safeId = String(req.id || '').replace(/'/g, "\\'");
        const finishedTs = Number(req.timeFinished || req.timestamp || 0);
        return `<div onclick="showDetailModal('${safeId}')" oncontextmenu="handleHistoryRightClick(event, '${safeId}', ${finishedTs})" title="Klik kiri untuk detail • Klik kanan untuk Undo Closed" class="cursor-pointer bg-white border border-gray-100 rounded-lg shadow-sm hover:shadow mb-2"><div class="bg-gray-50 flex justify-between items-center px-2.5 py-1.5 border-b"><div class="flex items-center gap-1.5 overflow-hidden flex-1 pr-2"><span class="font-display font-black text-[13px] ${req.isFromGsheet ? 'text-emerald-700' : 'text-brand-blue'} shrink-0">${req.displayId || '#' + req.queueNum}</span>${req.isFromGsheet ? '<span class="text-[7px] font-black uppercase px-1 rounded bg-emerald-600 text-white shrink-0">GSHEET</span>' : ''}<span class="text-[8px] font-bold uppercase px-1.5 rounded border shrink-0 ${req.type === 'ALL' ? 'bg-blue-100 text-blue-700' : 'bg-purple-100 text-purple-700'}">${req.type}</span><span class="text-[10px] font-bold text-gray-700 truncate">${req.items.map(i => i.assy).join(', ')}</span></div><span class="text-[8px] text-green-600 font-bold uppercase shrink-0"><i class="fas fa-check"></i> Selesai</span></div><div class="px-2.5 py-1.5 flex justify-between items-center text-[9px] text-gray-400"><span class="font-bold truncate pr-2"><i class="fas fa-hand-holding"></i> ${req.pickedBy || req.requestedBy}</span><span class="font-mono bg-gray-100 px-1.5 py-0.5 rounded text-gray-500 shrink-0">${new Date(req.timeFinished || req.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} | ${new Date(req.timeFinished || req.timestamp).toLocaleDateString()}</span></div></div>`;
    }).join('');
}

let historyContextTarget = null;

function hideHistoryContextMenu() {
    const menu = document.getElementById('history-context-menu');
    if (menu) menu.classList.add('hidden');
    historyContextTarget = null;
}

function handleHistoryRightClick(e, id, timeFinished) {
    if (e) {
        e.preventDefault();
        e.stopPropagation();
    }
    const targetReq = findHistoryRecord(id, timeFinished);
    if (!targetReq) return;

    historyContextTarget = {
        id: targetReq.id,
        timeFinished: Number(targetReq.timeFinished || targetReq.timestamp || 0)
    };

    const menu = document.getElementById('history-context-menu');
    if (!menu) return;
    menu.classList.remove('hidden');

    const menuWidth = menu.offsetWidth || 180;
    const menuHeight = menu.offsetHeight || 42;
    const vw = (typeof window !== 'undefined' && window.innerWidth) ? window.innerWidth : 1280;
    const vh = (typeof window !== 'undefined' && window.innerHeight) ? window.innerHeight : 720;
    const clientX = (e && typeof e.clientX === 'number') ? e.clientX : 100;
    const clientY = (e && typeof e.clientY === 'number') ? e.clientY : 100;
    const left = Math.max(8, Math.min(clientX, vw - menuWidth - 8));
    const top = Math.max(8, Math.min(clientY, vh - menuHeight - 8));

    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
}

function findHistoryRecord(id, timeFinished) {
    const targetTs = Number(timeFinished || 0);
    let found = loadedHistoryData.find(r => r.id === id && (!targetTs || Number(r.timeFinished || r.timestamp || 0) === targetTs));
    if (!found) found = loadedHistoryData.find(r => r.id === id);
    return found || null;
}

function isSameHistoryRecord(r, targetReq) {
    if (!r || !targetReq || r.id !== targetReq.id) return false;
    const rTs = Number(r.timeFinished || r.timestamp || 0);
    const tTs = Number(targetReq.timeFinished || targetReq.timestamp || 0);
    return !tTs || !rTs || rTs === tTs;
}

function removeLocalHistoryRecord(targetReq) {
    loadedHistoryData = loadedHistoryData.filter(r => !isSameHistoryRecord(r, targetReq));

    const dateStr = new Date(targetReq.timeFinished || targetReq.timestamp || Date.now()).toISOString().split('T')[0];
    if (Array.isArray(cachedHistoryBuckets[dateStr])) {
        cachedHistoryBuckets[dateStr] = cachedHistoryBuckets[dateStr].filter(r => !isSameHistoryRecord(r, targetReq));
    }

    try {
        const all = JSON.parse(localStorage.getItem(LOCAL_HISTORY_STORAGE_KEY) || '{}') || {};
        let changed = false;
        Object.keys(all).forEach(k => {
            if (!Array.isArray(all[k])) return;
            const beforeLen = all[k].length;
            all[k] = all[k].filter(r => !isSameHistoryRecord(r, targetReq));
            if (all[k].length !== beforeLen) changed = true;
        });
        if (changed) {
            localStorage.setItem(LOCAL_HISTORY_STORAGE_KEY, JSON.stringify(all));
        }
    } catch (e) {}
}

async function removeHistoryFromFirestore(targetReq) {
    if (!dbFs || !targetReq) return;
    const dateStr = new Date(targetReq.timeFinished || targetReq.timestamp || Date.now()).toISOString().split('T')[0];
    const docRef = dbFs.collection('eks_history_buckets').doc(dateStr);
    try {
        const doc = await docRef.get();
        if (!doc.exists) return;
        const currentTx = Array.isArray(doc.data().transactions) ? doc.data().transactions : [];
        let removedOne = false;
        const nextTx = currentTx.filter(r => {
            if (!removedOne && isSameHistoryRecord(r, targetReq)) {
                removedOne = true;
                return false;
            }
            return true;
        });
        if (removedOne) {
            await docRef.update({ transactions: nextTx });
            if (Array.isArray(cachedHistoryBuckets[dateStr])) {
                cachedHistoryBuckets[dateStr] = nextTx;
            }
        }
    } catch (e) {
        console.error('Error removing history record from Firestore:', e);
    }
}

function confirmUndoClosedFromHistory() {
    if (!historyContextTarget) return;
    const { id, timeFinished } = historyContextTarget;
    hideHistoryContextMenu();
    undoClosedFromHistory(id, timeFinished);
}

async function undoClosedFromHistory(id, timeFinished) {
    const targetReq = findHistoryRecord(id, timeFinished);
    if (!targetReq) {
        showMessage('Data history tidak ditemukan.');
        return;
    }

    const isGsheet = !!(targetReq.isFromGsheet || (targetReq.id && String(targetReq.id).startsWith('GS-')) || targetReq.gsheetSafeKey);

    if (isGsheet) {
        const keysToRemove = new Set();
        const primaryKey = targetReq.gsheetSafeKey || String(targetReq.id || '').replace(/^GS-/, '');
        if (primaryKey) keysToRemove.add(primaryKey);
        if (targetReq.gsheetLegacySafeKey) keysToRemove.add(targetReq.gsheetLegacySafeKey);

        const targetAssy = (targetReq.items && targetReq.items[0] && targetReq.items[0].assy) ? targetReq.items[0].assy : '';
        Object.keys(completedGsheetSerials || {}).forEach(k => {
            const entry = completedGsheetSerials[k];
            if (keysToRemove.has(k)) return;
            if (entry && targetReq.gsheetSerial && entry.serialWO === targetReq.gsheetSerial && (!entry.assy || !targetAssy || entry.assy === targetAssy)) {
                keysToRemove.add(k);
            }
        });

        keysToRemove.forEach(k => {
            delete completedGsheetSerials[k];
        });
        saveLocalCompletedGsheet();

        if (completedGsheetRef) {
            keysToRemove.forEach(k => {
                try {
                    completedGsheetRef.child(k).remove();
                } catch (e) {
                    console.warn('Gagal menghapus status selesai GSheet di Firebase:', e);
                }
            });
        }

        rebuildGsheetRequests();
    } else {
        const restoredReq = { ...targetReq };
        restoredReq.status = STATUS_READY;
        restoredReq.step = restoredReq.step || 4;
        restoredReq.timeReady = restoredReq.timeReady || restoredReq.timeFinished || Date.now();
        delete restoredReq.timeFinished;
        delete restoredReq.pickedBy;
        delete restoredReq.finishedBy;

        if (!Array.isArray(db.requests)) db.requests = [];
        const existingIdx = db.requests.findIndex(r => r.id === restoredReq.id);
        if (existingIdx > -1) {
            db.requests[existingIdx] = restoredReq;
        } else {
            db.requests.push(restoredReq);
        }
        saveDB();
    }

    removeLocalHistoryRecord(targetReq);
    filterAndRenderHistory();

    const detailModal = document.getElementById('modal-detail');
    if (detailModal && !detailModal.classList.contains('hidden') && currentDetailReqId === targetReq.id) {
        closeModal('modal-detail');
    }

    if (isHistoryOpen) {
        toggleHistory();
    }

    renderData();
    await removeHistoryFromFirestore(targetReq);

    if (isGsheet && !gsheetReadyRequests.some(r => r.id === targetReq.id)) {
        syncGsheetReadyItems(false);
    }

    const label = targetReq.displayId || (targetReq.items && targetReq.items[0] ? targetReq.items[0].assy : targetReq.id);
    showMessage(`Undo Closed berhasil! ${label} dikembalikan ke Active Queue.`);
}

if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('click', (e) => {
        const menu = document.getElementById('history-context-menu');
        if (!menu || menu.classList.contains('hidden')) return;
        if (e && e.target && typeof e.target.closest === 'function' && e.target.closest('#history-context-menu')) return;
        hideHistoryContextMenu();
    });
    document.addEventListener('keydown', (e) => {
        if (e && e.key === 'Escape') hideHistoryContextMenu();
    });
}

function toggleChatPanel() {
    const c = document.getElementById('chat-panel-container');
    const d = document.getElementById('detail-panel-container');
    const b = document.getElementById('toggle-chat-btn');
    if (c.classList.contains('hidden')) {
        c.classList.remove('hidden');
        d.classList.remove('w-full');
        d.classList.add('w-2/3');
        b.innerHTML = `<i class="fas fa-eye-slash mr-1"></i> Sembunyikan Chat`;
    } else {
        c.classList.add('hidden');
        d.classList.remove('w-2/3');
        d.classList.add('w-full');
        b.innerHTML = `<i class="fas fa-comment-dots mr-1"></i> Tampilkan Chat`;
    }
}

function sendChatMessage(reqId) {
    const i = document.getElementById('chat-input');
    const t = i.value.trim();
    if (!t) return;
    const gsReq = gsheetReadyRequests.find(r => r.id === reqId);
    if (gsReq) {
        const msgPayload = {
            senderName: currentUser.name,
            senderRole: currentUser.role,
            text: t,
            timestamp: Date.now(),
            isRead: false
        };
        if (gsheetMetaRef) {
            gsheetMetaRef.child(gsReq.gsheetSafeKey).child('messages').push(msgPayload);
        } else {
            if (!gsheetMetaMap[gsReq.gsheetSafeKey]) gsheetMetaMap[gsReq.gsheetSafeKey] = {};
            if (!gsheetMetaMap[gsReq.gsheetSafeKey].messages) gsheetMetaMap[gsReq.gsheetSafeKey].messages = {};
            gsheetMetaMap[gsReq.gsheetSafeKey].messages['msg_' + Date.now()] = msgPayload;
            saveLocalGsheetMeta();
            rebuildGsheetRequests();
            renderData();
        }
        i.value = '';
        setTimeout(() => showDetailModal(reqId), 150);
        return;
    }
    const idx = db.requests.findIndex(r => r.id === reqId);
    if (idx === -1) return;
    if (!db.requests[idx].messages) db.requests[idx].messages = [];
    db.requests[idx].messages.push({
        senderName: currentUser.name,
        senderRole: currentUser.role,
        text: t,
        timestamp: Date.now(),
        isRead: false
    });
    saveDB();
    showDetailModal(reqId);
}

window.toggleRequestUrgent = function(reqId) {
    const gsReq = gsheetReadyRequests.find(r => r.id === reqId);
    if (gsReq) {
        const nextUrgent = !gsReq.urgent;
        if (gsheetMetaRef) {
            gsheetMetaRef.child(gsReq.gsheetSafeKey).child('urgent').set(nextUrgent);
        } else {
            if (!gsheetMetaMap[gsReq.gsheetSafeKey]) gsheetMetaMap[gsReq.gsheetSafeKey] = {};
            gsheetMetaMap[gsReq.gsheetSafeKey].urgent = nextUrgent;
            saveLocalGsheetMeta();
            rebuildGsheetRequests();
            renderData();
        }
        setTimeout(() => showDetailModal(reqId), 150);
        return;
    }
    const idx = db.requests.findIndex(r => r.id === reqId);
    if (idx > -1) {
        db.requests[idx].urgent = !db.requests[idx].urgent;
        saveDB();
        showDetailModal(reqId);
    }
};

function showDetailModal(id) {
    let req = db.requests.find(r => r.id === id);
    if (!req) req = gsheetReadyRequests.find(r => r.id === id);
    if (!req) req = loadedHistoryData.find(r => r.id === id);
    if (!req) return;
    currentDetailReqId = req.id;

    if (req.isFromGsheet && req.status !== STATUS_FINISHED && gsheetMetaMap[req.gsheetSafeKey] && gsheetMetaMap[req.gsheetSafeKey].messages) {
        const msgObj = gsheetMetaMap[req.gsheetSafeKey].messages;
        let localUpdated = false;
        Object.keys(msgObj).forEach(k => {
            if (msgObj[k].senderRole !== currentUser.role && !msgObj[k].isRead) {
                msgObj[k].isRead = true;
                localUpdated = true;
                if (gsheetMetaRef) {
                    gsheetMetaRef.child(req.gsheetSafeKey).child('messages').child(k).child('isRead').set(true);
                }
            }
        });
        if (localUpdated && !gsheetMetaRef) {
            saveLocalGsheetMeta();
            rebuildGsheetRequests();
            renderData();
        }
    } else {
        let hasUnread = false;
        if (req.messages && req.status !== STATUS_FINISHED) {
            req.messages.forEach(m => {
                if (m.senderRole !== currentUser.role && !m.isRead) {
                    m.isRead = true;
                    hasUnread = true;
                }
            });
            if (hasUnread) saveDB();
        }
    }

    const statStyle = req.status === 'WAITING'
        ? 'text-yellow-600 bg-yellow-50 border-yellow-200'
        : (req.status === 'PROCESSING'
            ? 'text-blue-600 bg-blue-50 border-blue-200'
            : (req.status === 'READY' ? 'text-white bg-brand-teal shadow-md' : 'text-green-600 bg-green-50 border-green-200'));
    let displayStatus = req.status;
    if (displayStatus === 'PROCESSING') displayStatus += ` (${req.step}/4)`;

    const msgs = (req.messages || []).map(m => `<div class="mb-3 flex flex-col ${m.senderRole === currentUser.role ? 'items-end' : 'items-start'}"><span class="text-[9px] font-bold text-gray-400 mb-0.5">${m.senderName} • ${new Date(m.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span><div class="px-3 py-2.5 rounded-xl text-xs font-bold max-w-[85%] shadow-sm ${m.senderRole === currentUser.role ? 'bg-brand-teal text-white rounded-br-none' : 'bg-white text-gray-800 rounded-bl-none border border-gray-200'}">${m.text}</div></div>`).join('');

    const itemsHtml = `<div class="border border-gray-200 rounded-lg bg-white shadow-sm flex flex-col overflow-hidden">` + req.items.map((item, idx) => {
        const isIMPP = item.type === 'IMPP';
        const totalQty = req.type === 'ALL' ? item.qty : (item.markers || []).reduce((sum, m) => sum + (typeof m === 'object' ? Number(m.qty) : Number(item.qty || 1)), 0);
        const markersHtml = isIMPP && item.markers ? `
        <div class="w-1/2 pl-3 border-l border-gray-100 flex flex-col bg-gray-50/50 relative group">
            <div class="flex justify-between items-center mb-2 border-b border-gray-200 pb-1 shrink-0">
                <span class="text-[9px] font-black text-indigo-800 uppercase bg-indigo-100 px-2 py-0.5 rounded shadow-sm border border-indigo-200"><i class="fas fa-list-ol mr-1"></i>Daftar Marker</span>
                <button onclick="copyMarkersToClipboard('${req.id}', ${idx})" class="text-[9px] font-bold text-brand-teal bg-white border border-teal-200 px-2 py-0.5 rounded shadow-sm hover:bg-teal-50 transition"><i class="fas fa-copy"></i> Salin (${totalQty}x)</button>
            </div>
            <div class="flex flex-col gap-1 overflow-y-auto max-h-32 pr-1">
                ${item.markers.map(m => {
                    const mText = typeof m === 'object' ? m.text : String(m);
                    const mType = typeof m === 'object' ? m.typeMarker : (item.typeMarker || 'Wire');
                    const mQty = typeof m === 'object' ? m.qty : (item.qty || 1);
                    const mProb = typeof m === 'object' ? m.problem : (item.problem || '');
                    return `
                    <div class="flex justify-between items-center bg-white p-1 rounded border shadow-sm">
                        <span class="font-mono font-black text-indigo-800 text-[10px] w-24 truncate px-1" title="${mText}">${mText}</span>
                        <span class="text-[8px] font-bold bg-gray-100 px-1 rounded">${mType}</span>
                        <span class="text-[9px] font-black text-blue-600 bg-blue-50 px-1.5 rounded border border-blue-100">QTY: ${mQty}</span>
                        ${mProb ? `<span class="text-[8px] text-red-500 font-bold max-w-[60px] truncate" title="${mProb}">${mProb}</span>` : ''}
                    </div>`;
                }).join('')}
            </div>
        </div>` : '';

        const hasNote = item.note && item.note.trim() !== '';
        const noteIndicator = hasNote ? `<div class="w-1.5 h-1.5 rounded-full bg-yellow-400 ml-1 shadow-sm border border-yellow-500 inline-block shrink-0" title="Ada Keterangan Tambahan"></div>` : '';

        return `
        <div class="flex items-stretch py-2.5 px-3 border-b hover:bg-gray-50 relative">
            ${item.urgent ? `<span class="absolute left-0 top-0 bottom-0 w-1 bg-red-500 animate-pulse"></span>` : ''}
            <div class="text-[10px] font-bold text-gray-400 w-5 text-right shrink-0 mr-2 pt-0.5">${idx + 1}.</div>
            <div class="${isIMPP ? 'w-1/2 pr-3' : 'w-full'} flex flex-col justify-center">
                <div class="flex items-center gap-1.5 mb-1.5 flex-wrap">
                    <span class="text-base font-display font-black text-gray-800 uppercase">${item.assy}</span>
                    <span class="bg-gray-800 text-white px-2 py-0.5 rounded text-[10px] font-black uppercase shadow-sm">WP: ${item.wp || '-'}</span>
                    <span class="bg-blue-600 text-white px-2 py-0.5 rounded text-[10px] font-black shadow-sm">QTY: ${totalQty}</span>
                    ${item.lot ? `<span class="text-[10px] font-black bg-purple-600 px-2 py-0.5 rounded shadow-sm text-white">${item.lot}</span>` : ''}
                    ${noteIndicator}
                </div>
                <div class="flex flex-wrap gap-1.5 text-[9px] font-bold text-gray-500 mt-0.5">
                    <span class="bg-gray-100 px-1.5 py-0.5 rounded border uppercase">Line: ${item.line}</span>
                    ${!isIMPP ? `<span class="bg-indigo-50 text-indigo-700 px-1.5 py-0.5 rounded border border-indigo-200 uppercase">${item.typeMarker || '-'}</span>` : ''}
                    ${item.pic ? `<span class="bg-teal-50 text-brand-teal px-1.5 py-0.5 rounded border border-teal-200 uppercase">PIC: ${item.pic}</span>` : ''}
                </div>
                ${item.note ? `<div class="mt-2 text-[9px] bg-yellow-50 text-yellow-800 px-2 py-1.5 rounded border border-yellow-200 font-bold shadow-sm italic"><i class="fas fa-info-circle mr-1"></i>${item.note}</div>` : ''}
            </div>
            ${markersHtml}
        </div>`;
    }).join('') + `</div>`;

    let histHtml = '';
    if (req.status === STATUS_FINISHED) {
        const tsReq = req.timestamp;
        const tsAcc = req.timeAccepted || req.timeReady || req.timeFinished || req.timestamp;
        const tsRdy = req.timeReady || req.timeFinished || tsAcc;
        const tsFin = req.timeFinished || tsRdy;

        const waitMs = Math.max(0, tsAcc - tsReq);
        const procMs = Math.max(0, tsRdy - tsAcc);
        const readyMs = Math.max(0, tsFin - tsRdy);
        const totalMs = Math.max(0, tsFin - tsReq);

        histHtml = `
        <div class="mb-5 bg-white p-4 rounded-xl border shadow-sm">
            <div class="text-[10px] font-bold text-gray-400 uppercase border-b pb-1 mb-3">Lead Time Breakdown</div>
            <div class="grid grid-cols-3 gap-2 mb-3">
                <div class="bg-orange-50 border border-orange-100 p-2 rounded-lg text-center">
                    <div class="text-[8px] font-black text-orange-600 uppercase mb-1">Wait</div>
                    <div class="font-mono text-[10px] font-bold text-orange-800">${formatDurationMs(waitMs)}</div>
                </div>
                <div class="bg-blue-50 border border-blue-100 p-2 rounded-lg text-center">
                    <div class="text-[8px] font-black text-blue-600 uppercase mb-1">Process</div>
                    <div class="font-mono text-[10px] font-bold text-blue-800">${formatDurationMs(procMs)}</div>
                </div>
                <div class="bg-green-50 border border-green-100 p-2 rounded-lg text-center">
                    <div class="text-[8px] font-black text-green-600 uppercase mb-1">Ready</div>
                    <div class="font-mono text-[10px] font-bold text-green-800">${formatDurationMs(readyMs)}</div>
                </div>
            </div>
            <div class="mt-2 pt-2 border-t flex justify-between items-center font-black text-brand-teal">
                <span>TOTAL WAKTU</span>
                <span class="bg-teal-50 px-3 py-1.5 rounded-lg text-sm font-mono border">${formatDurationMs(totalMs)}</span>
            </div>
            <div class="mt-3 text-[10px] font-bold text-gray-500">
                <i class="fas fa-box text-blue-500"></i> MP Gudang (Supplier): <span class="uppercase text-brand-blue">${req.supplierBy || req.finishedBy || '-'}</span><br>
                <i class="fas fa-check-double text-green-500 mt-1"></i> Diambil oleh: <span class="uppercase text-brand-blue">${req.pickedBy || '-'}</span>
            </div>
        </div>`;
    }

    document.getElementById('detail-content-wrapper').innerHTML = `
        <div id="chat-panel-container" class="w-1/3 bg-white rounded-2xl shadow-2xl flex flex-col overflow-hidden border relative transition-all duration-300 origin-left"><div class="px-5 py-4 border-b bg-gray-50 flex items-center shrink-0"><h3 class="font-display font-black text-[15px] text-brand-blue"><i class="fas fa-comments text-brand-teal"></i> Komunikasi</h3></div><div class="flex-1 overflow-y-auto p-4 bg-gray-50/50" id="chat-messages-container">${msgs || '<div class="h-full flex flex-col items-center justify-center text-gray-400 opacity-60"><i class="fas fa-comment-dots text-4xl mb-2"></i><span class="text-xs font-bold">Belum ada pesan.</span></div>'}</div><div class="p-3 border-t bg-white shrink-0"><div class="flex gap-2 bg-gray-50 p-1.5 rounded-xl border"><input type="text" id="chat-input" class="w-full bg-transparent border-none outline-none px-2 text-xs font-bold text-gray-700" placeholder="${req.status === STATUS_FINISHED ? 'Tidak bisa membalas histori' : 'Ketik pesan...'}" ${req.status === STATUS_FINISHED ? 'disabled' : ''} onkeypress="if(event.key==='Enter') sendChatMessage('${req.id}')"><button onclick="sendChatMessage('${req.id}')" ${req.status === STATUS_FINISHED ? 'disabled' : ''} class="bg-brand-teal disabled:bg-gray-300 text-white px-4 py-2 rounded-lg"><i class="fas fa-paper-plane"></i></button></div></div></div>
        <div id="detail-panel-container" class="w-2/3 bg-white rounded-2xl shadow-2xl flex flex-col overflow-hidden border relative transition-all duration-300 origin-right"><div class="px-6 py-4 border-b bg-gray-50 flex justify-between shrink-0"><h3 class="font-display font-black text-lg text-brand-blue"><i class="fas fa-info-circle text-brand-teal"></i> Detail MARKER</h3><div class="flex items-center gap-3"><button id="toggle-chat-btn" onclick="toggleChatPanel()" class="text-[10px] font-bold text-gray-500 bg-white border px-3 py-1.5 rounded uppercase"><i class="fas fa-eye-slash mr-1"></i> Sembunyikan Chat</button><button onclick="closeModal('modal-detail')" class="text-gray-400 hover:text-red-500 bg-white rounded-full w-8 h-8 border"><i class="fas fa-times"></i></button></div></div><div class="p-6 flex-1 overflow-y-auto">
            <div class="flex justify-between items-start mb-5">
                <div>
                    <div class="flex items-center gap-2">
                        <h2 class="text-3xl font-display font-black ${req.isFromGsheet ? 'text-emerald-700' : 'text-brand-blue'} leading-none">${req.displayId || req.queueNum}</h2>
                        ${req.isFromGsheet ? '<span class="px-2 py-1 rounded-full bg-emerald-600 text-white text-[9px] font-black uppercase tracking-wider shadow-sm"><i class="fas fa-table mr-1"></i>GSHEET READY</span>' : ''}
                    </div>
                    ${req.status !== STATUS_FINISHED && currentUser.role === 'leader' ? `
                    <label class="flex items-center cursor-pointer mt-3 group">
                        <div class="relative flex items-center">
                            <input type="checkbox" class="sr-only toggle-switch-input" onchange="toggleRequestUrgent('${req.id}')" ${req.urgent ? 'checked' : ''}>
                            <div class="w-10 h-5 rounded-full transition-colors toggle-switch-bg ${req.urgent ? 'bg-red-500' : 'bg-gray-300'} shadow-inner">
                                <div class="toggle-switch-dot absolute left-1 top-1 bg-white w-3 h-3 rounded-full transition-transform duration-300 ${req.urgent ? 'translate-x-5' : ''} shadow"></div>
                            </div>
                        </div>
                        <span class="ml-2 text-xs font-black uppercase ${req.urgent ? 'text-red-600' : 'text-gray-500'}">Jadikan Urgent</span>
                    </label>
                    ` : ''}
                </div>
                <span class="px-3 py-1.5 rounded text-[11px] font-black uppercase border ${statStyle}">${displayStatus}</span>
            </div>
            ${req.isFromGsheet ? `
            <div class="mb-5 bg-emerald-50 border border-emerald-200 p-3.5 rounded-xl shadow-sm grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
                <div><div class="text-[9px] font-bold text-emerald-600 uppercase">Serial WO ID (${(req.colLetters && req.colLetters.serialWO) || 'B'})</div><div class="font-mono font-black text-emerald-900 break-all">${req.gsheetSerial}</div></div>
                <div><div class="text-[9px] font-bold text-emerald-600 uppercase">No BOX (${(req.colLetters && req.colLetters.noBox) || 'AJ'})</div><div class="font-black text-emerald-900">${req.noBox || '-'}</div></div>
                <div><div class="text-[9px] font-bold text-emerald-600 uppercase">Tgl Print (${(req.colLetters && req.colLetters.tglPrint) || 'AC'})</div><div class="font-black text-emerald-900">${req.tglPrintLabel || '-'}</div></div>
                <div><div class="text-[9px] font-bold text-emerald-600 uppercase">PIC Warehouse (${(req.colLetters && req.colLetters.pic) || 'AG'})</div><div class="font-black text-emerald-900">${req.supplierBy || '-'}</div></div>
            </div>
            ` : ''}
            <div class="flex gap-4 mb-6 text-xs text-gray-500 font-bold bg-gray-50 p-3.5 rounded-xl border shadow-inner"><div class="flex-1"><i class="fas fa-user-circle text-gray-400"></i> ${req.requestedBy}</div><div class="flex-1"><i class="fas fa-tag text-gray-400"></i> ${req.type}</div>${req.urgent ? `<div class="text-red-500 animate-pulse"><i class="fas fa-fire"></i> URGENT</div>` : ''}</div>${req.status !== STATUS_WAITING && req.status !== STATUS_FINISHED ? `<div class="mb-6 bg-white p-4 rounded-xl border shadow-sm"><div class="flex gap-1.5"><div class="h-2.5 flex-1 rounded-l-full ${req.step >= 1 ? 'bg-brand-teal' : 'bg-gray-100'}"></div><div class="h-2.5 flex-1 ${req.step >= 2 ? 'bg-brand-teal' : 'bg-gray-100'}"></div><div class="h-2.5 flex-1 ${req.step >= 3 ? 'bg-brand-teal' : 'bg-gray-100'}"></div><div class="h-2.5 flex-1 rounded-r-full ${req.step >= 4 ? 'bg-brand-teal' : 'bg-gray-100'}"></div></div><div class="flex justify-between text-[9px] font-bold text-gray-400 mt-2 uppercase"><span>Accept</span><span>Print</span><span>Cut</span><span>Done</span></div></div>` : ''}${histHtml}<div class="text-[11px] font-black text-brand-blue uppercase mb-2 pl-1">Data Part Request</div>${itemsHtml}</div></div>
    `;
    openModal('modal-detail');
    setTimeout(() => {
        const c = document.getElementById('chat-messages-container');
        if (c) c.scrollTop = c.scrollHeight;
    }, 50);
}

function openStatsModal() {
    if (!document.getElementById('stat-date-start').value) {
        const today = new Date().toISOString().split('T')[0];
        document.getElementById('stat-date-start').value = today;
        document.getElementById('stat-date-end').value = today;
    }
    switchStatTab('ALL');
    openModal('modal-statistics');
}

function switchStatTab(tab) {
    currentStatTab = tab;
    ['ALL', 'IMPP', 'ASSY'].forEach(t => {
        const btn = document.getElementById('tab-stat-' + t.toLowerCase());
        if (t === tab) btn.className = 'px-5 py-1.5 rounded-md text-xs font-black transition-all bg-brand-blue text-white shadow-sm';
        else btn.className = 'px-5 py-1.5 rounded-md text-xs font-black transition-all text-gray-500 hover:bg-gray-200';
    });

    if (tab === 'ASSY') {
        document.getElementById('stat-overview-container').classList.add('hidden');
        document.getElementById('stat-assy-container').classList.remove('hidden');
    } else {
        document.getElementById('stat-overview-container').classList.remove('hidden');
        document.getElementById('stat-assy-container').classList.add('hidden');
        document.getElementById('stat-title-display').textContent = `STATISTIK KANBAN (${tab})`;
    }
    calculateStats();
}

async function calculateStats() {
    if (!currentUser) return;
    const startStr = document.getElementById('stat-date-start').value;
    const endStr = document.getElementById('stat-date-end').value;
    if (!startStr || !endStr) return;

    document.getElementById('stat-loading').classList.remove('hidden');

    const startDate = new Date(startStr);
    startDate.setHours(0, 0, 0, 0);
    const endDate = new Date(endStr);
    endDate.setHours(23, 59, 59, 999);

    const diffTime = Math.abs(endDate - startDate);
    const diffDays = Math.max(1, Math.ceil(diffTime / (1000 * 60 * 60 * 24)));
    document.getElementById('stat-days-calc').textContent = diffDays;

    const bucketReqs = await fetchHistoryBuckets(startStr, endStr);

    if (currentStatTab === 'ALL' || currentStatTab === 'IMPP') {
        const reqs = bucketReqs.filter(r => r.type === currentStatTab);
        const finishedList = reqs.filter(r => r.status === STATUS_FINISHED && r.timeFinished >= startDate.getTime() && r.timeFinished <= endDate.getTime());
        const incomingList = reqs.filter(r => r.timestamp >= startDate.getTime() && r.timestamp <= endDate.getTime());

        const totalIn = incomingList.length;
        const totalOut = finishedList.length;

        document.getElementById('stat-total-in').textContent = totalIn;
        document.getElementById('stat-total-out').textContent = totalOut;
        document.getElementById('stat-avg-in').textContent = (totalIn / diffDays).toFixed(1).replace('.0', '');
        document.getElementById('stat-avg-out').textContent = (totalOut / diffDays).toFixed(1).replace('.0', '');
    } else if (currentStatTab === 'ASSY') {
        const reqs = bucketReqs.filter(r => r.type === 'ALL' && r.status === STATUS_FINISHED && r.timeFinished >= startDate.getTime() && r.timeFinished <= endDate.getTime());
        const assyStats = {};

        reqs.forEach(req => {
            const endTime = req.timeReady || req.timeFinished || req.timestamp;
            const startTime = req.timestamp;
            const durationMs = Math.max(0, endTime - startTime);

            req.items.forEach(item => {
                const assyKey = item.assy.trim().toUpperCase();
                if (!assyStats[assyKey]) {
                    assyStats[assyKey] = { totalMs: 0, count: 0 };
                }
                assyStats[assyKey].totalMs += durationMs;
                assyStats[assyKey].count += 1;
            });
        });

        const assyArray = Object.keys(assyStats).map(key => {
            return { assy: key, avgMs: assyStats[key].totalMs / assyStats[key].count, count: assyStats[key].count };
        });

        assyArray.sort((a, b) => b.avgMs - a.avgMs);

        document.getElementById('stat-assy-total-data').textContent = assyArray.length;
        const statAssyContainer = document.getElementById('stat-assy-times');
        if (assyArray.length === 0) {
            statAssyContainer.innerHTML = `<div class="text-center text-gray-400 text-xs font-bold py-6 bg-gray-50 rounded-xl border border-dashed"><i class="fas fa-box-open mb-2 text-2xl opacity-50 block"></i>Belum ada data Assy yang diselesaikan pada rentang tanggal ini.</div>`;
        } else {
            statAssyContainer.innerHTML = assyArray.map((item, index) => `
                <div class="flex justify-between items-center bg-gray-50 hover:bg-indigo-50/30 transition-colors p-2.5 rounded-lg border border-gray-100 shadow-sm relative overflow-hidden group">
                    ${index < 3 ? '<div class="absolute left-0 top-0 bottom-0 w-1 bg-red-400"></div>' : ''}
                    <div class="flex flex-col pl-2">
                        <span class="font-display font-black text-brand-blue text-sm truncate max-w-[200px] md:max-w-[300px]">${item.assy}</span>
                        <span class="text-[9px] text-gray-500 font-bold mt-0.5"><i class="fas fa-layer-group text-gray-300"></i> Diproses: ${item.count} kali</span>
                    </div>
                    <div class="flex flex-col items-end shrink-0">
                        <span class="font-mono text-xs font-black text-brand-teal bg-teal-50 px-2 py-1 rounded-md border border-teal-100 shadow-inner">
                            ${formatDurationMs(item.avgMs)}
                        </span>
                        <span class="text-[8px] text-gray-400 mt-1 uppercase font-bold text-right hidden md:block">Avg Wait + Process</span>
                    </div>
                </div>
            `).join('');
        }
    }

    document.getElementById('stat-loading').classList.add('hidden');
}

// ============================================================================
// DETEKSI NOTIFIKASI REALTIME
// ============================================================================
let previousReqsState = {};

function checkNewNotifications() {
    if (!currentUser) return;
    let shouldBeep = false;
    let type = 'notification';
    let t = '';
    let b = '';

    const isolatedRequests = db.requests.filter(r => r.systemType === currentUser.section);
    const activeReqs = isolatedRequests.filter(req => req.status !== STATUS_FINISHED);
    const reqs = activeReqs.filter(r => (currentUser.role === 'warehouse' || (r.requestedBy === currentUser.name && r.shift === currentUser.shift)));

    reqs.forEach(req => {
        const prev = previousReqsState[req.id];

        if (!prev) {
            if (currentUser.role === 'warehouse' && req.status === STATUS_WAITING) {
                shouldBeep = true;
                type = req.urgent ? 'urgent' : 'notification';
                t = req.urgent ? 'URGENT!' : 'Request Baru';
                b = `Antrian masuk: ${req.items[0]?.assy}`;
            }
        } else {
            if (prev.status !== STATUS_READY && req.status === STATUS_READY && currentUser.role === 'leader') {
                shouldBeep = true;
                type = 'ready';
                t = 'Part READY!';
                b = `Silakan ambil di gudang: ${req.items[0]?.assy}`;
            }

            if (req.lastSignal !== prev.lastSignal) {
                if (currentUser.role === 'warehouse' && req.lastSignal?.startsWith('waiting_')) {
                    shouldBeep = true;
                    t = 'Ping Line!';
                    b = `Cek antrian: ${req.items[0]?.assy}`;
                } else if (currentUser.role === 'leader' && req.lastSignal?.startsWith('ready_')) {
                    shouldBeep = true;
                    type = 'ready';
                    t = 'Panggilan Gudang!';
                    b = `Antrian siap diambil: ${req.items[0]?.assy}`;
                }
            }

            const prevUnread = (prev.messages || []).filter(m => m.senderRole !== currentUser.role && !m.isRead).length;
            const currUnread = (req.messages || []).filter(m => m.senderRole !== currentUser.role && !m.isRead).length;
            if (currUnread > prevUnread) {
                shouldBeep = true;
                type = 'message';
                t = 'Pesan Baru!';
                b = `Pesan baru di antrian ${req.items[0]?.assy}`;
            }
        }
    });

    previousReqsState = {};
    reqs.forEach(r => {
        previousReqsState[r.id] = JSON.parse(JSON.stringify(r));
    });

    if (shouldBeep) {
        playBeep(type);
        triggerDesktopNotification(t, b);
    }
}

window.onload = initApp;
