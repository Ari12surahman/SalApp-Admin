"use client";


import { createClient } from '@supabase/supabase-js';
import { formatDateID, formatDateTimeID } from '../lib/utils';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "https://placeholder.supabase.co";
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "placeholder";

if (supabaseUrl === "https://placeholder.supabase.co") {
    console.error("Missing Supabase Environment Variables!");
}

const supabase = createClient(supabaseUrl, supabaseKey);

// Helper to fetch all rows from a Supabase table by chunking to bypass the default 1000-row limit
async function fetchAllSupabaseRows(tableName, selectColumns = '*') {
    let allData = [];
    let from = 0;
    const step = 1000;
    while (true) {
        const { data, error } = await supabase
            .from(tableName)
            .select(selectColumns)
            .range(from, from + step - 1);
        if (error) {
            console.error(`Error fetching rows from ${tableName}:`, error);
            break;
        }
        if (!data || data.length === 0) break;
        allData = allData.concat(data);
        if (data.length < step) break;
        from += step;
    }
    return allData;
}

// Helper for saveTableData replacement
async function supabaseSaveTableData(tableName, dataArr) {
    if (!dataArr) return { success: true }; // if undefined, do nothing
    if (dataArr.length === 0) {
        // If array is empty but not undefined, it means user deleted ALL data in this table
        // We should truncate or delete all
        await supabase.from(tableName).delete().neq('id', 'dummy_non_existent'); // deletes all
        return { success: true };
    }

    const cleanData = dataArr.map(row => {
        const cleaned = {};
        for (let k of Object.keys(row)) {
            cleaned[k] = row[k] === '' ? null : (Array.isArray(row[k]) ? JSON.stringify(row[k]) : row[k]);
        }
        return cleaned;
    });

    if (tableName === 'Data Santri') {
        cleanData.forEach(item => {
            if (item.id && typeof item.id === 'string' && isNaN(Number(item.id))) {
                item.id = Math.abs(item.id.split('').reduce((acc, char) => (acc * 31 + char.charCodeAt(0)) % 9000000, 1000000));
            } else if (item.id !== null && item.id !== undefined) {
                item.id = Number(item.id);
            }
            if (item.password !== null && item.password !== undefined && isNaN(Number(item.password))) {
                item.password = 1234;
            } else if (item.password !== null && item.password !== undefined) {
                item.password = Number(item.password);
            }
        });
    }

    let finalData = cleanData;
    if (tableName === 'Data Santri') {
        const seen = new Set();
        finalData = cleanData.map(item => {
            if (!item.nis || item.nis.trim() === '') item.nis = 'AUTO-' + Math.floor(Math.random() * 90000);
            return item;
        }).filter(item => {
            if (seen.has(item.nis)) return false;
            seen.add(item.nis);
            return true;
        });
    }

    if (tableName === 'MasterTagihan') {
        if (!finalData || finalData.length === 0) return { success: true };
        // Upsert aman tanpa menghapus seluruh tabel
        const { error } = await supabase.from('MasterTagihan').upsert(finalData, { onConflict: 'tagihan' });
        if (error) {
            console.error("Gagal upsert MasterTagihan:", error);
            return { success: false, message: error.message };
        }
        return { success: true };
    }

    if (tableName === 'MasterRoleAccess') {
        if (!finalData || finalData.length === 0) return { success: true };
        const { error } = await supabase.from('MasterRoleAccess').upsert(finalData, { onConflict: 'jabatan' });
        if (error) {
            console.error("Gagal upsert MasterRoleAccess:", error);
            return { success: false, message: error.message };
        }
        return { success: true };
    }

    if (tableName === 'MasterConfig') {
        if (!finalData || finalData.length === 0) return { success: true };
        const { error } = await supabase.from('MasterConfig').upsert(finalData, { onConflict: 'kunci' });
        if (error) {
            console.error("Gagal upsert MasterConfig:", error);
            return { success: false, message: error.message };
        }
        return { success: true };
    }

    const fullReplaceTables = ['MasterPeriode', 'MasterJabatan', 'MasterKelas', 'KategoriKas'];
    if (fullReplaceTables.includes(tableName)) {
        const dummyCol = Object.keys(finalData[0] || {})[0];
        if (dummyCol) {
            await supabase.from(tableName).delete().not(dummyCol, 'is', null);
            const { error } = await supabase.from(tableName).insert(finalData);
            if (error) return { success: false, message: error.message };
        }
        return { success: true };
    }

    // Deduplicate before upserting (if duplicate keys exist in the same batch, postgres will fail)
    let uniqueData = cleanData;
    let upsertOptions = undefined;

    if (tableName === 'Data Santri') {
        const seen = new Set();
        uniqueData = cleanData.filter(item => {
            const key = item.id || item.nis;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
        upsertOptions = { onConflict: 'id' };
    } else if (tableName === 'Tabungan') {
        const seen = new Set();
        uniqueData = cleanData.filter(item => {
            if (seen.has(item.id)) return false;
            seen.add(item.id);
            return true;
        });
    }

    // Sync DELETES: delete rows in DB that are missing from uniqueData
    if (uniqueData.length > 0 && uniqueData[0].id) {
        const existingData = await fetchAllSupabaseRows(tableName, 'id');
        if (existingData) {
            const currentIds = new Set(uniqueData.map(r => String(r.id)));
            const toDeleteIds = existingData.filter(r => r.id && !currentIds.has(String(r.id))).map(r => r.id);

            if (toDeleteIds.length > 0) {
                // Delete in chunks of 50 to avoid URL length limits
                for (let i = 0; i < toDeleteIds.length; i += 50) {
                    const chunk = toDeleteIds.slice(i, i + 50);
                    await supabase.from(tableName).delete().in('id', chunk);
                }
            }
        }
    }

    // Upsert in chunks to avoid payload size limits (e.g. Failed to fetch)
    const CHUNK_SIZE = 500;
    for (let i = 0; i < uniqueData.length; i += CHUNK_SIZE) {
        const chunk = uniqueData.slice(i, i + CHUNK_SIZE);
        const { error } = await supabase.from(tableName).upsert(chunk, upsertOptions);
        if (error) return { success: false, message: error.message };
    }
    
    return { success: true };
}

// Helper to generate unique Invoice ID for Tagihan
function generateInvoiceId(tagihan, list) {
    const prefix = String(tagihan || 'TAG').substring(0, 3).toUpperCase();
    const timestamp = Date.now();
    const random = Math.floor(Math.random() * 1000);
    return `INV-${prefix}-${timestamp}-${random}`;
}

// Helper to deterministically sort data (newest first for transactions)
function sortSupabaseData(tableName, data) {
    if (!data) return [];
    if (['Santri', 'Data Santri', 'Pegawai', 'Data Pegawai', 'Admin', 'MasterPeriode', 'MasterJabatan', 'MasterKelas', 'MasterTagihan'].includes(tableName)) {
        return data.reverse(); // keep legacy behavior for masters
    }
    
    return data.sort((a, b) => {
        const dateA = a.tanggal || a.Waktu || a.WaktuPengajuan || '';
        const dateB = b.tanggal || b.Waktu || b.WaktuPengajuan || '';
        if (dateA !== dateB) return dateB.localeCompare(dateA);
        
        const getTs = (id) => {
            if (!id) return 0;
            const pts = String(id).split('-');
            const ts = pts.find(p => p.length === 13 && !isNaN(p));
            return ts ? parseInt(ts) : 0;
        };
        const tsA = getTs(a.id || a.TrxID || a.IDPencairan);
        const tsB = getTs(b.id || b.TrxID || b.IDPencairan);
        if (tsA !== tsB) return tsB - tsA;
        
        return String(b.id || b.TrxID || '').localeCompare(String(a.id || a.TrxID || ''));
    });
}

// Helper hitung saldo berjalan (running balance) per transaksi tabungan
function computeRunningBalanceMap(dataTabungan) {
    const byNis = {};
    (dataTabungan || []).forEach(t => {
        const rawNis = String(t.nis || t.NIS || '').trim();
        const clean = rawNis.replace(/^0+/, '') || rawNis;
        if (!byNis[clean]) byNis[clean] = [];
        byNis[clean].push(t);
    });

    const getTrxTime = (trx) => {
        if (trx.id) {
            const match = String(trx.id).match(/\d{13}/);
            if (match) return Number(match[0]);
        }
        if (trx.tanggal) {
            const d = new Date(trx.tanggal).getTime();
            if (!isNaN(d)) return d;
        }
        return 0;
    };

    const map = {};
    Object.keys(byNis).forEach(nisKey => {
        const list = byNis[nisKey];
        list.sort((a, b) => {
            const tA = getTrxTime(a);
            const tB = getTrxTime(b);
            if (tA !== tB) return tA - tB;
            return String(a.id || '').localeCompare(String(b.id || ''));
        });

        let running = 0;
        list.forEach(item => {
            const nom = Number(item.nominal || item.Nominal || 0);
            const j = String(item.jenis || item.Jenis || '').toLowerCase().trim();
            const isWithdraw = j === 'tarik' || j === 'keluar' || j.includes('tarik') || j.includes('keluar') || j === 'debet' || j === 'debit';
            if (isWithdraw) {
                running -= nom;
            } else {
                running += nom;
            }
            map[item.id] = running;
        });
    });

    return map;
}

// --- HELPER PERHITUNGAN POTONGAN PENCAIRAN (MOU) ---
function getPeriodeBulanKey(dateStr) {
    if (!dateStr) {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    }
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) {
        const now = new Date();
        return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    }
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function getWarungMonthlyFeeStatus(warungId, periodeBulan, feeHistory = {}, feeConfig = {}) {
    const defaultAplikasi = feeConfig && feeConfig.biayaAplikasi !== undefined ? Number(feeConfig.biayaAplikasi) : 30000;
    const defaultKader = feeConfig && feeConfig.biayaKader !== undefined ? Number(feeConfig.biayaKader) : 200000;
    
    const custom = (feeConfig && feeConfig.warungConfig && feeConfig.warungConfig[warungId]) || {};
    const targetAplikasi = custom.biayaAplikasi !== undefined ? Number(custom.biayaAplikasi) : defaultAplikasi;
    const targetKader = custom.biayaKader !== undefined ? Number(custom.biayaKader) : defaultKader;
    const targetTotal = targetAplikasi + targetKader;

    let terbayarAplikasi = 0;
    let terbayarKader = 0;

    Object.values(feeHistory || {}).forEach(h => {
        if (h && String(h.warungId) === String(warungId) && h.periodeBulan === periodeBulan) {
            terbayarAplikasi += Number(h.potonganAplikasi || 0);
            terbayarKader += Number(h.potonganKader || 0);
        }
    });

    const sisaAplikasi = Math.max(0, targetAplikasi - terbayarAplikasi);
    const sisaKader = Math.max(0, targetKader - terbayarKader);
    const totalSisa = sisaAplikasi + sisaKader;

    return {
        targetAplikasi,
        targetKader,
        targetTotal,
        terbayarAplikasi,
        terbayarKader,
        totalTerbayar: terbayarAplikasi + terbayarKader,
        sisaAplikasi,
        sisaKader,
        totalSisa,
        isLunas: totalSisa === 0
    };
}

function calculateSafeDeduction(totalDana, sisaAplikasi, sisaKader, maxPotongPersen = 50) {
    const dana = Number(totalDana || 0);
    const maxDeduct = Math.floor(dana * (Number(maxPotongPersen || 50) / 100));
    const totalSisa = sisaAplikasi + sisaKader;

    if (totalSisa <= maxDeduct) {
        return {
            potongAplikasi: sisaAplikasi,
            potongKader: sisaKader,
            totalPotongan: totalSisa,
            totalBersih: Math.max(0, dana - totalSisa),
            maxDeduct
        };
    }

    const potongAplikasi = Math.min(sisaAplikasi, maxDeduct);
    const remainingBudget = Math.max(0, maxDeduct - potongAplikasi);
    const potongKader = Math.min(sisaKader, remainingBudget);
    const totalPotongan = potongAplikasi + potongKader;

    return {
        potongAplikasi,
        potongKader,
        totalPotongan,
        totalBersih: Math.max(0, dana - totalPotongan),
        maxDeduct
    };
}

import React, { useState, useEffect, useRef, useCallback } from "react";


// Import Lucide Icons
import {
    LayoutDashboard, Users, CreditCard, Wallet, TrendingUp, AlertCircle, Plus, Search, Filter, Bell,
    User, X, Trash2, Settings, FileSpreadsheet, FileText, BadgePercent, Zap, ArrowDownCircle,
    ArrowUpCircle, Edit, Printer, CheckCircle2, BarChart3, History, Activity, QrCode, Link as LinkIcon,
    Copy, ExternalLink, RefreshCw, Check, Briefcase, BookOpen, DownloadCloud, TrendingDown, Menu, ArrowRight, ArrowLeft, Eye, EyeOff, ChevronRight, Scan, Download,
    SlidersHorizontal, ShieldAlert, ShieldCheck, ShoppingBag, Store, CalendarDays, Package,
    Coins, Scissors, HandHeart, Building2, Key
} from "lucide-react";

// Import Recharts dengan parameter bundle untuk mencegah error lodash missing modules
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from "recharts";
import * as XLSX from "xlsx";

// Helper nama bank Pakasir v2
const getBankDisplayName = (method) => {
    const map = {
        bri_va: 'BRI Virtual Account',
        bni_va: 'BNI Virtual Account',
        bsi_va: 'BSI Virtual Account',
        cimb_niaga_va: 'CIMB Niaga VA',
        danamon_va: 'Danamon VA',
        muamalat_va: 'Muamalat VA',
        ocbc_va: 'OCBC VA',
        maybank_va: 'Maybank VA',
        bnc_va: 'Bank Neo Commerce (BNC)',
        qris: 'QRIS',
        payment_link: 'Payment Link'
    };
    return map[method] || String(method || '').replace('_va', ' VA').toUpperCase();
};

// --- CSS Classes (Stitch Design Taste) ---
const inputBase = "w-full rounded-xl border border-whisper bg-surface px-4 py-2.5 text-sm text-ink focus:outline-none focus:border-accent focus:ring-2 focus:ring-accent/20 transition-all duration-200";
const btnPrimary = "bg-accent hover:bg-accentDark active:scale-[0.98] text-white rounded-xl px-5 py-2.5 font-semibold flex items-center justify-center gap-2 transition-all duration-200 shrink-0 text-sm shadow-sm";
const btnOutline = "bg-surface hover:bg-canvas text-ink border border-whisper rounded-xl px-5 py-2.5 font-medium flex items-center justify-center gap-2 transition-all duration-200 shrink-0 text-sm";
const btnDanger = "bg-dangerBg hover:bg-red-100 text-danger border border-red-200 rounded-xl px-5 py-2.5 font-medium flex items-center justify-center gap-2 transition-all duration-200 shrink-0 text-sm";
const btnGhost = "bg-transparent hover:bg-canvas text-steel rounded-xl px-3 py-2 text-sm transition-colors";

// --- KOMPONEN FORM WRAPPER ---
const FormWrapper = ({ title, onClose, onSubmit, children, customFooter }) => (
    <div className="fixed inset-0 z-[100] flex items-end sm:items-center justify-center p-0 sm:p-4 bg-ink/20 backdrop-blur-[3px]">
        <div className="bg-surface rounded-t-[1.5rem] sm:rounded-card border border-whisper w-full max-w-lg flex flex-col max-h-[90vh] relative shadow-diffused animate-fade-in-up">
            <button type="button" onClick={onClose} className="absolute top-5 right-5 z-[200] w-8 h-8 flex items-center justify-center rounded-lg bg-transparent text-steel hover:text-ink hover:bg-canvas transition-colors" style={{ cursor: 'pointer', pointerEvents: 'auto' }}>
                <X className="w-5 h-5" />
            </button>
            <div className="px-6 sm:px-8 py-5 sm:py-6 border-b border-whisper pr-14 shrink-0"><h3 className="font-bold text-ink tracking-tight text-lg">{title}</h3></div>
            <form onSubmit={onSubmit} className="flex flex-col overflow-hidden flex-1">
                <div className="p-6 sm:p-8 overflow-y-auto space-y-5">{children}</div>
                {customFooter ? customFooter : (
                    <div className="px-6 sm:px-8 py-4 bg-canvas border-t border-whisper flex justify-end gap-3 shrink-0 rounded-b-none sm:rounded-b-card">
                        <button type="button" onClick={onClose} className={btnOutline}>Batal</button>
                        <button type="submit" className={btnPrimary}>Simpan Data</button>
                    </div>
                )}
            </form>
        </div>
    </div>
);

// --- KOMPONEN COMBOBOX SMART ---
const SantriCombobox = ({ dataSantri, formData, setFormData, disabled, isPegawai = false, dataPegawai = [] }) => {
    const [isOpen, setIsOpen] = useState(false);
    const [search, setSearch] = useState('');

    const dataList = isPegawai ? dataPegawai : dataSantri;
    const idField = isPegawai ? 'nip' : 'nis';
    const selected = dataList.find(s => String(s[idField]) === String(formData[idField]));

    useEffect(() => { if (selected) setSearch(`${selected[idField]} - ${selected.nama}`); else if (!formData[idField]) setSearch(''); }, [selected, formData[idField], idField]);
    const filtered = dataList.filter(s => (s.nama || '').toLowerCase().includes((search || '').toLowerCase()) || String(s[idField] || '').includes(search));

    return (
        <div className="relative">
            <div className="relative"><Search className="w-4 h-4 absolute left-3 top-3 text-steel" /><input type="text" placeholder={`Ketik & cari nama atau ${idField.toUpperCase()}...`} className={`${inputBase} pl-9`} value={search} disabled={disabled} onChange={(e) => { setSearch(e.target.value); setIsOpen(true); if (formData[idField]) setFormData(prev => ({ ...prev, [idField]: '', selectedTagihanBayar: [], nominal: '' })); }} onFocus={() => setIsOpen(true)} onBlur={() => setTimeout(() => setIsOpen(false), 200)} /></div>
            {isOpen && !disabled && (
                <div className="absolute z-[300] w-full mt-1 bg-white border border-whisper rounded-lg shadow-diffused max-h-48 overflow-y-auto">
                    {filtered.length > 0 ? filtered.map(s => (
                        <div key={s.id} className="px-3 py-2 text-sm hover:bg-blue-50 cursor-pointer border-b border-slate-50 last:border-0" onMouseDown={(e) => { e.preventDefault(); setFormData(prev => ({ ...prev, [idField]: s[idField], selectedTagihanBayar: [], nominal: '' })); setSearch(`${s[idField]} - ${s.nama}`); setIsOpen(false); }}>
                            <div className="font-medium text-ink">{s.nama}</div><div className="text-xs text-steel">{idField.toUpperCase()}: {s[idField]} • {isPegawai ? s.jabatan : s.kelas}</div>
                        </div>
                    )) : (<div className="px-3 py-2 text-sm text-steel text-center">Data tidak ditemukan</div>)}
                </div>
            )}
        </div>
    );
};

// --- MOCK DATA AWAL ---
const initialSantri = [];
const initialPegawai = [];
const initialTagihan = [];
const initialPembayaran = [];
const initialTabungan = [];
const initialKas = [];
const initialGaji = [];
const initialLogs = [];

function App() {
    const formatPeriodeStr = (p) => {
        if (!p) return "";
        return String(p).replace(/^(jan|feb|mar|apr|mei|jun|jul|agu|sep|okt|nov|des)[a-z]* /i, '$1 ').trim();
    };
    const [activeTab, setActiveTab] = useState('dashboard');
    const [showMobileMenu, setShowMobileMenu] = useState(false);

    const [dataSantri, setDataSantri] = useState(initialSantri);
    const [dataPegawai, setDataPegawai] = useState(initialPegawai);
    const [dataTagihan, setDataTagihan] = useState(initialTagihan);
    const [dataPembayaran, setDataPembayaran] = useState(initialPembayaran);
    const [dataTabungan, setDataTabungan] = useState(initialTabungan);
    const [dataKas, setDataKas] = useState(initialKas);
    const [dataGaji, setDataGaji] = useState(initialGaji);
    const [dataLog, setDataLog] = useState(initialLogs);

    // === AUTH & LOGIN STATE (persist via localStorage) ===
    const [isLoggedIn, setIsLoggedIn] = useState(false);
    const [currentUser, setCurrentUser] = useState(null);
    const [mounted, setMounted] = useState(false);

    useEffect(() => {
        setMounted(true);
        try {
            setIsLoggedIn(JSON.parse(localStorage.getItem('_auth_loggedIn')) || false);
            setCurrentUser(JSON.parse(localStorage.getItem('_auth_user')) || null);
        } catch (e) { }
    }, []);

    const [loginMode, setLoginMode] = useState('admin');
    const [loginError, setLoginError] = useState('');
    const [selectedIds, setSelectedIds] = useState([]);

    // === ADMIN, CONFIG, RBAC DATA ===
    const [dataAdmin, setDataAdmin] = useState([{ id: 'ADM-1', username: 'admin', nama: 'Super Admin', password: 'admin123', role: 'superadmin' }]);
    const [appConfig, setAppConfig] = useState({ appName: 'PesantrenTech', appLogo: '' });
    const [dataRoleAccess, setDataRoleAccess] = useState([]);
    const [settingsTab, setSettingsTab] = useState('branding');
    const [backupList, setBackupList] = useState([]);
    const [loadingBackups, setLoadingBackups] = useState(false);

    const [modalType, setModalType] = useState(null);
    const [formData, setFormData] = useState({});
    const [searchTerm, setSearchTerm] = useState('');
    const [currentPage, setCurrentPage] = useState(1);
    const [tabunganSubTab, setTabunganSubTab] = useState('transaksi'); // 'transaksi' | 'limit' | 'iuran'
    // --- IURAN & KAS INSIDENTAL (POTONG OTOMATIS) ---
    const defaultMasterInsidental = [
        { id: 'Kas Kamar', label: 'Kas Kamar', icon: 'Building2', defaultNom: 10000, desc: 'Iuran kas kamar asrama', alokasiDefault: 'KasKamar', targetDefault: 'Kamar' },
        { id: 'Kas Kelas', label: 'Kas Kelas', icon: 'Users', defaultNom: 5000, desc: 'Uang kas kelas santri', alokasiDefault: 'BukuKas', targetDefault: 'Kelas' },
        { id: 'Infaq / Sedekah', label: 'Infaq', icon: 'HandHeart', defaultNom: 2000, desc: 'Jumat berkah / amal santri', alokasiDefault: 'BukuKas', targetDefault: 'Semua' },
        { id: 'Cukur', label: 'Cukur Santri', icon: 'Scissors', defaultNom: 15000, desc: 'Jasa tukang cukur', alokasiDefault: 'BukuKas', targetDefault: 'Kelas' },
        { id: 'Kegiatan', label: 'Kegiatan / Ekstra', icon: 'Zap', defaultNom: 20000, desc: 'Iuran lomba / kegiatan', alokasiDefault: 'BukuKas', targetDefault: 'Kelas' }
    ];
    const [showModalMasterInsidental, setShowModalMasterInsidental] = useState(false);
    const [formMasterKat, setFormMasterKat] = useState({ id: '', label: '', defaultNom: 10000, desc: '', alokasiDefault: 'BukuKas', targetDefault: 'Kelas' });
    const [iuranSelectedKamarNis, setIuranSelectedKamarNis] = useState('');
    const [iuranKategori, setIuranKategori] = useState('Kas Kamar');
    const [iuranTargetType, setIuranTargetType] = useState('Kamar'); // 'Kamar' | 'Kelas' | 'PilihSantri' | 'Semua'
    const [iuranSelectedKelas, setIuranSelectedKelas] = useState('');
    const [iuranSelectedNisList, setIuranSelectedNisList] = useState([]);
    const [iuranNominal, setIuranNominal] = useState(10000);
    const [iuranKeterangan, setIuranKeterangan] = useState('Kas Kamar');
    const [iuranAlokasi, setIuranAlokasi] = useState('KasKamar'); // 'BukuKas' | 'KasKamar' | 'None'
    const [iuranTujuanAkunNis, setIuranTujuanAkunNis] = useState('');
    const [iuranSkipInsufficient, setIuranSkipInsufficient] = useState(true);
    const [iuranSearchSantri, setIuranSearchSantri] = useState('');
    const [iuranProcessing, setIuranProcessing] = useState(false);
    const [iuranHasilEksekusi, setIuranHasilEksekusi] = useState(null);
    const [iuranRiwayatFilter, setIuranRiwayatFilter] = useState('Semua');
    const [iuranRiwayatSearch, setIuranRiwayatSearch] = useState('');
    const [showModalBuatAkunKamar, setShowModalBuatAkunKamar] = useState(false);
    const [namaKamarBaru, setNamaKamarBaru] = useState('');
    const [kelasKamarBaru, setKelasKamarBaru] = useState('');
    const [uidKamarBaru, setUidKamarBaru] = useState('');
    const [pinKamarBaru, setPinKamarBaru] = useState('123456');
    const [modalEditPinKamar, setModalEditPinKamar] = useState(null); // { nis, nama, pin }
    const [inputPinEdit, setInputPinEdit] = useState('');
    const [modalEditRfidKamar, setModalEditRfidKamar] = useState(null); // { nis, nama, uid }
    const [inputRfidEdit, setInputRfidEdit] = useState('');
    const [inputRfidDirect, setInputRfidDirect] = useState('');
    const [tabunganKelasFilter, setTabunganKelasFilter] = useState('Semua');
    // --- EDIT RIWAYAT PEMOTONGAN KAS & INFAQ ---
    const [modalEditRiwayatInsidental, setModalEditRiwayatInsidental] = useState(false);
    const [formEditRiwayatInsidental, setFormEditRiwayatInsidental] = useState({
        id: '',
        nama: '',
        nis: '',
        tanggal: '',
        jenis: '',
        nominal: 0,
        keterangan: ''
    });
    // --- DETAIL TABUNGAN POS ---
    const [detailTabunganModal, setDetailTabunganModal] = useState(null); // { trx, detailItems, warungName, loading }
    // --- REKAP PENCAIRAN PER WARUNG ---
    const [pencairanSubTab, setPencairanSubTab] = useState('daftar'); // 'daftar' | 'rekap'
    const [rekapPeriode, setRekapPeriode] = useState('harian'); // 'harian' | 'mingguan' | 'bulanan' | 'custom'
    const [rekapStartDate, setRekapStartDate] = useState(() => {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    });
    const [rekapEndDate, setRekapEndDate] = useState(() => {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    });
    const [rekapData, setRekapData] = useState([]);
    const [loadingRekap, setLoadingRekap] = useState(false);
    const [rekapWarungSubTab, setRekapWarungSubTab] = useState({}); // { [warungId]: 'santri' | 'hari' }
    const [rekapSearchSantri, setRekapSearchSantri] = useState({}); // { [warungId]: string }
    const [rekapFilterTanggal, setRekapFilterTanggal] = useState({}); // { [warungId]: string }
    const [rekapPagePerWarung, setRekapPagePerWarung] = useState({}); // { [warungId]: number }
    const [limitModalData, setLimitModalData] = useState({
        targetType: 'Semua', // 'Semua' | 'Kelas' | 'Santri'
        selectedKelas: '',
        selectedNis: '',
        nominal: '',
        periode: 'harian'
    });
    
    useEffect(() => {
        setCurrentPage(1);
    }, [activeTab, searchTerm]);
    
    const [notification, setNotification] = useState(null);
    const [scanResult, setScanResult] = useState(null);
    const [scanInput, setScanInput] = useState('');
    const scanInputRef = useRef(null);

    const fetchBackups = async () => {
        setLoadingBackups(true);
        try {
            const res = await fetchGasAPI('getBackups');
            if (res && res.success) {
                setBackupList(res.data || []);
            } else {
                showNotification('Gagal memuat backup: ' + (res?.error || 'Unknown error'));
            }
        } catch (e) {
            showNotification('Error jaringan saat memuat backup');
        }
        setLoadingBackups(false);
    };

    const forceBackup = async () => {
        setLoadingBackups(true);
        showNotification('Sedang memproses backup... mohon tunggu');
        try {
            const res = await fetchGasAPI('forceBackup');
            if (res && res.success) {
                showNotification('Backup harian berhasil dibuat secara manual!');
                fetchBackups();
            } else {
                showNotification('Gagal membuat backup: ' + (res?.error || 'Cek koneksi/deployment'));
            }
        } catch (e) {
            showNotification('Error jaringan saat membuat backup');
        }
        setLoadingBackups(false);
    };
    const [confirmDialog, setConfirmDialog] = useState(null);
    const [pakasirData, setPakasirData] = useState({ step: 'CHOOSE_METHOD', method: '', qrString: null, loading: false, url: '', isPaid: false, checkoutUrl: '' });
    const [pakasirTimeLeft, setPakasirTimeLeft] = useState(900);

    useEffect(() => {
        let timer;
        if ((pakasirData.step === 'SHOW_QR' || pakasirData.step === 'SHOW_VA') && pakasirTimeLeft > 0) {
            timer = setInterval(() => {
                setPakasirTimeLeft(prev => prev - 1);
            }, 1000);
        } else if (pakasirTimeLeft <= 0 && (pakasirData.step === 'SHOW_QR' || pakasirData.step === 'SHOW_VA')) {
            clearInterval(timer);
        }
        return () => clearInterval(timer);
    }, [pakasirData.step, pakasirTimeLeft]);

    const [masterPeriodeList, setMasterPeriodeList] = useState(['2022/2023', '2023/2024', '2024/2025']);
    const [masterKelasList, setMasterKelasList] = useState(['10A', '10B', '11A', '11B', '12A']);
    const [masterTagihanList, setMasterTagihanList] = useState([]);
    const [kategoriKas, setKategoriKas] = useState({ pemasukan: ['Dana BOS', 'Sumbangan', 'Lainnya'], pengeluaran: ['Operasional', 'Sarana Prasarana', 'Kesehatan', 'Lainnya'] });
    const [masterJabatanList, setMasterJabatanList] = useState(['Kepala Sekolah', 'Pengajar', 'Administrasi', 'Dapur', 'Kebersihan']);
    const listBulan = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];

    // Helper normalisasi nama bulan
    const normalizeMonth = (m) => {
        if (!m) return '';
        const clean = String(m).trim().toLowerCase();
        const idx = listBulan.findIndex(b => b.toLowerCase().startsWith(clean.substring(0, 3)));
        return idx >= 0 ? listBulan[idx] : m;
    };

    // Helper pencocokan nama tagihan (termasuk alias seperti 'SPP' dan 'SPP Bulanan')
    const isTagihanMatch = (t1, t2) => {
        if (!t1 || !t2) return false;
        const a = String(t1).trim().toLowerCase();
        const b = String(t2).trim().toLowerCase();
        if (a === b) return true;
        const isSppA = a === 'spp' || a === 'spp bulanan';
        const isSppB = b === 'spp' || b === 'spp bulanan';
        if (isSppA && isSppB) return true;
        return false;
    };

    // Helper mengekstrak seluruh bulan dan tahun dari string periode (misal: 'Juli 2026', 'Juli - September 2026')
    const parsePeriodeMonthsAndYear = (periodeStr) => {
        if (!periodeStr) return { months: [], year: null };
        const p = String(periodeStr).trim();
        const yearMatch = p.match(/\b(20\d{2})\b/);
        const year = yearMatch ? parseInt(yearMatch[1], 10) : null;

        const rangeMatch = p.match(/([a-zA-Z]+)\s*-\s*([a-zA-Z]+)/);
        if (rangeMatch) {
            const m1 = normalizeMonth(rangeMatch[1]);
            const m2 = normalizeMonth(rangeMatch[2]);
            const i1 = listBulan.indexOf(m1);
            const i2 = listBulan.indexOf(m2);
            if (i1 >= 0 && i2 >= 0) {
                const start = Math.min(i1, i2);
                const end = Math.max(i1, i2);
                const months = listBulan.slice(start, end + 1);
                return { months, year };
            }
        }

        for (const b of listBulan) {
            if (new RegExp('\\b' + b.substring(0, 3), 'i').test(p)) {
                return { months: [b], year };
            }
        }

        return { months: [], year };
    };

    // Helper komprehensif mengecek apakah tagihan santri untuk periode tertentu sudah ada di Tagihan atau sudah Lunas di Pembayaran
    const checkBillStatus = (targetTagihan, targetPembayaran, nis, tagihanName, bln, thn) => {
        const cleanNis = String(nis || '').trim().replace(/^0+/, '');
        const targetBln = normalizeMonth(bln);
        const targetThn = thn ? parseInt(thn, 10) : null;

        // 1. Cek di daftar Tagihan (tagihan yang masih aktif belum lunas / cicilan)
        const existingTagihan = (targetTagihan || []).find(t => {
            if (String(t.nis || '').trim().replace(/^0+/, '') !== cleanNis) return false;
            if (!isTagihanMatch(t.tagihan, tagihanName)) return false;
            const { months, year } = parsePeriodeMonthsAndYear(t.periode);
            if (targetThn && year && year !== targetThn) return false;
            return months.includes(targetBln);
        });

        if (existingTagihan) {
            return {
                status: 'IN_TAGIHAN',
                tagihan: existingTagihan,
                message: `Tagihan ${existingTagihan.tagihan} (${existingTagihan.periode}) sudah ada di daftar Tagihan (Status: ${existingTagihan.status || 'Belum Lunas'}).`
            };
        }

        // 2. Cek di daftar Pembayaran (riwayat pembayaran yang sudah Lunas)
        for (const p of (targetPembayaran || [])) {
            if (String(p.nis || '').trim().replace(/^0+/, '') !== cleanNis) continue;
            if (p.status && String(p.status).toLowerCase().includes('cicil')) continue;

            let items = [];
            if (p.items) {
                try {
                    items = typeof p.items === 'string' ? JSON.parse(p.items) : p.items;
                } catch (e) {}
            }

            if (Array.isArray(items) && items.length > 0) {
                const matchItem = items.find(it => {
                    if (!isTagihanMatch(it.tagihan, tagihanName)) return false;
                    const { months, year } = parsePeriodeMonthsAndYear(it.periode);
                    if (targetThn && year && year !== targetThn) return false;
                    return months.includes(targetBln);
                });
                if (matchItem) {
                    return {
                        status: 'ALREADY_PAID',
                        pembayaran: p,
                        message: `Tagihan ${matchItem.tagihan} (${matchItem.periode}) SUDAH LUNAS dibayar pada transaksi ${p.id} (${p.tanggal || ''}).`
                    };
                }
            } else {
                if (isTagihanMatch(p.tagihan, tagihanName)) {
                    const { months, year } = parsePeriodeMonthsAndYear(p.periode);
                    if ((!targetThn || !year || year === targetThn) && months.includes(targetBln)) {
                        return {
                            status: 'ALREADY_PAID',
                            pembayaran: p,
                            message: `Tagihan ${p.tagihan} (${p.periode}) SUDAH LUNAS dibayar pada transaksi ${p.id} (${p.tanggal || ''}).`
                        };
                    }
                }
            }
        }

        return { status: 'AVAILABLE' };
    };

    const [periodeAktif, setPeriodeAktif] = useState('Semua');
    const [masterTagihanFilter, setMasterTagihanFilter] = useState('Semua Tagihan');
    const [isLoaded, setIsLoaded] = useState(false);

    // All sidebar menu items (for RBAC)
    const allMenuItems = [
        { id: 'dashboard', icon: LayoutDashboard, label: 'Dashboard' },
        { id: 'santri', icon: Users, label: 'Data Santri' },
        { id: 'pegawai', icon: Briefcase, label: 'Data Pegawai' },
        { id: 'tagihan', icon: FileText, label: 'Tagihan Santri' },
        { id: 'pembayaran', icon: CreditCard, label: 'Pembayaran' },
        { id: 'tabungan', icon: Zap, label: 'Tabungan Santri' },
        { id: 'penggajian', icon: ArrowUpCircle, label: 'Penggajian' },
        { id: 'bukukas', icon: BookOpen, label: 'Buku Kas' },
        { id: 'pencairan', icon: Wallet, label: 'Pencairan Warung' },
        { id: 'log', icon: History, label: 'Log Aktivitas' },
        { id: 'pengaturan', icon: Settings, label: 'Pengaturan' },
    ];

    // Filter menu by user role
    const getVisibleMenus = () => {
        if (!currentUser) return [];
        if (currentUser.role === 'superadmin') return allMenuItems;
        const roleAccess = dataRoleAccess.find(r => r.jabatan === currentUser.jabatan);
        if (!roleAccess || !roleAccess.aksesMenu) return allMenuItems.filter(m => m.id === 'dashboard');
        const allowedIds = typeof roleAccess.aksesMenu === 'string' ? roleAccess.aksesMenu.split(',') : roleAccess.aksesMenu;
        return allMenuItems.filter(m => allowedIds.includes(m.id) || m.id === 'dashboard');
    };

    // === LOGIN HANDLER ===
    const handleLogin = (e) => {
        e.preventDefault();
        const username = formData.loginUser?.trim();
        const password = formData.loginPass?.trim();
        if (!username || !password) { setLoginError('Isi username/NIP dan password.'); return; }

        // Check Admin
        const adminFound = dataAdmin.find(a => a.username === username && String(a.password) === String(password));
        if (adminFound) {
            const user = { id: adminFound.id, nama: adminFound.nama, role: 'superadmin', jabatan: 'Super Admin' };
            setCurrentUser(user); setIsLoggedIn(true);
            try { localStorage.setItem('_auth_loggedIn', 'true'); localStorage.setItem('_auth_user', JSON.stringify(user)); } catch { }
            setLoginError('');
            setFormData({});
            addLog('LOGIN', 'AUTH', `Admin "${adminFound.nama}" berhasil masuk.`);
            return;
        }

        // Check Pegawai
        const pegawaiFound = dataPegawai.find(p => String(p.nip) === String(username) && String(p.password) === String(password));
        if (pegawaiFound) {
            const user = { id: pegawaiFound.id, nama: pegawaiFound.nama, role: 'pegawai', jabatan: pegawaiFound.jabatan, nip: pegawaiFound.nip };
            setCurrentUser(user); setIsLoggedIn(true);
            try { localStorage.setItem('_auth_loggedIn', 'true'); localStorage.setItem('_auth_user', JSON.stringify(user)); } catch { }
            setLoginError('');
            setFormData({});
            addLog('LOGIN', 'AUTH', `Pegawai "${pegawaiFound.nama}" berhasil masuk.`);
            return;
        }

        setLoginError('Username/NIP atau password salah.');
    };

    const handleLogout = () => {
        addLog('LOGOUT', 'AUTH', `"${currentUser?.nama}" keluar dari sistem.`);
        setIsLoggedIn(false);
        setCurrentUser(null);
        setActiveTab('dashboard');
        setFormData({});
        setSelectedIds([]);
        try { localStorage.removeItem('_auth_loggedIn'); localStorage.removeItem('_auth_user'); } catch { }
    };

    // === BULK DELETE ===
    const toggleSelectId = (id) => setSelectedIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
    const toggleSelectAll = (ids) => setSelectedIds(prev => ids.every(id => prev.includes(id)) ? prev.filter(x => !ids.includes(x)) : [...new Set([...prev, ...ids])]);
    const executeBulkDelete = (type, setData, label) => {
        if (selectedIds.length === 0) return;
        setConfirmDialog({ type: 'BULK', id: selectedIds, nama: `${selectedIds.length} data ${label}`, bulkType: type, bulkSetData: setData });
    };

    // === INTEGRASI GOOGLE SHEETS: MUAT DATA AWAL ===
    useEffect(() => {
        if (true) {

            (async () => {
                try {
                    const tables = ['Santri', 'Pegawai', 'Admin', 'Tagihan', 'Pembayaran', 'Tabungan', 'Kas', 'Gaji', 'Logs', 'MasterPeriode', 'MasterJabatan', 'MasterKelas', 'MasterTagihan', 'MasterConfig', 'KategoriKas', 'MasterRoleAccess'];
                    const result = {};
                    for (const t of tables) {
                        let actualT = t;
                        if (t === 'Santri') actualT = 'Data Santri';
                        if (t === 'Pegawai') actualT = 'Data Pegawai';

                        const data = await fetchAllSupabaseRows(actualT);
                        result[t] = data ? sortSupabaseData(actualT, data) : [];
                    }
                    const jsonString = JSON.stringify(result);

                    try {
                        const data = JSON.parse(jsonString);
                        if (data.Santri && data.Santri.length > 0) setDataSantri(data.Santri);
                        if (data.Pegawai && data.Pegawai.length > 0) setDataPegawai(data.Pegawai);
                        if (data.Tagihan && data.Tagihan.length > 0) setDataTagihan(data.Tagihan.filter(t => String(t.status || '').trim().toLowerCase() !== 'lunas'));
                        if (data.Pembayaran && data.Pembayaran.length > 0) setDataPembayaran(data.Pembayaran);
                        if (data.Tabungan && data.Tabungan.length > 0) setDataTabungan(data.Tabungan);
                        if (data.Kas && data.Kas.length > 0) setDataKas(data.Kas);
                        if (data.Gaji && data.Gaji.length > 0) setDataGaji(data.Gaji);
                        if (data.Logs && data.Logs.length > 0) setDataLog(data.Logs);
                        // Muat Master Periode dari Spreadsheet & sinkronkan dengan santri
                        let loadedPeriode = (data.MasterPeriode && data.MasterPeriode.length > 0)
                            ? data.MasterPeriode.map(item => item.periode).filter(Boolean)
                            : ['2022/2023', '2023/2024', '2024/2025'];
                        if (data.Santri && data.Santri.length > 0) {
                            const pSet = new Set(loadedPeriode.map(p => p.toLowerCase().trim()));
                            data.Santri.forEach(s => {
                                const p = (s.periode || '').trim();
                                if (p && !pSet.has(p.toLowerCase())) {
                                    loadedPeriode.push(p);
                                    pSet.add(p.toLowerCase());
                                }
                            });
                        }
                        setMasterPeriodeList(loadedPeriode);

                        // Muat Master Jabatan dari Spreadsheet & sinkronkan dengan pegawai
                        let loadedJabatan = (data.MasterJabatan && data.MasterJabatan.length > 0)
                            ? data.MasterJabatan.map(item => item.jabatan).filter(Boolean)
                            : ['Kepala Sekolah', 'Pengajar', 'Administrasi', 'Dapur', 'Kebersihan'];
                        if (data.Pegawai && data.Pegawai.length > 0) {
                            const jSet = new Set(loadedJabatan.map(j => j.toLowerCase().trim()));
                            data.Pegawai.forEach(p => {
                                const j = (p.jabatan || '').trim();
                                if (j && !jSet.has(j.toLowerCase())) {
                                    loadedJabatan.push(j);
                                    jSet.add(j.toLowerCase());
                                }
                            });
                        }
                        setMasterJabatanList(loadedJabatan);

                        // Muat Master Kelas dari Spreadsheet & sinkronkan dengan santri
                        let loadedKelas = (data.MasterKelas && data.MasterKelas.length > 0)
                            ? data.MasterKelas.map(item => item.kelas).filter(Boolean)
                            : ['10A', '10B', '11A', '11B', '12A'];
                        if (data.Santri && data.Santri.length > 0) {
                            const kSet = new Set(loadedKelas.map(k => k.toLowerCase().trim()));
                            data.Santri.forEach(s => {
                                const k = (s.kelas || '').trim();
                                if (k && !kSet.has(k.toLowerCase())) {
                                    loadedKelas.push(k);
                                    kSet.add(k.toLowerCase());
                                }
                            });
                        }
                        setMasterKelasList(loadedKelas);
                        // Muat Master Tagihan dari Database Supabase
                        if (data.MasterTagihan && data.MasterTagihan.length > 0) {
                            setMasterTagihanList(data.MasterTagihan);
                        } else {
                            // Fallback direct query jika batch fetch kosong
                            supabase.from('MasterTagihan').select('*').then(({ data: mtRows, error: mtErr }) => {
                                if (!mtErr && mtRows && mtRows.length > 0) {
                                    setMasterTagihanList(mtRows);
                                }
                            });
                        }
                        // Muat Kategori Kas dari Spreadsheet
                        if (data.KategoriKas && data.KategoriKas.length > 0) {
                            const pemasukan = data.KategoriKas.filter(k => k.tipe === 'pemasukan').map(k => k.kategori).filter(Boolean);
                            const pengeluaran = data.KategoriKas.filter(k => k.tipe === 'pengeluaran').map(k => k.kategori).filter(Boolean);
                            if (pemasukan.length > 0 || pengeluaran.length > 0) setKategoriKas({ pemasukan, pengeluaran });
                        }
                        // Muat Admin
                        if (data.Admin && data.Admin.length > 0) setDataAdmin(data.Admin);
                        // Muat Config
                        if (data.MasterConfig && data.MasterConfig.length > 0) {
                            const cfg = {};
                            data.MasterConfig.forEach(item => { 
                                if (item.kunci) {
                                    try {
                                        cfg[item.kunci] = (typeof item.nilai === 'string' && (item.nilai.startsWith('[') || item.nilai.startsWith('{'))) ? JSON.parse(item.nilai) : item.nilai;
                                    } catch(e) {
                                        cfg[item.kunci] = item.nilai;
                                    }
                                } 
                            });
                            setAppConfig(prev => ({ ...prev, ...cfg }));
                        } else {
                            // Fallback direct query jika batch fetch kosong
                            supabase.from('MasterConfig').select('*').then(({ data: cfgRows }) => {
                                if (cfgRows && cfgRows.length > 0) {
                                    const cfg = {};
                                    cfgRows.forEach(item => {
                                        if (item.kunci) {
                                            try {
                                                cfg[item.kunci] = (typeof item.nilai === 'string' && (item.nilai.startsWith('[') || item.nilai.startsWith('{'))) ? JSON.parse(item.nilai) : item.nilai;
                                            } catch(e) { cfg[item.kunci] = item.nilai; }
                                        }
                                    });
                                    setAppConfig(prev => ({ ...prev, ...cfg }));
                                }
                            });
                        }
                        // Muat Role Access
                        if (data.MasterRoleAccess && data.MasterRoleAccess.length > 0) {
                            setDataRoleAccess(data.MasterRoleAccess.map(r => ({
                                ...r,
                                aksesMenu: typeof r.aksesMenu === 'string' ? r.aksesMenu.split(',').filter(Boolean) : (r.aksesMenu || [])
                            })));
                        } else {
                            // Fallback direct query jika batch fetch kosong
                            supabase.from('MasterRoleAccess').select('*').then(({ data: roleRows }) => {
                                if (roleRows && roleRows.length > 0) {
                                    setDataRoleAccess(roleRows.map(r => ({
                                        ...r,
                                        aksesMenu: typeof r.aksesMenu === 'string' ? r.aksesMenu.split(',').filter(Boolean) : (r.aksesMenu || [])
                                    })));
                                }
                            });
                        }
                        window['lastSync_Santri'] = JSON.stringify(data.Santri || []);
                        window['lastSync_Pegawai'] = JSON.stringify(data.Pegawai || []);
                        window['lastSync_Tagihan'] = JSON.stringify(data.Tagihan || []);
                        window['lastSync_Pembayaran'] = JSON.stringify(data.Pembayaran || []);
                        window['lastSync_Tabungan'] = JSON.stringify(data.Tabungan || []);
                        window['lastSync_Kas'] = JSON.stringify(data.Kas || []);
                        window['lastSync_Gaji'] = JSON.stringify(data.Gaji || []);
                        window['lastSync_Logs'] = JSON.stringify(data.Logs || []);

                    } catch (e) {
                        console.error('Gagal parsing data dari Spreadsheet:', e);
                    }
                    setIsLoaded(true);
                } catch (err) {
                    console.error("Error fetching initial data", err);
                    setIsLoaded(true);
                }
            })();

        } else {
            // Jika bukan di environment Apps Script (misalnya testing lokal)
            setIsLoaded(true);
        }
    }, []);

    // Background Auto-Refresh (Polling)
    useEffect(() => {
        if (!isLoaded) return;
        const interval = setInterval(() => {
            if (true) {

                (async () => {
                    try {
                        const tables = ['Santri', 'Pegawai', 'Admin', 'Tagihan', 'Pembayaran', 'Tabungan', 'Kas', 'Gaji', 'Logs', 'MasterPeriode', 'MasterJabatan', 'MasterKelas', 'MasterTagihan', 'MasterConfig', 'MasterRoleAccess'];
                        const result = {};
                        for (const t of tables) {
                            let actualT = t;
                            if (t === 'Santri') actualT = 'Data Santri';
                            if (t === 'Pegawai') actualT = 'Data Pegawai';

                            const data = await fetchAllSupabaseRows(actualT);
                            result[t] = data ? sortSupabaseData(actualT, data) : [];
                        }
                        const jsonStr = JSON.stringify(result);

                        try {
                            const data = JSON.parse(jsonStr);

                            const updateIfChanged = (sheet, setter) => {
                                const serverStr = JSON.stringify(data[sheet] || []);
                                if (window['lastSync_' + sheet] !== serverStr) {
                                    // Jangan timpa jika ada save yang masih pending atau baru saja menulis
                                    if (window['_pending_' + sheet]) return;
                                    if (window['lastWrite_' + sheet] && Date.now() - window['lastWrite_' + sheet] < 30000) {
                                        return;
                                    }
                                    window['lastSync_' + sheet] = serverStr;
                                    setter(data[sheet] || []);
                                }
                            };

                            updateIfChanged('Santri', setDataSantri);
                            updateIfChanged('Pegawai', setDataPegawai);
                            updateIfChanged('Tagihan', (val) => setDataTagihan((val || []).filter(t => String(t.status || '').trim().toLowerCase() !== 'lunas')));
                            updateIfChanged('Pembayaran', setDataPembayaran);
                            updateIfChanged('Tabungan', setDataTabungan);
                            updateIfChanged('Kas', setDataKas);
                            updateIfChanged('Gaji', setDataGaji);
                            updateIfChanged('MasterTagihan', (val) => {
                                if (Array.isArray(val) && val.length > 0) setMasterTagihanList(val);
                            });
                            updateIfChanged('MasterConfig', (val) => {
                                if (Array.isArray(val) && val.length > 0) {
                                    const cfg = {};
                                    val.forEach(item => {
                                        if (item.kunci) {
                                            try {
                                                cfg[item.kunci] = (typeof item.nilai === 'string' && (item.nilai.startsWith('[') || item.nilai.startsWith('{'))) ? JSON.parse(item.nilai) : item.nilai;
                                            } catch (e) { cfg[item.kunci] = item.nilai; }
                                        }
                                    });
                                    setAppConfig(prev => ({ ...prev, ...cfg }));
                                }
                            });
                            updateIfChanged('MasterRoleAccess', (val) => {
                                if (Array.isArray(val) && val.length > 0) {
                                    setDataRoleAccess(val.map(r => ({
                                        jabatan: r.jabatan,
                                        aksesMenu: typeof r.aksesMenu === 'string' ? r.aksesMenu.split(',').filter(Boolean) : (r.aksesMenu || [])
                                    })));
                                }
                            });
                        } catch (e) { }

                    } catch (err) {
                        console.error("Error fetching initial data", err);
                    }
                })();

            }
        }, 15000); // 15 detik

        // Realtime Subscription untuk Tagihan
        const tagihanChannel = supabase
            .channel('realtime-admin-tagihan')
            .on('postgres_changes', { event: '*', schema: 'public', table: 'Tagihan' }, async () => {
                // Fetch Tagihan terbaru ketika ada event (Insert/Update dari Webhook)
                console.log("[Supabase Real-time] Tagihan berubah, memuat ulang data Tagihan...");
                const data = await fetchAllSupabaseRows('Tagihan');
                if (data) {
                    const activeBills = data.filter(t => String(t.status || '').trim().toLowerCase() !== 'lunas');
                    const sortedData = sortSupabaseData('Tagihan', activeBills);
                    const serverStr = JSON.stringify(sortedData);
                    if (!window['_pending_Tagihan'] && (!window['lastWrite_Tagihan'] || Date.now() - window['lastWrite_Tagihan'] >= 30000)) {
                        window['lastSync_Tagihan'] = serverStr;
                        setDataTagihan(sortedData);
                    }
                }
            })
            .subscribe();

        // Realtime Subscription untuk Data Santri (sinkron jika dihapus/diedit langsung di Supabase)
        const santriChannel = supabase
            .channel('realtime-admin-santri')
            .on('postgres_changes', { event: '*', schema: 'public', table: 'Data Santri' }, async (payload) => {
                console.log("[Supabase Real-time] Data Santri berubah:", payload.eventType);
                if (payload.eventType === 'DELETE') {
                    const oldRow = payload.old || {};
                    setDataSantri(prev => prev.filter(s => {
                        if (oldRow.id && s.id === oldRow.id) return false;
                        if (oldRow.nis && String(s.nis).trim() === String(oldRow.nis).trim()) return false;
                        return true;
                    }));
                } else {
                    const data = await fetchAllSupabaseRows('Data Santri');
                    if (data) {
                        const sorted = sortSupabaseData('Data Santri', data);
                        const serverStr = JSON.stringify(sorted);
                        if (!window['_pending_Santri'] && (!window['lastWrite_Santri'] || Date.now() - window['lastWrite_Santri'] >= 30000)) {
                            window['lastSync_Santri'] = serverStr;
                            setDataSantri(sorted);
                        }
                    }
                }
            })
            .subscribe();

        // Realtime Subscription untuk Tabungan (sinkron saat ada transaksi jajan/top-up)
        const tabunganChannel = supabase
            .channel('realtime-admin-tabungan')
            .on('postgres_changes', { event: '*', schema: 'public', table: 'Tabungan' }, async () => {
                const data = await fetchAllSupabaseRows('Tabungan');
                if (data) {
                    const sortedData = sortSupabaseData('Tabungan', data);
                    const serverStr = JSON.stringify(sortedData);
                    if (!window['_pending_Tabungan'] && (!window['lastWrite_Tabungan'] || Date.now() - window['lastWrite_Tabungan'] >= 30000)) {
                        window['lastSync_Tabungan'] = serverStr;
                        setDataTabungan(sortedData);
                    }
                }
            })
            .subscribe();

        return () => {
            clearInterval(interval);
            supabase.removeChannel(tagihanChannel);
            supabase.removeChannel(santriChannel);
            supabase.removeChannel(tabunganChannel);
        };
    }, [isLoaded]);

    // === INTEGRASI GOOGLE SHEETS: AUTO-SYNC KE SPREADSHEET (DEBOUNCED) ===
    const syncTimers = useRef({});
    const syncToSheet = (sheetName, dataArray) => {
        if (true) {
            const strData = JSON.stringify(dataArray);
            if (window['lastSync_' + sheetName] === strData) return;

            // Set lastWrite SEKARANG untuk melindungi dari polling
            window['lastWrite_' + sheetName] = Date.now();

            // Simpan strData yang akan dikirim, tapi JANGAN update lastSync dulu
            // Baru update lastSync SETELAH server berhasil menyimpan
            const pendingKey = '_pending_' + sheetName;
            window[pendingKey] = strData;

            supabaseSaveTableData(sheetName === 'Santri' ? 'Data Santri' : sheetName === 'Pegawai' ? 'Data Pegawai' : sheetName, dataArray)
                .then((result) => {
                    if (result.success) {
                        window['lastSync_' + sheetName] = window[pendingKey] || strData;
                        delete window[pendingKey];
                        console.log(`✅ ${sheetName} berhasil disimpan ke Database`);
                    } else {
                        console.error(`❌ Gagal menyimpan ${sheetName}:`, result.message);
                        delete window[pendingKey];
                        window['lastWrite_' + sheetName] = Date.now();
                    }
                })
                .catch(err => {
                    console.error(`❌ Gagal menyimpan ${sheetName}:`, err);
                    delete window[pendingKey];
                    window['lastWrite_' + sheetName] = Date.now();
                });
        }
    };
    const debouncedSync = useCallback((sheetName, dataArray) => {
        // Mencegah polling menimpa state lokal saat menunggu debounce
        window['lastWrite_' + sheetName] = Date.now();

        if (syncTimers.current[sheetName]) clearTimeout(syncTimers.current[sheetName]);
        syncTimers.current[sheetName] = setTimeout(() => {
            syncToSheet(sheetName, dataArray);
        }, 1500);
    }, []);

    // Auto-sync setiap kali state data berubah (hanya setelah data awal sudah dimuat)
    useEffect(() => { if (isLoaded) debouncedSync('Santri', dataSantri); }, [dataSantri, isLoaded]);
    useEffect(() => { if (isLoaded) debouncedSync('Pegawai', dataPegawai); }, [dataPegawai, isLoaded]);
    useEffect(() => { if (isLoaded) debouncedSync('Tagihan', dataTagihan); }, [dataTagihan, isLoaded]);
    useEffect(() => { if (isLoaded) debouncedSync('Pembayaran', dataPembayaran); }, [dataPembayaran, isLoaded]);
    useEffect(() => { if (isLoaded) debouncedSync('Tabungan', dataTabungan); }, [dataTabungan, isLoaded]);
    useEffect(() => { if (isLoaded) debouncedSync('Kas', dataKas); }, [dataKas, isLoaded]);
    useEffect(() => { if (isLoaded) debouncedSync('Gaji', dataGaji); }, [dataGaji, isLoaded]);
    useEffect(() => { if (isLoaded) debouncedSync('Logs', dataLog); }, [dataLog, isLoaded]);
    // Sync semua Master Data
    useEffect(() => { if (isLoaded) debouncedSync('MasterPeriode', masterPeriodeList.map(p => ({ periode: p }))); }, [masterPeriodeList, isLoaded]);
    useEffect(() => { if (isLoaded) debouncedSync('MasterJabatan', masterJabatanList.map(j => ({ jabatan: j }))); }, [masterJabatanList, isLoaded]);
    useEffect(() => { if (isLoaded) debouncedSync('MasterKelas', masterKelasList.map(k => ({ kelas: k }))); }, [masterKelasList, isLoaded]);
    // Hindari menimpa database dengan array kosong pada saat baru loading
    useEffect(() => {
        if (isLoaded && masterTagihanList.length > 0) {
            debouncedSync('MasterTagihan', masterTagihanList);
        }
    }, [masterTagihanList]);
    useEffect(() => {
        if (isLoaded) {
            const flat = [...kategoriKas.pemasukan.map(k => ({ kategori: k, tipe: 'pemasukan' })), ...kategoriKas.pengeluaran.map(k => ({ kategori: k, tipe: 'pengeluaran' }))];
            debouncedSync('KategoriKas', flat);
        }
    }, [kategoriKas, isLoaded]);
    // Sync Admin secara debounced
    useEffect(() => { if (isLoaded) debouncedSync('Admin', dataAdmin); }, [dataAdmin, isLoaded]);

    useEffect(() => { if (notification) { const timer = setTimeout(() => setNotification(null), 3000); return () => clearTimeout(timer); } }, [notification]);

    // Copy To Clipboard fallback (penting untuk IFrames Apps Script)
    const copyToClipboard = (text) => {
        const el = document.createElement('textarea');
        el.value = text;
        document.body.appendChild(el);
        el.select();
        try {
            document.execCommand('copy');
            showNotification("Link berhasil disalin!");
        } catch (err) {
            showNotification("Gagal menyalin link.");
        }
        document.body.removeChild(el);
    };

    const showNotification = (msg) => setNotification(msg);
    const triggerPushNotification = (nis, title, body) => {
        if (!nis) return;
        fetch('/api/notifikasi', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ nis, title, body })
        }).catch(e => console.log('Push notif error:', e));
    };
    const closeModal = () => { setModalType(null); setFormData({}); setPakasirData({ qrString: null, loading: false, url: '' }); };
    const handleInputChange = (e) => setFormData(prev => ({ ...prev, [e.target.name]: e.target.value }));
    const handleCheckboxChange = (field, value) => setFormData(prev => { const current = prev[field] || []; return { ...prev, [field]: current.includes(value) ? current.filter(i => i !== value) : [...current, value] }; });
    const handleBulanChange = (b, e) => {
        if (e.target.checked && formData.nis && formData.targetType !== 'Kelas' && formData.targetType !== 'Santri') {
            const pStr = `${b} ${formData.tahun || new Date().getFullYear()}`;

            const tagsToCheck = [];
            if (formData.tagihan) tagsToCheck.push(formData.tagihan);
            if (formData.selectedTagihans && formData.selectedTagihans.length > 0) {
                tagsToCheck.push(...formData.selectedTagihans);
            }

            for (const tagName of tagsToCheck) {
                const check = checkBillStatus(dataTagihan, dataPembayaran, formData.nis, tagName, b, formData.tahun);
                if (modalType === 'FORM_TAGIHAN_SANTRI') {
                    if (check.status === 'IN_TAGIHAN') {
                        showNotification(`Tagihan ${tagName} periode ${pStr} sudah ADA di daftar Tagihan!`);
                        return;
                    }
                    if (check.status === 'ALREADY_PAID') {
                        showNotification(`Tagihan ${tagName} periode ${pStr} SUDAH LUNAS dibayar sebelumnya!`);
                        return;
                    }
                } else if (modalType === 'FORM_PEMBAYARAN') {
                    if (check.status === 'ALREADY_PAID') {
                        showNotification(`Tagihan ${tagName} periode ${pStr} SUDAH LUNAS dibayar!`);
                        return;
                    } else if (check.status === 'IN_TAGIHAN') {
                        const tRef = check.tagihan;
                        if (String(tRef.status).toLowerCase() === 'cicil' || String(tRef.status).toLowerCase() === 'cicilan') {
                            const sisa = Math.max(0, (tRef.nominal || 0) - (tRef.terbayar || 0));
                            showNotification(`Tagihan ${tagName} berstatus CICILAN. Sisa Tagihan: Rp ${sisa.toLocaleString('id-ID')}`);
                            setFormData(prev => ({ ...prev, nominal: sisa }));
                        }
                    }
                }
            }
        }
        handleCheckboxChange('selectedBulan', b);
    };
    const updateTagihanDetail = (tagName, field, value) => setFormData(prev => ({ ...prev, tagihanDetails: { ...prev.tagihanDetails, [tagName]: { ...(prev.tagihanDetails?.[tagName] || {}), [field]: value } } }));

    // Efek sinkronisasi potongan diskon otomatis saat santri atau jenis tagihan dipilih di Form Tagihan
    useEffect(() => {
        if (modalType === 'FORM_TAGIHAN_SANTRI' && formData.nis) {
            const santriRef = dataSantri.find(x => String(x.nis).replace(/^0+/, '') === String(formData.nis || '').replace(/^0+/, ''));
            if (santriRef && formData.selectedTagihans?.length > 0) {
                setFormData(prev => {
                    const updatedDetails = { ...(prev.tagihanDetails || {}) };
                    let changed = false;
                    prev.selectedTagihans.forEach(tagName => {
                        const tagRef = masterTagihanList.find(x => x.tagihan === tagName);
                        const nomAwal = tagRef ? Number(tagRef.nominal) || 0 : (updatedDetails[tagName]?.nominalAwal || 0);
                        const disk = (santriRef.diskonKhusus && santriRef.diskonKhusus[tagName] !== undefined && santriRef.diskonKhusus[tagName] !== '')
                            ? Number(santriRef.diskonKhusus[tagName]) || 0
                            : 0;
                        if (!updatedDetails[tagName] || updatedDetails[tagName].diskon !== disk || updatedDetails[tagName].nominalAwal !== nomAwal) {
                            updatedDetails[tagName] = { nominalAwal: nomAwal, diskon: disk };
                            changed = true;
                        }
                    });
                    return changed ? { ...prev, tagihanDetails: updatedDetails } : prev;
                });
            }
        }
    }, [formData.nis, formData.selectedTagihans, modalType]);

    // Efek filter otomatis bulan yang sudah lunas atau sudah ada di tagihan agar tidak terpilih
    useEffect(() => {
        if (formData.nis && formData.selectedBulan?.length > 0 && formData.targetType !== 'Kelas' && formData.targetType !== 'Santri') {
            const tagsToCheck = [];
            if (formData.tagihan) tagsToCheck.push(formData.tagihan);
            if (formData.selectedTagihans?.length > 0) tagsToCheck.push(...formData.selectedTagihans);

            if (tagsToCheck.length > 0) {
                const validMonths = formData.selectedBulan.filter(b => {
                    for (const tag of tagsToCheck) {
                        const st = checkBillStatus(dataTagihan, dataPembayaran, formData.nis, tag, b, formData.tahun);
                        if (modalType === 'FORM_TAGIHAN_SANTRI' && st.status !== 'AVAILABLE') return false;
                        if (modalType === 'FORM_PEMBAYARAN' && st.status === 'ALREADY_PAID') return false;
                    }
                    return true;
                });
                if (validMonths.length !== formData.selectedBulan.length) {
                    setFormData(prev => ({ ...prev, selectedBulan: validMonths }));
                }
            }
        }
    }, [formData.nis, formData.tagihan, formData.selectedTagihans, formData.tahun, modalType, dataTagihan, dataPembayaran]);

    // Efek sinkronisasi potongan diskon otomatis saat santri atau jenis tagihan dipilih di Form Pembayaran
    useEffect(() => {
        if (modalType === 'FORM_PEMBAYARAN' && formData.nis && formData.tagihan && !formData.selectedTagihanBayar?.length && !formData.id) {
            const santriRef = dataSantri.find(x => String(x.nis).replace(/^0+/, '') === String(formData.nis || '').replace(/^0+/, ''));
            const tagRef = masterTagihanList.find(x => x.tagihan === formData.tagihan);
            if (santriRef && tagRef) {
                const diskon = (santriRef.diskonKhusus && santriRef.diskonKhusus[formData.tagihan] !== undefined && santriRef.diskonKhusus[formData.tagihan] !== '')
                    ? Number(santriRef.diskonKhusus[formData.tagihan]) || 0
                    : 0;
                const nominalAwal = Number(tagRef.nominal) || 0;
                const nominalBersih = Math.max(0, nominalAwal - diskon);
                setFormData(prev => {
                    if (prev.diskonPotongan !== diskon || prev.nominalAwal !== nominalAwal || prev.nominal !== nominalBersih) {
                        return { ...prev, nominal: nominalBersih, diskonPotongan: diskon, nominalAwal: nominalAwal };
                    }
                    return prev;
                });
            }
        }
    }, [formData.nis, formData.tagihan, modalType]);

    const addLog = (aksi, modul, detail) => setDataLog(prev => [{ id: `LOG-${Date.now()}`, waktu: formatDateTimeID(new Date()), user: currentUser?.nama || 'Sistem', aksi, modul, detail }, ...prev]);
    const confirmDelete = (type, id, nama) => setConfirmDialog({ type, id, nama });

    const executeDelete = () => {
        let deletedName = confirmDialog.nama;

        // === BULK DELETE ===
        if (confirmDialog.type === 'BULK') {
            const ids = confirmDialog.id;
            const bType = confirmDialog.bulkType;
            if (bType === 'SANTRI') {
                const targetSantris = dataSantri.filter(s => ids.includes(s.id));
                const targetNises = targetSantris.map(s => s.nis).filter(Boolean);
                if (ids.length > 0) supabase.from('Data Santri').delete().in('id', ids).then(({ error }) => { if (error) console.error("Gagal bulk delete santri by id:", error); });
                if (targetNises.length > 0) supabase.from('Data Santri').delete().in('nis', targetNises).then(({ error }) => { if (error) console.error("Gagal bulk delete santri by nis:", error); });
                setDataSantri(prev => prev.filter(s => !ids.includes(s.id)));
            }
            if (bType === 'PEGAWAI') {
                if (ids.length > 0) supabase.from('Data Pegawai').delete().in('id', ids).then(({ error }) => { if (error) console.error("Gagal bulk delete pegawai:", error); });
                setDataPegawai(prev => prev.filter(p => !ids.includes(p.id)));
            }
            if (bType === 'TAGIHAN') {
                if (ids.length > 0) supabase.from('Tagihan').delete().in('id', ids).then(({ error }) => { if (error) console.error("Gagal bulk delete tagihan:", error); });
                const deletedTags = dataTagihan.filter(t => ids.includes(t.id));
                setDataPembayaran(prev => prev.filter(p => {
                    return !deletedTags.some(deletedTagihan => {
                        if (p.linkedTagihans && p.linkedTagihans.includes(deletedTagihan.id)) return true;
                        if (String(p.nis).replace(/^0+/, '') === String(deletedTagihan.nis).replace(/^0+/, '')) {
                            const pParsed = typeof p.items === 'string' ? JSON.parse(p.items) : p.items;
                            if (pParsed && pParsed.length > 0) {
                                return pParsed.some(item => String(item.tagihan).toLowerCase().trim() === String(deletedTagihan.tagihan).toLowerCase().trim() && formatPeriodeStr(item.periode).toLowerCase().trim() === formatPeriodeStr(deletedTagihan.periode).toLowerCase().trim());
                            } else {
                                return String(p.tagihan).toLowerCase().trim() === String(deletedTagihan.tagihan).toLowerCase().trim() && formatPeriodeStr(p.periode).toLowerCase().trim() === formatPeriodeStr(deletedTagihan.periode).toLowerCase().trim();
                            }
                        }
                        return false;
                    });
                }));
                setDataTagihan(prev => prev.filter(t => !ids.includes(t.id)));
            }
            if (bType === 'PEMBAYARAN') {
                if (ids.length > 0) supabase.from('Pembayaran').delete().in('id', ids).then(({ error }) => { if (error) console.error("Gagal bulk delete pembayaran:", error); });
                const deletedTxs = dataPembayaran.filter(p => ids.includes(p.id));
                setDataTagihan(prev => {
                    let updatedTags = [...prev];
                    deletedTxs.forEach(deletedTrx => {
                        const parsedItems = typeof deletedTrx.items === 'string' ? JSON.parse(deletedTrx.items) : deletedTrx.items;
                        const itemsToReverse = parsedItems && parsedItems.length > 0 
                                               ? parsedItems 
                                               : [{ tagihan: deletedTrx.tagihan, periode: deletedTrx.periode, nominal: deletedTrx.nominal }];
                        itemsToReverse.forEach(item => {
                            const idx = updatedTags.findIndex(t => String(t.nis).replace(/^0+/, '') === String(deletedTrx.nis).replace(/^0+/, '') && String(t.tagihan).toLowerCase().trim() === String(item.tagihan).toLowerCase().trim() && formatPeriodeStr(t.periode).toLowerCase().trim() === formatPeriodeStr(item.periode).toLowerCase().trim());
                            if (idx > -1) {
                                const t = updatedTags[idx];
                                const newTerbayar = Math.max(0, (t.terbayar || 0) - (item.nominal || 0));
                                const statusTrx = newTerbayar >= t.nominal ? 'Lunas' : (newTerbayar > 0 ? 'Cicil' : 'Belum Lunas');
                                updatedTags[idx] = { ...t, terbayar: newTerbayar, status: statusTrx };
                            }
                        });
                    });
                    return updatedTags;
                });
                setDataPembayaran(prev => prev.filter(p => !ids.includes(p.id)));
            }
            if (bType === 'TABUNGAN') {
                if (ids.length > 0) supabase.from('Tabungan').delete().in('id', ids).then(({ error }) => { if (error) console.error("Gagal bulk delete tabungan:", error); });
                setDataTabungan(prev => prev.filter(t => !ids.includes(t.id)));
            }
            if (bType === 'KAS') {
                if (ids.length > 0) supabase.from('Kas').delete().in('id', ids).then(({ error }) => { if (error) console.error("Gagal bulk delete kas:", error); });
                setDataKas(prev => prev.filter(k => !ids.includes(k.id)));
            }
            if (bType === 'GAJI') {
                if (ids.length > 0) supabase.from('Gaji').delete().in('id', ids).then(({ error }) => { if (error) console.error("Gagal bulk delete gaji:", error); });
                setDataGaji(prev => prev.filter(g => !ids.includes(g.id)));
            }
            addLog('BULK_DELETE', bType, `Menghapus ${ids.length} data sekaligus`);
            showNotification(`${ids.length} data berhasil dihapus!`);
            setSelectedIds([]);
            setConfirmDialog(null);
            return;
        }

        if (confirmDialog.type === 'NAIK_KELAS') {
            const targetKelas = confirmDialog.targetKelas; // null = semua, string = kelas tertentu
            setDataSantri(prev => prev.map(s => {
                if (s.status !== 'Aktif') return s;
                if (targetKelas && s.kelas !== targetKelas) return s;
                const match = s.kelas.match(/^(\d+)(.*)$/);
                if (match) {
                    const tingkat = parseInt(match[1], 10);
                    const suffix = match[2];
                    const kelasMax = Math.max(...masterKelasList.map(k => { const m = k.match(/^(\d+)/); return m ? parseInt(m[1], 10) : 0; }));
                    if (tingkat >= kelasMax) return { ...s, status: 'Alumni' };
                    return { ...s, kelas: `${tingkat + 1}${suffix}` };
                }
                return s;
            }));
            addLog('UPDATE', 'SANTRI', targetKelas ? `Kenaikan Kelas: ${targetKelas}` : 'Kenaikan Kelas Massal semua santri aktif');
            showNotification(targetKelas ? `Santri kelas ${targetKelas} berhasil naik kelas!` : 'Kenaikan Kelas Massal Berhasil!');
            setConfirmDialog(null);
            return;
        }

        if (confirmDialog.type === 'SANTRI') {
            const targetId = confirmDialog.id;
            const targetSantri = dataSantri.find(s => s.id === targetId || s.nis === targetId);
            const targetNis = targetSantri ? targetSantri.nis : null;
            if (targetId) supabase.from('Data Santri').delete().eq('id', targetId).then(({ error }) => { if (error) console.error("Gagal hapus santri by id dari Supabase:", error); });
            if (targetNis) supabase.from('Data Santri').delete().eq('nis', targetNis).then(({ error }) => { if (error) console.error("Gagal hapus santri by nis dari Supabase:", error); });
            setDataSantri(prev => prev.filter(s => s.id !== targetId && s.nis !== targetId));
        }
        if (confirmDialog.type === 'PEGAWAI') {
            supabase.from('Data Pegawai').delete().eq('id', confirmDialog.id).then(({ error }) => { if (error) console.error("Gagal hapus pegawai:", error); });
            setDataPegawai(prev => prev.filter(p => p.id !== confirmDialog.id));
        }
        if (confirmDialog.type === 'TAGIHAN_SANTRI') {
            supabase.from('Tagihan').delete().eq('id', confirmDialog.id).then(({ error }) => { if (error) console.error("Gagal hapus tagihan:", error); });
            const deletedTagihan = dataTagihan.find(t => t.id === confirmDialog.id);
            if (deletedTagihan) {
                setDataPembayaran(prev => prev.filter(p => {
                    if (p.linkedTagihans && p.linkedTagihans.includes(deletedTagihan.id)) return false;
                    if (String(p.nis).replace(/^0+/, '') === String(deletedTagihan.nis).replace(/^0+/, '')) {
                        const pParsed = typeof p.items === 'string' ? JSON.parse(p.items) : p.items;
                        if (pParsed && pParsed.length > 0) {
                            const match = pParsed.some(item => String(item.tagihan).toLowerCase().trim() === String(deletedTagihan.tagihan).toLowerCase().trim() && formatPeriodeStr(item.periode).toLowerCase().trim() === formatPeriodeStr(deletedTagihan.periode).toLowerCase().trim());
                            if (match) return false;
                        } else {
                            if (String(p.tagihan).toLowerCase().trim() === String(deletedTagihan.tagihan).toLowerCase().trim() && formatPeriodeStr(p.periode).toLowerCase().trim() === formatPeriodeStr(deletedTagihan.periode).toLowerCase().trim()) return false;
                        }
                    }
                    return true;
                }));
            }
            setDataTagihan(prev => prev.filter(t => t.id !== confirmDialog.id));
        }
        if (confirmDialog.type === 'PEMBAYARAN') {
            supabase.from('Pembayaran').delete().eq('id', confirmDialog.id).then(({ error }) => { if (error) console.error("Gagal hapus pembayaran:", error); });
            const deletedTrx = dataPembayaran.find(p => p.id === confirmDialog.id);
            if (deletedTrx) {
                setDataTagihan(prev => {
                    const updatedTags = [...prev];
                    const parsedItems = typeof deletedTrx.items === 'string' ? JSON.parse(deletedTrx.items) : deletedTrx.items;
                    const itemsToReverse = parsedItems && parsedItems.length > 0 
                                           ? parsedItems 
                                           : [{ tagihan: deletedTrx.tagihan, periode: deletedTrx.periode, nominal: deletedTrx.nominal }];
                    itemsToReverse.forEach(item => {
                        const idx = updatedTags.findIndex(t => String(t.nis).replace(/^0+/, '') === String(deletedTrx.nis).replace(/^0+/, '') && String(t.tagihan).toLowerCase().trim() === String(item.tagihan).toLowerCase().trim() && formatPeriodeStr(t.periode).toLowerCase().trim() === formatPeriodeStr(item.periode).toLowerCase().trim());
                        if (idx > -1) {
                            const t = updatedTags[idx];
                            const newTerbayar = Math.max(0, (t.terbayar || 0) - (item.nominal || 0));
                            const statusTrx = newTerbayar >= t.nominal ? 'Lunas' : (newTerbayar > 0 ? 'Cicil' : 'Belum Lunas');
                            updatedTags[idx] = { ...t, terbayar: newTerbayar, status: statusTrx };
                        }
                    });
                    return updatedTags;
                });
            }
            setDataPembayaran(prev => prev.filter(p => p.id !== confirmDialog.id));
        }
        if (confirmDialog.type === 'TABUNGAN') {
            supabase.from('Tabungan').delete().eq('id', confirmDialog.id).then(({ error }) => { if (error) console.error("Gagal hapus tabungan:", error); });
            setDataTabungan(prev => prev.filter(t => t.id !== confirmDialog.id));
        }
        if (confirmDialog.type === 'KAS') {
            supabase.from('Kas').delete().eq('id', confirmDialog.id).then(({ error }) => { if (error) console.error("Gagal hapus kas:", error); });
            setDataKas(prev => prev.filter(k => k.id !== confirmDialog.id));
        }
        if (confirmDialog.type === 'GAJI') {
            supabase.from('Gaji').delete().eq('id', confirmDialog.id).then(({ error }) => { if (error) console.error("Gagal hapus gaji:", error); });
            setDataGaji(prev => prev.filter(g => g.id !== confirmDialog.id));
        }
        if (confirmDialog.type === 'MASTER_PERIODE') setMasterPeriodeList(prev => prev.filter(p => p !== confirmDialog.id));
        if (confirmDialog.type === 'MASTER_KELAS') setMasterKelasList(prev => prev.filter(k => k !== confirmDialog.id));
        if (confirmDialog.type === 'MASTER_TAGIHAN') {
            supabase.from('MasterTagihan').delete().eq('tagihan', confirmDialog.id).then(({ error }) => {
                if (error) console.error("Gagal hapus master tagihan di Supabase:", error);
            });
            setMasterTagihanList(prev => prev.filter(t => t.tagihan !== confirmDialog.id));
        }
        if (confirmDialog.type === 'MASTER_JABATAN') setMasterJabatanList(prev => prev.filter(j => j !== confirmDialog.id));
        if (confirmDialog.type === 'LOG') {
            supabase.from('Logs').delete().eq('id', confirmDialog.id).then(({ error }) => { if (error) console.error("Gagal hapus log:", error); });
            setDataLog(prev => prev.filter(l => l.id !== confirmDialog.id));
        }

        addLog('DELETE', confirmDialog.type.replace('_', ' '), `Menghapus data: ${deletedName}`);
        showNotification('Data berhasil dihapus!');
        setConfirmDialog(null);
    };

    const executePrint = (htmlContent) => {
        const printWindow = window.open('', '_blank', 'width=800,height=600');
        if (!printWindow) return showNotification("Pop-up diblokir browser! Izinkan akses cetak.");
        printWindow.document.open(); printWindow.document.write(htmlContent); printWindow.document.close(); printWindow.focus();
        setTimeout(() => { printWindow.print(); setTimeout(() => printWindow.close(), 500); }, 500);
    };

    // Auto Polling untuk Pakasir Admin Modal
    useEffect(() => {
        if (modalType !== 'FORM_PAKASIR' || !pakasirData.qrString || pakasirData.isPaid) return;

        const interval = setInterval(async () => {
            try {
                const tRef = dataTagihan.find(t => t.id === formData.id);
                const targetTagihanName = tRef ? tRef.tagihan : formData.tagihan;
                const masterRef = masterTagihanList.find(m => String(targetTagihanName).toLowerCase().includes(String(m.tagihan).toLowerCase()));
                const slug = masterRef?.pakasirSlug || masterRef?.pakasir_slug || masterRef?.PAKASIR_SLUG || appConfig.pakasirSlug || appConfig.pakasir_slug || appConfig.PAKASIR_SLUG || 'depodomain';
                const apiKey = masterRef?.pakasirApiKey || masterRef?.pakasir_apikey || masterRef?.PAKASIR_APIKEY || appConfig.pakasirApiKey || appConfig.pakasir_apikey || appConfig.PAKASIR_APIKEY || 'xxx123';

                let data;
                const res = await fetch('/api/pakasir', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action: 'pollPakasirStatus', data: { slug, txnId: pakasirData.txnId, apiKey } })
                });
                data = await res.json();

                const status = (data?.transaction?.status || data?.payment?.status || data?.status || '').toLowerCase();
                if (['completed', 'success', 'settlement', 'paid'].includes(status)) {
                    setPakasirData(prev => ({ ...prev, isPaid: true }));
                    showNotification("Pembayaran berhasil dikonfirmasi!");
                    setTimeout(() => {
                        processPelunasanOtomatis(new Date().toISOString());
                    }, 2000);
                }
            } catch (err) { }
        }, 5000);

        return () => clearInterval(interval);
    }, [modalType, pakasirData.qrString, pakasirData.isPaid, formData.id]);


    const handleGeneratePakasirQR = async (method) => {
        const tRef = dataTagihan.find(t => t.id === formData.id);
        const targetTagihanName = (tRef ? tRef.tagihan : formData.tagihan) || '';
        const masterRef = masterTagihanList.find(m => String(targetTagihanName).toLowerCase().includes(String(m.tagihan).toLowerCase()));
        const slug = masterRef?.pakasirSlug || masterRef?.pakasir_slug || masterRef?.PAKASIR_SLUG || appConfig.pakasirSlug || appConfig.pakasir_slug || appConfig.PAKASIR_SLUG || 'depodomain';
        const apiKey = masterRef?.pakasirApiKey || masterRef?.pakasir_apikey || masterRef?.PAKASIR_APIKEY || appConfig.pakasirApiKey || appConfig.pakasir_apikey || appConfig.PAKASIR_APIKEY || 'xxx123';

        if (!slug) return showNotification("Project Slug Pakasir belum diatur di Master Tagihan!");

        setPakasirData(prev => ({ ...prev, loading: true, step: 'LOADING', method }));
        try {
            const amountToPay = formData.sisa || formData.nominal || 0;
            const isQris = method === 'QRIS' || method === 'qris';
            if (!isQris && amountToPay < 10000) {
                showNotification("Nominal pembayaran via Virtual Account minimal Rp 10.000. Untuk nominal di bawah Rp 10.000, silakan gunakan QRIS.");
                setPakasirData(prev => ({ ...prev, loading: false, step: 'CHOOSE_METHOD' }));
                return;
            }
            
            // Save to PakasirOrders for Webhook support
            // Generate a unique orderId to prevent "Transaction already canceled/exist" errors from Pakasir
            const uniqueOrderId = `${formData.id}_${Date.now()}`;
            
            const dbPayload = {
              orderId: formData.id, // Keep the original for internal reference
              pakasirOrderId: uniqueOrderId,
              method,
              amount: amountToPay,
              tagihanData: tRef || formData,
              isBulk: false,
              slug: slug,
              apiKey: apiKey
            };
            await supabase.from('PakasirOrders').upsert([{
              order_id: uniqueOrderId,
              tipe: 'TAGIHAN_ADMIN',
              status: 'PENDING',
              payload: dbPayload
            }]);

            let data;
            const res = await fetch('/api/pakasir', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'requestPakasirPayment', data: { slug, method, amount: amountToPay, orderId: uniqueOrderId, apiKey } })
            });
            
            let rawData = await res.json();
            // Handle double-stringified JSON from Pakasir/Next.js
            data = typeof rawData === 'string' ? (JSON.parse(rawData) || rawData) : rawData;
            
            console.log("PAKASIR RESPONSE:", data);
            
            const paymentData = data?.payment || data?.data || data;

            if (paymentData && (paymentData.payment_number || paymentData.va_number || paymentData.checkout_url || paymentData.qr_string)) {
                const checkoutUrl = paymentData.checkout_url || paymentData.url || '';
                const qrStr = paymentData.va_number || paymentData.payment_number || paymentData.qr_string || '';

                const strData = JSON.stringify(data || {}).toLowerCase();
                const isSandboxApi = strData.includes('"sandbox"') || strData.includes('sandbox.pakasir.com') || String(qrStr).toUpperCase().includes('SANDBOX') || String(checkoutUrl).toUpperCase().includes('SANDBOX') || String(qrStr) === '123123123';

                console.log("IS SANDBOX:", isSandboxApi, "qrString:", qrStr, "checkout_url:", checkoutUrl);
                const txnId = paymentData.txn_id || data.txn_id || '';
                setPakasirTimeLeft(900);
                setPakasirData(prev => ({ ...prev, loading: false, step: isQris ? 'SHOW_QR' : 'SHOW_VA', qrString: qrStr, checkoutUrl: checkoutUrl, isSandbox: isSandboxApi, txnId: txnId }));
                addLog('INTEGRATION', 'PAKASIR API', `Berhasil request ${method} untuk ${uniqueOrderId}${isSandboxApi ? ' (Sandbox)' : ''}`);
            } else {
                console.error('Pakasir API Response Gagal:', JSON.stringify(data, null, 2));
                const errMsg = data?.message || data?.error || paymentData?.message || paymentData?.error || (typeof data === 'object' ? JSON.stringify(data) : String(data));
                throw new Error(errMsg || "Invalid response dari Pakasir (mungkin project belum diset / parameter salah)");
            }
        } catch (error) {
            console.error('Pakasir Catch Error:', error);
            const isQris = method === 'QRIS' || method === 'qris';
            const mockString = isQris ? "00020101021226610016ID.CO.SHOPEE.WWW01189360091800216005230208216005230303UME51440014ID.CO.QRIS.WWW0215ID10243228429300303UME5204792953033605409100003.005802ID5907Pakasir6012KAB.KEBUMEN61055439262230519SP25RZRATEQI2HQ65Q46304A079" : "8023123456789012";
            setPakasirTimeLeft(900);
            setPakasirData({ step: isQris ? 'SHOW_QR' : 'SHOW_VA', method: method, loading: false, qrString: mockString, url: '', isSandbox: true });
            addLog('INTEGRATION', 'PAKASIR DEMO', `Fallback ke Mock ${isQris ? 'QRIS' : 'VA'} untuk ${formData.id}`);
            showNotification(`GAGAL: ${error.message || error}. Menggunakan Mock ${isQris ? 'QRIS' : 'VA'} (cek console).`);
        }
    };

    const processPelunasanOtomatis = (tanggalWaktu) => {
        if (formData.id.startsWith('TGH-')) {
            setDataTagihan(prev => {
                const updated = [...prev];
                const idx = updated.findIndex(t => t.id === formData.id);
                if (idx > -1) {
                    const tRef = updated[idx];
                    const totalTerbayarBaru = (tRef.terbayar || 0) + formData.sisa;
                    const statusTrx = totalTerbayarBaru < tRef.nominal ? 'Cicil' : 'Lunas';
                    const sisaTagihan = Math.max(0, tRef.nominal - totalTerbayarBaru);
                    updated[idx] = { ...tRef, status: statusTrx, terbayar: totalTerbayarBaru };

                    const newTrx = { id: `INV-PKS-${Math.floor(Math.random() * 10000) + '-' + Date.now()}`, tanggal: tanggalWaktu.split('T')[0], nis: tRef.nis, nama: tRef.nama, tagihan: tRef.tagihan + ' (Via QRIS)', periode: tRef.periode, nominal: formData.sisa, status: statusTrx === 'Cicil' ? 'Cicilan' : 'Lunas', sisa: sisaTagihan, items: [{ tagihan: tRef.tagihan, periode: tRef.periode, nominal: formData.sisa }] };
                    setDataPembayaran(p => [newTrx, ...p]);
                }
                return updated;
            });
        } else if (formData.id.startsWith('INV-')) {
            let invRef = formData.pendingTrx;
            if (invRef) {
                invRef = { ...invRef, status: 'Lunas', sisa: 0, tagihan: invRef.tagihan + ' (Via QRIS)' };
                setDataPembayaran(prev => [invRef, ...prev]);
            } else {
                setDataPembayaran(prev => {
                    const updated = [...prev];
                    const idx = updated.findIndex(p => p.id === formData.id);
                    if (idx > -1) {
                        invRef = updated[idx];
                        updated[idx] = { ...invRef, status: 'Lunas', sisa: 0, tagihan: invRef.tagihan + ' (Via QRIS)' };
                    }
                    return updated;
                });
            }

            if (invRef) {
                if (invRef.linkedTagihans?.length > 0) {
                    setDataTagihan(prevTags => {
                        const upTags = [...prevTags];
                        invRef.linkedTagihans.forEach(tid => {
                            const tagIndex = upTags.findIndex(t => t.id === tid);
                            if (tagIndex > -1) {
                                const t = upTags[tagIndex];
                                if (invRef.linkedTagihans.length === 1) {
                                    const totalTerbayarBaru = (t.terbayar || 0) + invRef.nominal;
                                    const statusTrx = totalTerbayarBaru < t.nominal ? 'Cicil' : 'Lunas';
                                    upTags[tagIndex] = { ...t, status: statusTrx, terbayar: totalTerbayarBaru };
                                } else { upTags[tagIndex] = { ...t, status: 'Lunas', terbayar: t.nominal }; }
                            }
                        });
                        return upTags;
                    });
                } else {
                    setDataTagihan(prevTags => {
                        const upTags = [...prevTags];
                        const cleanedNis = String(invRef.nis).replace(/^0+/, '');
                        const parsedInvItems = typeof invRef.items === 'string' ? JSON.parse(invRef.items) : invRef.items;
                        const itemsToProcess = parsedInvItems && parsedInvItems.length > 0 ? parsedInvItems : [{ tagihan: invRef.tagihan.replace(' (Via QRIS)', ''), periode: invRef.periode, nominal: invRef.nominal }];

                        itemsToProcess.forEach(item => {
                            const cleanTagihan = String(item.tagihan).replace(' (Via QRIS)', '').toLowerCase().trim();
                            const cleanPeriode = formatPeriodeStr(item.periode).toLowerCase().trim();

                            const tagIndex = upTags.findIndex(t =>
                                String(t.nis).replace(/^0+/, '') === cleanedNis &&
                                String(t.tagihan).toLowerCase().trim() === cleanTagihan &&
                                formatPeriodeStr(t.periode).toLowerCase().trim() === cleanPeriode
                            );

                            if (tagIndex > -1) {
                                const t = upTags[tagIndex];
                                const currentTerbayar = (t.terbayar || 0) + item.nominal;
                                const statusTrx = currentTerbayar >= t.nominal ? 'Lunas' : 'Cicil';
                                upTags[tagIndex] = { ...t, status: statusTrx, terbayar: currentTerbayar };
                            } else {
                                upTags.unshift({
                                    id: generateInvoiceId(item.tagihan, upTags),
                                    tanggal: invRef.tanggal,
                                    nis: invRef.nis,
                                    nama: invRef.nama,
                                    tagihan: item.tagihan.replace(' (Via QRIS)', ''),
                                    periode: item.periode,
                                    nominalAwal: item.nominal,
                                    diskon: 0,
                                    nominal: item.nominal,
                                    terbayar: item.nominal,
                                    status: 'Lunas'
                                });
                            }
                        });
                        return upTags;
                    });
                }
            }
        }
        addLog('CREATE', 'PAKASIR AUTO', `Konfirmasi otomatis QRIS Lunas`);
        showNotification("Sistem: Pembayaran Pakasir Terkonfirmasi LUNAS!");
        closeModal();
    };

    const handleCekStatusPakasir = async () => {
        if (!pakasirData.qrString) return;
        setPakasirData(prev => ({ ...prev, loading: true }));
        try {
            const tRef = dataTagihan.find(t => t.id === formData.id);
            const targetTagihanName = (tRef ? tRef.tagihan : formData.tagihan) || '';
            const masterRef = masterTagihanList.find(m => String(targetTagihanName).toLowerCase().includes(String(m.tagihan).toLowerCase()));
            const slug = masterRef?.pakasirSlug || masterRef?.pakasir_slug || masterRef?.PAKASIR_SLUG || appConfig.pakasirSlug || appConfig.pakasir_slug || appConfig.PAKASIR_SLUG || 'depodomain';
            const apiKey = masterRef?.pakasirApiKey || masterRef?.pakasir_apikey || masterRef?.PAKASIR_APIKEY || appConfig.pakasirApiKey || appConfig.pakasir_apikey || appConfig.PAKASIR_APIKEY || 'xxx123';

            let data;
            const res = await fetch('/api/pakasir', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'pollPakasirStatus', data: { slug, txnId: pakasirData.txnId, apiKey } })
            });
            data = await res.json();

            const status = (data?.transaction?.status || data?.payment?.status || data?.status || '').toLowerCase();
            if (['completed', 'success', 'settlement', 'paid'].includes(status)) {
                setPakasirData(prev => ({ ...prev, isPaid: true, loading: false }));
                showNotification("Pembayaran berhasil dikonfirmasi!");
                setTimeout(() => {
                    processPelunasanOtomatis(new Date().toISOString());
                }, 1000);
            } else {
                setPakasirData(prev => ({ ...prev, loading: false }));
                showNotification(`Pembayaran belum diterima (Status: ${status || 'Unknown'}). Silakan selesaikan pembayaran.`, "error");
            }
        } catch (error) {
            console.error("Cek Status Error:", error);
            setPakasirData(prev => ({ ...prev, loading: false }));
            showNotification(`Gagal mengecek status: ${error.message || 'Error'}`, "error");
        }
    };

    const handleOpenPakasir = (isTabungan = false) => {
        const santriTerpilih = dataSantri.find(s => String(s.nis || '').replace(/^0+/, '') === String(formData.nis || '').replace(/^0+/, ''));
        if (!santriTerpilih) return showNotification("Pilih santri terlebih dahulu!");

        if (!isTabungan) {
            if (formData.selectedTagihanBayar?.length > 0) {
                for (const tid of formData.selectedTagihanBayar) {
                    const tRef = dataTagihan.find(t => t.id === tid);
                    if (tRef && String(tRef.status).toLowerCase() === 'lunas') {
                        showNotification(`Tagihan ${tRef.tagihan} periode ${tRef.periode} sudah LUNAS! Pembayaran dibatalkan.`);
                        return;
                    }
                }
            } else {
                const tagihanName = formData.tagihan || 'Pembayaran Manual';
                const selectedB = formData.selectedBulan || [];
                for (const bln of selectedB) {
                    const pStr = `${bln} ${formData.tahun || new Date().getFullYear()}`;
                    const tRef = dataTagihan.find(t =>
                        String(t.nis).replace(/^0+/, '') === String(santriTerpilih.nis).replace(/^0+/, '') &&
                        String(t.tagihan).toLowerCase().trim() === String(tagihanName).toLowerCase().trim() &&
                        formatPeriodeStr(t.periode).toLowerCase().trim() === formatPeriodeStr(pStr).toLowerCase().trim()
                    );
                    if (tRef && String(tRef.status).toLowerCase() === 'lunas') {
                        showNotification(`Tagihan ${tagihanName} periode ${pStr} sudah LUNAS! Pembayaran dibatalkan.`);
                        return;
                    }
                }
            }
        }

        if (isTabungan) {
            const nominalAngka = parseInt(String(formData.nominal || '').replace(/\D/g, ''), 10) || 0;
            if (!nominalAngka || nominalAngka <= 0) return showNotification("Nominal tidak valid!");
            const tempId = `TB-PKS-${Date.now()}`;
            setFormData({ ...formData, id: tempId, nama: santriTerpilih.nama, tagihan: 'Tabungan', sisa: nominalAngka });
            setPakasirData({ step: 'CHOOSE_METHOD', method: '', qrString: null, loading: false, url: '', isPaid: false, checkoutUrl: '' });
            setModalType('FORM_PAKASIR');
            return;
        }

        let pInvoiceStr = formData.bulan && formData.tahun ? `${formData.bulan} ${formData.tahun}` : 'Juni 2026';
        const tempId = `INV-PKS-${Math.floor(Math.random() * 100000) + '-' + Date.now()}`;

        let nominalAngka = 0; let tagihanNames = ''; let linkedIds = [];
        let itemsToPay = [];

        if (formData.selectedTagihanBayar?.length > 0) {
            if (formData.selectedTagihanBayar.length === 1) {
                const tagihanId = formData.selectedTagihanBayar[0];
                const tRef = dataTagihan.find(t => t.id === tagihanId);
                tagihanNames = tRef.tagihan;
                pInvoiceStr = tRef.periode;
                nominalAngka = parseInt(String(formData.nominal || '').replace(/\D/g, ''), 10) || (tRef.nominal - (tRef.terbayar || 0));
                linkedIds = [tRef.id];
                itemsToPay = [{ tagihan: tRef.tagihan, periode: tRef.periode, nominal: nominalAngka }];
            } else {
                let totalNom = 0;
                const names = [];
                formData.selectedTagihanBayar.forEach(tagihanId => {
                    const tRef = dataTagihan.find(t => t.id === tagihanId);
                    if (tRef) {
                        const sisa = Number(tRef.nominal) - (Number(tRef.terbayar) || 0);
                        totalNom += sisa;
                        names.push(tRef.tagihan);
                        linkedIds.push(tRef.id);
                        itemsToPay.push({ tagihan: tRef.tagihan, periode: tRef.periode, nominal: sisa });
                    }
                });
                nominalAngka = totalNom;
                tagihanNames = names.join(', ');
                pInvoiceStr = itemsToPay[0]?.periode || 'Multi-Periode';
            }
        } else {
            const selectedB = formData.selectedBulan || [];
            if (selectedB.length === 0) return showNotification('Pilih minimal 1 bulan!');
            const perBulan = parseInt(String(formData.nominal || '').replace(/\D/g, ''), 10);
            nominalAngka = perBulan * selectedB.length;
            tagihanNames = formData.tagihan;
            pInvoiceStr = selectedB.length > 1 ? `${selectedB[0]} - ${selectedB[selectedB.length - 1]} ${formData.tahun}` : `${selectedB[0]} ${formData.tahun}`;
            itemsToPay = selectedB.map(b => ({ tagihan: formData.tagihan, periode: `${b} ${formData.tahun}`, nominal: perBulan }));
        }

        if (!nominalAngka || nominalAngka <= 0) return showNotification("Nominal tidak valid!");
        const newTrx = { id: tempId, tanggal: new Date().toISOString().split('T')[0], nis: santriTerpilih.nis, nama: santriTerpilih.nama, tagihan: tagihanNames, periode: pInvoiceStr, nominal: nominalAngka, status: 'Pending', sisa: nominalAngka, linkedTagihans: linkedIds, items: itemsToPay };
        setFormData({ ...formData, id: tempId, nama: santriTerpilih.nama, tagihan: tagihanNames, sisa: nominalAngka, pendingTrx: newTrx });
        setPakasirData({ step: 'CHOOSE_METHOD', method: '', qrString: null, loading: false, url: '', isPaid: false, checkoutUrl: '' });
        setModalType('FORM_PAKASIR');
    };

    const submitTambahPembayaran = (e) => {
        e.preventDefault();
        const periodeStr = formData.bulan && formData.tahun ? `${formData.bulan} ${formData.tahun}` : 'Juni 2026';

        if (formData.id && formData.id.startsWith('INV')) {
            let nominalAngka = parseInt(String(formData.nominal || '').replace(/\D/g, ''), 10);
            
            const oldTrx = dataPembayaran.find(p => p.id === formData.id);
            if (oldTrx) {
                const selisih = nominalAngka - oldTrx.nominal;
                const targetTgh = dataTagihan.find(t => String(t.nis).replace(/^0+/,'') === String(oldTrx.nis).replace(/^0+/,'') && String(t.tagihan).toLowerCase().trim() === String(oldTrx.tagihan).toLowerCase().trim() && t.periode === oldTrx.periode);
                
                let newStatusTrx = oldTrx.status;
                let newSisa = oldTrx.sisa;

                if (targetTgh) {
                    const newTerbayar = Math.max(0, (targetTgh.terbayar || 0) + selisih);
                    const tagihanStatus = newTerbayar >= targetTgh.nominal ? 'Lunas' : newTerbayar > 0 ? 'Cicil' : 'Belum Lunas';
                    newStatusTrx = tagihanStatus === 'Lunas' ? 'Lunas' : 'Cicilan';
                    newSisa = Math.max(0, targetTgh.nominal - newTerbayar);
                    
                    if (tagihanStatus === 'Lunas') {
                        setDataTagihan(prev => prev.filter(t => t.id !== targetTgh.id));
                    } else {
                        setDataTagihan(prev => prev.map(t => t.id === targetTgh.id ? { ...t, terbayar: newTerbayar, status: tagihanStatus } : t));
                    }
                } else {
                    if (nominalAngka < oldTrx.nominal) newStatusTrx = 'Cicilan';
                }
                
                setDataPembayaran(prev => prev.map(p => p.id === formData.id ? { ...p, nominal: nominalAngka, periode: periodeStr, status: newStatusTrx, sisa: newSisa } : p));
            } else {
                setDataPembayaran(prev => prev.map(p => p.id === formData.id ? { ...p, nominal: nominalAngka, periode: periodeStr } : p));
            }
            showNotification(`Transaksi diperbarui!`); closeModal(); return;
        }

        if (modalType === 'FORM_PEMBAYARAN_MASSAL') {
            const selectedTags = formData.selectedTagihans || [];
            const selectedB = formData.selectedBulan || [];
            if (selectedTags.length === 0 || selectedB.length === 0) return showNotification('Lengkapi pilihan!');

            let targetSantri = formData.targetType === 'Kelas' ? dataSantri.filter(s => (formData.selectedKelas || []).includes(s.kelas)) : formData.targetType === 'Santri' ? dataSantri.filter(s => (formData.selectedSantri || []).includes(s.nis)) : dataSantri;

            const newTrxs = [];
            let skippedMassalPembayaran = 0;
            targetSantri.forEach(santri => {
                const itemsToPayMassal = []; let totalBayar = 0;
                selectedTags.forEach(tagName => {
                    selectedB.forEach(bln => {
                        const pStr = `${bln} ${formData.tahun}`;

                        // Cegah duplikat: lewati jika santri ini sudah lunas untuk tagihan & bulan ini
                        const check = checkBillStatus(dataTagihan, dataPembayaran, santri.nis, tagName, bln, formData.tahun);
                        if (check.status === 'ALREADY_PAID') {
                            skippedMassalPembayaran++;
                            return;
                        }

                        const tRef = masterTagihanList.find(t => isTagihanMatch(t.tagihan, tagName));
                        const diskon = (santri.diskonKhusus && santri.diskonKhusus[tagName] !== undefined && santri.diskonKhusus[tagName] !== '')
                            ? Number(santri.diskonKhusus[tagName]) || 0
                            : (santri.beasiswa ? Math.round(((tRef?.nominal || 0) * Number(santri.beasiswa)) / 100) : 0);
                        const finalNominal = Math.max(0, (tRef?.nominal || 0) - diskon);
                        if (finalNominal > 0) {
                            itemsToPayMassal.push({ tagihan: tagName, periode: pStr, nominal: finalNominal });
                            totalBayar += finalNominal;
                        }
                    });
                });
                if (itemsToPayMassal.length > 0) {
                    const tagihanNames = itemsToPayMassal.map(i => i.tagihan).join(', ');
                    const pInvoiceStr = itemsToPayMassal.length > 1 ? `${selectedB[0]} - ${selectedB[selectedB.length - 1]} ${formData.tahun}` : `${selectedB[0]} ${formData.tahun}`;
                    newTrxs.push({ id: `INV-${Math.floor(Math.random() * 100000) + '-' + Date.now()}`, tanggal: new Date().toISOString().split('T')[0], nis: santri.nis, nama: santri.nama, tagihan: tagihanNames.length > 30 ? tagihanNames.substring(0, 30) + '...' : tagihanNames, periode: pInvoiceStr, nominal: totalBayar, status: 'Lunas', sisa: 0, items: itemsToPayMassal });
                }
            });
            // Hapus tagihan yang sudah terbayar lunas dari dataTagihan agar tidak menumpuk di daftar tagihan
            setDataTagihan(prevTags => {
                return prevTags.filter(t => {
                    const isPaidInMass = newTrxs.some(trx => 
                        String(trx.nis).replace(/^0+/, '') === String(t.nis).replace(/^0+/, '') &&
                        trx.items?.some(it => String(it.tagihan).toLowerCase().trim() === String(t.tagihan).toLowerCase().trim() && formatPeriodeStr(it.periode).toLowerCase().trim() === formatPeriodeStr(t.periode).toLowerCase().trim())
                    );
                    return !isPaidInMass;
                });
            });
            setDataPembayaran(prev => [...newTrxs, ...prev]);
            addLog('CREATE', 'PEMBAYARAN MASSAL', `Menerima ${newTrxs.length} pembayaran massal`);
            showNotification(`${newTrxs.length} Transaksi Massal dicatat!`);
            newTrxs.forEach(trx => {
                triggerPushNotification(trx.nis, 'Pembayaran Tagihan', `Alhamdulillah, pembayaran massal Rp ${trx.nominal.toLocaleString('id-ID')} untuk Ananda ${trx.nama} berhasil dicatat.`);
            });
            closeModal(); return;
        }

        const santriTerpilih = dataSantri.find(s => String(s.nis || '').replace(/^0+/, '') === String(formData.nis || '').replace(/^0+/, '')) || { nama: 'Santri Tidak Dikenal' };

        if (formData.selectedTagihanBayar?.length > 0) {
            for (const tid of formData.selectedTagihanBayar) {
                const tRef = dataTagihan.find(t => t.id === tid);
                if (tRef && String(tRef.status).toLowerCase() === 'lunas') {
                    alert(`PERINGATAN: Tagihan ${tRef.tagihan} periode ${tRef.periode} SUDAH LUNAS!\n\nPembayaran dibatalkan otomatis agar tidak double.`);
                    return;
                }
            }
        } else {
            const tagihanName = formData.tagihan || 'Pembayaran Manual';
            const selectedB = formData.selectedBulan || [];
            for (const bln of selectedB) {
                const pStr = `${bln} ${formData.tahun || new Date().getFullYear()}`;
                const check = checkBillStatus(dataTagihan, dataPembayaran, santriTerpilih.nis, tagihanName, bln, formData.tahun);
                if (check.status === 'ALREADY_PAID') {
                    alert(`PERINGATAN: ${check.message}\n\nPembayaran dibatalkan otomatis agar tidak terjadi transaksi duplikat.`);
                    return;
                }
            }
        }

        if (formData.selectedTagihanBayar?.length > 0) {
            if (formData.selectedTagihanBayar.length === 1) {
                const tagihanId = formData.selectedTagihanBayar[0];
                const tRef = dataTagihan.find(t => t.id === tagihanId);
                let nominalAngka = parseInt(String(formData.nominal || '').replace(/\D/g, ''), 10);
                const totalTerbayarBaru = (tRef.terbayar || 0) + nominalAngka;
                let statusTrx = 'Lunas';
                let sisaTagihan = 0;

                if (totalTerbayarBaru < tRef.nominal) {
                    statusTrx = 'Cicil';
                    sisaTagihan = tRef.nominal - totalTerbayarBaru;
                    // Tagihan belum lunas: simpan sisa cicilan di Tagihan
                    setDataTagihan(prev => prev.map(t => t.id === tagihanId ? { ...t, status: 'Cicil', terbayar: totalTerbayarBaru } : t));
                } else {
                    // Tagihan SUDAH LUNAS: Hapus dari daftar Tagihan agar tidak menumpuk
                    setDataTagihan(prev => prev.filter(t => t.id !== tagihanId));
                }

                const newTrx = {
                    id: `INV-${Math.floor(Math.random() * 10000) + '-' + Date.now()}`,
                    tanggal: new Date().toISOString().split('T')[0],
                    nis: santriTerpilih.nis,
                    nama: santriTerpilih.nama,
                    tagihan: tRef.tagihan,
                    periode: tRef.periode,
                    nominal: nominalAngka,
                    status: statusTrx === 'Cicil' ? 'Cicilan' : 'Lunas',
                    sisa: sisaTagihan,
                    items: [{ tagihan: tRef.tagihan, periode: tRef.periode, nominal: nominalAngka }]
                };
                setDataPembayaran(prev => [newTrx, ...prev]);
                addLog('CREATE', 'PEMBAYARAN', `Menerima pembayaran Rp ${nominalAngka.toLocaleString('id-ID')} dari ${santriTerpilih.nama}`);
                showNotification(`Pembayaran Rp ${nominalAngka.toLocaleString('id-ID')} dicatat!`);
                triggerPushNotification(santriTerpilih.nis, 'Pembayaran Tagihan', `Alhamdulillah, pembayaran Rp ${nominalAngka.toLocaleString('id-ID')} untuk ${tRef.tagihan} (${tRef.periode}) Ananda ${santriTerpilih.nama} berhasil dicatat.`);
            } else {
                const itemsToPay = [];
                let totalPayment = 0;

                formData.selectedTagihanBayar.forEach(tagihanId => {
                    const tRef = dataTagihan.find(t => t.id === tagihanId);
                    if (tRef) {
                        const sisa = Number(tRef.nominal) - (Number(tRef.terbayar) || 0);
                        itemsToPay.push({ tagihan: tRef.tagihan, periode: tRef.periode, nominal: sisa });
                        totalPayment += sisa;
                    }
                });

                // Semua tagihan yang dipilih sudah lunas dibayar sekaligus: hapus dari daftar Tagihan
                setDataTagihan(prevTags => prevTags.filter(t => !formData.selectedTagihanBayar.includes(t.id)));

                const tagihanNames = itemsToPay.map(i => i.tagihan).join(', ');
                const newTrx = {
                    id: `INV-${Math.floor(Math.random() * 100000) + '-' + Date.now()}`,
                    tanggal: new Date().toISOString().split('T')[0],
                    nis: santriTerpilih.nis,
                    nama: santriTerpilih.nama,
                    tagihan: tagihanNames.length > 30 ? tagihanNames.substring(0, 30) + '...' : tagihanNames,
                    periode: itemsToPay[0]?.periode || 'Multi-Periode',
                    nominal: totalPayment,
                    status: 'Lunas',
                    sisa: 0,
                    items: itemsToPay
                };
                setDataPembayaran(prev => [newTrx, ...prev]);
                addLog('CREATE', 'PEMBAYARAN', `Menerima pembayaran ${itemsToPay.length} tagihan dari ${santriTerpilih.nama}`);
                showNotification(`Pembayaran ${itemsToPay.length} tagihan sekaligus berhasil!`);
                triggerPushNotification(santriTerpilih.nis, 'Pembayaran Tagihan', `Alhamdulillah, pembayaran ${itemsToPay.length} tagihan sekaligus (Total Rp ${totalPayment.toLocaleString('id-ID')}) untuk Ananda ${santriTerpilih.nama} berhasil dicatat.`);
            }
            closeModal();
            return;
        }

        const selectedB = formData.selectedBulan || [];
        if (selectedB.length === 0) return showNotification('Pilih minimal 1 bulan!');
        let nominalPerBulan = parseInt(String(formData.nominal || '').replace(/\D/g, ''), 10);
        const itemsToPay = [];
        let totalPayment = 0;
        let anyCicilan = false;
        let totalSisa = 0;

        // Ambil tarif normal dan potongan santri
        const masterRef = masterTagihanList.find(m => String(m.tagihan).toLowerCase().trim() === String(formData.tagihan).toLowerCase().trim()) || masterTagihanList.find(m => String(formData.tagihan).toLowerCase().trim().includes(String(m.tagihan).toLowerCase().trim()));
        const tarifNormal = masterRef ? Number(masterRef.nominal) || 0 : nominalPerBulan;
        const diskonSantri = (santriTerpilih.diskonKhusus && santriTerpilih.diskonKhusus[formData.tagihan] !== undefined && santriTerpilih.diskonKhusus[formData.tagihan] !== '')
            ? Number(santriTerpilih.diskonKhusus[formData.tagihan]) || 0
            : (formData.diskonPotongan ? Number(formData.diskonPotongan) || 0 : 0);
        const tagihanWajib = Math.max(0, tarifNormal - diskonSantri);

        selectedB.forEach(bln => {
            const pStr = `${bln} ${formData.tahun}`;
            itemsToPay.push({ tagihan: formData.tagihan, periode: pStr, nominal: nominalPerBulan });
            totalPayment += nominalPerBulan;
            if (nominalPerBulan < tagihanWajib) {
                anyCicilan = true;
                totalSisa += (tagihanWajib - nominalPerBulan);
            }
        });

        // Update Tagihan: hanya sisa cicilan yang masuk ke Tagihan! Yang LUNAS TIDAK masuk ke Tagihan!
        setDataTagihan(prevTags => {
            let updatedTags = [...prevTags];
            selectedB.forEach(bln => {
                const pStr = `${bln} ${formData.tahun}`;
                const idx = updatedTags.findIndex(t =>
                    String(t.nis).replace(/^0+/, '') === String(formData.nis).replace(/^0+/, '') &&
                    String(t.tagihan).toLowerCase().trim() === String(formData.tagihan).toLowerCase().trim() &&
                    formatPeriodeStr(t.periode).toLowerCase().trim() === formatPeriodeStr(pStr).toLowerCase().trim()
                );

                if (idx > -1) {
                    const t = updatedTags[idx];
                    const currentTerbayar = (t.terbayar || 0) + nominalPerBulan;
                    if (currentTerbayar >= t.nominal) {
                        // Lunas: Hapus dari Tagihan
                        updatedTags.splice(idx, 1);
                    } else {
                        // Cicil: Perbarui status & terbayar
                        updatedTags[idx] = { ...t, terbayar: currentTerbayar, status: 'Cicil' };
                    }
                } else {
                    // Jika cicil (nominal bayar < tagihan wajib): masukkan sisa kewajiban ke Tagihan
                    if (nominalPerBulan < tagihanWajib) {
                        updatedTags.unshift({
                            id: generateInvoiceId(formData.tagihan, updatedTags),
                            tanggal: new Date().toISOString().split('T')[0],
                            nis: santriTerpilih.nis,
                            nama: santriTerpilih.nama,
                            tagihan: formData.tagihan,
                            periode: pStr,
                            nominalAwal: tarifNormal,
                            diskon: diskonSantri,
                            nominal: tagihanWajib,
                            terbayar: nominalPerBulan,
                            status: 'Cicil'
                        });
                    }
                    // Jika LUNAS: JANGAN tambahkan ke Tagihan! Cukup tercatat di dataPembayaran!
                }
            });
            return updatedTags;
        });

        const pInvoiceStr = itemsToPay.length > 1 ? `${selectedB[0]} - ${selectedB[selectedB.length - 1]} ${formData.tahun}` : `${selectedB[0]} ${formData.tahun}`;
        const trxStatus = anyCicilan ? 'Cicilan' : 'Lunas';
        const newTrx = {
            id: `INV-${Math.floor(Math.random() * 10000) + '-' + Date.now()}`,
            tanggal: new Date().toISOString().split('T')[0],
            nis: formData.nis,
            nama: santriTerpilih.nama,
            tagihan: formData.tagihan,
            periode: pInvoiceStr,
            nominal: totalPayment,
            status: trxStatus,
            sisa: totalSisa,
            items: itemsToPay
        };
        setDataPembayaran(prev => [newTrx, ...prev]);
        addLog('CREATE', 'PEMBAYARAN MANUAL', `Menerima pembayaran manual Rp ${totalPayment.toLocaleString('id-ID')} dari ${santriTerpilih.nama}`);
        showNotification(`Pembayaran Rp ${totalPayment.toLocaleString('id-ID')} dicatat!`);
        triggerPushNotification(santriTerpilih.nis, 'Pembayaran Tagihan', `Alhamdulillah, pembayaran Rp ${totalPayment.toLocaleString('id-ID')} untuk ${formData.tagihan} Ananda ${santriTerpilih.nama} berhasil dicatat.`);
        closeModal();
    };

    const submitTagihanSantri = (e) => {
        e.preventDefault();

        if (modalType === 'GENERATE_MASSAL') {
            const selectedTags = formData.selectedTagihans || [];
            const selectedB = formData.selectedBulan || [];
            if (selectedTags.length === 0 || selectedB.length === 0) return showNotification('Pilih minimal 1 jenis tagihan dan 1 bulan!');

            let targetSantri = formData.targetType === 'Kelas' 
                ? dataSantri.filter(s => (formData.selectedKelas || []).some(k => String(k).trim().toLowerCase() === String(s.kelas).trim().toLowerCase())) 
                : formData.targetType === 'Santri' 
                    ? dataSantri.filter(s => (formData.selectedSantri || []).some(id => String(id) === String(s.nis))) 
                    : dataSantri;
            if (targetSantri.length === 0) return showNotification(formData.targetType === 'Kelas' ? 'Tidak ada santri di kelas yang dipilih!' : 'Harap cari dan pilih Santri terlebih dahulu!');

            const newTags = [];
            let skippedMassalTagihan = 0;
            targetSantri.forEach(santriTerpilih => {
                selectedTags.forEach(tagName => {
                    selectedB.forEach(bln => {
                        const periodeStr = `${bln} ${formData.tahun}`;

                        // Cegah duplikat: lewati jika sudah ada di Tagihan atau sudah Lunas di Pembayaran
                        const check = checkBillStatus(dataTagihan, dataPembayaran, santriTerpilih.nis, tagName, bln, formData.tahun);
                        if (check.status !== 'AVAILABLE') {
                            skippedMassalTagihan++;
                            return;
                        }

                        const masterRef = masterTagihanList.find(m => isTagihanMatch(m.tagihan, tagName)) || masterTagihanList.find(m => String(tagName).toLowerCase().trim().startsWith(String(m.tagihan).toLowerCase().trim()));
                        const awal = masterRef ? Number(masterRef.nominal) || 0 : 0;
                        
                        // Cek potongan diskon khusus santri (diskonKhusus) lebih dulu!
                        let disk = 0;
                        if (santriTerpilih.diskonKhusus && santriTerpilih.diskonKhusus[tagName] !== undefined && santriTerpilih.diskonKhusus[tagName] !== '') {
                            disk = Number(santriTerpilih.diskonKhusus[tagName]) || 0;
                        } else if (santriTerpilih.beasiswa && santriTerpilih.beasiswa > 0) {
                            disk = Math.round((awal * Number(santriTerpilih.beasiswa)) / 100);
                        }
                        const finalNominal = Math.max(0, awal - disk);

                        newTags.push({ id: `TGH-${Math.floor(Math.random() * 100000) + '-' + Date.now()}`, tanggal: new Date().toISOString().split('T')[0], nis: santriTerpilih.nis, nama: santriTerpilih.nama, tagihan: tagName, periode: periodeStr, nominalAwal: awal, diskon: disk, nominal: finalNominal, terbayar: 0, status: finalNominal === 0 ? 'Lunas' : 'Belum Lunas' });
                    });
                });
            });

            if (newTags.length === 0) return showNotification('Tidak ada tagihan yang dibuat. Semua tagihan yang dipilih sudah ada atau sudah lunas dibayar.');

            setDataTagihan(prev => [...newTags, ...prev]);
            showNotification(`${newTags.length} Tagihan massal berhasil dibuat!${skippedMassalTagihan > 0 ? ` (${skippedMassalTagihan} dilewati karena sudah ada/lunas)` : ''}`);
            closeModal();
            return;
        }

        if (!formData.nis) return showNotification("Harap cari dan pilih Santri terlebih dahulu!");
        const santriTerpilih = dataSantri.find(s => String(s.nis) === String(formData.nis)) || { nama: 'Santri Tidak Dikenal' };

        if (formData.id) {
            const periodeStr = formData.bulan && formData.tahun ? `${formData.bulan} ${formData.tahun}` : 'Juni 2026';
            const detail = formData.tagihanDetails?.[formData.tagihan] || { nominalAwal: formData.nominalAwal, diskon: formData.diskon };
            const nominalAwalAngka = parseInt(String(detail.nominalAwal).replace(/\D/g, ''), 10) || 0;
            const diskonAngka = parseInt(String(detail.diskon).replace(/\D/g, ''), 10) || 0;
            const finalNominal = Math.max(0, nominalAwalAngka - diskonAngka);

            setDataTagihan(prev => prev.map(t => t.id === formData.id ? { ...t, ...formData, nama: santriTerpilih.nama, nominalAwal: nominalAwalAngka, diskon: diskonAngka, nominal: finalNominal, periode: periodeStr } : t));
            addLog('UPDATE', 'TAGIHAN', `Memperbarui tagihan ${formData.tagihan} untuk ${santriTerpilih.nama}`);
            showNotification(`Tagihan berhasil diperbarui!`);
        } else {
            const selectedT = formData.selectedTagihans || [];
            const selectedB = formData.selectedBulan || [];
            if (selectedT.length === 0 || selectedB.length === 0) return showNotification('Pilih minimal 1 jenis tagihan dan 1 bulan!');

            const newTags = [];
            for (const tagName of selectedT) {
                for (const bln of selectedB) {
                    const periodeStr = `${bln} ${formData.tahun}`;
                    const detail = formData.tagihanDetails?.[tagName] || { nominalAwal: 0, diskon: 0 };
                    const awal = parseInt(String(detail.nominalAwal).replace(/\D/g, ''), 10) || 0;
                    let disk = detail.diskon !== undefined && detail.diskon !== '' ? parseInt(String(detail.diskon).replace(/\D/g, ''), 10) || 0 : 0;
                    if (disk === 0 && santriTerpilih?.diskonKhusus?.[tagName]) {
                        disk = Number(santriTerpilih.diskonKhusus[tagName]) || 0;
                    }
                    const finalNominal = Math.max(0, awal - disk);

                    const check = checkBillStatus(dataTagihan, dataPembayaran, formData.nis, tagName, bln, formData.tahun);
                    if (check.status === 'IN_TAGIHAN') {
                        alert(`PERINGATAN: ${check.message}\n\nPembuatan tagihan dibatalkan agar tidak duplikat.`);
                        return;
                    }
                    if (check.status === 'ALREADY_PAID') {
                        alert(`PERINGATAN: ${check.message}\n\nPembuatan tagihan dibatalkan karena tagihan tersebut sudah lunas dibayar.`);
                        return;
                    }

                    newTags.push({ id: `TGH-${Math.floor(Math.random() * 100000) + '-' + Date.now()}`, tanggal: new Date().toISOString().split('T')[0], nis: formData.nis, nama: santriTerpilih.nama, tagihan: tagName, periode: periodeStr, nominalAwal: awal, diskon: disk, nominal: finalNominal, terbayar: 0, status: finalNominal === 0 ? 'Lunas' : 'Belum Lunas' });
                }
            }
            setDataTagihan(prev => [...newTags, ...prev]);
            showNotification(`${newTags.length} Tagihan berhasil dibuat!`);

            const tNames = Array.from(new Set(newTags.map(t => t.tagihan))).join(', ');
            const bodyNotif = newTags.length === 1
                ? `Ada 1 tagihan ${newTags[0].tagihan} (${newTags[0].periode}) untuk Ananda ${santriTerpilih.nama}.`
                : `Ada ${newTags.length} tagihan baru (${tNames}) untuk Ananda ${santriTerpilih.nama}.`;
            triggerPushNotification(formData.nis, 'Info Tagihan Baru', bodyNotif);
        }
        closeModal();
    };

    const submitSantri = (e) => {
        e.preventDefault();
        const targetNis = formData.nis || `200${dataSantri.length + 1}`;
        const isDuplicate = dataSantri.some(s => s.nis === targetNis && s.id !== formData.id);
        if (isDuplicate) return showNotification('NIS sudah digunakan! Gunakan NIS lain.');

        const targetUid = formData.uid ? String(formData.uid).trim() : '';
        if (targetUid) {
            const cleanTargetUid = targetUid.replace(/^0+/, '');
            const isDuplicateUid = dataSantri.some(s => {
                if (s.id === formData.id) return false;
                const existingUid = String(s.uid || '').trim().replace(/^0+/, '');
                const existingRfid = String(s.rfid || '').trim().replace(/^0+/, '');
                return (existingUid === cleanTargetUid || existingRfid === cleanTargetUid);
            });
            if (isDuplicateUid) return showNotification('UID Kartu RFID sudah digunakan oleh Santri lain! Gunakan kartu yang berbeda.');
        }

        if (formData.id) {
            setDataSantri(prev => prev.map(s => s.id === formData.id ? { ...s, ...formData, nis: targetNis } : s));
            addLog('UPDATE', 'SANTRI', `Memperbarui data: ${formData.nama}`);
            showNotification('Data Santri diperbarui!');
        } else {
            const newSantri = { id: Math.floor(Math.random() * 8000000) + Date.now() % 1000, nis: targetNis, nama: formData.nama, kelas: formData.kelas, periode: formData.periode, status: 'Aktif', diskonKhusus: formData.diskonKhusus || {}, password: formData.password, uid: formData.uid || '', pin: formData.pin || '' };
            setDataSantri(prev => [...prev, newSantri]);
            addLog('CREATE', 'SANTRI', `Menambahkan santri: ${formData.nama} (NIS: ${newSantri.nis})`);
            showNotification('Santri ditambahkan!');
        }
        closeModal();
    };

    const submitPegawai = (e) => {
        e.preventDefault();
        const targetNip = formData.nip || `900${dataPegawai.length + 1}`;
        const isDuplicate = dataPegawai.some(p => p.nip === targetNip && p.id !== formData.id);
        if (isDuplicate) return showNotification('NIP sudah digunakan! Gunakan NIP lain.');

        if (formData.jabatan && formData.jabatan.trim()) {
            const jTrim = formData.jabatan.trim();
            setMasterJabatanList(prev => {
                if (!prev.some(j => j.toLowerCase().trim() === jTrim.toLowerCase())) {
                    return [...prev, jTrim];
                }
                return prev;
            });
        }

        if (formData.id) {
            setDataPegawai(prev => prev.map(p => p.id === formData.id ? { ...p, ...formData, nip: targetNip } : p));
            addLog('UPDATE', 'PEGAWAI', `Memperbarui data: ${formData.nama}`);
            showNotification('Data Pegawai diperbarui!');
        } else {
            const newPegawai = { id: Math.floor(Math.random() * 8000000) + Date.now() % 1000, nip: targetNip, nama: formData.nama, jabatan: formData.jabatan, gajiPokok: parseInt(String(formData.gajiPokok).replace(/\D/g, ''), 10) || 0, password: formData.password };
            setDataPegawai(prev => [...prev, newPegawai]);
            addLog('CREATE', 'PEGAWAI', `Menambahkan pegawai: ${formData.nama} (NIP: ${newPegawai.nip})`);
            showNotification('Pegawai ditambahkan!');
        }
        closeModal();
    };

    // Helper hitung saldo akumulatif tabungan santri (Setor bertambah, Tarik berkurang)
    const getSantriSaldoTabungan = (nis, list = dataTabungan) => {
        const sNisClean = String(nis || '').trim().replace(/^0+/, '');
        const sNisRaw = String(nis || '').trim();
        return (list || [])
            .filter(t => {
                const tNisClean = String(t.nis || t.NIS || '').trim().replace(/^0+/, '');
                const tNisRaw = String(t.nis || t.NIS || '').trim();
                return (sNisClean && tNisClean === sNisClean) || (sNisRaw && tNisRaw === sNisRaw);
            })
            .reduce((sum, item) => {
                const nom = Number(item.nominal || item.Nominal || 0);
                const j = String(item.jenis || item.Jenis || '').toLowerCase().trim();
                const isWithdraw = j === 'tarik' || j === 'keluar' || j.includes('tarik') || j.includes('keluar') || j === 'debet' || j === 'debit';
                return isWithdraw ? sum - nom : sum + nom;
            }, 0);
    };

    // Helper hitung pemakaian penarikan/jajan tabungan santri dalam periode tertentu
    const getUsageInPeriod = (nis, periode = 'harian', dataTabunganList = dataTabungan) => {
        const sNisClean = String(nis || '').replace(/^0+/, '');
        const now = new Date();
        const todayStr = now.toISOString().split('T')[0];
        
        let startDateStr = todayStr;
        if (periode === 'mingguan') {
            const day = now.getDay();
            const diffToMonday = (day === 0 ? -6 : 1) - day;
            const monday = new Date(now);
            monday.setDate(now.getDate() + diffToMonday);
            startDateStr = monday.toISOString().split('T')[0];
        } else if (periode === 'bulanan') {
            startDateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
        }
        
        const userWithdrawals = (dataTabunganList || []).filter(t => {
            const tNis = String(t.nis || t.NIS || '').trim().replace(/^0+/, '');
            const tJenis = String(t.jenis || t.Jenis || '').toLowerCase().trim();
            const isWithdraw = tJenis === 'tarik' || tJenis === 'keluar' || tJenis.includes('tarik') || tJenis.includes('keluar') || tJenis === 'debet' || tJenis === 'debit';
            const tDate = String(t.tanggal || t.Tanggal || '').split('T')[0];
            return (tNis === sNisClean || String(t.nis || t.NIS || '').trim() === String(nis || '').trim()) && isWithdraw && tDate >= startDateStr && tDate <= todayStr;
        });
        
        return userWithdrawals.reduce((sum, t) => sum + (Number(t.nominal || t.Nominal || 0)), 0);
    };

    // Helper untuk membaca konfigurasi limit santri (bisa custom atau default)
    const getSantriLimitConfig = (santri, appConfigObj = appConfig) => {
        if (!santri) return { limit: 0, periode: 'harian', isCustom: false };
        const globalCfg = appConfigObj?.tabunganLimitConfig || {};
        const santriMap = globalCfg?.santriLimits || {};
        const sNisClean = String(santri.nis || '').replace(/^0+/, '');
        const custom = santriMap[santri.nis] || santriMap[sNisClean];
        
        if (custom && custom.limit !== undefined) {
            return {
                limit: Number(custom.limit || 0),
                periode: custom.periode || 'harian',
                isCustom: true
            };
        }
        
        if (santri.limit_jajan_harian && Number(santri.limit_jajan_harian) > 0) {
            return {
                limit: Number(santri.limit_jajan_harian),
                periode: santri.limit_periode || 'harian',
                isCustom: true
            };
        }
        
        if (globalCfg.defaultLimit && Number(globalCfg.defaultLimit) > 0) {
            return {
                limit: Number(globalCfg.defaultLimit),
                periode: globalCfg.defaultPeriode || 'harian',
                isCustom: false
            };
        }
        
        return { limit: 0, periode: 'harian', isCustom: false };
    };

    const handleSaveLimitTabungan = async (e) => {
        e.preventDefault();
        const targetType = limitModalData.targetType || 'Semua';
        const nominal = parseInt(String(limitModalData.nominal || 0).replace(/\D/g, ''), 10) || 0;
        const periode = limitModalData.periode || 'harian';

        const currentConfig = { ...(appConfig.tabunganLimitConfig || {}) };
        const santriLimits = { ...(currentConfig.santriLimits || {}) };

        let updatedSantriList = [...dataSantri];

        if (targetType === 'Semua') {
            currentConfig.defaultLimit = nominal;
            currentConfig.defaultPeriode = periode;
            updatedSantriList = updatedSantriList.map(s => {
                const hasCustom = !!santriLimits[s.nis];
                if (!hasCustom) {
                    return { ...s, limit_jajan_harian: nominal, limit_periode: periode };
                }
                return s;
            });
        } else if (targetType === 'Kelas') {
            const targetKelas = limitModalData.selectedKelas;
            if (!targetKelas) return showNotification("Pilih kelas terlebih dahulu!");
            
            updatedSantriList = updatedSantriList.map(s => {
                if (String(s.kelas).trim().toLowerCase() === String(targetKelas).trim().toLowerCase()) {
                    santriLimits[s.nis] = { limit: nominal, periode: periode };
                    return { ...s, limit_jajan_harian: nominal, limit_periode: periode };
                }
                return s;
            });
            currentConfig.santriLimits = santriLimits;
        } else if (targetType === 'Santri') {
            const targetNis = limitModalData.selectedNis;
            if (!targetNis) return showNotification("Pilih santri terlebih dahulu!");

            santriLimits[targetNis] = { limit: nominal, periode: periode };
            currentConfig.santriLimits = santriLimits;

            updatedSantriList = updatedSantriList.map(s => {
                if (String(s.nis) === String(targetNis)) {
                    return { ...s, limit_jajan_harian: nominal, limit_periode: periode };
                }
                return s;
            });
        }

        setAppConfig(prev => ({ ...prev, tabunganLimitConfig: currentConfig }));
        setDataSantri(updatedSantriList);

        try {
            await supabase.from('MasterConfig').upsert({
                kunci: 'tabunganLimitConfig',
                nilai: JSON.stringify(currentConfig)
            }, { onConflict: 'kunci' });

            if (targetType === 'Santri') {
                await supabase.from('Data Santri').update({ limit_jajan_harian: nominal }).eq('nis', limitModalData.selectedNis);
            } else if (targetType === 'Kelas') {
                const affectedSantri = updatedSantriList.filter(s => String(s.kelas).trim().toLowerCase() === String(limitModalData.selectedKelas).trim().toLowerCase());
                for (const s of affectedSantri) {
                    await supabase.from('Data Santri').update({ limit_jajan_harian: nominal }).eq('nis', s.nis);
                }
            } else if (targetType === 'Semua') {
                for (const s of updatedSantriList) {
                    await supabase.from('Data Santri').update({ limit_jajan_harian: nominal }).eq('nis', s.nis);
                }
            }

            const periodeText = periode === 'mingguan' ? 'Per Minggu' : periode === 'bulanan' ? 'Per Bulan' : 'Per Hari';
            addLog('UPDATE', 'TABUNGAN', `Atur Limit Tabungan (${targetType}): Rp ${nominal.toLocaleString('id-ID')} (${periodeText})`);
            showNotification(`Pengaturan limit tabungan berhasil disimpan!`);
            closeModal();
        } catch (err) {
            console.error("Gagal simpan limit:", err);
            showNotification(`Gagal menyimpan limit: ${err.message || 'Error'}`, "error");
        }
    };

    const submitTabungan = (e) => {
        e.preventDefault();
        const s = dataSantri.find(s => String(s.nis) === String(formData.nis)) || { nama: 'Unknown' };
        const nom = parseInt(String(formData.nominal || '').replace(/\D/g, ''), 10) || 0;
        const jenis = formData.jenis || 'Setor';

        if (nom <= 0) return showNotification("Nominal transaksi tidak valid!");

        if (jenis === 'Tarik') {
            const currentSaldo = getSantriSaldoTabungan(formData.nis);

            if (nom > currentSaldo) {
                return showNotification(`Saldo tabungan tidak mencukupi! Saldo saat ini: Rp ${currentSaldo.toLocaleString('id-ID')}`);
            }

            const { limit, periode } = getSantriLimitConfig(s);
            if (limit > 0) {
                const used = getUsageInPeriod(formData.nis, periode);
                if (used + nom > limit) {
                    const periodeLabel = periode === 'mingguan' ? 'minggu' : periode === 'bulanan' ? 'bulan' : 'hari';
                    const confirmExceed = window.confirm(
                        `PERINGATAN LIMIT TABUNGAN:\n\n` +
                        `Santri: ${s.nama}\n` +
                        `Batas Limit: Rp ${limit.toLocaleString('id-ID')} / ${periodeLabel}\n` +
                        `Sudah Digunakan Periode Ini: Rp ${used.toLocaleString('id-ID')}\n` +
                        `Penarikan Ini: Rp ${nom.toLocaleString('id-ID')}\n` +
                        `Total Setelah Penarikan: Rp ${(used + nom).toLocaleString('id-ID')}\n\n` +
                        `Penarikan ini MELEBIHI batas limit yang telah diatur. Apakah Anda (Admin) ingin tetap melanjutkan transaksi ini?`
                    );
                    if (!confirmExceed) return;
                }
            }
        }

        setDataTabungan(prev => [{ id: `TB-${Date.now()}`, tanggal: new Date().toISOString().split('T')[0], nis: formData.nis, nama: s.nama, jenis: jenis, nominal: nom, keterangan: formData.keterangan || '' }, ...prev]);
        addLog('CREATE', 'TABUNGAN', `${jenis} Rp ${nom.toLocaleString('id-ID')} - ${s.nama}`);
        showNotification(`Tabungan dicatat!`);
        triggerPushNotification(formData.nis, 'Info Tabungan', `Transaksi ${jenis} Tabungan Rp ${nom.toLocaleString('id-ID')} untuk Ananda ${s.nama} berhasil dicatat.`);
        closeModal();
    };

    const handleSaveBukuKas = (e) => {
        e.preventDefault();
        const nom = parseInt(String(formData.nominal || '').replace(/\D/g, ''), 10) || 0;
        setDataKas(prev => [{ id: `KAS-${Date.now()}`, tanggal: formData.tanggal || new Date().toISOString().split('T')[0], tipeKas: formData.tipeKas, sumberTujuan: formData.sumberTujuan || 'Lainnya', nominal: nom, keterangan: formData.keterangan || '' }, ...prev]);
        addLog('CREATE', 'KAS', `${formData.tipeKas} Rp ${nom.toLocaleString('id-ID')} - ${formData.sumberTujuan || 'Lainnya'}`);
        showNotification(`Data Kas dicatat!`); closeModal();
    };

    const handleScanRFID = (e) => {
        e.preventDefault();
        const code = String(scanInput).trim().replace(/^0+/, '');
        if (!code) return;

        // Cari santri berdasarkan uid atau nis
        const santri = dataSantri.find(s =>
            String(s.uid || '').trim().replace(/^0+/, '') === code ||
            String(s.nis || '').trim().replace(/^0+/, '') === code
        );

        if (santri) {
            const saldoTabungan = getSantriSaldoTabungan(santri.nis);
            const totalTunggakan = dataTagihan
                .filter(t => String(t.nis).replace(/^0+/, '') === String(santri.nis).replace(/^0+/, '') && t.status !== 'Lunas')
                .reduce((sum, item) => sum + (Number(item.nominal || 0) - Number(item.terbayar || 0)), 0);

            setScanResult({
                found: true,
                santri: santri,
                saldoTabungan: saldoTabungan,
                totalTunggakan: totalTunggakan
            });
        } else {
            setScanResult({ found: false, code: scanInput });
        }

        // Reset input untuk scan berikutnya
        setScanInput('');
        if (scanInputRef.current) scanInputRef.current.focus();
    };

    const submitGaji = (e) => {
        e.preventDefault();
        const p = dataPegawai.find(x => x.nip === formData.nip) || { nama: 'Unknown' };
        const gapok = parseInt(String(formData.gajiPokok || 0).replace(/\D/g, ''), 10) || 0;
        const tj = parseInt(String(formData.tunjangan || 0).replace(/\D/g, ''), 10) || 0;
        const pt = parseInt(String(formData.potongan || 0).replace(/\D/g, ''), 10) || 0;
        const total = gapok + tj - pt;
        setDataGaji(prev => [{ id: `GJ-${Date.now()}`, tanggal: new Date().toISOString().split('T')[0], nip: formData.nip, nama: p.nama, periode: `${formData.bulan} ${formData.tahun}`, gajiPokok: gapok, tunjangan: tj, potongan: pt, totalBersih: total }, ...prev]);
        addLog('CREATE', 'GAJI', `Gaji ${p.nama} Rp ${total.toLocaleString('id-ID')} - ${formData.bulan} ${formData.tahun}`);
        showNotification(`Gaji Rp ${total.toLocaleString('id-ID')} dicatat!`); closeModal();
    };

    const submitLog = (e) => {
        e.preventDefault();
        if (!formData.detail) return showNotification("Detail log wajib diisi", "error");
        setDataLog(prev => prev.map(l => l.id === formData.id ? { ...l, aksi: formData.aksi, modul: formData.modul, detail: formData.detail } : l));
        addLog('UPDATE', 'LOG AKTIVITAS', `Mengubah log aktivitas ${formData.id}`);
        showNotification("Log berhasil diubah!");
        closeModal();
    };

    const handleImportCSV = (e, type) => {
        const file = e.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (event) => {
            try {
                const data = new Uint8Array(event.target.result);
                const workbook = XLSX.read(data, { type: 'array' });
                const firstSheetName = workbook.SheetNames[0];
                const worksheet = workbook.Sheets[firstSheetName];

                const json = XLSX.utils.sheet_to_json(worksheet, { header: 1 });
                let newData = [];

                let startIndex = 1;
                for (let i = 0; i < json.length; i++) {
                    if (json[i] && (String(json[i][0]).toUpperCase() === 'NIS' || String(json[i][0]).toUpperCase() === 'NIP')) {
                        startIndex = i + 1; break;
                    }
                }

                for (let i = startIndex; i < json.length; i++) {
                    const cells = json[i];
                    if (!cells || cells.length === 0 || !cells[0] || String(cells[0]).trim() === '') continue;

                    if (type === 'santri') {
                        newData.push({
                            id: Math.floor(Math.random() * 8000000) + i,
                            nis: String(cells[0] || '').trim(),
                            nama: String(cells[1] || '').trim(),
                            kelas: String(cells[2] || '').trim(),
                            periode: String(cells[3] || '').trim(),
                            status: String(cells[4] || 'Aktif').trim(), 
                            diskonKhusus: {},
                            password: Math.floor(1000 + Math.random() * 9000).toString(),
                            pin: Math.floor(1000 + Math.random() * 9000).toString()
                        });
                    } else {
                        newData.push({
                            id: Math.floor(Math.random() * 8000000) + i,
                            nip: String(cells[0] || '').trim(),
                            nama: String(cells[1] || '').trim(),
                            jabatan: String(cells[2] || '').trim(),
                            gajiPokok: parseInt(String(cells[3] || '').replace(/\D/g, ''), 10) || 0,
                            password: Math.floor(1000 + Math.random() * 9000).toString()
                        });
                    }
                }

                if (newData.length > 0) {
                    if (type === 'santri') {
                        setDataSantri(prev => [...newData, ...prev]);

                        // Otomatis masukkan Kelas baru ke Master Kelas
                        const importedKelas = [...new Set(newData.map(s => (s.kelas || '').trim()).filter(Boolean))];
                        if (importedKelas.length > 0) {
                            setMasterKelasList(prev => {
                                const existingLower = new Set(prev.map(k => k.toLowerCase().trim()));
                                const toAdd = importedKelas.filter(k => !existingLower.has(k.toLowerCase()));
                                return toAdd.length > 0 ? [...prev, ...toAdd] : prev;
                            });
                        }

                        // Otomatis masukkan Periode baru ke Master Periode
                        const importedPeriode = [...new Set(newData.map(s => (s.periode || '').trim()).filter(Boolean))];
                        if (importedPeriode.length > 0) {
                            setMasterPeriodeList(prev => {
                                const existingLower = new Set(prev.map(p => p.toLowerCase().trim()));
                                const toAdd = importedPeriode.filter(p => !existingLower.has(p.toLowerCase()));
                                return toAdd.length > 0 ? [...prev, ...toAdd] : prev;
                            });
                        }
                    } else {
                        setDataPegawai(prev => [...newData, ...prev]);

                        // Otomatis masukkan Jabatan baru ke Master Jabatan
                        const importedJabatans = [...new Set(newData.map(p => (p.jabatan || '').trim()).filter(Boolean))];
                        if (importedJabatans.length > 0) {
                            setMasterJabatanList(prev => {
                                const existingLower = new Set(prev.map(j => j.toLowerCase().trim()));
                                const toAdd = importedJabatans.filter(j => !existingLower.has(j.toLowerCase()));
                                return toAdd.length > 0 ? [...prev, ...toAdd] : prev;
                            });
                        }
                    }
                    showNotification(`${newData.length} data ${type} berhasil diimpor!`);
                    addLog('IMPORT', type.toUpperCase(), `Berhasil import ${newData.length} data`);
                } else {
                    showNotification('Tidak ada data valid yang ditemukan (Pastikan isi data di bawah judul kolom).');
                }
            } catch (err) {
                console.error(err);
                showNotification('Gagal memproses file. Pastikan berformat XLSX/Excel.');
            }
            closeModal();
        };
        reader.readAsArrayBuffer(file);
    };

    const handleDownloadTemplate = (type) => {
        const isSantri = type === 'santri';
        const title = isSantri ? "Template Import Data Santri" : "Template Import Data Pegawai";
        const headers = isSantri ? ['NIS', 'Nama Lengkap', 'Kelas', 'Periode', 'Password'] : ['NIP', 'Nama Lengkap', 'Jabatan', 'Gaji Pokok', 'Password'];
        const sampleData = isSantri ? ['1001', 'Ahmad Fulan', '10A', '2023/2024', '123456'] : ['9001', 'Ustadz Budi', 'Pengajar', '2000000', '123456'];

        try {
            const wb = XLSX.utils.book_new();
            const infoData = [
                [title],
                ['PENTING: Isi data di bawah baris judul warna biru. JANGAN mengubah/menghapus judul kolom (baris 4). Hapus baris contoh ini (Ahmad/Budi) sebelum Anda menyimpan & mengunggah.'],
                []
            ];
            const aoa = [...infoData, headers, sampleData];
            const ws = XLSX.utils.aoa_to_sheet(aoa);

            const titleAddr = XLSX.utils.encode_cell({ r: 0, c: 0 });
            if (ws[titleAddr]) ws[titleAddr].s = { font: { sz: 14, bold: true } };

            const descAddr = XLSX.utils.encode_cell({ r: 1, c: 0 });
            if (ws[descAddr]) ws[descAddr].s = { font: { color: { rgb: "DC2626" }, italic: true } };

            for (let c = 0; c < headers.length; c++) {
                const cellAddr = XLSX.utils.encode_cell({ r: 3, c });
                if (ws[cellAddr]) ws[cellAddr].s = { fill: { fgColor: { rgb: "2563EB" } }, font: { color: { rgb: "FFFFFF" }, bold: true } };
            }

            const wscols = headers.map(h => ({ wch: 22 }));
            ws['!cols'] = wscols;

            XLSX.utils.book_append_sheet(wb, ws, 'Template');
            XLSX.writeFile(wb, `Template_${type}.xlsx`);
        } catch (e) {
            console.error("Export Error:", e);
            showNotification("Gagal membuat template Excel.");
        }
    };

    const handleNaikKelas = (kelas = null) => {
        if (kelas) {
            setConfirmDialog({ type: 'NAIK_KELAS', id: kelas, nama: `Santri kelas ${kelas}`, targetKelas: kelas });
        } else {
            setConfirmDialog({ type: 'NAIK_KELAS', id: 'ALL', nama: 'Semua Santri Aktif (Massal)', targetKelas: null });
        }
    };

    // === STYLED EXCEL DOWNLOAD UTILITY ===
    const downloadStyledExcel = (title, headers, rows, filename) => {
        try {
            const d = formatDateID(new Date());
            const wb = XLSX.utils.book_new();
            const headerRows = [
                [title],
                [`${appConfig.appName || 'PesantrenTech'} — Diunduh: ${d}`],
                [],
                headers
            ];
            const aoa = [...headerRows, ...rows];
            const ws = XLSX.utils.aoa_to_sheet(aoa);

            for (let c = 0; c < headers.length; c++) {
                const cellAddr = XLSX.utils.encode_cell({ r: 3, c });
                if (ws[cellAddr]) {
                    ws[cellAddr].s = {
                        fill: { fgColor: { rgb: "10B981" } },
                        font: { color: { rgb: "FFFFFF" }, bold: true },
                        border: { top: { style: "thin", color: { rgb: "D1D5DB" } }, bottom: { style: "thin", color: { rgb: "D1D5DB" } }, left: { style: "thin", color: { rgb: "D1D5DB" } }, right: { style: "thin", color: { rgb: "D1D5DB" } } }
                    };
                }
            }
            const titleAddr = XLSX.utils.encode_cell({ r: 0, c: 0 });
            if (ws[titleAddr]) ws[titleAddr].s = { font: { sz: 16, bold: true, color: { rgb: "18181B" } } };

            const wscols = headers.map(h => ({ wch: Math.max(h.length + 5, 12) }));
            ws['!cols'] = wscols;

            XLSX.utils.book_append_sheet(wb, ws, 'Laporan');
            XLSX.writeFile(wb, `${filename}.xlsx`);

            showNotification(`${title} berhasil diunduh!`);
            addLog('DOWNLOAD', 'EXPORT', `Download: ${filename}`);
        } catch (e) {
            console.error("Excel Export Error:", e);
            showNotification("Gagal mengunduh Excel (Pastikan format data valid).");
        }
    };

    const handleDownloadExcel = () => {
        downloadStyledExcel('Laporan Dashboard (Pembayaran)', ['No. Invoice', 'Tanggal', 'NIS', 'Nama Santri', 'Jenis Tagihan', 'Periode Bulan', 'Nominal', 'Status'], dataPembayaran.map(trx => [trx.id, trx.tanggal, trx.nis, trx.nama, trx.tagihan, trx.periode, trx.nominal, trx.status]), 'Laporan_Dashboard');
    };

    const renderDashboard = () => {
        const totalPemasukan = dataPembayaran.reduce((sum, item) => sum + item.nominal, 0);
        const totalTunggakan = dataTagihan.filter(t => t.status !== 'Lunas').reduce((sum, item) => sum + (item.nominal - (item.terbayar || 0)), 0);
        const totalTabungan = dataTabungan.reduce((sum, item) => {
            const nom = Number(item.nominal || item.Nominal || 0);
            const j = String(item.jenis || item.Jenis || '').toLowerCase().trim();
            const isWithdraw = j === 'tarik' || j === 'keluar' || j.includes('tarik') || j.includes('keluar') || j === 'debet' || j === 'debit';
            return isWithdraw ? sum - nom : sum + nom;
        }, 0);
        const totalKasMasuk = totalPemasukan + dataKas.filter(t => t.tipeKas === 'MASUK').reduce((sum, item) => sum + item.nominal, 0);
        const totalKasKeluar = dataGaji.reduce((sum, g) => sum + g.totalBersih, 0) + dataKas.filter(t => t.tipeKas === 'KELUAR').reduce((sum, item) => sum + item.nominal, 0);
        const saldoKasUtama = totalKasMasuk - totalKasKeluar;

        const chartData = [{ name: 'Bulan Ini', Pemasukan: totalPemasukan }];
        const topTunggakan = dataSantri.slice(0, 5).map(s => ({ nis: s.nis, nama: s.nama, kelas: s.kelas, total: dataTagihan.filter(t => t.nis === s.nis && t.status !== 'Lunas').reduce((sum, t) => sum + (t.nominal - (t.terbayar || 0)), 0) })).filter(s => s.total > 0).sort((a, b) => b.total - a.total);

        const pengeluaranMap = {};
        dataGaji.forEach(g => {
            const p = dataPegawai.find(x => String(x.nip) === String(g.nip));
            const key = p ? p.jabatan : 'Gaji Lainnya';
            pengeluaranMap[key] = (pengeluaranMap[key] || 0) + g.totalBersih;
        });
        dataKas.filter(k => k.tipeKas === 'KELUAR').forEach(k => {
            const key = k.kategori || 'Operasional Lainnya';
            pengeluaranMap[key] = (pengeluaranMap[key] || 0) + k.nominal;
        });
        const pengeluaranArr = Object.keys(pengeluaranMap).map(k => ({ divisi: k, total: pengeluaranMap[k] })).filter(item => item.total > 0).sort((a, b) => b.total - a.total);
        const top5Pengeluaran = pengeluaranArr.slice(0, 5);
        const bottom5Pengeluaran = [...pengeluaranArr].reverse().slice(0, 5);

        return (
            <div className="space-y-6 animate-in fade-in duration-500">
                <div className="flex flex-col xl:flex-row justify-between items-start xl:items-center gap-4 mb-6 w-full">
                    <div className="flex-1 min-w-0 pr-4"><h2 className="text-2xl font-semibold tracking-tight text-ink">Dashboard & Analitik</h2><p className="text-sm text-steel">Ringkasan dan Analisis keuangan pesantren.</p></div>
                    <button onClick={handleDownloadExcel} className={btnOutline}><FileSpreadsheet className="w-4 h-4 text-green-600" /> Ekspor Lengkap</button>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                    <div className="bg-surface border border-whisper p-5 rounded-card p-6 shadow-card"><div className="flex items-center gap-3 mb-2"><TrendingUp className="w-5 h-5 text-blue-600" /><h3 className="font-medium text-steel">Total Pemasukan</h3></div><div className="text-2xl font-bold text-ink">Rp {totalPemasukan.toLocaleString('id-ID')}</div></div>
                    <div className="bg-surface border border-whisper p-5 rounded-card p-6 shadow-card"><div className="flex items-center gap-3 mb-2"><AlertCircle className="w-5 h-5 text-rose-600" /><h3 className="font-medium text-steel">Sisa Tunggakan</h3></div><div className="text-2xl font-bold text-ink">Rp {totalTunggakan.toLocaleString('id-ID')}</div></div>
                    <div className="bg-surface border border-whisper p-5 rounded-card p-6 shadow-card"><div className="flex items-center gap-3 mb-2"><Wallet className="w-5 h-5 text-emerald-600" /><h3 className="font-medium text-steel">Kas Utama</h3></div><div className="text-2xl font-bold text-ink">Rp {saldoKasUtama.toLocaleString('id-ID')}</div></div>
                    <div className="bg-surface border border-whisper p-5 rounded-card p-6 shadow-card"><div className="flex items-center gap-3 mb-2"><Zap className="w-5 h-5 text-amber-600" /><h3 className="font-medium text-steel">Tabungan Santri</h3></div><div className="text-2xl font-bold text-ink">Rp {totalTabungan.toLocaleString('id-ID')}</div></div>
                </div>
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 pt-4 border-t border-whisper/60">
                    <div className="lg:col-span-2 bg-surface border border-whisper p-5 rounded-lg">
                        <h3 className="font-semibold text-ink mb-4 flex items-center gap-2"><BarChart3 className="w-5 h-5 text-blue-600" /> Pemasukan Bulanan</h3>
                        <div className="h-72 w-full mt-4">
                            {chartData.length > 0 ? (
                                <ResponsiveContainer width="100%" height="100%"><BarChart data={chartData} margin={{ top: 10, right: 10, left: 10, bottom: 0 }}><CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" /><XAxis dataKey="name" axisLine={false} tickLine={false} tick={{ fill: '#64748b', fontSize: 12 }} dy={10} /><YAxis tickFormatter={(val) => `Rp ${val / 1000}k`} axisLine={false} tickLine={false} tick={{ fill: '#64748b', fontSize: 12 }} dx={-10} /><Tooltip cursor={{ fill: '#f1f5f9' }} formatter={(value) => [`Rp ${value.toLocaleString('id-ID')}`, 'Pemasukan']} /><Bar dataKey="Pemasukan" fill="#3b82f6" radius={[4, 4, 0, 0]} maxBarSize={50} /></BarChart></ResponsiveContainer>
                            ) : (<div className="h-full flex items-center justify-center text-steel text-sm">Belum ada data.</div>)}
                        </div>
                    </div>
                    <div className="flex flex-col gap-6">
                        <div className="bg-surface border border-whisper p-5 rounded-lg">
                            <h3 className="font-semibold text-ink mb-4 flex items-center gap-2"><Activity className="w-5 h-5 text-emerald-600" /> Rekap Arus Kas</h3>
                            <div className="space-y-3"><div className="flex justify-between items-center pb-2 border-b border-whisper"><span className="text-sm text-steel">Total Kas Masuk</span><span className="font-medium text-emerald-600">Rp {totalKasMasuk.toLocaleString('id-ID')}</span></div><div className="flex justify-between items-center pb-2 border-b border-whisper"><span className="text-sm text-steel">Total Kas Keluar</span><span className="font-medium text-rose-600">Rp {totalKasKeluar.toLocaleString('id-ID')}</span></div><div className="flex justify-between items-center pt-1"><span className="font-semibold text-ink">Saldo Bersih</span><span className="font-bold text-ink text-lg">Rp {saldoKasUtama.toLocaleString('id-ID')}</span></div></div>
                        </div>
                        <div className="bg-surface border border-whisper p-5 rounded-lg flex-1">
                            <h3 className="font-semibold text-ink mb-4 flex items-center gap-2"><AlertCircle className="w-5 h-5 text-rose-600" /> Top Tunggakan</h3>
                            {topTunggakan.length > 0 ? (<div className="space-y-3">{topTunggakan.map((t, idx) => (<div key={t.nis} className="flex justify-between items-center"><div className="flex items-center gap-2"><div className="w-6 h-6 rounded-full bg-whisper flex items-center justify-center text-xs font-bold text-steel">{idx + 1}</div><div><p className="text-sm font-medium text-ink line-clamp-1">{t.nama}</p><p className="text-xs text-steel">{t.kelas}</p></div></div><span className="text-sm font-semibold text-rose-600">Rp {Number(t.total || 0).toLocaleString('id-ID')}</span></div>))}</div>) : (<div className="text-sm text-steel text-center py-4">Semua santri lunas!</div>)}
                        </div>
                    </div>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6 pt-4 border-t border-whisper/60">
                    <div className="bg-surface border border-whisper p-5 rounded-lg">
                        <h3 className="font-semibold text-ink mb-4 flex items-center gap-2"><TrendingDown className="w-5 h-5 text-rose-600" /> 5 Pengeluaran Terbesar (Divisi/Jabatan)</h3>
                        {top5Pengeluaran.length > 0 ? (<div className="space-y-3">{top5Pengeluaran.map((item, idx) => (<div key={item.divisi} className="flex justify-between items-center"><div className="flex items-center gap-2"><div className="w-6 h-6 rounded-full bg-rose-50 flex items-center justify-center text-xs font-bold text-rose-600">{idx + 1}</div><span className="text-sm font-medium text-ink">{item.divisi}</span></div><span className="text-sm font-semibold text-rose-600">Rp {Number(item.total || 0).toLocaleString('id-ID')}</span></div>))}</div>) : (<div className="text-sm text-steel text-center py-4">Belum ada data pengeluaran.</div>)}
                    </div>
                    <div className="bg-surface border border-whisper p-5 rounded-lg">
                        <h3 className="font-semibold text-ink mb-4 flex items-center gap-2"><TrendingDown className="w-5 h-5 text-emerald-600" /> 5 Pengeluaran Terkecil (Divisi/Jabatan)</h3>
                        {bottom5Pengeluaran.length > 0 ? (<div className="space-y-3">{bottom5Pengeluaran.map((item, idx) => (<div key={item.divisi} className="flex justify-between items-center"><div className="flex items-center gap-2"><div className="w-6 h-6 rounded-full bg-emerald-50 flex items-center justify-center text-xs font-bold text-emerald-600">{idx + 1}</div><span className="text-sm font-medium text-ink">{item.divisi}</span></div><span className="text-sm font-semibold text-emerald-600">Rp {Number(item.total || 0).toLocaleString('id-ID')}</span></div>))}</div>) : (<div className="text-sm text-steel text-center py-4">Belum ada data pengeluaran.</div>)}
                    </div>
                </div>
            </div>
        );
    };

    const renderDataSantri = () => {
        const filteredSantri = dataSantri.filter(s => (periodeAktif === 'Semua' || s.periode === periodeAktif) && ((s.nama || '').toLowerCase().includes(searchTerm.toLowerCase()) || String(s.nis || '').includes(searchTerm)));
        
        const itemsPerPage = 10;
        const totalPages = Math.ceil(filteredSantri.length / itemsPerPage);
        const paginatedSantri = filteredSantri.slice((currentPage - 1) * itemsPerPage, currentPage * itemsPerPage);

        const filteredIds = paginatedSantri.map(s => s.id);
        const allChecked = filteredIds.length > 0 && filteredIds.every(id => selectedIds.includes(id));
        const someChecked = selectedIds.filter(id => filteredIds.includes(id)).length > 0;
        return (
            <div className="space-y-5 animate-fade-in-up">
                <div className="flex flex-col xl:flex-row justify-between items-start xl:items-center gap-4 mb-6 w-full">
                    <div className="flex-1 min-w-0 pr-4"><h2 className="text-2xl font-bold tracking-tight text-ink">Data Santri</h2><p className="text-sm text-steel mt-1">Kelola master santri dan diskon khusus.</p></div>
                    <div className="grid grid-cols-2 sm:flex sm:flex-wrap sm:justify-start xl:justify-end gap-3 w-full xl:w-auto">
                        <button onClick={() => { setFormData({ diskonKhusus: {}, nis: Math.floor(1000 + Math.random() * 9000).toString(), password: Math.floor(1000 + Math.random() * 9000).toString(), pin: Math.floor(1000 + Math.random() * 9000).toString() }); setModalType('FORM_SANTRI'); }} className={btnPrimary}><Plus className="w-4 h-4" /> Tambah Santri</button>
                        <button onClick={() => { setFormData({ type: 'santri' }); setModalType('IMPORT_CSV'); }} className={btnOutline}><DownloadCloud className="w-4 h-4" /> Import</button>
                        <div className="relative group flex w-full sm:w-auto shrink-0">
                            <button className="bg-purple-600 hover:bg-purple-700 text-white rounded-xl px-4 py-2.5 font-semibold flex items-center justify-center w-full sm:w-auto gap-2 text-sm shadow-sm"><Activity className="w-4 h-4" /> Naik Kelas ▾</button>
                            <div className="absolute right-0 top-full mt-1 bg-surface border border-whisper rounded-xl shadow-diffused w-52 hidden group-hover:block z-40 py-1">
                                <button onClick={() => handleNaikKelas()} className="w-full text-left px-4 py-2.5 text-sm font-medium hover:bg-canvas transition-colors text-ink">Semua Kelas (Massal)</button>
                                <div className="border-t border-whisper my-1"></div>
                                {masterKelasList.map(k => <button key={k} onClick={() => handleNaikKelas(k)} className="w-full text-left px-4 py-2.5 text-sm hover:bg-canvas transition-colors text-steel hover:text-ink">Kelas {k}</button>)}
                            </div>
                        </div>
                        <button onClick={() => downloadStyledExcel('Data Santri', ['NIS', 'Nama', 'Kelas', 'Periode', 'Status'], dataSantri.map(s => [s.nis, s.nama, s.kelas, s.periode, s.status]), 'Data_Santri')} className={btnOutline}><FileSpreadsheet className="w-4 h-4 text-accent" /> Unduh</button>
                    </div>
                </div>
                <div className="flex flex-wrap gap-2 mb-4">
                    <button onClick={() => { setFormData({}); setModalType('MASTER_PERIODE'); }} className={`${btnOutline} text-xs px-3 py-1.5`}><Settings className="w-3.5 h-3.5" /> Master Periode ({masterPeriodeList.length})</button>
                    <button onClick={() => { setFormData({}); setModalType('MASTER_KELAS'); }} className={`${btnOutline} text-xs px-3 py-1.5`}><Settings className="w-3.5 h-3.5" /> Master Kelas ({masterKelasList.length})</button>
                </div>
                {someChecked && (
                    <div className="bg-accent/5 border border-accent/20 rounded-xl px-4 py-2.5 flex items-center justify-between">
                        <span className="text-sm font-medium text-accent">{selectedIds.filter(id => filteredIds.includes(id)).length} data terpilih</span>
                        <button onClick={() => executeBulkDelete('SANTRI', setDataSantri, 'santri')} className={btnDanger}><Trash2 className="w-4 h-4" /> Hapus Terpilih</button>
                    </div>
                )}
                <div className="bg-surface border border-whisper shadow-card rounded-card overflow-hidden">
                    <div className="p-4 border-b border-whisper/50 flex flex-col sm:flex-row justify-between gap-4 bg-canvas/40">
                        <select className={`${inputBase} w-48`} value={periodeAktif} onChange={(e) => setPeriodeAktif(e.target.value)}><option value="Semua">Semua Periode</option>{masterPeriodeList.map(p => <option key={p} value={p}>{p}</option>)}</select>
                        <div className="relative"><Search className="w-4 h-4 absolute left-3 top-3 text-steel" /><input type="text" placeholder="Cari NIS / Nama..." value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} className={`${inputBase} pl-9 w-full sm:w-64`} /></div>
                    </div>
                    <div className="overflow-x-auto hidden md:block">
                        <table className="w-full text-sm text-left">
                            <thead className="bg-canvas/60 text-steel border-b border-whisper/50"><tr>
                                <th className="px-4 py-3 w-10"><input type="checkbox" checked={allChecked} onChange={() => toggleSelectAll(filteredIds)} className="w-4 h-4 rounded border-whisper text-accent focus:ring-accent/30 cursor-pointer" /></th>
                                <th className="px-4 py-3">NIS</th><th className="px-4 py-3">Nama Lengkap</th><th className="px-4 py-3">Kelas</th><th className="px-4 py-3 text-center">Aksi</th>
                            </tr></thead>
                            <tbody className="divide-y divide-whisper/50">
                                {paginatedSantri.length === 0 ? (
                                    <tr><td colSpan="100%" className="text-center py-8 text-steel">Belum ada data santri.</td></tr>
                                ) : paginatedSantri.map((santri, idx) => (
                                    <tr key={`${santri.id}-${idx}`} className={`hover:bg-canvas transition-colors ${selectedIds.includes(santri.id) ? 'bg-accent/5' : 'bg-surface'}`}>
                                        <td className="px-4 py-3"><input type="checkbox" checked={selectedIds.includes(santri.id)} onChange={() => toggleSelectId(santri.id)} className="w-4 h-4 rounded border-whisper text-accent focus:ring-accent/30 cursor-pointer" /></td>
                                        <td className="px-4 py-3 font-medium text-ink font-mono text-xs">{santri.nis}</td>
                                        <td className="px-4 py-3 text-ink font-medium">{santri.nama}</td>
                                        <td className="px-4 py-3 text-steel">{santri.kelas}</td>
                                        <td className="px-4 py-3 flex justify-center gap-3">
                                            <button onClick={() => { setFormData(santri); setModalType('FORM_SANTRI'); }} className="text-accent hover:text-accentDark"><Edit className="w-4 h-4" /></button>
                                            <button onClick={() => confirmDelete('SANTRI', santri.id, santri.nama)} className="text-danger hover:text-red-700"><Trash2 className="w-4 h-4" /></button>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                    <div className="md:hidden flex flex-col divide-y divide-whisper/50">
                        {paginatedSantri.length === 0 ? (
                            <div className="text-center py-8 text-steel text-sm">Belum ada data santri.</div>
                        ) : paginatedSantri.map((santri, idx) => (
                            <div key={`${santri.id}-${idx}`} className={`p-4 flex items-center justify-between gap-3 ${selectedIds.includes(santri.id) ? 'bg-accent/5' : 'bg-surface'}`}>
                                <div className="flex items-center gap-3 min-w-0">
                                    <input type="checkbox" checked={selectedIds.includes(santri.id)} onChange={() => toggleSelectId(santri.id)} className="w-4 h-4 shrink-0 rounded border-whisper text-accent focus:ring-accent/30 cursor-pointer" />
                                    <div className="min-w-0">
                                        <div className="font-medium text-ink truncate text-base">{santri.nama}</div>
                                        <div className="text-xs text-steel mt-0.5"><span className="font-mono">{santri.nis}</span> • Kelas {santri.kelas}</div>
                                    </div>
                                </div>
                                <div className="flex items-center gap-2 shrink-0">
                                    <button onClick={() => { setFormData(santri); setModalType('FORM_SANTRI'); }} className="p-2 text-accent bg-accent/10 hover:bg-accent/20 rounded-lg"><Edit className="w-4 h-4" /></button>
                                    <button onClick={() => confirmDelete('SANTRI', santri.id, santri.nama)} className="p-2 text-danger bg-dangerBg hover:bg-red-100 rounded-lg"><Trash2 className="w-4 h-4" /></button>
                                </div>
                            </div>
                        ))}
                    </div>
                    
                    {totalPages > 0 && (
                        <div className="flex justify-center items-center gap-4 p-4 border-t border-whisper/50 bg-canvas/30">
                            <button onClick={() => setCurrentPage(p => Math.max(1, p - 1))} disabled={currentPage === 1} className="px-3 py-1.5 text-sm font-medium border border-whisper rounded-lg bg-surface hover:bg-canvas disabled:opacity-50 disabled:cursor-not-allowed text-ink">Prev</button>
                            <span className="text-sm text-steel font-medium">Hal {currentPage} dari {totalPages}</span>
                            <button onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))} disabled={currentPage === totalPages} className="px-3 py-1.5 text-sm font-medium border border-whisper rounded-lg bg-surface hover:bg-canvas disabled:opacity-50 disabled:cursor-not-allowed text-ink">Next</button>
                        </div>
                    )}
                </div>
            </div>
        );
    };

    const renderDataPegawai = () => {
        const filtered = dataPegawai.filter(p => (p.nama || '').toLowerCase().includes(searchTerm.toLowerCase()) || String(p.nip || '').includes(searchTerm));
        
        const itemsPerPage = 10;
        const totalPages = Math.ceil(filtered.length / itemsPerPage);
        const paginatedPegawai = filtered.slice((currentPage - 1) * itemsPerPage, currentPage * itemsPerPage);

        const filteredIds = paginatedPegawai.map(p => p.id);
        const allChecked = filteredIds.length > 0 && filteredIds.every(id => selectedIds.includes(id));
        const someChecked = selectedIds.filter(id => filteredIds.includes(id)).length > 0;
        return (
            <div className="space-y-5 animate-fade-in-up">
                <div className="flex flex-col xl:flex-row justify-between items-start xl:items-center gap-4 mb-6 w-full">
                    <div className="flex-1 min-w-0 pr-4"><h2 className="text-2xl font-bold tracking-tight text-ink">Data Pegawai</h2><p className="text-sm text-steel mt-1">Kelola Ustadz & Karyawan.</p></div>
                    <div className="grid grid-cols-2 sm:flex sm:flex-wrap sm:justify-start xl:justify-end gap-3 w-full xl:w-auto">
                        <button onClick={() => { setFormData({ nip: Math.floor(1000 + Math.random() * 9000).toString(), password: Math.floor(1000 + Math.random() * 9000).toString() }); setModalType('FORM_PEGAWAI'); }} className={btnPrimary}><Plus className="w-4 h-4" /> Tambah Pegawai</button>
                        <button onClick={() => { setFormData({ type: 'pegawai' }); setModalType('IMPORT_CSV'); }} className={btnOutline}><DownloadCloud className="w-4 h-4" /> Import</button>
                        <button onClick={() => downloadStyledExcel('Data Pegawai', ['NIP', 'Nama', 'Jabatan', 'Gaji Pokok'], dataPegawai.map(p => [p.nip, p.nama, p.jabatan, p.gajiPokok]), 'Data_Pegawai')} className={btnOutline}><FileSpreadsheet className="w-4 h-4 text-accent" /> Unduh</button>
                    </div>
                </div>
                <div className="flex flex-wrap gap-2 mb-4">
                    <button onClick={() => { setFormData({}); setModalType('MASTER_JABATAN'); }} className={`${btnOutline} text-xs px-3 py-1.5`}><Settings className="w-3.5 h-3.5" /> Master Jabatan ({masterJabatanList.length})</button>
                </div>
                {someChecked && (
                    <div className="bg-accent/5 border border-accent/20 rounded-xl px-4 py-2.5 flex items-center justify-between">
                        <span className="text-sm font-medium text-accent">{selectedIds.filter(id => filteredIds.includes(id)).length} data terpilih</span>
                        <button onClick={() => executeBulkDelete('PEGAWAI', setDataPegawai, 'pegawai')} className={btnDanger}><Trash2 className="w-4 h-4" /> Hapus Terpilih</button>
                    </div>
                )}
                <div className="bg-surface border border-whisper shadow-card rounded-card overflow-hidden">
                    <div className="p-4 border-b border-whisper/50 flex justify-end bg-canvas/40">
                        <div className="relative"><Search className="w-4 h-4 absolute left-3 top-3 text-steel" /><input type="text" placeholder="Cari NIP / Nama..." value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} className={`${inputBase} pl-9 w-full sm:w-64`} /></div>
                    </div>
                    <div className="overflow-x-auto hidden md:block">
                        <table className="w-full text-sm text-left">
                            <thead className="bg-canvas/60 text-steel border-b border-whisper/50"><tr>
                                <th className="px-4 py-3 w-10"><input type="checkbox" checked={allChecked} onChange={() => toggleSelectAll(filteredIds)} className="w-4 h-4 rounded border-whisper text-accent focus:ring-accent/30 cursor-pointer" /></th>
                                <th className="px-4 py-3">NIP</th><th className="px-4 py-3">Nama Lengkap</th><th className="px-4 py-3">Jabatan</th><th className="px-4 py-3 text-right">Gaji Pokok</th><th className="px-4 py-3 text-center">Aksi</th>
                            </tr></thead>
                            <tbody className="divide-y divide-whisper/50">
                                {paginatedPegawai.length === 0 ? (
                                    <tr><td colSpan="100%" className="text-center py-8 text-steel">Belum ada data pegawai.</td></tr>
                                ) : paginatedPegawai.map((p, idx) => (
                                    <tr key={`${p.id}-${idx}`} className={`hover:bg-canvas transition-colors ${selectedIds.includes(p.id) ? 'bg-accent/5' : 'bg-surface'}`}>
                                        <td className="px-4 py-3"><input type="checkbox" checked={selectedIds.includes(p.id)} onChange={() => toggleSelectId(p.id)} className="w-4 h-4 rounded border-whisper text-accent focus:ring-accent/30 cursor-pointer" /></td>
                                        <td className="px-4 py-3 font-medium text-ink font-mono text-xs">{p.nip}</td><td className="px-4 py-3 text-ink font-medium">{p.nama}</td><td className="px-4 py-3 text-steel">{p.jabatan}</td><td className="px-4 py-3 text-right font-medium font-mono text-xs">Rp {(p.gajiPokok || 0).toLocaleString('id-ID')}</td>
                                        <td className="px-4 py-3 flex justify-center gap-3">
                                            <button onClick={() => { setFormData(p); setModalType('FORM_PEGAWAI'); }} className="text-accent hover:text-accentDark"><Edit className="w-4 h-4" /></button>
                                            <button onClick={() => confirmDelete('PEGAWAI', p.id, p.nama)} className="text-danger hover:text-red-700"><Trash2 className="w-4 h-4" /></button>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                    <div className="md:hidden flex flex-col divide-y divide-whisper/50">
                        {paginatedPegawai.length === 0 ? (
                            <div className="text-center py-8 text-steel text-sm">Belum ada data pegawai.</div>
                        ) : paginatedPegawai.map((p, idx) => (
                            <div key={`${p.id}-${idx}`} className={`p-4 flex flex-col gap-3 ${selectedIds.includes(p.id) ? 'bg-accent/5' : 'bg-surface'}`}>
                                <div className="flex items-center justify-between gap-3">
                                    <div className="flex items-center gap-3 min-w-0">
                                        <input type="checkbox" checked={selectedIds.includes(p.id)} onChange={() => toggleSelectId(p.id)} className="w-4 h-4 shrink-0 rounded border-whisper text-accent focus:ring-accent/30 cursor-pointer" />
                                        <div className="min-w-0">
                                            <div className="font-medium text-ink truncate text-base">{p.nama}</div>
                                            <div className="text-xs text-steel mt-0.5"><span className="font-mono">{p.nip}</span> • {p.jabatan}</div>
                                        </div>
                                    </div>
                                    <div className="text-right shrink-0">
                                        <div className="text-sm font-bold text-ink">Rp {(p.gajiPokok || 0).toLocaleString('id-ID')}</div>
                                    </div>
                                </div>
                                <div className="flex items-center gap-2 justify-end w-full border-t border-whisper/50 pt-3 mt-1">
                                    <button onClick={() => { setFormData(p); setModalType('FORM_PEGAWAI'); }} className="flex-1 flex items-center justify-center gap-2 py-2 text-accent bg-accent/10 hover:bg-accent/20 rounded-lg text-sm font-medium"><Edit className="w-4 h-4" /> Edit</button>
                                    <button onClick={() => confirmDelete('PEGAWAI', p.id, p.nama)} className="flex-1 flex items-center justify-center gap-2 py-2 text-danger bg-dangerBg hover:bg-red-100 rounded-lg text-sm font-medium"><Trash2 className="w-4 h-4" /> Hapus</button>
                                </div>
                            </div>
                        ))}
                    </div>
                    
                    {totalPages > 0 && (
                        <div className="flex justify-center items-center gap-4 p-4 border-t border-whisper/50 bg-canvas/30">
                            <button onClick={() => setCurrentPage(p => Math.max(1, p - 1))} disabled={currentPage === 1} className="px-3 py-1.5 text-sm font-medium border border-whisper rounded-lg bg-surface hover:bg-canvas disabled:opacity-50 disabled:cursor-not-allowed text-ink">Prev</button>
                            <span className="text-sm text-steel font-medium">Hal {currentPage} dari {totalPages}</span>
                            <button onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))} disabled={currentPage === totalPages} className="px-3 py-1.5 text-sm font-medium border border-whisper rounded-lg bg-surface hover:bg-canvas disabled:opacity-50 disabled:cursor-not-allowed text-ink">Next</button>
                        </div>
                    )}
                </div>
            </div>
        );
    };

    const renderTagihan = () => {
        const filtered = dataTagihan.filter(t => String(t.status || '').trim().toLowerCase() !== 'lunas' && ((t.nama || '').toLowerCase().includes(searchTerm.toLowerCase()) || String(t.nis || '').includes(searchTerm)));
        
        const itemsPerPage = 10;
        const totalPages = Math.ceil(filtered.length / itemsPerPage);
        const paginatedTagihan = filtered.slice((currentPage - 1) * itemsPerPage, currentPage * itemsPerPage);

        const filteredIds = paginatedTagihan.map(t => t.id);
        const allChecked = filteredIds.length > 0 && filteredIds.every(id => selectedIds.includes(id));
        return (
            <div className="space-y-6 animate-in fade-in duration-500">
                <div className="flex flex-col xl:flex-row justify-between items-start xl:items-center gap-4 mb-6 w-full">
                    <div className="flex-1 min-w-0 pr-4"><h2 className="text-2xl font-semibold tracking-tight text-ink">Tagihan Santri</h2><p className="text-sm text-steel">Daftar tagihan wajib dibayar santri.</p></div>
                    <div className="grid grid-cols-2 sm:flex sm:flex-wrap sm:justify-start xl:justify-end gap-3 w-full xl:w-auto">
                        <button onClick={() => setModalType('MASTER_TAGIHAN_LIST')} className={btnOutline}><Settings className="w-4 h-4" /> Master Tagihan</button>
                        <button onClick={() => { const d = new Date(); setFormData({ targetType: 'Semua', selectedBulan: [listBulan[d.getMonth()]], tahun: d.getFullYear(), selectedTagihans: [] }); setModalType('GENERATE_MASSAL'); }} className="bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg px-4 py-2 font-medium flex items-center gap-2 text-sm"><Zap className="w-4 h-4" /> Generate Massal</button>
                        <button onClick={() => { const d = new Date(); setFormData({ selectedTagihans: [], tagihanDetails: {}, selectedBulan: [listBulan[d.getMonth()]], tahun: d.getFullYear() }); setModalType('FORM_TAGIHAN_SANTRI'); }} className={btnPrimary}><Plus className="w-4 h-4" /> Buat Tagihan</button>
                        <button onClick={() => downloadStyledExcel('Tagihan Santri', ['ID', 'Tanggal', 'NIS', 'Nama', 'Tagihan', 'Periode', 'Nominal', 'Terbayar', 'Status'], dataTagihan.map(t => [t.id, t.tanggal, t.nis, t.nama, t.tagihan, t.periode, t.nominal, t.terbayar || 0, t.status]), 'Tagihan_Santri')} className={btnOutline}><FileSpreadsheet className="w-4 h-4 text-accent" /> Unduh</button>
                    </div>
                </div>
                <div className="bg-surface border border-whisper shadow-sm rounded-card overflow-hidden">
                    <div className="p-4 border-b border-whisper/50 flex flex-col sm:flex-row justify-between sm:justify-end items-center gap-3 bg-canvas/40">
                        <div className="relative w-full sm:w-auto">
                            <Search className="w-4 h-4 absolute left-3 top-3 text-steel" />
                            <input type="text" placeholder="Cari santri..." value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} className={`${inputBase} pl-9 w-full sm:w-64`} />

                        </div>
                        {selectedIds.length > 0 && (
                            <button onClick={() => executeBulkDelete('TAGIHAN', setDataTagihan, 'tagihan')} className="w-full sm:w-auto px-4 py-2.5 bg-rose-50 text-rose-600 font-medium text-sm rounded-xl hover:bg-rose-100 flex items-center justify-center gap-2 border border-rose-200"><Trash2 className="w-4 h-4" /> Hapus ({selectedIds.length})</button>
                        )}
                    </div>
                    <div className="overflow-x-auto hidden md:block">
                        <table className="w-full text-sm text-left">
                            <thead className="bg-canvas/60 text-steel border-b border-whisper/50"><tr><th className="px-6 py-3 w-12 text-center"><input type="checkbox" checked={allChecked} onChange={() => toggleSelectAll(filteredIds)} className="w-4 h-4 rounded border-whisper text-accent cursor-pointer" /></th><th className="px-6 py-3">Tagihan</th><th className="px-6 py-3">Santri</th><th className="px-6 py-3">Periode</th><th className="px-6 py-3 text-right">Nominal</th><th className="px-6 py-3">Status</th><th className="px-6 py-3 text-center">Aksi</th></tr></thead>
                            <tbody className="divide-y divide-slate-100">
                                {paginatedTagihan.length === 0 ? (
                                    <tr><td colSpan="100%" className="text-center py-8 text-steel">Tidak ada tagihan ditemukan.</td></tr>
                                ) : paginatedTagihan.map((trx, idx) => (
                                    <tr key={`${trx.id}-${idx}`} className="bg-surface hover:bg-canvas">
                                        <td className="px-6 py-4 text-center"><input type="checkbox" checked={selectedIds.includes(trx.id)} onChange={() => toggleSelectId(trx.id)} className="w-4 h-4 rounded border-whisper text-accent cursor-pointer" /></td>
                                        <td className="px-6 py-4 font-medium text-ink">{trx.tagihan}</td>
                                        <td className="px-6 py-4">{trx.nama} <span className="text-xs text-steel block">{trx.nis}</span></td>
                                        <td className="px-6 py-4 text-steel">{trx.periode}</td>
                                        <td className="px-6 py-4 text-right">
                                            <div className="font-medium">Rp {Number(trx.nominal || 0).toLocaleString('id-ID')}</div>
                                            {trx.diskon > 0 && <div className="text-xs text-emerald-600 mt-1 font-medium">(Diskon: Rp {Number(trx.diskon || 0).toLocaleString('id-ID')})</div>}
                                            {trx.status === 'Cicil' && <div className="text-xs text-amber-600 mt-1 font-medium">Sisa: Rp {(trx.nominal - (trx.terbayar || 0)).toLocaleString('id-ID')}</div>}
                                        </td>
                                        <td className="px-6 py-4"><span className={`inline-flex px-2 py-1 text-xs font-medium rounded-md ${trx.status === 'Lunas' ? 'bg-emerald-50 text-emerald-700' : trx.status === 'Cicil' ? 'bg-amber-50 text-amber-700' : 'bg-rose-50 text-rose-700'}`}>{trx.status}</span></td>
                                        <td className="px-6 py-4 text-center flex justify-center gap-2">
                                            {trx.status !== 'Lunas' && (
                                                <>
                                                    <button onClick={() => {
                                                        const sisa = trx.nominal - (trx.terbayar || 0);
                                                        if (sisa <= 0 || trx.status === 'Lunas') {
                                                            alert('Peringatan: Tagihan ini sudah LUNAS! Pembayaran ditolak.');
                                                            return;
                                                        }
                                                        const [bln, thn] = (trx.periode || 'Juni 2026').split(' ');
                                                        setFormData({ nis: trx.nis, selectedTagihanBayar: [trx.id], bulan: bln, tahun: thn, nominal: sisa <= 0 ? 0 : sisa });
                                                        setModalType('FORM_PEMBAYARAN');
                                                    }} className="text-emerald-600 hover:text-emerald-800 font-medium text-xs bg-emerald-50 px-2 py-1 rounded border border-emerald-200">Bayar</button>
                                                    <button onClick={() => {
                                                        const sisa = trx.nominal - (trx.terbayar || 0);
                                                        setFormData({ id: trx.id, nama: trx.nama, tagihan: trx.tagihan, sisa: sisa });
                                                        setPakasirData({ step: 'CHOOSE_METHOD', qrString: null, loading: false, url: '' });
                                                        setModalType('FORM_PAKASIR');
                                                    }} className="text-blue-600 hover:text-blue-800 font-medium text-xs bg-blue-50 px-2 py-1 rounded border border-blue-200 flex items-center gap-1" title="Bayar via QRIS / VA"><QrCode className="w-3 h-3" /> QRIS/VA</button>
                                                </>
                                            )}
                                            <button onClick={() => {
                                                const [b, t] = (trx.periode || ' ').split(' ');
                                                setFormData({ ...trx, tagihanDetails: { [trx.tagihan]: { nominalAwal: trx.nominalAwal, diskon: trx.diskon } }, bulan: b, tahun: t });
                                                setModalType('FORM_TAGIHAN_SANTRI');
                                            }} className="text-blue-600 hover:text-blue-800 ml-1"><Edit className="w-4 h-4" /></button>
                                            <button onClick={() => confirmDelete('TAGIHAN_SANTRI', trx.id, trx.tagihan)} className="text-rose-600 hover:text-rose-800"><Trash2 className="w-4 h-4" /></button>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                    <div className="md:hidden flex flex-col divide-y divide-whisper/50">
                        {paginatedTagihan.length === 0 ? (
                            <div className="text-center py-8 text-steel text-sm">Tidak ada tagihan ditemukan.</div>
                        ) : paginatedTagihan.map((trx, idx) => (
                            <div key={`${trx.id}-${idx}`} className={`p-4 flex flex-col gap-3 ${selectedIds.includes(trx.id) ? 'bg-accent/5' : 'bg-surface'}`}>
                                <div className="flex justify-between items-start gap-3">
                                    <div className="flex items-start gap-3 min-w-0">
                                        <input type="checkbox" checked={selectedIds.includes(trx.id)} onChange={() => toggleSelectId(trx.id)} className="w-4 h-4 mt-1 shrink-0 rounded border-whisper text-accent focus:ring-accent/30 cursor-pointer" />
                                        <div className="min-w-0">
                                            <div className="font-bold text-ink truncate text-sm">{trx.nama}</div>
                                            <div className="text-xs text-steel mt-0.5"><span className="font-mono">{trx.nis}</span> • {trx.tagihan} ({trx.periode})</div>
                                        </div>
                                    </div>
                                    <div className="text-right shrink-0">
                                        <div className="text-sm font-bold text-ink">Rp {Number(trx.nominal || 0).toLocaleString('id-ID')}</div>
                                        {trx.status === 'Cicil' && <div className="text-[10px] text-amber-600 font-bold mt-0.5">Sisa: Rp {(trx.nominal - (trx.terbayar || 0)).toLocaleString('id-ID')}</div>}
                                        <span className={`inline-block mt-1 px-1.5 py-0.5 text-[10px] font-bold uppercase rounded ${trx.status === 'Lunas' ? 'bg-emerald-50 text-emerald-700' : trx.status === 'Cicil' ? 'bg-amber-50 text-amber-700' : 'bg-rose-50 text-rose-700'}`}>{trx.status}</span>
                                    </div>
                                </div>
                                <div className="flex flex-wrap items-center gap-2 justify-end w-full border-t border-whisper/50 pt-3 mt-1">
                                    {trx.status !== 'Lunas' && (
                                        <button onClick={() => {
                                            const [bln, thn] = (trx.periode || 'Juni 2026').split(' ');
                                            const sisa = trx.nominal - (trx.terbayar || 0);
                                            setFormData({ nis: trx.nis, selectedTagihanBayar: [trx.id], bulan: bln, tahun: thn, nominal: sisa });
                                            setModalType('FORM_PEMBAYARAN');
                                        }} className="flex items-center gap-1 text-emerald-700 bg-emerald-50 hover:bg-emerald-100 font-bold text-xs px-3 py-1.5 rounded-lg border border-emerald-100"><CheckCircle2 className="w-3.5 h-3.5" /> Bayar</button>
                                    )}
                                    <button onClick={() => {
                                        const [b, t] = (trx.periode || ' ').split(' ');
                                        setFormData({ ...trx, tagihanDetails: { [trx.tagihan]: { nominalAwal: trx.nominalAwal, diskon: trx.diskon } }, bulan: b, tahun: t });
                                        setModalType('FORM_TAGIHAN_SANTRI');
                                    }} className="p-1.5 text-blue-600 bg-blue-50 hover:bg-blue-100 rounded-lg"><Edit className="w-4 h-4" /></button>
                                    <button onClick={() => confirmDelete('TAGIHAN_SANTRI', trx.id, trx.tagihan)} className="p-1.5 text-danger bg-dangerBg hover:bg-red-100 rounded-lg"><Trash2 className="w-4 h-4" /></button>
                                </div>
                            </div>
                        ))}
                    </div>
                    
                    {totalPages > 0 && (
                        <div className="flex justify-center items-center gap-4 p-4 border-t border-whisper/50 bg-canvas/30">
                            <button onClick={() => setCurrentPage(p => Math.max(1, p - 1))} disabled={currentPage === 1} className="px-3 py-1.5 text-sm font-medium border border-whisper rounded-lg bg-surface hover:bg-canvas disabled:opacity-50 disabled:cursor-not-allowed text-ink">Prev</button>
                            <span className="text-sm text-steel font-medium">Hal {currentPage} dari {totalPages}</span>
                            <button onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))} disabled={currentPage === totalPages} className="px-3 py-1.5 text-sm font-medium border border-whisper rounded-lg bg-surface hover:bg-canvas disabled:opacity-50 disabled:cursor-not-allowed text-ink">Next</button>
                        </div>
                    )}
                </div>
            </div>
        );
    };

    const renderPembayaran = () => {
        const filtered = dataPembayaran.filter(t => (masterTagihanFilter === 'Semua Tagihan' || t.tagihan.includes(masterTagihanFilter)) && ((t.nama || '').toLowerCase().includes(searchTerm.toLowerCase()) || String(t.nis || '').includes(searchTerm)));
        
        const itemsPerPage = 10;
        const totalPages = Math.ceil(filtered.length / itemsPerPage);
        const paginatedTrx = filtered.slice((currentPage - 1) * itemsPerPage, currentPage * itemsPerPage);

        const filteredIds = paginatedTrx.map(t => t.id);
        const allChecked = filteredIds.length > 0 && filteredIds.every(id => selectedIds.includes(id));
        return (
            <div className="space-y-6 animate-in fade-in duration-500">
                <div className="flex flex-col xl:flex-row justify-between items-start xl:items-center gap-4 mb-6 w-full">
                    <div className="flex-1 min-w-0 pr-4"><h2 className="text-2xl font-semibold tracking-tight text-ink">Transaksi Uang Masuk</h2><p className="text-sm text-steel">Riwayat pembayaran yang diterima.</p></div>
                    <div className="grid grid-cols-2 sm:flex sm:flex-wrap sm:justify-start xl:justify-end gap-3 w-full xl:w-auto">
                        <button onClick={() => { const d = new Date(); setFormData({ targetType: 'Semua', selectedTagihans: [], selectedBulan: [listBulan[d.getMonth()]], tahun: d.getFullYear() }); setModalType('FORM_PEMBAYARAN_MASSAL'); }} className="bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg px-4 py-2 font-medium flex items-center gap-2 text-sm"><CheckCircle2 className="w-4 h-4" /> Catat Massal</button>
                        <button onClick={() => { const d = new Date(); setFormData({ selectedBulan: [listBulan[d.getMonth()]], tahun: d.getFullYear(), selectedTagihanBayar: [] }); setModalType('FORM_PEMBAYARAN'); }} className={btnPrimary}><Plus className="w-4 h-4" /> Catat Uang Masuk</button>
                        <button onClick={() => downloadStyledExcel('Pembayaran / Uang Masuk', ['Invoice', 'Tanggal', 'NIS', 'Nama', 'Tagihan', 'Periode', 'Nominal', 'Status'], dataPembayaran.map(t => [t.id, t.tanggal, t.nis, t.nama, t.tagihan, t.periode, t.nominal, t.status]), 'Pembayaran')} className={btnOutline}><FileSpreadsheet className="w-4 h-4 text-accent" /> Unduh</button>
                    </div>
                </div>
                <div className="bg-surface border border-whisper shadow-sm rounded-card overflow-hidden">
                    <div className="p-4 border-b border-whisper/50 flex flex-col sm:flex-row justify-between gap-4 bg-canvas/40">
                        <div className="flex items-center gap-2"><Filter className="w-4 h-4 text-steel" /><select className={`${inputBase} w-48`} value={masterTagihanFilter} onChange={(e) => setMasterTagihanFilter(e.target.value)}><option value="Semua Tagihan">Semua Tagihan</option>{masterTagihanList.filter(t => !String(t.portalMenu || '').includes('Sembunyikan')).map(t => <option key={t.tagihan} value={t.tagihan}>{t.tagihan}</option>)}</select></div>
                        <div className="relative flex items-center gap-2">
                            <Search className="w-4 h-4 absolute left-3 top-3 text-steel" />
                            <input type="text" placeholder="Cari santri..." value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} className={`${inputBase} pl-9 w-full sm:w-64`} />
                            {selectedIds.length > 0 && (
                                <button onClick={() => executeBulkDelete('PEMBAYARAN', setDataPembayaran, 'pembayaran')} className="px-3 py-2 bg-rose-50 text-rose-600 font-medium text-sm rounded-lg hover:bg-rose-100 flex items-center gap-1 border border-rose-200"><Trash2 className="w-4 h-4" /> Hapus ({selectedIds.length})</button>
                            )}
                        </div>
                    </div>
                    <div className="overflow-x-auto hidden md:block">
                        <table className="w-full text-sm text-left">
                            <thead className="bg-canvas/60 text-steel border-b border-whisper/50"><tr><th className="px-6 py-3 w-12 text-center"><input type="checkbox" checked={allChecked} onChange={() => toggleSelectAll(filteredIds)} className="w-4 h-4 rounded border-whisper text-accent cursor-pointer" /></th><th className="px-6 py-3">No. Inv</th><th className="px-6 py-3">Santri</th><th className="px-6 py-3">Keterangan</th><th className="px-6 py-3 text-right">Nominal</th><th className="px-6 py-3 text-center">Status</th><th className="px-6 py-3 text-center">Aksi</th></tr></thead>
                            <tbody className="divide-y divide-slate-100">
                                {paginatedTrx.length === 0 ? (
                                    <tr><td colSpan="100%" className="text-center py-8 text-steel">Belum ada transaksi pembayaran.</td></tr>
                                ) : paginatedTrx.map((trx) => (
                                    <tr key={trx.id} className="bg-surface hover:bg-canvas">
                                        <td className="px-6 py-4 text-center"><input type="checkbox" checked={selectedIds.includes(trx.id)} onChange={() => toggleSelectId(trx.id)} className="w-4 h-4 rounded border-whisper text-accent cursor-pointer" /></td>
                                        <td className="px-6 py-4 font-mono text-xs">{trx.id}</td><td className="px-6 py-4 font-medium">{trx.nama}</td>
                                        <td className="px-6 py-4"><span className="line-clamp-2 max-w-xs">{trx.tagihan}</span> <span className="text-xs text-steel block">{trx.periode}</span></td>
                                        <td className="px-6 py-4 text-right font-medium">Rp {Number(trx.nominal || 0).toLocaleString('id-ID')}</td>
                                        <td className="px-6 py-4 text-center"><span className={`inline-flex px-2 py-1 text-xs font-medium rounded-md ${trx.status === 'Lunas' ? 'bg-emerald-50 text-emerald-700' : trx.status === 'Pending' ? 'bg-canvas text-steel' : 'bg-amber-50 text-amber-700'}`}>{trx.status}</span></td>
                                        <td className="px-6 py-4 text-center flex gap-3 justify-center">
                                            <button onClick={() => {
                                                const itemsHtml = trx.items && trx.items.length > 0 ? trx.items.map(item => `<tr><td>${item.tagihan}</td><td>${item.periode}</td><td style="text-align: right;">Rp ${Number(item.nominal || 0).toLocaleString('id-ID')}</td></tr>`).join('') : `<tr><td>${trx.tagihan}</td><td>${trx.periode}</td><td style="text-align: right;">Rp ${Number(trx.nominal || 0).toLocaleString('id-ID')}</td></tr>`;
                                                const htmlContent = `<html><head><title>Invoice - ${trx.id}</title><style>body { font-family: 'Courier New', Courier, monospace; padding: 20px; color: #000; } .invoice-box { max-width: 450px; margin: auto; border: 1px solid #ddd; padding: 20px; border-radius: 8px; } .header { text-align: center; margin-bottom: 20px; border-bottom: 2px dashed #000; padding-bottom: 10px; } .header h2 { margin: 0; font-size: 24px; } .row { display: flex; justify-content: space-between; margin-bottom: 5px; font-size: 14px; } table { margin-top: 15px; border-collapse: collapse; width: 100%; } th, td { padding: 8px 0; border-bottom: 1px solid #ddd; text-align: left; font-size: 14px; } .total { font-weight: bold; font-size: 16px; margin-top: 15px; text-align: right; border-top: 2px dashed #000; padding-top: 10px; } .footer { text-align: center; margin-top: 20px; font-size: 12px; color: #555; }</style></head><body><div class="invoice-box"><div class="header"><h2>BUKTI PEMBAYARAN</h2><div>Pesantren Tech</div></div><div class="row"><span>No. Inv</span><span>${trx.id}</span></div><div class="row"><span>Tanggal</span><span>${trx.tanggal}</span></div><div class="row"><span>NIS / Nama</span><span>${trx.nis} / ${trx.nama}</span></div><table><thead><tr><th>Deskripsi Tagihan</th><th>Periode</th><th style="text-align: right;">Nominal</th></tr></thead><tbody>${itemsHtml}</tbody></table><div class="total">DIBAYAR: Rp ${Number(trx.nominal || 0).toLocaleString('id-ID')}</div><div class="footer">Status: <strong>${trx.status ? trx.status.toUpperCase() : 'LUNAS'}</strong><br>${trx.sisa > 0 ? `<em>Sisa Tagihan: Rp ${Number(trx.sisa || 0).toLocaleString('id-ID')}</em><br>` : ''}<br>Terima kasih atas pembayaran Anda.</div></div></body></html>`;
                                                executePrint(htmlContent);
                                            }} className="text-steel hover:text-ink" title="Print"><Printer className="w-4 h-4" /></button>
                                            {(trx.status === 'Cicilan' || trx.status === 'Pending') && (
                                                <button onClick={() => {
                                                    setFormData({ id: trx.id, nama: trx.nama, tagihan: trx.tagihan, sisa: trx.sisa || trx.nominal });
                                                    setPakasirData({ step: 'CHOOSE_METHOD', qrString: null, loading: false, url: '' });
                                                    setModalType('FORM_PAKASIR');
                                                }} className="text-blue-600 hover:text-blue-800" title="Bayar via QRIS / VA"><QrCode className="w-4 h-4" /></button>
                                            )}
                                            <button onClick={() => { const [b, t] = (trx.periode || ' ').split(' '); setFormData({ ...trx, bulan: b, tahun: t }); setModalType('FORM_PEMBAYARAN'); }} className="text-blue-600 hover:text-blue-800"><Edit className="w-4 h-4" /></button>
                                            <button onClick={() => confirmDelete('PEMBAYARAN', trx.id, trx.id)} className="text-rose-600 hover:text-rose-800"><Trash2 className="w-4 h-4" /></button>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                    <div className="md:hidden flex flex-col divide-y divide-whisper/50">
                        {paginatedTrx.length === 0 ? (
                            <div className="text-center py-8 text-steel text-sm">Belum ada transaksi pembayaran.</div>
                        ) : paginatedTrx.map((trx) => (
                            <div key={trx.id} className={`p-4 flex flex-col gap-3 ${selectedIds.includes(trx.id) ? 'bg-accent/5' : 'bg-surface'}`}>
                                <div className="flex justify-between items-start gap-3">
                                    <div className="flex items-start gap-3 min-w-0">
                                        <input type="checkbox" checked={selectedIds.includes(trx.id)} onChange={() => toggleSelectId(trx.id)} className="w-4 h-4 mt-1 shrink-0 rounded border-whisper text-accent focus:ring-accent/30 cursor-pointer" />
                                        <div className="min-w-0">
                                            <div className="font-bold text-ink truncate text-sm">{trx.nama}</div>
                                            <div className="text-[10px] text-steel mt-0.5 leading-tight"><span className="font-medium text-ink">{trx.tagihan}</span> ({trx.periode})</div>
                                            <div className="text-[10px] text-slate font-mono mt-1">Inv: {trx.id}</div>
                                        </div>
                                    </div>
                                    <div className="text-right shrink-0">
                                        <div className="text-sm font-bold text-emerald-600">+ Rp {Number(trx.nominal || 0).toLocaleString('id-ID')}</div>
                                        <span className={`inline-block mt-1 px-1.5 py-0.5 text-[10px] font-bold uppercase rounded ${trx.status === 'Lunas' ? 'bg-emerald-50 text-emerald-700' : trx.status === 'Pending' ? 'bg-canvas text-steel' : 'bg-amber-50 text-amber-700'}`}>{trx.status}</span>
                                    </div>
                                </div>
                                <div className="flex flex-wrap items-center gap-2 justify-end w-full border-t border-whisper/50 pt-3 mt-1">
                                    <button onClick={() => {
                                        const itemsHtml = trx.items && trx.items.length > 0 ? trx.items.map(item => `<tr><td>${item.tagihan}</td><td>${item.periode}</td><td style="text-align: right;">Rp ${Number(item.nominal || 0).toLocaleString('id-ID')}</td></tr>`).join('') : `<tr><td>${trx.tagihan}</td><td>${trx.periode}</td><td style="text-align: right;">Rp ${Number(trx.nominal || 0).toLocaleString('id-ID')}</td></tr>`;
                                        const htmlContent = `<html><head><title>Invoice - ${trx.id}</title><style>body { font-family: 'Courier New', Courier, monospace; padding: 20px; color: #000; } .invoice-box { max-width: 450px; margin: auto; border: 1px solid #ddd; padding: 20px; border-radius: 8px; } .header { text-align: center; margin-bottom: 20px; border-bottom: 2px dashed #000; padding-bottom: 10px; } .header h2 { margin: 0; font-size: 24px; } .row { display: flex; justify-content: space-between; margin-bottom: 5px; font-size: 14px; } table { margin-top: 15px; border-collapse: collapse; width: 100%; } th, td { padding: 8px 0; border-bottom: 1px solid #ddd; text-align: left; font-size: 14px; } .total { font-weight: bold; font-size: 16px; margin-top: 15px; text-align: right; border-top: 2px dashed #000; padding-top: 10px; } .footer { text-align: center; margin-top: 20px; font-size: 12px; color: #555; }</style></head><body><div class="invoice-box"><div class="header"><h2>BUKTI PEMBAYARAN</h2><div>Pesantren Tech</div></div><div class="row"><span>No. Inv</span><span>${trx.id}</span></div><div class="row"><span>Tanggal</span><span>${trx.tanggal}</span></div><div class="row"><span>NIS / Nama</span><span>${trx.nis} / ${trx.nama}</span></div><table><thead><tr><th>Deskripsi Tagihan</th><th>Periode</th><th style="text-align: right;">Nominal</th></tr></thead><tbody>${itemsHtml}</tbody></table><div class="total">DIBAYAR: Rp ${Number(trx.nominal || 0).toLocaleString('id-ID')}</div><div class="footer">Status: <strong>${trx.status ? trx.status.toUpperCase() : 'LUNAS'}</strong><br>${trx.sisa > 0 ? `<em>Sisa Tagihan: Rp ${Number(trx.sisa || 0).toLocaleString('id-ID')}</em><br>` : ''}<br>Terima kasih atas pembayaran Anda.</div></div></body></html>`;
                                        executePrint(htmlContent);
                                    }} className="flex items-center gap-1 text-steel bg-canvas hover:bg-whisper/50 font-bold text-xs px-3 py-1.5 rounded-lg border border-whisper"><Printer className="w-3.5 h-3.5" /> Cetak</button>
                                    <button onClick={() => { const [b, t] = (trx.periode || ' ').split(' '); setFormData({ ...trx, bulan: b, tahun: t }); setModalType('FORM_PEMBAYARAN'); }} className="p-1.5 text-blue-600 bg-blue-50 hover:bg-blue-100 rounded-lg"><Edit className="w-4 h-4" /></button>
                                    <button onClick={() => confirmDelete('PEMBAYARAN', trx.id, trx.id)} className="p-1.5 text-danger bg-dangerBg hover:bg-red-100 rounded-lg"><Trash2 className="w-4 h-4" /></button>
                                </div>
                            </div>
                        ))}
                    </div>
                    
                    {totalPages > 0 && (
                        <div className="flex justify-center items-center gap-4 p-4 border-t border-whisper/50 bg-canvas/30">
                            <button onClick={() => setCurrentPage(p => Math.max(1, p - 1))} disabled={currentPage === 1} className="px-3 py-1.5 text-sm font-medium border border-whisper rounded-lg bg-surface hover:bg-canvas disabled:opacity-50 disabled:cursor-not-allowed text-ink">Prev</button>
                            <span className="text-sm text-steel font-medium">Hal {currentPage} dari {totalPages}</span>
                            <button onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))} disabled={currentPage === totalPages} className="px-3 py-1.5 text-sm font-medium border border-whisper rounded-lg bg-surface hover:bg-canvas disabled:opacity-50 disabled:cursor-not-allowed text-ink">Next</button>
                        </div>
                    )}
                </div>
            </div>
        );
    };

    // --- HANDLER DETAIL TABUNGAN POS ---
    const handleDetailTabungan = async (trx) => {
        // Extract TrxID from keterangan format: "Belanja Kantin (POS) [TRX-xxx]"
        const ket = trx.keterangan || '';
        const trxIdMatch = ket.match(/\[(TRX-[^\]]+)\]/);
        
        setDetailTabunganModal({ trx, detailItems: [], warungName: '-', loading: true });

        if (trxIdMatch) {
            const trxId = trxIdMatch[1];
            try {
                const [trxRes, detailRes] = await Promise.all([
                    supabase.from('Transaksi').select('*').eq('TrxID', trxId).maybeSingle(),
                    supabase.from('DetailTransaksi').select('*').eq('TrxID', trxId)
                ]);
                const warungId = trxRes.data?.WarungID;
                let warungName = warungId || '-';
                if (warungId) {
                    const { data: wData } = await supabase.from('Warung').select('Nama').eq('ID', warungId).maybeSingle();
                    if (wData?.Nama) warungName = wData.Nama;
                }
                setDetailTabunganModal({ 
                    trx, 
                    detailItems: detailRes.data || [], 
                    warungName, 
                    warungId: warungId || '-',
                    metode: trxRes.data?.Metode || '-',
                    waktu: trxRes.data?.Waktu || null,
                    trxId,
                    loading: false 
                });
            } catch (e) {
                console.error(e);
                setDetailTabunganModal(prev => ({ ...prev, loading: false }));
                showNotification('Gagal memuat detail transaksi', 'error');
            }
        } else {
            // No TrxID in keterangan — try to find by NIS + date + approximate total
            try {
                const { data: trxList } = await supabase.from('Transaksi')
                    .select('*')
                    .eq('SantriID', trx.nis)
                    .eq('TotalHarga', trx.nominal)
                    .order('Waktu', { ascending: false })
                    .limit(5);
                
                if (trxList && trxList.length > 0) {
                    // Find closest matching date
                    const matchedTrx = trxList.find(t => t.Waktu && t.Waktu.startsWith(trx.tanggal)) || trxList[0];
                    const { data: detailData } = await supabase.from('DetailTransaksi').select('*').eq('TrxID', matchedTrx.TrxID);
                    const warungId = matchedTrx.WarungID;
                    let warungName = warungId || '-';
                    if (warungId) {
                        const { data: wData } = await supabase.from('Warung').select('Nama').eq('ID', warungId).maybeSingle();
                        if (wData?.Nama) warungName = wData.Nama;
                    }
                    setDetailTabunganModal({ 
                        trx, 
                        detailItems: detailData || [], 
                        warungName, 
                        warungId: warungId || '-',
                        metode: matchedTrx.Metode || '-',
                        waktu: matchedTrx.Waktu || null,
                        trxId: matchedTrx.TrxID,
                        loading: false 
                    });
                } else {
                    setDetailTabunganModal(prev => ({ ...prev, loading: false }));
                }
            } catch (e) {
                console.error(e);
                setDetailTabunganModal(prev => ({ ...prev, loading: false }));
            }
        }
    };

    // --- HANDLER REKAP TRANSAKSI PER WARUNG ---
    const fetchRekapPerWarung = async (periode = rekapPeriode, customStart = null, customEnd = null) => {
        setLoadingRekap(true);
        try {
            const now = new Date();
            let startDate;
            let endDate;

            const effectiveStart = customStart || rekapStartDate;
            const effectiveEnd = customEnd || rekapEndDate;

            if (periode === 'custom') {
                const [sy, sm, sd] = (effectiveStart || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`).split('-').map(Number);
                startDate = new Date(sy, sm - 1, sd, 0, 0, 0, 0);

                const [ey, em, ed] = (effectiveEnd || effectiveStart || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`).split('-').map(Number);
                endDate = new Date(ey, em - 1, ed, 23, 59, 59, 999);
            } else if (periode === 'harian') {
                startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
                endDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
            } else if (periode === 'mingguan') {
                const day = now.getDay();
                const diff = (day === 0 ? -6 : 1) - day;
                startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() + diff, 0, 0, 0, 0);
                endDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
            } else {
                startDate = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
                endDate = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
            }

            const startStr = startDate.toISOString();
            const endStr = endDate.toISOString();

            const [trxRes, warungRes] = await Promise.all([
                supabase.from('Transaksi')
                    .select('TrxID, WarungID, TotalHarga, Waktu, Metode, SantriID')
                    .gte('Waktu', startStr)
                    .lte('Waktu', endStr)
                    .order('Waktu', { ascending: false }),
                supabase.from('Warung').select('*')
            ]);

            const warungs = warungRes.data || [];
            const transactions = trxRes.data || [];

            // Ambil DetailTransaksi untuk semua transaksi yang ada
            const trxIds = transactions.map(t => t.TrxID).filter(Boolean);
            const detailsMap = {};
            if (trxIds.length > 0) {
                const chunkSize = 200;
                for (let i = 0; i < trxIds.length; i += chunkSize) {
                    const chunk = trxIds.slice(i, i + chunkSize);
                    const { data: dData } = await supabase
                        .from('DetailTransaksi')
                        .select('*')
                        .in('TrxID', chunk);
                    if (dData) {
                        dData.forEach(item => {
                            if (!detailsMap[item.TrxID]) detailsMap[item.TrxID] = [];
                            detailsMap[item.TrxID].push(item);
                        });
                    }
                }
            }

            // Group by WarungID
            const grouped = {};
            transactions.forEach(trx => {
                const wId = trx.WarungID || 'UNKNOWN';
                if (!grouped[wId]) {
                    const w = warungs.find(wr => String(wr.ID || wr.id) === String(wId));
                    grouped[wId] = {
                        warungId: wId,
                        warungName: w ? (w.Nama || w.nama || wId) : wId,
                        totalTransaksi: 0,
                        totalNominal: 0,
                        transaksiList: [],
                        perHari: {}
                    };
                }
                grouped[wId].totalTransaksi += 1;
                grouped[wId].totalNominal += Number(trx.TotalHarga || 0);

                // Sinkronkan nama santri & barang belanjaan
                const santri = (dataSantri || []).find(s => 
                    String(s.nis || '').replace(/^0+/, '') === String(trx.SantriID || '').replace(/^0+/, '')
                );
                const items = detailsMap[trx.TrxID] || [];
                const itemSummary = items.length > 0 
                    ? items.map(i => `${i.NamaProduk} (${i.Kuantitas}x)`).join(', ')
                    : '-';

                const enrichedTrx = {
                    ...trx,
                    santriNama: santri ? santri.nama : (trx.SantriID === 'GUEST' ? 'Umum / Tamu' : (trx.SantriID ? `Santri (${trx.SantriID})` : '-')),
                    santriNis: trx.SantriID || '-',
                    santriKelas: santri?.kelas || '-',
                    items,
                    itemSummary
                };

                grouped[wId].transaksiList.push(enrichedTrx);

                // Group per-day within the selected period (menggunakan tanggal lokal)
                const trxDate = trx.Waktu ? new Date(trx.Waktu) : null;
                const tgl = trxDate && !isNaN(trxDate.getTime()) 
                    ? `${trxDate.getFullYear()}-${String(trxDate.getMonth() + 1).padStart(2, '0')}-${String(trxDate.getDate()).padStart(2, '0')}`
                    : (trx.Waktu ? trx.Waktu.split('T')[0] : 'N/A');

                if (!grouped[wId].perHari[tgl]) {
                    grouped[wId].perHari[tgl] = { count: 0, total: 0, transaksiList: [] };
                }
                grouped[wId].perHari[tgl].count += 1;
                grouped[wId].perHari[tgl].total += Number(trx.TotalHarga || 0);
                grouped[wId].perHari[tgl].transaksiList.push(enrichedTrx);
            });

            const result = Object.values(grouped).sort((a, b) => b.totalNominal - a.totalNominal);
            setRekapData(result);
        } catch (e) {
            console.error(e);
            showNotification('Gagal memuat rekap', 'error');
        }
        setLoadingRekap(false);
    };

    const handleSelectPeriodePreset = (p) => {
        const now = new Date();
        const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
        
        let start = todayStr;
        let end = todayStr;

        if (p === 'harian') {
            start = todayStr;
            end = todayStr;
        } else if (p === 'mingguan') {
            const day = now.getDay();
            const diff = (day === 0 ? -6 : 1) - day;
            const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + diff);
            start = `${monday.getFullYear()}-${String(monday.getMonth() + 1).padStart(2, '0')}-${String(monday.getDate()).padStart(2, '0')}`;
            end = todayStr;
        } else if (p === 'bulanan') {
            start = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
            end = todayStr;
        } else if (p === 'custom') {
            setRekapPeriode('custom');
            return;
        }

        setRekapStartDate(start);
        setRekapEndDate(end);
        setRekapPeriode(p);
        fetchRekapPerWarung(p, start, end);
    };

    const handleOpenTrxDetail = (trx, warungName, warungId) => {
        setDetailTabunganModal({
            trx: {
                nama: trx.santriNama,
                nis: trx.santriNis,
                tanggal: trx.Waktu ? formatDateID(trx.Waktu) : '-',
                nominal: trx.TotalHarga
            },
            detailItems: trx.items || [],
            warungName: warungName || getNamaWarung(trx.WarungID),
            warungId: warungId || trx.WarungID || '-',
            metode: trx.Metode || '-',
            waktu: trx.Waktu || null,
            trxId: trx.TrxID,
            loading: false
        });
    };

    const downloadRekapSummaryExcel = () => {
        const rows = [];
        rekapData.forEach(w => {
            Object.entries(w.perHari).sort(([a], [b]) => b.localeCompare(a)).forEach(([tgl, data]) => {
                rows.push([w.warungName, w.warungId, formatDateID(tgl), data.count, data.total]);
            });
            rows.push([w.warungName, w.warungId, 'SUBTOTAL', w.totalTransaksi, w.totalNominal]);
        });
        const labelPeriode = rekapPeriode === 'custom' 
            ? `${formatDateID(rekapStartDate)}_sd_${formatDateID(rekapEndDate)}` 
            : (rekapPeriode === 'harian' ? 'Hari_Ini' : rekapPeriode === 'mingguan' ? 'Minggu_Ini' : 'Bulan_Ini');
        downloadStyledExcel(
            `Rekap Ringkasan Transaksi per Warung (${labelPeriode})`,
            ['Nama Warung', 'ID Warung', 'Tanggal', 'Jumlah Transaksi', 'Total Omzet'],
            rows,
            `Rekap_Warung_Ringkasan_${labelPeriode}`
        );
    };

    const downloadRekapDetailSantriExcel = () => {
        const rows = [];
        rekapData.forEach(w => {
            (w.transaksiList || []).forEach(trx => {
                rows.push([
                    w.warungName,
                    w.warungId,
                    trx.TrxID || '-',
                    trx.Waktu ? formatDateTimeID(trx.Waktu) : '-',
                    trx.santriNis || '-',
                    trx.santriNama || '-',
                    trx.santriKelas || '-',
                    trx.Metode || 'Tunai',
                    trx.itemSummary || '-',
                    Number(trx.TotalHarga || 0)
                ]);
            });
        });
        const labelPeriode = rekapPeriode === 'custom' 
            ? `${formatDateID(rekapStartDate)}_sd_${formatDateID(rekapEndDate)}` 
            : (rekapPeriode === 'harian' ? 'Hari_Ini' : rekapPeriode === 'mingguan' ? 'Minggu_Ini' : 'Bulan_Ini');
        downloadStyledExcel(
            `Rincian Pembelian Santri per Warung (${labelPeriode})`,
            ['Nama Warung', 'ID Warung', 'Trx ID', 'Waktu Transaksi', 'NIS', 'Nama Santri', 'Kelas', 'Metode', 'Item Dibeli', 'Total Belanja'],
            rows,
            `Rincian_Pembelian_Santri_${labelPeriode}`
        );
    };

    // === LOGIKA PENARIKAN KAS / IURAN INSIDENTAL OTOMATIS ===
    const handleEksekusiPotongIuran = async () => {
        const currentKelas = iuranSelectedKelas || masterKelasList[0] || '';
        let targetSantri = [];
        if (iuranTargetType === 'Kamar') {
            const selectedKamarObj = dataSantri.find(s => String(s.nis) === String(iuranSelectedKamarNis));
            if (!selectedKamarObj) return showNotification('Pilih kamar / asrama target terlebih dahulu!', 'error');
            const kamarKelas = String(selectedKamarObj.kelas || '').trim().toLowerCase();
            targetSantri = dataSantri.filter(s => 
                !String(s.nis || '').startsWith('KAS-') &&
                (!s.status || s.status.toLowerCase() !== 'keluar') &&
                String(s.kelas || '').trim().toLowerCase() === kamarKelas
            );
        } else if (iuranTargetType === 'Kelas') {
            if (!currentKelas) return showNotification('Pilih kelas target terlebih dahulu!', 'error');
            targetSantri = dataSantri.filter(s => 
                !String(s.nis || '').startsWith('KAS-') &&
                (!s.status || s.status.toLowerCase() !== 'keluar') &&
                String(s.kelas || '').trim().toLowerCase() === String(currentKelas).trim().toLowerCase()
            );
        } else if (iuranTargetType === 'PilihSantri') {
            if (iuranSelectedNisList.length === 0) return showNotification('Pilih minimal 1 santri!', 'error');
            targetSantri = dataSantri.filter(s => 
                !String(s.nis || '').startsWith('KAS-') &&
                (!s.status || s.status.toLowerCase() !== 'keluar') &&
                iuranSelectedNisList.includes(String(s.nis))
            );
        } else if (iuranTargetType === 'Semua') {
            targetSantri = dataSantri.filter(s => 
                !String(s.nis || '').startsWith('KAS-') &&
                (!s.status || s.status.toLowerCase() !== 'keluar')
            );
        }

        if (targetSantri.length === 0) return showNotification('Tidak ada santri yang ditargetkan!', 'error');
        const nom = Number(iuranNominal || 0);
        if (nom <= 0) return showNotification('Nominal iuran harus lebih besar dari Rp 0!', 'error');

        const eligible = targetSantri.filter(s => getSantriSaldoTabungan(s.nis) >= nom);
        const insufficient = targetSantri.filter(s => getSantriSaldoTabungan(s.nis) < nom);

        if (eligible.length === 0 && iuranSkipInsufficient) {
            return showNotification(`Tidak ada santri yang memiliki saldo mencukupi (minimal Rp ${nom.toLocaleString('id-ID')})!`, 'error');
        }

        const santriToProcess = iuranSkipInsufficient ? eligible : targetSantri;
        const totalDitarik = santriToProcess.length * nom;

        const confirmMsg = 
            `KONFIRMASI PENARIKAN KAS / IURAN OTOMATIS:\n\n` +
            `• Kategori: ${iuranKategori}\n` +
            `• Keterangan: ${iuranKeterangan || '-'}\n` +
            `• Nominal per Santri: Rp ${nom.toLocaleString('id-ID')}\n` +
            `• Target: ${santriToProcess.length} santri\n` +
            `• Total Dana Terkumpul: Rp ${totalDitarik.toLocaleString('id-ID')}\n` +
            (insufficient.length > 0 && iuranSkipInsufficient ? `• Dilewati (Saldo Kurang): ${insufficient.length} santri\n` : '') +
            `• Alokasi Dana: ${iuranAlokasi === 'BukuKas' ? 'Buku Kas Pondok (Pemasukan)' : iuranAlokasi === 'KasKamar' ? `Akun Dompet Kamar (${iuranTujuanAkunNis || 'Otomatis'})` : 'Hanya Potong Saldo Santri'}\n\n` +
            `Apakah Anda yakin ingin memproses pemotongan saldo santri ini sekarang?`;

        if (!window.confirm(confirmMsg)) return;

        setIuranProcessing(true);
        try {
            const todayStr = new Date().toISOString().split('T')[0];
            const newTabunganRecords = [];

            santriToProcess.forEach(s => {
                newTabunganRecords.push({
                    id: `TB-IRN-${Date.now()}-${Math.floor(1000 + Math.random() * 9000)}`,
                    tanggal: todayStr,
                    nis: s.nis,
                    nama: s.nama,
                    jenis: 'Tarik',
                    nominal: nom,
                    keterangan: `[${iuranKategori}] ${iuranKeterangan || ''}`.trim()
                });
            });

            // Jika dialokasikan ke Akun Kas Kamar / Virtual Account Santri
            if (iuranAlokasi === 'KasKamar' && iuranTujuanAkunNis) {
                const targetAkun = dataSantri.find(s => String(s.nis) === String(iuranTujuanAkunNis)) || { nama: 'Kas Kamar' };
                newTabunganRecords.push({
                    id: `TB-IRN-IN-${Date.now()}-${Math.floor(1000 + Math.random() * 9000)}`,
                    tanggal: todayStr,
                    nis: iuranTujuanAkunNis,
                    nama: targetAkun.nama,
                    jenis: 'Setor',
                    nominal: totalDitarik,
                    keterangan: `[Penerimaan ${iuranKategori}] Dari ${santriToProcess.length} santri: ${iuranKeterangan}`
                });
            }

            // Simpan ke state Tabungan (otomatis auto-sync ke Supabase Tabungan)
            setDataTabungan(prev => [...newTabunganRecords, ...prev]);

            // Jika dialokasikan ke Buku Kas Pondok (Tabel Kas)
            if (iuranAlokasi === 'BukuKas') {
                const katKas = iuranKategori === 'Infaq / Sedekah' ? 'Infaq / Sedekah' : iuranKategori === 'Cukur' ? 'Jasa Cukur' : 'Kas Kamar/Asrama';
                const newKas = {
                    id: `KAS-IRN-${Date.now()}`,
                    tanggal: todayStr,
                    tipeKas: 'MASUK',
                    kategori: katKas,
                    sumber: `Potong Tabungan (${santriToProcess.length} santri)`,
                    nominal: totalDitarik,
                    keterangan: `[${iuranKategori}] ${iuranKeterangan || ''} (Target: ${iuranTargetType === 'Kelas' ? 'Kelas ' + currentKelas : iuranTargetType})`
                };
                setDataKas(prev => [newKas, ...prev]);
            }

            addLog('CREATE', 'TABUNGAN', `Potong ${iuranKategori} otomatis: Rp ${nom.toLocaleString('id-ID')} x ${santriToProcess.length} santri (Total: Rp ${totalDitarik.toLocaleString('id-ID')})`);
            showNotification(`Berhasil memotong saldo ${santriToProcess.length} santri! Total dana: Rp ${totalDitarik.toLocaleString('id-ID')}`);

            setIuranHasilEksekusi({
                tanggal: todayStr,
                kategori: iuranKategori,
                keterangan: iuranKeterangan,
                nominalPerSantri: nom,
                suksesCount: santriToProcess.length,
                gagalCount: insufficient.length,
                totalDana: totalDitarik,
                detailSukses: santriToProcess,
                detailGagal: insufficient
            });
        } catch (err) {
            console.error("Gagal potong iuran:", err);
            showNotification("Gagal memproses pemotongan iuran!", "error");
        } finally {
            setIuranProcessing(false);
        }
    };

    const handleBuatAkunKamar = async (e) => {
        e.preventDefault();
        const nm = (namaKamarBaru || '').trim();
        if (!nm) return showNotification('Nama kamar / kelompok tidak boleh kosong!', 'error');

        const cleanUid = (uidKamarBaru || '').trim();
        const cleanCode = cleanUid.replace(/^0+/, '').toLowerCase();
        let targetConflict = null;

        if (cleanUid) {
            targetConflict = dataSantri.find(s => {
                const exUid = String(s.uid || '').trim().replace(/^0+/, '').toLowerCase();
                const exRfid = String(s.rfid || '').trim().replace(/^0+/, '').toLowerCase();
                return cleanCode && (exUid === cleanCode || exRfid === cleanCode);
            });

            if (targetConflict) {
                const confirmMove = window.confirm(
                    `Kartu RFID (${cleanUid}) saat ini sudah terdaftar atas nama: ${targetConflict.nama} (NIS: ${targetConflict.nis}, Kelas: ${targetConflict.kelas || '-'}).\n\nSatu kartu fisik TIDAK BOLEH digunakan ganda agar tidak tertukar di kasir POS.\n\nApakah Anda ingin MENCABUT kartu ini dari ${targetConflict.nama} dan memasangkannya ke akun kamar baru ini?`
                );
                if (!confirmMove) return;

                try {
                    await supabase.from('Data Santri').update({ uid: null }).eq('nis', targetConflict.nis);
                } catch (err) {
                    console.error("Gagal cabut UID lama:", err);
                }
            }
        }

        const nisKamar = `KAS-${nm.replace(/\s+/g, '-').toUpperCase()}-${Math.floor(100 + Math.random() * 900)}`;
        const pinFinal = (pinKamarBaru || '123456').trim();

        const newSantri = {
            id: Math.floor(Math.random() * 8000000) + (Date.now() % 100000),
            nis: nisKamar,
            nama: `Kas ${nm}`,
            kelas: kelasKamarBaru || masterKelasList[0] || 'Asrama',
            periode: masterPeriodeList[0] || '2024/2025',
            uid: cleanUid || null,
            pin: pinFinal,
            password: 1234,
            status: 'Aktif'
        };

        try {
            const { error: saveErr } = await supabase.from('Data Santri').upsert([newSantri], { onConflict: 'id' });
            if (saveErr) throw saveErr;

            setDataSantri(prev => {
                let updated = prev;
                if (targetConflict) {
                    updated = updated.map(s => String(s.nis) === String(targetConflict.nis) ? { ...s, uid: null } : s);
                }
                return [newSantri, ...updated];
            });

            setIuranTujuanAkunNis(nisKamar);
            setShowModalBuatAkunKamar(false);
            setNamaKamarBaru('');
            setUidKamarBaru('');
            setPinKamarBaru('123456');
            showNotification(`Akun Dompet '${newSantri.nama}' (NIS: ${nisKamar}) berhasil dibuat & disimpan permanen!`);
        } catch (err) {
            console.error("Gagal simpan akun kamar:", err);
            showNotification(`Gagal simpan akun kamar: ${err.message || err}`, 'error');
        }
    };

    const handleSimpanRfidKamar = async (e) => {
        e.preventDefault();
        if (!modalEditRfidKamar) return;
        const targetNis = modalEditRfidKamar.nis;
        const cleanUid = String(inputRfidEdit || '').trim();
        const cleanCode = cleanUid.replace(/^0+/, '').toLowerCase();

        let targetConflict = null;
        if (cleanUid) {
            targetConflict = dataSantri.find(s => {
                if (String(s.nis) === String(targetNis)) return false;
                const exUid = String(s.uid || '').trim().replace(/^0+/, '').toLowerCase();
                const exRfid = String(s.rfid || '').trim().replace(/^0+/, '').toLowerCase();
                return cleanCode && (exUid === cleanCode || exRfid === cleanCode);
            });

            if (targetConflict) {
                const confirmMove = window.confirm(
                    `Kartu RFID (${cleanUid}) saat ini terdaftar atas nama: ${targetConflict.nama} (NIS: ${targetConflict.nis}, Kelas: ${targetConflict.kelas || '-'}).\n\nSatu kartu fisik TIDAK BOLEH digunakan ganda!\n\nApakah Anda ingin MENCABUT kartu ini dari ${targetConflict.nama} dan memasangkannya ke ${modalEditRfidKamar.nama}?`
                );
                if (!confirmMove) return;

                try {
                    await supabase.from('Data Santri').update({ uid: null }).eq('nis', targetConflict.nis);
                } catch (err) {
                    console.error("Gagal cabut UID lama:", err);
                }
            }
        }

        try {
            await supabase.from('Data Santri').update({ uid: cleanUid || null }).eq('nis', targetNis);
            setDataSantri(prev => {
                let updated = prev;
                if (targetConflict) {
                    updated = updated.map(s => String(s.nis) === String(targetConflict.nis) ? { ...s, uid: null } : s);
                }
                return updated.map(s => String(s.nis) === String(targetNis) ? { ...s, uid: cleanUid || null } : s);
            });
            showNotification(`Kartu RFID untuk ${modalEditRfidKamar.nama} berhasil diperbarui!`);
            setModalEditRfidKamar(null);
            setInputRfidEdit('');
        } catch (err) {
            showNotification(`Gagal update kartu RFID: ${err.message || err}`, 'error');
        }
    };

    const handleSimpanPinKamar = async (e) => {
        e.preventDefault();
        if (!modalEditPinKamar) return;
        const targetNis = modalEditPinKamar.nis;
        const cleanPin = String(inputPinEdit || '').trim();
        if (!cleanPin || cleanPin.length < 4) {
            return showNotification('PIN minimal 4 - 6 digit angka!', 'error');
        }

        try {
            await supabase.from('Data Santri').update({ pin: cleanPin }).eq('nis', targetNis);
            setDataSantri(prev => prev.map(s => String(s.nis) === String(targetNis) ? { ...s, pin: cleanPin } : s));
            showNotification(`PIN Kasir POS untuk ${modalEditPinKamar.nama} berhasil diubah!`);
            setModalEditPinKamar(null);
            setInputPinEdit('');
        } catch (err) {
            showNotification(`Gagal update PIN: ${err.message || err}`, 'error');
        }
    };

    const handleHapusAkunKamar = async (kamar) => {
        const saldo = getSantriSaldoTabungan(kamar.nis);
        if (saldo > 0) {
            if (!window.confirm(`Akun '${kamar.nama}' masih memiliki sisa saldo kas Rp ${saldo.toLocaleString('id-ID')}!\nYakin ingin tetap menghapus akun dompet kamar ini?`)) {
                return;
            }
        } else {
            if (!window.confirm(`Hapus akun dompet '${kamar.nama}'?`)) return;
        }

        try {
            await supabase.from('Data Santri').delete().eq('nis', kamar.nis);
            setDataSantri(prev => prev.filter(s => String(s.nis) !== String(kamar.nis)));
            if (iuranTujuanAkunNis === kamar.nis) setIuranTujuanAkunNis('');
            showNotification(`Akun ${kamar.nama} berhasil dihapus.`);
        } catch (err) {
            showNotification(`Gagal menghapus akun kamar: ${err.message || err}`, 'error');
        }
    };

    const handleHubungkanRfidDirect = async (targetNis, targetNama) => {
        const cleanUid = String(inputRfidDirect || '').trim();
        if (!cleanUid) return showNotification('Tempelkan kartu ke reader atau masukkan nomor UID!', 'error');
        const cleanCode = cleanUid.replace(/^0+/, '').toLowerCase();

        const targetConflict = dataSantri.find(s => {
            if (String(s.nis) === String(targetNis)) return false;
            const exUid = String(s.uid || '').trim().replace(/^0+/, '').toLowerCase();
            const exRfid = String(s.rfid || '').trim().replace(/^0+/, '').toLowerCase();
            return cleanCode && (exUid === cleanCode || exRfid === cleanCode);
        });

        if (targetConflict) {
            const confirmMove = window.confirm(
                `Kartu RFID (${cleanUid}) saat ini terdaftar atas nama: ${targetConflict.nama} (NIS: ${targetConflict.nis}, Kelas: ${targetConflict.kelas || '-'}).\n\nSatu kartu fisik TIDAK BOLEH digunakan ganda!\n\nApakah Anda ingin MENCABUT kartu ini dari ${targetConflict.nama} dan memasangkannya ke ${targetNama}?`
            );
            if (!confirmMove) return;

            try {
                await supabase.from('Data Santri').update({ uid: null }).eq('nis', targetConflict.nis);
            } catch (err) {
                console.error("Gagal cabut UID lama:", err);
            }
        }

        try {
            await supabase.from('Data Santri').update({ uid: cleanUid }).eq('nis', targetNis);
            setDataSantri(prev => {
                let updated = prev;
                if (targetConflict) {
                    updated = updated.map(s => String(s.nis) === String(targetConflict.nis) ? { ...s, uid: null } : s);
                }
                return updated.map(s => String(s.nis) === String(targetNis) ? { ...s, uid: cleanUid } : s);
            });
            showNotification(`Kartu RFID (UID: ${cleanUid}) berhasil dihubungkan ke ${targetNama}!`);
            setInputRfidDirect('');
        } catch (err) {
            showNotification(`Gagal hubungkan RFID: ${err.message || err}`, 'error');
        }
    };

    const handleBukaEditRiwayatInsidental = (item) => {
        setFormEditRiwayatInsidental({
            id: item.id,
            nama: item.nama || '',
            nis: item.nis || '',
            tanggal: item.tanggal || new Date().toISOString().split('T')[0],
            jenis: item.jenis || 'Tarik',
            nominal: Number(item.nominal || 0),
            keterangan: item.keterangan || ''
        });
        setModalEditRiwayatInsidental(true);
    };

    const handleSimpanEditRiwayatInsidental = async (e) => {
        e.preventDefault();
        const nom = Number(formEditRiwayatInsidental.nominal || 0);
        if (nom <= 0) return showNotification('Nominal transaksi harus lebih dari Rp 0!', 'error');

        try {
            const { error } = await supabase.from('Tabungan').update({
                tanggal: formEditRiwayatInsidental.tanggal,
                nominal: nom,
                keterangan: formEditRiwayatInsidental.keterangan
            }).eq('id', formEditRiwayatInsidental.id);

            if (error) {
                console.error("Gagal update transaksi di Supabase:", error);
                showNotification(`Gagal update transaksi: ${error.message}`, 'error');
                return;
            }

            setDataTabungan(prev => prev.map(t => {
                if (t.id === formEditRiwayatInsidental.id) {
                    return {
                        ...t,
                        tanggal: formEditRiwayatInsidental.tanggal,
                        nominal: nom,
                        keterangan: formEditRiwayatInsidental.keterangan
                    };
                }
                return t;
            }));

            setModalEditRiwayatInsidental(false);
            showNotification('Riwayat transaksi insidental berhasil diubah!', 'success');
            addLog('UPDATE', 'TABUNGAN_INSIDENTAL', `Edit transaksi ${formEditRiwayatInsidental.nama} menjadi Rp ${nom.toLocaleString('id-ID')}`);
        } catch (err) {
            console.error("Error simpan edit riwayat:", err);
            showNotification('Terjadi kesalahan saat menyimpan perubahan.', 'error');
        }
    };

    const handleHapusRiwayatInsidental = async (item) => {
        const isTarik = String(item.jenis).toLowerCase() === 'tarik';
        const nominalStr = Number(item.nominal || 0).toLocaleString('id-ID');
        const confirmText = isTarik
            ? `Hapus & batalkan pemotongan kas/iuran ini?\n\n• Santri: ${item.nama} (${item.nis})\n• Nominal: Rp ${nominalStr}\n• Keterangan: ${item.keterangan}\n\nSaldo tabungan santri sebesar Rp ${nominalStr} akan OTOMATIS DIPULIHKAN kembali.`
            : `Hapus transaksi penerimaan kas ini?\n\n• Akun: ${item.nama} (${item.nis})\n• Nominal: Rp ${nominalStr}\n• Keterangan: ${item.keterangan}\n\nSaldo kas akun akan berkurang sebesar Rp ${nominalStr}.`;

        if (!window.confirm(confirmText)) return;

        try {
            const { error } = await supabase.from('Tabungan').delete().eq('id', item.id);
            if (error) {
                console.error("Gagal hapus transaksi di Supabase:", error);
                showNotification(`Gagal menghapus: ${error.message}`, 'error');
                return;
            }

            setDataTabungan(prev => prev.filter(t => t.id !== item.id));
            showNotification(`Transaksi berhasil dihapus & saldo berhasil diperbarui!`, 'success');
            addLog('DELETE', 'TABUNGAN_INSIDENTAL', `Hapus ${item.jenis} Rp ${nominalStr} - ${item.nama} (${item.keterangan})`);
        } catch (err) {
            console.error("Error hapus riwayat:", err);
            showNotification('Terjadi kesalahan saat menghapus data.', 'error');
        }
    };

    // === RENDER SUB-TAB: IURAN & KAS INSIDENTAL (POTONG OTOMATIS) ===
    const renderTabunganIuran = () => {
        const currentKelas = iuranSelectedKelas || masterKelasList[0] || '';
        
        const currentKategoriList = appConfig?.masterKategoriInsidental || defaultMasterInsidental;

        let targetSantri = [];
        if (iuranTargetType === 'Kamar') {
            const selectedKamarObj = dataSantri.find(s => String(s.nis) === String(iuranSelectedKamarNis));
            if (selectedKamarObj) {
                const kamarKelas = String(selectedKamarObj.kelas || '').trim().toLowerCase();
                targetSantri = dataSantri.filter(s => 
                    !String(s.nis || '').startsWith('KAS-') &&
                    (!s.status || s.status.toLowerCase() !== 'keluar') &&
                    String(s.kelas || '').trim().toLowerCase() === kamarKelas
                );
            }
        } else if (iuranTargetType === 'Kelas') {
            targetSantri = dataSantri.filter(s => 
                !String(s.nis || '').startsWith('KAS-') &&
                (!s.status || s.status.toLowerCase() !== 'keluar') &&
                String(s.kelas || '').trim().toLowerCase() === String(currentKelas).trim().toLowerCase()
            );
        } else if (iuranTargetType === 'PilihSantri') {
            targetSantri = dataSantri.filter(s => 
                !String(s.nis || '').startsWith('KAS-') &&
                (!s.status || s.status.toLowerCase() !== 'keluar') &&
                iuranSelectedNisList.includes(String(s.nis))
            );
        } else if (iuranTargetType === 'Semua') {
            targetSantri = dataSantri.filter(s => 
                !String(s.nis || '').startsWith('KAS-') &&
                (!s.status || s.status.toLowerCase() !== 'keluar')
            );
        }

        const nom = Number(iuranNominal || 0);
        const eligibleSantri = targetSantri.filter(s => getSantriSaldoTabungan(s.nis) >= nom);
        const insufficientSantri = targetSantri.filter(s => getSantriSaldoTabungan(s.nis) < nom);
        const totalEstimasiDana = eligibleSantri.length * nom;

        const santriPilihanFiltered = dataSantri.filter(s => 
            (s.nama || '').toLowerCase().includes(iuranSearchSantri.toLowerCase()) || 
            String(s.nis || '').includes(iuranSearchSantri) ||
            String(s.kelas || '').toLowerCase().includes(iuranSearchSantri.toLowerCase())
        );

        const akunKamarTersedia = dataSantri.filter(s => 
            (s.nama || '').toLowerCase().includes('kas') || 
            (s.nama || '').toLowerCase().includes('kamar') || 
            String(s.nis || '').startsWith('KAS-')
        );

        const riwayatInsidental = dataTabungan.filter(t => {
            const ket = (t.keterangan || '').toLowerCase();
            const matchesCategory = 
                ket.includes('[kas kamar]') || 
                ket.includes('[infaq') || 
                ket.includes('[cukur') || 
                ket.includes('[kas kelas]') || 
                ket.includes('[iuran');
            if (!matchesCategory) return false;
            if (iuranRiwayatFilter !== 'Semua') {
                if (iuranRiwayatFilter === 'Kas Kamar' && !ket.includes('[kas kamar]')) return false;
                if (iuranRiwayatFilter === 'Infaq' && !ket.includes('[infaq')) return false;
                if (iuranRiwayatFilter === 'Cukur' && !ket.includes('[cukur')) return false;
                if (iuranRiwayatFilter === 'Kas Kelas' && !ket.includes('[kas kelas]')) return false;
            }
            if (iuranRiwayatSearch) {
                const s = iuranRiwayatSearch.toLowerCase();
                return (t.nama || '').toLowerCase().includes(s) || 
                       String(t.nis || '').includes(s) || 
                       ket.includes(s);
            }
            return true;
        });

        return (
            <div className="space-y-6 animate-in fade-in duration-300">
                {/* Header Info */}
                <div className="p-6 bg-gradient-to-br from-indigo-50/80 via-white to-blue-50/40 border border-indigo-100 rounded-2xl shadow-sm">
                    <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
                        <div className="space-y-1">
                            <div className="flex items-center gap-2">
                                <span className="px-2.5 py-1 text-xs font-bold uppercase tracking-wider bg-indigo-600 text-white rounded-lg flex items-center gap-1.5 shadow-sm">
                                    <Coins className="w-3.5 h-3.5" /> Cashless Ekosistem
                                </span>
                                <span className="text-xs font-semibold text-indigo-700 bg-indigo-100/60 px-2.5 py-1 rounded-lg">
                                    Pembayaran Insidental
                                </span>
                            </div>
                            <h3 className="text-xl font-bold tracking-tight text-ink mt-2">
                                Tarik Iuran, Kas Kamar & Infaq Otomatis
                            </h3>
                            <p className="text-sm text-steel">
                                Potong saldo tabungan santri secara massal tanpa perlu kartu fisik. Dana langsung dialokasikan ke Kas Pondok atau Dompet Virtual Kamar.
                            </p>
                        </div>
                        <div className="flex items-center gap-3">
                            <button
                                type="button"
                                onClick={() => setShowModalBuatAkunKamar(true)}
                                className="px-4 py-2.5 bg-white hover:bg-slate-50 text-indigo-700 border border-indigo-200 rounded-xl font-semibold text-xs flex items-center gap-2 shadow-sm transition-all"
                            >
                                <Plus className="w-4 h-4" /> Buat Akun Dompet Kamar
                            </button>
                        </div>
                    </div>
                </div>

                {/* Banner Hasil Eksekusi Terakhir (Jika ada) */}
                {iuranHasilEksekusi && (
                    <div className="p-5 bg-emerald-50/80 border border-emerald-200 rounded-2xl space-y-3 animate-in slide-in-from-top-3 duration-300">
                        <div className="flex justify-between items-start">
                            <div className="flex items-center gap-3">
                                <div className="w-10 h-10 rounded-xl bg-emerald-600 text-white flex items-center justify-center font-bold shadow-sm">
                                    <Check className="w-5 h-5" />
                                </div>
                                <div>
                                    <h4 className="font-bold text-ink text-sm">
                                        Pemotongan ${iuranHasilEksekusi.kategori} Berhasil Diproses!
                                    </h4>
                                    <p className="text-xs text-steel mt-0.5">
                                        ${iuranHasilEksekusi.keterangan} • ${iuranHasilEksekusi.tanggal}
                                    </p>
                                </div>
                            </div>
                            <button 
                                type="button"
                                onClick={() => setIuranHasilEksekusi(null)} 
                                className="text-steel hover:text-ink text-xs font-semibold px-2 py-1 rounded-lg hover:bg-emerald-100/60"
                            >
                                Tutup
                            </button>
                        </div>
                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-2 border-t border-emerald-200/60 text-xs">
                            <div>
                                <span className="text-steel">Santri Terpotong:</span>
                                <div className="font-bold text-emerald-700 text-sm">${iuranHasilEksekusi.suksesCount} santri</div>
                            </div>
                            <div>
                                <span className="text-steel">Total Dana Masuk:</span>
                                <div className="font-bold text-emerald-700 text-sm">Rp ${iuranHasilEksekusi.totalDana.toLocaleString('id-ID')}</div>
                            </div>
                            <div>
                                <span className="text-steel">Nominal per Anak:</span>
                                <div className="font-bold text-ink text-sm">Rp ${iuranHasilEksekusi.nominalPerSantri.toLocaleString('id-ID')}</div>
                            </div>
                            <div>
                                <span className="text-steel">Saldo Kurang (Dilewati):</span>
                                <div className="font-bold text-amber-600 text-sm">${iuranHasilEksekusi.gagalCount} santri</div>
                            </div>
                        </div>
                    </div>
                )}

                {/* Form Utama (2 Kolom) */}
                <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
                    {/* Kolom Kiri: Formulir Pengaturan */}
                    <div className="lg:col-span-7 space-y-6">
                        <div className="bg-surface border border-whisper rounded-2xl p-6 shadow-sm space-y-5">
                            {/* 1. Pilih Kategori Pembayaran (Dinamis dari Master Insidental) */}
                            <div>
                                <div className="flex justify-between items-center mb-2.5">
                                    <label className="block text-xs font-bold text-steel uppercase tracking-wider">
                                        1. Jenis Pembayaran Insidental
                                    </label>
                                    <button
                                        type="button"
                                        onClick={() => setShowModalMasterInsidental(true)}
                                        className="px-2.5 py-1 text-xs font-semibold text-indigo-700 bg-indigo-50 hover:bg-indigo-100 border border-indigo-200 rounded-lg flex items-center gap-1 transition-all"
                                    >
                                        <Settings className="w-3.5 h-3.5" /> Kelola Master Insidental
                                    </button>
                                </div>
                                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2.5">
                                    {currentKategoriList.map(item => {
                                        const isSelected = iuranKategori === item.id;
                                        const IconComp = item.icon === 'Building2' ? Building2 :
                                                         item.icon === 'Users' ? Users :
                                                         item.icon === 'HandHeart' ? HandHeart :
                                                         item.icon === 'Scissors' ? Scissors :
                                                         item.icon === 'Zap' ? Zap : Coins;
                                        return (
                                            <button
                                                key={item.id}
                                                type="button"
                                                onClick={() => {
                                                    setIuranKategori(item.id);
                                                    setIuranNominal(item.defaultNom || 10000);
                                                    if (item.alokasiDefault) setIuranAlokasi(item.alokasiDefault);
                                                    if (item.targetDefault) setIuranTargetType(item.targetDefault);
                                                    
                                                    if (item.id === 'Kas Kamar' || item.targetDefault === 'Kamar') {
                                                        setIuranTargetType('Kamar');
                                                        setIuranAlokasi('KasKamar');
                                                        const firstKamar = akunKamarTersedia[0];
                                                        if (firstKamar) {
                                                            setIuranSelectedKamarNis(firstKamar.nis);
                                                            setIuranTujuanAkunNis(firstKamar.nis);
                                                            setIuranKeterangan(`Kas ${firstKamar.nama}`);
                                                        }
                                                    } else if (item.id === 'Kas Kelas' || item.targetDefault === 'Kelas') {
                                                        setIuranKeterangan(`Kas Kelas ${currentKelas || ''}`);
                                                    } else {
                                                        setIuranKeterangan(item.desc || item.label);
                                                    }
                                                }}
                                                className={`p-3 rounded-xl border text-left transition-all flex flex-col justify-between gap-2 ${
                                                    isSelected 
                                                        ? 'bg-indigo-50/80 border-indigo-500 text-indigo-900 shadow-sm ring-1 ring-indigo-400' 
                                                        : 'bg-canvas/50 border-whisper hover:border-slate-300 text-ink'
                                                }`}
                                            >
                                                <div className="flex items-center justify-between">
                                                    <IconComp className={`w-5 h-5 ${isSelected ? 'text-indigo-600' : 'text-steel'}`} />
                                                    {isSelected && <span className="w-2 h-2 rounded-full bg-indigo-600"></span>}
                                                </div>
                                                <div>
                                                    <div className="font-bold text-xs">{item.label}</div>
                                                    <div className="text-[10px] text-steel leading-tight mt-0.5">{item.desc}</div>
                                                    <div className="text-[10px] font-mono font-bold text-indigo-600 mt-1">Rp {(item.defaultNom || 0).toLocaleString('id-ID')}</div>
                                                </div>
                                            </button>
                                        );
                                    })}
                                </div>
                            </div>

                            {/* 2. Target Santri */}
                            <div>
                                <label className="block text-xs font-bold text-steel uppercase tracking-wider mb-2.5">
                                    2. Target Santri Yang Dipotong
                                </label>
                                <div className="flex border border-whisper rounded-xl p-1 bg-canvas/40 mb-3 gap-1 text-xs font-semibold">
                                    {[
                                        { id: 'Kamar', label: 'Per Kamar' },
                                        { id: 'Kelas', label: 'Per Kelas' },
                                        { id: 'PilihSantri', label: `Pilih Manual (${iuranSelectedNisList.length})` },
                                        { id: 'Semua', label: 'Semua Santri' },
                                    ].map(tab => (
                                        <button
                                            key={tab.id}
                                            type="button"
                                            onClick={() => setIuranTargetType(tab.id)}
                                            className={`flex-1 py-2 rounded-lg transition-all ${
                                                iuranTargetType === tab.id 
                                                    ? 'bg-surface text-indigo-600 shadow-sm font-bold' 
                                                    : 'text-steel hover:text-ink'
                                            }`}
                                        >
                                            {tab.label}
                                        </button>
                                    ))}
                                </div>

                                {iuranTargetType === 'Kamar' && (
                                    <div className="p-3.5 bg-indigo-50/70 border border-indigo-200 rounded-xl space-y-2">
                                        <div className="flex justify-between items-center">
                                            <label className="text-xs font-semibold text-indigo-950 flex items-center gap-1.5">
                                                <Building2 className="w-4 h-4 text-indigo-600" /> Pilih Kamar / Asrama Target:
                                            </label>
                                            <button 
                                                type="button" 
                                                onClick={() => setShowModalBuatAkunKamar(true)}
                                                className="text-[11px] font-bold text-indigo-700 hover:underline"
                                            >
                                                + Buat Kamar Baru
                                            </button>
                                        </div>
                                        <select
                                            value={iuranSelectedKamarNis}
                                            onChange={(e) => {
                                                const val = e.target.value;
                                                setIuranSelectedKamarNis(val);
                                                setIuranTujuanAkunNis(val);
                                                const km = akunKamarTersedia.find(k => String(k.nis) === String(val));
                                                if (km) {
                                                    setIuranKeterangan(`Kas ${km.nama}`);
                                                }
                                            }}
                                            className={`${inputBase} text-xs py-2 bg-white`}
                                        >
                                            <option value="">Pilih Kamar / Asrama...</option>
                                            {akunKamarTersedia.map(k => {
                                                const count = dataSantri.filter(s => 
                                                    !String(s.nis || '').startsWith('KAS-') &&
                                                    (!s.status || s.status.toLowerCase() !== 'keluar') &&
                                                    String(s.kelas || '').trim().toLowerCase() === String(k.kelas || '').trim().toLowerCase()
                                                ).length;
                                                return (
                                                    <option key={k.nis} value={k.nis}>
                                                        {k.nama} ({k.kelas || 'Asrama'}) — {count} santri
                                                    </option>
                                                );
                                            })}
                                        </select>
                                        {(() => {
                                            const km = akunKamarTersedia.find(k => String(k.nis) === String(iuranSelectedKamarNis));
                                            if (!km) return null;
                                            return (
                                                <p className="text-[11px] text-indigo-800 bg-white/80 p-2 rounded-lg border border-indigo-200">
                                                    ✅ <strong>{km.nama}</strong>: Hanya akan memotong <strong>{targetSantri.length} santri</strong> di kelas/asrama {km.kelas || '-'}. Dana otomatis masuk ke kas kamar ini.
                                                </p>
                                            );
                                        })()}
                                    </div>
                                )}

                                {iuranTargetType === 'Kelas' && (
                                    <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-xl space-y-2">
                                        <label className="text-xs font-semibold text-ink">Pilih Kelas / Asrama:</label>
                                        <select
                                            value={currentKelas}
                                            onChange={(e) => setIuranSelectedKelas(e.target.value)}
                                            className={`${inputBase} text-xs py-2`}
                                        >
                                            {masterKelasList.map(k => {
                                                const count = dataSantri.filter(s => String(s.kelas) === String(k)).length;
                                                return (
                                                    <option key={k} value={k}>
                                                        Kelas {k} ({count} santri)
                                                    </option>
                                                );
                                            })}
                                        </select>
                                        <p className="text-[11px] text-steel">
                                            Akan memotong saldo dari seluruh santri yang berada di kelas {currentKelas}.
                                        </p>
                                    </div>
                                )}

                                {iuranTargetType === 'PilihSantri' && (
                                    <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-xl space-y-3">
                                        <div className="flex gap-2 items-center">
                                            <div className="relative flex-1">
                                                <Search className="w-3.5 h-3.5 absolute left-3 top-2.5 text-steel" />
                                                <input
                                                    type="text"
                                                    placeholder="Cari nama / NIS / kelas santri..."
                                                    value={iuranSearchSantri}
                                                    onChange={(e) => setIuranSearchSantri(e.target.value)}
                                                    className={`${inputBase} pl-8 text-xs py-1.5`}
                                                />
                                            </div>
                                            <button
                                                type="button"
                                                onClick={() => {
                                                    if (iuranSelectedNisList.length === santriPilihanFiltered.length) {
                                                        setIuranSelectedNisList([]);
                                                    } else {
                                                        setIuranSelectedNisList(santriPilihanFiltered.map(s => String(s.nis)));
                                                    }
                                                }}
                                                className="px-2.5 py-1.5 bg-surface text-ink border border-whisper rounded-lg text-xs font-medium hover:bg-whisper/40"
                                            >
                                                {iuranSelectedNisList.length === santriPilihanFiltered.length ? 'Batal Semua' : 'Pilih Semua'}
                                            </button>
                                        </div>

                                        <div className="max-h-48 overflow-y-auto divide-y divide-whisper/50 border border-whisper rounded-lg bg-surface">
                                            {santriPilihanFiltered.length === 0 ? (
                                                <div className="p-4 text-center text-xs text-steel">Tidak ada santri ditemukan</div>
                                            ) : (
                                                santriPilihanFiltered.map(s => {
                                                    const sNis = String(s.nis);
                                                    const isChecked = iuranSelectedNisList.includes(sNis);
                                                    const saldo = getSantriSaldoTabungan(s.nis);
                                                    return (
                                                        <label
                                                            key={s.nis}
                                                            className={`flex items-center justify-between p-2.5 text-xs hover:bg-canvas cursor-pointer ${
                                                                isChecked ? 'bg-indigo-50/50' : ''
                                                            }`}
                                                        >
                                                            <div className="flex items-center gap-2.5">
                                                                <input
                                                                    type="checkbox"
                                                                    checked={isChecked}
                                                                    onChange={() => {
                                                                        if (isChecked) {
                                                                            setIuranSelectedNisList(prev => prev.filter(x => x !== sNis));
                                                                        } else {
                                                                            setIuranSelectedNisList(prev => [...prev, sNis]);
                                                                        }
                                                                    }}
                                                                    className="w-4 h-4 rounded text-indigo-600 cursor-pointer"
                                                                />
                                                                <div>
                                                                    <div className="font-semibold text-ink">{s.nama}</div>
                                                                    <div className="text-[10px] text-steel">NIS: {s.nis} • Kelas: {s.kelas || '-'}</div>
                                                                </div>
                                                            </div>
                                                            <div className="text-right">
                                                                <span className={`font-mono font-bold ${saldo >= nom ? 'text-emerald-600' : 'text-rose-500'}`}>
                                                                    Rp {saldo.toLocaleString('id-ID')}
                                                                </span>
                                                            </div>
                                                        </label>
                                                    );
                                                })
                                            )}
                                        </div>
                                    </div>
                                )}

                                {iuranTargetType === 'Semua' && (
                                    <div className="p-3.5 bg-blue-50 border border-blue-200 rounded-xl text-xs text-blue-800">
                                        ⚡ <strong>Perhatian:</strong> Iuran akan dipotong dari <strong>seluruh santri aktif ({dataSantri.length} santri)</strong>. Cocok untuk Infaq Jumat Berkah atau Cukur Massal.
                                    </div>
                                )}
                            </div>

                            {/* 3. Nominal Iuran */}
                            <div>
                                <label className="block text-xs font-bold text-steel uppercase tracking-wider mb-2">
                                    3. Nominal Potongan per Santri
                                </label>
                                <div className="relative mb-2">
                                    <span className="absolute left-3.5 top-2.5 text-sm font-bold text-steel">Rp</span>
                                    <input
                                        type="number"
                                        value={iuranNominal || ''}
                                        onChange={(e) => setIuranNominal(Number(e.target.value))}
                                        className={`${inputBase} pl-11 text-base font-bold text-ink`}
                                        placeholder="10000"
                                    />
                                </div>
                                <div className="flex flex-wrap gap-1.5">
                                    {[2000, 5000, 10000, 15000, 20000, 50000].map(val => (
                                        <button
                                            key={val}
                                            type="button"
                                            onClick={() => setIuranNominal(val)}
                                            className={`px-3 py-1 rounded-lg text-xs font-semibold border transition-all ${
                                                iuranNominal === val 
                                                    ? 'bg-indigo-600 text-white border-indigo-600 shadow-sm' 
                                                    : 'bg-surface text-steel border-whisper hover:border-slate-300'
                                            }`}
                                        >
                                            {val >= 1000 ? `${val / 1000}rb` : val}
                                        </button>
                                    ))}
                                </div>
                            </div>

                            {/* 4. Keterangan Transaksi */}
                            <div>
                                <label className="block text-xs font-bold text-steel uppercase tracking-wider mb-2">
                                    4. Keterangan Transaksi
                                </label>
                                <input
                                    type="text"
                                    value={iuranKeterangan}
                                    onChange={(e) => setIuranKeterangan(e.target.value)}
                                    className={inputBase}
                                    placeholder="Contoh: Kas Kamar 2B November 2026"
                                />
                            </div>

                            {/* 5. Alokasi Tujuan Uang */}
                            <div>
                                <label className="block text-xs font-bold text-steel uppercase tracking-wider mb-2">
                                    5. Alokasi Penerima (Ke Mana Dana Masuk?)
                                </label>
                                <div className="space-y-2 text-xs">
                                    <label className="flex items-start gap-3 p-3 rounded-xl border border-whisper hover:bg-canvas cursor-pointer bg-surface">
                                        <input
                                            type="radio"
                                            name="alokasi"
                                            checked={iuranAlokasi === 'BukuKas'}
                                            onChange={() => setIuranAlokasi('BukuKas')}
                                            className="w-4 h-4 text-indigo-600 mt-0.5 cursor-pointer"
                                        />
                                        <div>
                                            <div className="font-bold text-ink">Buku Kas Pondok (Tabel Kas)</div>
                                            <div className="text-steel text-[11px] mt-0.5">
                                                Otomatis masuk sebagai Pemasukan di Buku Kas dengan kategori {iuranKategori === 'Infaq / Sedekah' ? 'Infaq' : iuranKategori === 'Cukur' ? 'Jasa Cukur' : 'Kas Kamar/Asrama'}.
                                            </div>
                                        </div>
                                    </label>

                                    <label className="flex items-start gap-3 p-3 rounded-xl border border-whisper hover:bg-canvas cursor-pointer bg-surface">
                                        <input
                                            type="radio"
                                            name="alokasi"
                                            checked={iuranAlokasi === 'KasKamar'}
                                            onChange={() => setIuranAlokasi('KasKamar')}
                                            className="w-4 h-4 text-indigo-600 mt-0.5 cursor-pointer"
                                        />
                                        <div className="flex-1">
                                            <div className="font-bold text-ink">Akun Dompet Kamar / Rekening Khusus</div>
                                            <div className="text-steel text-[11px] mt-0.5">
                                                Total dana langsung disetorkan ke saldo akun santri virtual khusus kamar yang bisa ditap saat belanja di POS.
                                            </div>
                                            {iuranAlokasi === 'KasKamar' && (
                                                <div className="mt-2 space-y-1.5">
                                                    <select
                                                        value={iuranTujuanAkunNis}
                                                        onChange={(e) => setIuranTujuanAkunNis(e.target.value)}
                                                        className={`${inputBase} text-xs py-1.5`}
                                                    >
                                                        <option value="">Pilih Akun Dompet Kamar / Kelompok...</option>
                                                        {akunKamarTersedia.map(a => (
                                                            <option key={a.nis} value={a.nis}>
                                                                {a.nama} ({a.nis}) {a.uid ? `[RFID: ${a.uid}]` : '[Belum Ada RFID]'} - Saldo: Rp {getSantriSaldoTabungan(a.nis).toLocaleString('id-ID')}
                                                            </option>
                                                        ))}
                                                    </select>
                                                    {iuranTujuanAkunNis && (() => {
                                                        const selectedAkunObj = dataSantri.find(a => String(a.nis) === String(iuranTujuanAkunNis));
                                                        if (!selectedAkunObj) return null;
                                                        return (
                                                            <div className="p-3 bg-indigo-50/80 border border-indigo-200 rounded-xl space-y-2.5 mt-2">
                                                                {selectedAkunObj.uid ? (
                                                                    <div className="flex items-center justify-between p-2.5 bg-white border border-emerald-300 rounded-xl shadow-xs">
                                                                        <div className="flex items-center gap-2">
                                                                            <div className="w-7 h-7 rounded-lg bg-emerald-600 text-white flex items-center justify-center font-bold">
                                                                                <Scan className="w-3.5 h-3.5" />
                                                                            </div>
                                                                            <div>
                                                                                <div className="text-xs font-bold text-emerald-950 flex items-center gap-1.5">
                                                                                    Kartu RFID Aktif: <span className="font-mono bg-emerald-50 px-2 py-0.5 rounded border border-emerald-200 text-emerald-800">{selectedAkunObj.uid}</span>
                                                                                </div>
                                                                                <div className="text-[10px] text-emerald-700">Kartu fisik ini yang dibawa saat belanja di kasir POS.</div>
                                                                            </div>
                                                                        </div>
                                                                        <button
                                                                            type="button"
                                                                            onClick={() => {
                                                                                setModalEditRfidKamar(selectedAkunObj);
                                                                                setInputRfidEdit(selectedAkunObj.uid || '');
                                                                            }}
                                                                            className="px-2.5 py-1 bg-white hover:bg-slate-50 text-indigo-700 border border-indigo-200 rounded-lg text-xs font-semibold shadow-xs"
                                                                        >
                                                                            Ganti Kartu
                                                                        </button>
                                                                    </div>
                                                                ) : (
                                                                    <div>
                                                                        <div className="flex justify-between items-center mb-1">
                                                                            <span className="font-bold text-xs text-indigo-950 flex items-center gap-1.5">
                                                                                <Scan className="w-3.5 h-3.5 text-indigo-600" /> Hubungkan Kartu RFID:
                                                                            </span>
                                                                            <span className="text-amber-800 bg-amber-100 border border-amber-300 px-2 py-0.5 rounded text-[10px] font-semibold">
                                                                                ⚠️ Belum Terhubung Kartu RFID
                                                                            </span>
                                                                        </div>
                                                                        <div className="flex items-center gap-2 pt-1">
                                                                            <input
                                                                                type="text"
                                                                                placeholder="Tempelkan kartu RFID ke reader atau ketik UID..."
                                                                                value={inputRfidDirect}
                                                                                onChange={(e) => setInputRfidDirect(e.target.value)}
                                                                                className={`${inputBase} text-xs py-2 font-mono bg-white flex-1 font-bold text-indigo-900 border-indigo-300`}
                                                                            />
                                                                            <button
                                                                                type="button"
                                                                                onClick={() => handleHubungkanRfidDirect(iuranTujuanAkunNis, selectedAkunObj.nama)}
                                                                                className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 active:scale-95 text-white rounded-xl text-xs font-bold shadow-sm shrink-0 transition-all"
                                                                            >
                                                                                Hubungkan RFID
                                                                            </button>
                                                                        </div>
                                                                    </div>
                                                                )}
                                                                <div className="flex items-center justify-between pt-2 border-t border-indigo-200/60 text-xs">
                                                                    <div className="flex items-center gap-1.5 font-semibold text-indigo-950">
                                                                        <Key className="w-3.5 h-3.5 text-amber-600" /> PIN Kasir POS:
                                                                        <span className="font-mono bg-white border border-indigo-200 px-2 py-0.5 rounded text-xs font-bold text-indigo-900">
                                                                            {selectedAkunObj.pin || '123456'}
                                                                        </span>
                                                                    </div>
                                                                    <button
                                                                        type="button"
                                                                        onClick={() => {
                                                                            setModalEditPinKamar(selectedAkunObj);
                                                                            setInputPinEdit(selectedAkunObj.pin || '123456');
                                                                        }}
                                                                        className="px-3 py-1 bg-white hover:bg-slate-50 text-amber-700 border border-amber-300 rounded-lg text-xs font-bold shadow-xs"
                                                                    >
                                                                        Ubah PIN
                                                                    </button>
                                                                </div>
                                                            </div>
                                                        );
                                                    })()}
                                                    {akunKamarTersedia.length === 0 && (
                                                        <div className="text-[11px] text-amber-600">
                                                            Belum ada akun kamar. Klik tombol "Buat Akun Dompet Kamar" di atas untuk membuatnya.
                                                        </div>
                                                    )}
                                                </div>
                                            )}
                                        </div>
                                    </label>

                                    <label className="flex items-start gap-3 p-3 rounded-xl border border-whisper hover:bg-canvas cursor-pointer bg-surface">
                                        <input
                                            type="radio"
                                            name="alokasi"
                                            checked={iuranAlokasi === 'None'}
                                            onChange={() => setIuranAlokasi('None')}
                                            className="w-4 h-4 text-indigo-600 mt-0.5 cursor-pointer"
                                        />
                                        <div>
                                            <div className="font-bold text-ink">Hanya Potong Saldo Santri</div>
                                            <div className="text-steel text-[11px] mt-0.5">
                                                Hanya mendebit saldo tabungan santri (misal uang fisik dicairkan secara terpisah di kasir koperasi).
                                            </div>
                                        </div>
                                    </label>
                                </div>
                            </div>

                            {/* 6. Proteksi Saldo */}
                            <div className="pt-2 border-t border-whisper">
                                <label className="flex items-center gap-2.5 text-xs text-ink cursor-pointer font-medium">
                                    <input
                                        type="checkbox"
                                        checked={iuranSkipInsufficient}
                                        onChange={(e) => setIuranSkipInsufficient(e.target.checked)}
                                        className="w-4 h-4 rounded text-indigo-600 cursor-pointer"
                                    />
                                    <span>
                                        Lewati santri yang saldonya kurang dari Rp {nom.toLocaleString('id-ID')} (Mencegah saldo minus)
                                    </span>
                                </label>
                            </div>
                        </div>
                    </div>

                    {/* Kolom Kanan: Pratinjau Real-Time & Eksekusi */}
                    <div className="lg:col-span-5 space-y-6">
                        <div className="bg-surface border border-whisper rounded-2xl p-6 shadow-sm space-y-5 sticky top-20">
                            <div>
                                <h4 className="font-bold text-ink text-sm flex items-center gap-2">
                                    <Zap className="w-4 h-4 text-indigo-600" /> Ringkasan & Kesiapan Eksekusi
                                </h4>
                                <p className="text-xs text-steel mt-0.5">
                                    Pengecekan live saldo tabungan santri sebelum dipotong.
                                </p>
                            </div>

                            <div className="grid grid-cols-2 gap-3 text-xs">
                                <div className="p-3 bg-canvas/60 rounded-xl border border-whisper">
                                    <div className="text-steel">Target Santri:</div>
                                    <div className="font-bold text-ink text-base mt-0.5">{targetSantri.length} santri</div>
                                </div>
                                <div className="p-3 bg-canvas/60 rounded-xl border border-whisper">
                                    <div className="text-steel">Nominal per Anak:</div>
                                    <div className="font-bold text-ink text-base mt-0.5">Rp {nom.toLocaleString('id-ID')}</div>
                                </div>
                            </div>

                            {/* Status Saldo */}
                            <div className="space-y-2 text-xs">
                                <div className="flex justify-between items-center p-3 rounded-xl bg-emerald-50 border border-emerald-200">
                                    <div className="flex items-center gap-2">
                                        <div className="w-2.5 h-2.5 rounded-full bg-emerald-500"></div>
                                        <span className="font-semibold text-emerald-900">Saldo Cukup (Bisa Ditarik):</span>
                                    </div>
                                    <span className="font-bold text-emerald-700 text-sm font-mono">
                                        {eligibleSantri.length} santri
                                    </span>
                                </div>

                                <div className="flex justify-between items-center p-3 rounded-xl bg-amber-50 border border-amber-200">
                                    <div className="flex items-center gap-2">
                                        <div className="w-2.5 h-2.5 rounded-full bg-amber-500"></div>
                                        <span className="font-semibold text-amber-900">Saldo Kurang (Akan Dilewati):</span>
                                    </div>
                                    <span className="font-bold text-amber-700 text-sm font-mono">
                                        {insufficientSantri.length} santri
                                    </span>
                                </div>
                            </div>

                            {/* Peringatan Santri Saldo Kurang */}
                            {insufficientSantri.length > 0 && (
                                <div className="p-3.5 bg-rose-50/70 border border-rose-200 rounded-xl space-y-1.5 text-xs">
                                    <div className="font-bold text-rose-800 flex items-center gap-1.5">
                                        <AlertCircle className="w-4 h-4 text-rose-600" /> {insufficientSantri.length} Santri Perlu Top-Up Saldo:
                                    </div>
                                    <div className="max-h-28 overflow-y-auto space-y-1 text-[11px] text-rose-700 divide-y divide-rose-200/50">
                                        {insufficientSantri.map(s => (
                                            <div key={s.nis} className="pt-1 flex justify-between">
                                                <span>{s.nama} ({s.nis})</span>
                                                <span className="font-bold font-mono">Saldo: Rp {getSantriSaldoTabungan(s.nis).toLocaleString('id-ID')}</span>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}

                            {/* Total Estimasi */}
                            <div className="p-4 bg-gradient-to-br from-indigo-900 to-indigo-950 text-white rounded-xl space-y-1">
                                <div className="text-xs text-indigo-200 font-medium">Total Estimasi Dana Masuk:</div>
                                <div className="text-2xl font-bold font-mono tracking-tight text-white">
                                    Rp {totalEstimasiDana.toLocaleString('id-ID')}
                                </div>
                                <div className="text-[11px] text-indigo-300">
                                    Dari {eligibleSantri.length} santri @ Rp {nom.toLocaleString('id-ID')}
                                </div>
                            </div>

                            {/* Tombol Eksekusi */}
                            <button
                                type="button"
                                disabled={iuranProcessing || eligibleSantri.length === 0}
                                onClick={handleEksekusiPotongIuran}
                                className={`w-full py-3.5 px-4 rounded-xl font-bold text-sm flex items-center justify-center gap-2 shadow-sm transition-all ${
                                    eligibleSantri.length > 0 && !iuranProcessing
                                        ? 'bg-indigo-600 hover:bg-indigo-700 text-white shadow-indigo-200 active:scale-[0.98]'
                                        : 'bg-slate-200 text-slate-400 cursor-not-allowed'
                                }`}
                            >
                                {iuranProcessing ? (
                                    <>
                                        <RefreshCw className="w-4 h-4 animate-spin" /> Memproses Pemotongan Saldo...
                                    </>
                                ) : (
                                    <>
                                        <Zap className="w-4 h-4" /> Tarik Saldo Sekarang ({eligibleSantri.length} Santri)
                                    </>
                                )}
                            </button>
                        </div>
                    </div>
                </div>

                {/* DAFTAR AKUN DOMPET KAMAR / ASRAMA */}
                <div className="bg-surface border border-whisper shadow-sm rounded-card overflow-hidden mt-8">
                    <div className="p-4 border-b border-whisper/50 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 bg-canvas/40">
                        <div>
                            <h4 className="font-bold text-ink text-sm flex items-center gap-2">
                                <Building2 className="w-4 h-4 text-indigo-600" /> Daftar Akun Dompet Kamar & Asrama
                            </h4>
                            <p className="text-xs text-steel">Rekening bersama per kamar untuk menampung kas dan belanja di kasir POS.</p>
                        </div>
                        <button
                            type="button"
                            onClick={() => setShowModalBuatAkunKamar(true)}
                            className="px-3.5 py-1.5 bg-indigo-600 hover:bg-indigo-700 active:scale-95 text-white rounded-xl text-xs font-bold shadow-sm flex items-center gap-1.5 transition-all"
                        >
                            <Plus className="w-4 h-4" /> Tambah Akun Kamar
                        </button>
                    </div>
                    <div className="overflow-x-auto">
                        <table className="w-full text-sm text-left">
                            <thead className="bg-canvas/60 text-steel border-b border-whisper/50 text-xs">
                                <tr>
                                    <th className="px-6 py-3">Nama Kamar / Akun</th>
                                    <th className="px-6 py-3">Asrama / Kelas</th>
                                    <th className="px-6 py-3 text-right">Saldo Kas</th>
                                    <th className="px-6 py-3 text-center">Kartu RFID (UID)</th>
                                    <th className="px-6 py-3 text-center">PIN Kasir POS</th>
                                    <th className="px-6 py-3 text-right">Aksi</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-100 text-xs">
                                {akunKamarTersedia.length === 0 ? (
                                    <tr>
                                        <td colSpan={6} className="px-6 py-8 text-center text-steel">
                                            Belum ada akun dompet kamar. Klik "Tambah Akun Kamar" untuk membuatnya.
                                        </td>
                                    </tr>
                                ) : (
                                    akunKamarTersedia.map(k => {
                                        const saldo = getSantriSaldoTabungan(k.nis);
                                        return (
                                            <tr key={k.nis} className="hover:bg-canvas/50 transition-colors">
                                                <td className="px-6 py-3 font-semibold text-ink">
                                                    <div className="flex items-center gap-2">
                                                        <Building2 className="w-4 h-4 text-indigo-500 shrink-0" />
                                                        <div>
                                                            <div>{k.nama}</div>
                                                            <div className="text-[10px] text-steel font-mono">{k.nis}</div>
                                                        </div>
                                                    </div>
                                                </td>
                                                <td className="px-6 py-3 text-steel">
                                                    {k.kelas || 'Asrama'}
                                                </td>
                                                <td className="px-6 py-3 text-right font-bold font-mono text-emerald-700 text-sm">
                                                    Rp {saldo.toLocaleString('id-ID')}
                                                </td>
                                                <td className="px-6 py-3 text-center">
                                                    {k.uid ? (
                                                        <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-mono font-bold bg-emerald-50 text-emerald-800 border border-emerald-200">
                                                            <Scan className="w-3 h-3 text-emerald-600" /> {k.uid}
                                                        </span>
                                                    ) : (
                                                        <span className="inline-block px-2 py-0.5 rounded text-[10px] bg-amber-50 text-amber-700 border border-amber-200 font-semibold">
                                                            Belum Ada Kartu
                                                        </span>
                                                    )}
                                                </td>
                                                <td className="px-6 py-3 text-center font-mono">
                                                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs bg-slate-100 text-slate-800 border border-slate-200 font-bold">
                                                        <Key className="w-3 h-3 text-slate-500" /> {k.pin || '123456'}
                                                    </span>
                                                </td>
                                                <td className="px-6 py-3 text-right space-x-2">
                                                    <button
                                                        type="button"
                                                        onClick={() => {
                                                            setModalEditRfidKamar(k);
                                                            setInputRfidEdit(k.uid || '');
                                                        }}
                                                        className="px-2.5 py-1 bg-white hover:bg-slate-50 text-indigo-700 border border-indigo-200 rounded-lg text-xs font-semibold shadow-xs"
                                                        title="Ganti / Hubungkan Kartu RFID"
                                                    >
                                                        <Scan className="w-3 h-3 inline mr-1" /> Kartu
                                                    </button>
                                                    <button
                                                        type="button"
                                                        onClick={() => {
                                                            setModalEditPinKamar(k);
                                                            setInputPinEdit(k.pin || '123456');
                                                        }}
                                                        className="px-2.5 py-1 bg-white hover:bg-slate-50 text-amber-700 border border-amber-200 rounded-lg text-xs font-semibold shadow-xs"
                                                        title="Ubah PIN Kasir POS"
                                                    >
                                                        <Key className="w-3 h-3 inline mr-1" /> PIN
                                                    </button>
                                                    <button
                                                        type="button"
                                                        onClick={() => handleHapusAkunKamar(k)}
                                                        className="px-2 py-1 bg-white hover:bg-rose-50 text-rose-600 border border-rose-200 rounded-lg text-xs font-semibold shadow-xs"
                                                        title="Hapus Akun Kamar"
                                                    >
                                                        <Trash2 className="w-3 h-3 inline" />
                                                    </button>
                                                </td>
                                            </tr>
                                        );
                                    })
                                )}
                            </tbody>
                        </table>
                    </div>
                </div>

                {/* Tabel Riwayat Penarikan Iuran / Kas Insidental */}
                <div className="bg-surface border border-whisper shadow-sm rounded-card overflow-hidden mt-8">
                    <div className="p-4 border-b border-whisper/50 flex flex-col sm:flex-row justify-between items-center gap-3 bg-canvas/40">
                        <div>
                            <h4 className="font-bold text-ink text-sm">Riwayat Pemotongan Kas & Infaq</h4>
                            <p className="text-xs text-steel">Daftar transaksi insidental yang pernah ditarik dari saldo tabungan.</p>
                        </div>
                        <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto">
                            <select
                                value={iuranRiwayatFilter}
                                onChange={(e) => setIuranRiwayatFilter(e.target.value)}
                                className={`${inputBase} py-1.5 text-xs w-auto`}
                            >
                                <option value="Semua">Semua Kategori</option>
                                <option value="Kas Kamar">Kas Kamar</option>
                                <option value="Infaq">Infaq</option>
                                <option value="Cukur">Cukur</option>
                                <option value="Kas Kelas">Kas Kelas</option>
                            </select>
                            <div className="relative w-full sm:w-auto">
                                <Search className="w-3.5 h-3.5 absolute left-3 top-2.5 text-steel" />
                                <input
                                    type="text"
                                    placeholder="Cari santri / keterangan..."
                                    value={iuranRiwayatSearch}
                                    onChange={(e) => setIuranRiwayatSearch(e.target.value)}
                                    className={`${inputBase} pl-8 py-1.5 text-xs w-full sm:w-56`}
                                />
                            </div>
                            <button
                                type="button"
                                onClick={() => {
                                    downloadStyledExcel(
                                        'Riwayat Kas dan Infaq',
                                        ['Tanggal', 'NIS', 'Nama Santri', 'Jenis', 'Nominal', 'Keterangan'],
                                        riwayatInsidental.map(t => [t.tanggal, t.nis, t.nama, t.jenis, t.nominal, t.keterangan]),
                                        'Riwayat_Iuran_Kas_Insidental'
                                    );
                                }}
                                className={btnOutline}
                            >
                                <FileSpreadsheet className="w-3.5 h-3.5 text-accent" /> Unduh Excel
                            </button>
                        </div>
                    </div>

                    <div className="overflow-x-auto">
                        <table className="w-full text-sm text-left">
                            <thead className="bg-canvas/60 text-steel border-b border-whisper/50 text-xs">
                                <tr>
                                    <th className="px-6 py-3">Tanggal</th>
                                    <th className="px-6 py-3">Santri / Akun</th>
                                    <th className="px-6 py-3">Keterangan</th>
                                    <th className="px-6 py-3 text-center">Jenis</th>
                                    <th className="px-6 py-3 text-right">Nominal</th>
                                    <th className="px-6 py-3 text-center">Aksi</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-100 text-xs">
                                {riwayatInsidental.length === 0 ? (
                                    <tr>
                                        <td colSpan={6} className="px-6 py-10 text-center text-steel">
                                            Belum ada riwayat transaksi penarikan kas atau iuran insidental.
                                        </td>
                                    </tr>
                                ) : (
                                    riwayatInsidental.slice(0, 50).map((t, idx) => (
                                        <tr key={t.id || idx} className="hover:bg-canvas/50 transition-colors">
                                            <td className="px-6 py-3 font-mono text-steel">{t.tanggal}</td>
                                            <td className="px-6 py-3">
                                                <div className="font-semibold text-ink">{t.nama}</div>
                                                <div className="text-[10px] text-steel font-mono">{t.nis}</div>
                                            </td>
                                            <td className="px-6 py-3 text-ink font-medium">{t.keterangan || '-'}</td>
                                            <td className="px-6 py-3 text-center">
                                                <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                                                    String(t.jenis).toLowerCase() === 'setor' 
                                                        ? 'bg-emerald-100 text-emerald-700' 
                                                        : 'bg-rose-100 text-rose-700'
                                                }`}>
                                                    {t.jenis}
                                                </span>
                                            </td>
                                            <td className="px-6 py-3 text-right font-bold font-mono text-ink">
                                                Rp {Number(t.nominal || 0).toLocaleString('id-ID')}
                                            </td>
                                            <td className="px-6 py-3 text-center">
                                                <div className="flex items-center justify-center gap-1.5">
                                                    <button
                                                        type="button"
                                                        onClick={() => handleBukaEditRiwayatInsidental(t)}
                                                        title="Edit Riwayat"
                                                        className="p-1.5 text-indigo-600 hover:bg-indigo-50 rounded-lg border border-indigo-200 transition-colors"
                                                    >
                                                        <Edit className="w-3.5 h-3.5" />
                                                    </button>
                                                    <button
                                                        type="button"
                                                        onClick={() => handleHapusRiwayatInsidental(t)}
                                                        title="Hapus Transaksi (Pulihkan Saldo)"
                                                        className="p-1.5 text-rose-600 hover:bg-rose-50 rounded-lg border border-rose-200 transition-colors"
                                                    >
                                                        <Trash2 className="w-3.5 h-3.5" />
                                                    </button>
                                                </div>
                                            </td>
                                        </tr>
                                    ))
                                )}
                            </tbody>
                        </table>
                    </div>
                </div>

                {/* Modal Buat Akun Dompet Kamar Baru */}
                {showModalBuatAkunKamar && (
                    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-ink/20 backdrop-blur-[3px]">
                        <div className="bg-surface rounded-2xl border border-whisper w-full max-w-md p-6 shadow-diffused space-y-4">
                            <div className="flex justify-between items-center pb-3 border-b border-whisper">
                                <h3 className="font-bold text-ink text-base">Buat Akun Dompet Kamar Baru</h3>
                                <button 
                                    type="button" 
                                    onClick={() => setShowModalBuatAkunKamar(false)}
                                    className="text-steel hover:text-ink"
                                >
                                    <X className="w-5 h-5" />
                                </button>
                            </div>
                            <form onSubmit={handleBuatAkunKamar} className="space-y-4 text-xs">
                                <div>
                                    <label className="block font-semibold text-ink mb-1">Nama Kamar / Kelompok:</label>
                                    <input
                                        type="text"
                                        required
                                        placeholder="Misal: Kamar Al-Fatih 1 atau Kamar 2B"
                                        value={namaKamarBaru}
                                        onChange={(e) => setNamaKamarBaru(e.target.value)}
                                        className={inputBase}
                                    />
                                </div>
                                <div>
                                    <label className="block font-semibold text-ink mb-1">Kelas / Asrama:</label>
                                    <select
                                        value={kelasKamarBaru}
                                        onChange={(e) => setKelasKamarBaru(e.target.value)}
                                        className={inputBase}
                                    >
                                        <option value="">Pilih Asrama / Kelas</option>
                                        {masterKelasList.map(k => (
                                            <option key={k} value={k}>{k}</option>
                                        ))}
                                    </select>
                                </div>
                                <div>
                                    <label className="block font-semibold text-ink mb-1 flex justify-between items-center">
                                        <span>Tempelkan Kartu RFID (Opsional):</span>
                                        <span className="text-[10px] text-steel font-normal">Tap kartu ke reader</span>
                                    </label>
                                    <input
                                        type="text"
                                        placeholder="Tap kartu RFID ke reader atau ketik UID..."
                                        value={uidKamarBaru}
                                        onChange={(e) => setUidKamarBaru(e.target.value)}
                                        className={`${inputBase} font-mono`}
                                    />
                                    {uidKamarBaru.trim() && (() => {
                                        const cleanCode = uidKamarBaru.trim().replace(/^0+/, '').toLowerCase();
                                        const conflict = dataSantri.find(s => {
                                            const exUid = String(s.uid || '').trim().replace(/^0+/, '').toLowerCase();
                                            const exRfid = String(s.rfid || '').trim().replace(/^0+/, '').toLowerCase();
                                            return cleanCode && (exUid === cleanCode || exRfid === cleanCode);
                                        });
                                        if (conflict) {
                                            return (
                                                <div className="p-2.5 rounded-xl bg-amber-50 border border-amber-300 text-amber-900 text-[11px] mt-1.5 space-y-1">
                                                    <div className="font-bold flex items-center gap-1 text-amber-800">
                                                        <AlertCircle className="w-3.5 h-3.5 text-amber-600" /> Kartu RFID ini sudah terdaftar:
                                                    </div>
                                                    <div>Milik: <strong>{conflict.nama}</strong> (NIS: {conflict.nis}, Kelas: {conflict.kelas || '-'}).</div>
                                                    <div className="text-[10px] text-amber-700">Saat disimpan, sistem akan meminta konfirmasi pemindahan kartu dari {conflict.nama}.</div>
                                                </div>
                                            );
                                        }
                                        return null;
                                    })()}
                                    <p className="text-[10px] text-steel mt-1">
                                        Kartu fisik ini yang nantinya dipegang ketua kamar untuk ditap saat belanja di kasir POS. (Bisa diisi nanti).
                                    </p>
                                </div>
                                <div>
                                    <label className="block font-semibold text-ink mb-1 flex justify-between items-center">
                                        <span>PIN Transaksi Kasir POS (6 Digit):</span>
                                        <span className="text-[10px] text-indigo-600 font-bold">Wajib di Kasir POS</span>
                                    </label>
                                    <input
                                        type="password"
                                        maxLength={6}
                                        required
                                        placeholder="6 Digit angka, misal: 123456"
                                        value={pinKamarBaru}
                                        onChange={(e) => setPinKamarBaru(e.target.value.replace(/\D/g, ''))}
                                        className={`${inputBase} font-mono text-center tracking-widest font-bold text-sm`}
                                    />
                                    <p className="text-[10px] text-steel mt-1">
                                        PIN keamanan 6 digit yang wajib dimasukkan bendahara/ketua kamar saat belanja di kasir POS. Default: 123456.
                                    </p>
                                </div>
                                <p className="text-[11px] text-steel">
                                    Akun ini didaftarkan sebagai dompet bersama. Saat bendahara kamar belanja di POS koperasi, kasir tinggal tap kartu dan memasukkan PIN ini.
                                </p>
                                <div className="flex justify-end gap-2 pt-3 border-t border-whisper">
                                    <button 
                                        type="button" 
                                        onClick={() => setShowModalBuatAkunKamar(false)}
                                        className={btnOutline}
                                    >
                                        Batal
                                    </button>
                                    <button type="submit" className={btnPrimary}>
                                        Simpan Akun Kamar
                                    </button>
                                </div>
                            </form>
                        </div>
                    </div>
                )}

                {/* Modal Edit Kartu RFID Kamar */}
                {modalEditRfidKamar && (
                    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-ink/20 backdrop-blur-[3px]">
                        <div className="bg-surface rounded-2xl border border-whisper w-full max-w-md p-6 shadow-diffused space-y-4">
                            <div className="flex justify-between items-center pb-3 border-b border-whisper">
                                <h3 className="font-bold text-ink text-base flex items-center gap-2">
                                    <Scan className="w-5 h-5 text-indigo-600" /> Hubungkan Kartu RFID Kamar
                                </h3>
                                <button 
                                    type="button" 
                                    onClick={() => { setModalEditRfidKamar(null); setInputRfidEdit(''); }}
                                    className="text-steel hover:text-ink"
                                >
                                    <X className="w-5 h-5" />
                                </button>
                            </div>
                            <form onSubmit={handleSimpanRfidKamar} className="space-y-4 text-xs">
                                <div>
                                    <label className="block font-semibold text-ink mb-1">Akun Kamar:</label>
                                    <div className="p-3 bg-slate-50 border border-slate-200 rounded-xl font-bold text-ink">
                                        {modalEditRfidKamar.nama} ({modalEditRfidKamar.nis})
                                    </div>
                                </div>
                                <div>
                                    <label className="block font-semibold text-ink mb-1 flex justify-between items-center">
                                        <span>Nomor UID Kartu RFID:</span>
                                        <span className="text-[10px] text-steel font-normal">Tap kartu ke reader</span>
                                    </label>
                                    <input
                                        type="text"
                                        autoFocus
                                        placeholder="Tempelkan kartu RFID atau ketik UID..."
                                        value={inputRfidEdit}
                                        onChange={(e) => setInputRfidEdit(e.target.value)}
                                        className={`${inputBase} font-mono`}
                                    />
                                    {inputRfidEdit.trim() && (() => {
                                        const cleanCode = inputRfidEdit.trim().replace(/^0+/, '').toLowerCase();
                                        const conflict = dataSantri.find(s => {
                                            if (String(s.nis) === String(modalEditRfidKamar.nis)) return false;
                                            const exUid = String(s.uid || '').trim().replace(/^0+/, '').toLowerCase();
                                            const exRfid = String(s.rfid || '').trim().replace(/^0+/, '').toLowerCase();
                                            return cleanCode && (exUid === cleanCode || exRfid === cleanCode);
                                        });
                                        if (conflict) {
                                            return (
                                                <div className="p-2.5 rounded-xl bg-amber-50 border border-amber-300 text-amber-900 text-[11px] mt-2 space-y-1">
                                                    <div className="font-bold flex items-center gap-1 text-amber-800">
                                                        <AlertCircle className="w-3.5 h-3.5 text-amber-600" /> Kartu RFID ini sudah terdaftar:
                                                    </div>
                                                    <div>Milik: <strong>{conflict.nama}</strong> (NIS: {conflict.nis}, Kelas: {conflict.kelas || '-'}).</div>
                                                    <div className="text-[10px] text-amber-700">Menyimpan akan otomatis memindahkan kartu dari {conflict.nama} ke {modalEditRfidKamar.nama}.</div>
                                                </div>
                                            );
                                        }
                                        return null;
                                    })()}
                                </div>
                                <div className="flex justify-end gap-2 pt-3 border-t border-whisper">
                                    <button 
                                        type="button" 
                                        onClick={() => { setModalEditRfidKamar(null); setInputRfidEdit(''); }}
                                        className={btnOutline}
                                    >
                                        Batal
                                    </button>
                                    {modalEditRfidKamar.uid && (
                                        <button
                                            type="button"
                                            onClick={async () => {
                                                if (!window.confirm(`Lepas kartu RFID dari ${modalEditRfidKamar.nama}?`)) return;
                                                try {
                                                    await supabase.from('Data Santri').update({ uid: null }).eq('nis', modalEditRfidKamar.nis);
                                                    setDataSantri(prev => prev.map(s => String(s.nis) === String(modalEditRfidKamar.nis) ? { ...s, uid: null } : s));
                                                    showNotification(`Kartu RFID berhasil dilepas dari ${modalEditRfidKamar.nama}.`);
                                                    setModalEditRfidKamar(null);
                                                    setInputRfidEdit('');
                                                } catch (err) {
                                                    showNotification('Gagal melepas kartu: ' + err.message, 'error');
                                                }
                                            }}
                                            className="px-3 py-1.5 bg-rose-50 hover:bg-rose-100 text-rose-600 border border-rose-200 rounded-xl text-xs font-semibold"
                                        >
                                            Lepas Kartu
                                        </button>
                                    )}
                                    <button type="submit" className={btnPrimary}>
                                        Simpan Kartu
                                    </button>
                                </div>
                            </form>
                        </div>
                    </div>
                )}

                {/* Modal Master Kategori Insidental */}
                {showModalMasterInsidental && (
                    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-ink/20 backdrop-blur-[3px]">
                        <div className="bg-surface rounded-2xl border border-whisper w-full max-w-2xl p-6 shadow-diffused space-y-4 max-h-[90vh] overflow-y-auto">
                            <div className="flex justify-between items-center pb-3 border-b border-whisper">
                                <h3 className="font-bold text-ink text-base flex items-center gap-2">
                                    <Settings className="w-5 h-5 text-indigo-600" /> Master Kategori Iuran & Kas Insidental
                                </h3>
                                <button 
                                    type="button" 
                                    onClick={() => setShowModalMasterInsidental(false)}
                                    className="text-steel hover:text-ink"
                                >
                                    <X className="w-5 h-5" />
                                </button>
                            </div>
                            
                            <p className="text-xs text-steel">
                                Atur jenis-jenis iuran insidental yang bisa ditarik dari saldo santri (Kas Kamar, Infaq, Cukur, Tabungan Qurban, dll).
                            </p>

                            {/* Daftar Kategori Saat Ini */}
                            <div className="space-y-2">
                                <h4 className="text-xs font-bold uppercase tracking-wider text-ink">Daftar Kategori Aktif</h4>
                                <div className="border border-whisper rounded-xl overflow-hidden">
                                    <table className="w-full text-xs text-left">
                                        <thead className="bg-canvas text-steel border-b border-whisper">
                                            <tr>
                                                <th className="p-2.5">Kategori</th>
                                                <th className="p-2.5">Nominal Default</th>
                                                <th className="p-2.5">Alokasi Dana</th>
                                                <th className="p-2.5">Target Santri</th>
                                                <th className="p-2.5 text-right">Aksi</th>
                                            </tr>
                                        </thead>
                                        <tbody className="divide-y divide-whisper">
                                            {(appConfig?.masterKategoriInsidental || defaultMasterInsidental).map((k, idx) => (
                                                <tr key={k.id || idx} className="hover:bg-canvas/50">
                                                    <td className="p-2.5 font-bold text-ink">
                                                        <div>{k.label}</div>
                                                        <div className="text-[10px] text-steel font-normal">{k.desc}</div>
                                                    </td>
                                                    <td className="p-2.5 font-mono font-bold text-emerald-700">
                                                        Rp {(k.defaultNom || 0).toLocaleString('id-ID')}
                                                    </td>
                                                    <td className="p-2.5">
                                                        <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-slate-100 text-slate-800">
                                                            {k.alokasiDefault === 'KasKamar' ? 'Dompet Kamar' : k.alokasiDefault === 'BukuKas' ? 'Buku Kas Pondok' : 'Potong Saldo Saja'}
                                                        </span>
                                                    </td>
                                                    <td className="p-2.5">
                                                        <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-indigo-50 text-indigo-700">
                                                            {k.targetDefault === 'Kamar' ? 'Per Kamar' : k.targetDefault === 'Kelas' ? 'Per Kelas' : 'Semua Santri'}
                                                        </span>
                                                    </td>
                                                    <td className="p-2.5 text-right">
                                                        <button
                                                            type="button"
                                                            onClick={async () => {
                                                                if (!window.confirm(`Hapus kategori '${k.label}'?`)) return;
                                                                const cur = appConfig?.masterKategoriInsidental || defaultMasterInsidental;
                                                                const updated = cur.filter(x => x.id !== k.id);
                                                                try {
                                                                    await supabase.from('MasterConfig').upsert({
                                                                        kunci: 'masterKategoriInsidental',
                                                                        nilai: JSON.stringify(updated)
                                                                    }, { onConflict: 'kunci' });
                                                                    setAppConfig(prev => ({ ...prev, masterKategoriInsidental: updated }));
                                                                    showNotification(`Kategori '${k.label}' dihapus!`);
                                                                } catch (err) {
                                                                    showNotification('Gagal hapus kategori: ' + err.message, 'error');
                                                                }
                                                            }}
                                                            className="text-rose-600 hover:text-rose-800 p-1 rounded"
                                                            title="Hapus Kategori"
                                                        >
                                                            <Trash2 className="w-3.5 h-3.5" />
                                                        </button>
                                                    </td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            </div>

                            {/* Form Tambah Kategori Baru */}
                            <form onSubmit={async (e) => {
                                e.preventDefault();
                                const nm = (formMasterKat.label || '').trim();
                                if (!nm) return showNotification('Nama kategori tidak boleh kosong!', 'error');
                                const cur = appConfig?.masterKategoriInsidental || defaultMasterInsidental;
                                const newId = nm;
                                if (cur.some(x => x.id.toLowerCase() === newId.toLowerCase())) {
                                    return showNotification('Kategori dengan nama ini sudah ada!', 'error');
                                }
                                const newCat = {
                                    id: newId,
                                    label: nm,
                                    icon: formMasterKat.targetDefault === 'Kamar' ? 'Building2' : 'Coins',
                                    defaultNom: Number(formMasterKat.defaultNom || 10000),
                                    desc: formMasterKat.desc || nm,
                                    alokasiDefault: formMasterKat.alokasiDefault || 'BukuKas',
                                    targetDefault: formMasterKat.targetDefault || 'Kelas'
                                };
                                const updated = [...cur, newCat];
                                try {
                                    await supabase.from('MasterConfig').upsert({
                                        kunci: 'masterKategoriInsidental',
                                        nilai: JSON.stringify(updated)
                                    }, { onConflict: 'kunci' });
                                    setAppConfig(prev => ({ ...prev, masterKategoriInsidental: updated }));
                                    setFormMasterKat({ id: '', label: '', defaultNom: 10000, desc: '', alokasiDefault: 'BukuKas', targetDefault: 'Kelas' });
                                    showNotification(`Kategori baru '${nm}' berhasil ditambahkan!`);
                                } catch (err) {
                                    showNotification('Gagal simpan kategori: ' + err.message, 'error');
                                }
                            }} className="p-4 bg-slate-50 border border-slate-200 rounded-xl space-y-3 text-xs">
                                <h4 className="font-bold text-ink text-xs uppercase tracking-wider flex items-center gap-1.5">
                                    <Plus className="w-3.5 h-3.5 text-indigo-600" /> Tambah Kategori Baru
                                </h4>
                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                    <div>
                                        <label className="block font-semibold text-ink mb-1">Nama Kategori:</label>
                                        <input
                                            type="text"
                                            required
                                            placeholder="Misal: Buka Bersama, Ujian, dll"
                                            value={formMasterKat.label}
                                            onChange={(e) => setFormMasterKat(prev => ({ ...prev, label: e.target.value }))}
                                            className={inputBase}
                                        />
                                    </div>
                                    <div>
                                        <label className="block font-semibold text-ink mb-1">Nominal Default (Rp):</label>
                                        <input
                                            type="number"
                                            required
                                            min="0"
                                            placeholder="10000"
                                            value={formMasterKat.defaultNom}
                                            onChange={(e) => setFormMasterKat(prev => ({ ...prev, defaultNom: Number(e.target.value) }))}
                                            className={inputBase}
                                        />
                                    </div>
                                    <div>
                                        <label className="block font-semibold text-ink mb-1">Alokasi Penerima Default:</label>
                                        <select
                                            value={formMasterKat.alokasiDefault}
                                            onChange={(e) => setFormMasterKat(prev => ({ ...prev, alokasiDefault: e.target.value }))}
                                            className={inputBase}
                                        >
                                            <option value="BukuKas">Buku Kas Pondok (Pemasukan)</option>
                                            <option value="KasKamar">Akun Dompet Kamar</option>
                                            <option value="None">Hanya Potong Saldo Santri</option>
                                        </select>
                                    </div>
                                    <div>
                                        <label className="block font-semibold text-ink mb-1">Target Santri Default:</label>
                                        <select
                                            value={formMasterKat.targetDefault}
                                            onChange={(e) => setFormMasterKat(prev => ({ ...prev, targetDefault: e.target.value }))}
                                            className={inputBase}
                                        >
                                            <option value="Kamar">Per Kamar / Asrama</option>
                                            <option value="Kelas">Per Kelas</option>
                                            <option value="Semua">Semua Santri</option>
                                        </select>
                                    </div>
                                    <div className="sm:col-span-2">
                                        <label className="block font-semibold text-ink mb-1">Keterangan Singkat:</label>
                                        <input
                                            type="text"
                                            placeholder="Contoh: Iuran buka puasa bersama santri"
                                            value={formMasterKat.desc}
                                            onChange={(e) => setFormMasterKat(prev => ({ ...prev, desc: e.target.value }))}
                                            className={inputBase}
                                        />
                                    </div>
                                </div>
                                <div className="flex justify-end pt-2">
                                    <button type="submit" className={btnPrimary}>
                                        <Plus className="w-3.5 h-3.5 mr-1" /> Simpan Kategori Baru
                                    </button>
                                </div>
                            </form>
                            
                            <div className="flex justify-end pt-3 border-t border-whisper">
                                <button
                                    type="button"
                                    onClick={() => setShowModalMasterInsidental(false)}
                                    className={btnOutline}
                                >
                                    Selesai & Tutup
                                </button>
                            </div>
                        </div>
                    </div>
                )}

                {/* Modal Edit PIN Kamar */}
                {modalEditPinKamar && (
                    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-ink/20 backdrop-blur-[3px]">
                        <div className="bg-surface rounded-2xl border border-whisper w-full max-w-md p-6 shadow-diffused space-y-4">
                            <div className="flex justify-between items-center pb-3 border-b border-whisper">
                                <h3 className="font-bold text-ink text-base flex items-center gap-2">
                                    <Key className="w-5 h-5 text-amber-600" /> Atur PIN Kasir POS Kamar
                                </h3>
                                <button 
                                    type="button" 
                                    onClick={() => { setModalEditPinKamar(null); setInputPinEdit(''); }}
                                    className="text-steel hover:text-ink"
                                >
                                    <X className="w-5 h-5" />
                                </button>
                            </div>
                            <form onSubmit={handleSimpanPinKamar} className="space-y-4 text-xs">
                                <div>
                                    <label className="block font-semibold text-ink mb-1">Akun Kamar:</label>
                                    <div className="p-3 bg-slate-50 border border-slate-200 rounded-xl font-bold text-ink">
                                        {modalEditPinKamar.nama} ({modalEditPinKamar.nis})
                                    </div>
                                </div>
                                <div>
                                    <label className="block font-semibold text-ink mb-1">PIN Baru (4 - 6 Digit Angka):</label>
                                    <input
                                        type="password"
                                        autoFocus
                                        maxLength={6}
                                        required
                                        placeholder="Misal: 123456"
                                        value={inputPinEdit}
                                        onChange={(e) => setInputPinEdit(e.target.value.replace(/\D/g, ''))}
                                        className={`${inputBase} font-mono text-center tracking-widest font-bold text-base`}
                                    />
                                    <p className="text-[10px] text-steel mt-1">
                                        PIN ini harus dimasukkan ketua/bendahara kamar saat membayar belanja di kasir POS.
                                    </p>
                                </div>
                                <div className="flex justify-end gap-2 pt-3 border-t border-whisper">
                                    <button 
                                        type="button" 
                                        onClick={() => { setModalEditPinKamar(null); setInputPinEdit(''); }}
                                        className={btnOutline}
                                    >
                                        Batal
                                    </button>
                                    <button type="submit" className={btnPrimary}>
                                        Simpan PIN
                                    </button>
                                </div>
                            </form>
                        </div>
                    </div>
                )}

                {/* Modal Edit Riwayat Pemotongan Kas & Infaq */}
                {modalEditRiwayatInsidental && (
                    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-ink/20 backdrop-blur-[3px] animate-in fade-in">
                        <div className="bg-surface rounded-2xl border border-whisper w-full max-w-md p-6 shadow-diffused space-y-4">
                            <div className="flex items-center justify-between pb-3 border-b border-whisper">
                                <h3 className="font-bold text-ink text-base flex items-center gap-2">
                                    <Edit className="w-5 h-5 text-indigo-600" /> Edit Riwayat Pemotongan Kas / Infaq
                                </h3>
                                <button
                                    type="button"
                                    onClick={() => setModalEditRiwayatInsidental(false)}
                                    className="text-steel hover:text-ink"
                                >
                                    <X className="w-5 h-5" />
                                </button>
                            </div>
                            <form onSubmit={handleSimpanEditRiwayatInsidental} className="space-y-4 text-xs">
                                <div>
                                    <label className="block font-semibold text-ink mb-1">Santri / Akun:</label>
                                    <div className="p-3 bg-slate-50 border border-slate-200 rounded-xl font-bold text-ink flex items-center justify-between">
                                        <span>{formEditRiwayatInsidental.nama}</span>
                                        <span className="font-mono text-steel text-[11px]">{formEditRiwayatInsidental.nis}</span>
                                    </div>
                                </div>

                                <div className="grid grid-cols-2 gap-3">
                                    <div>
                                        <label className="block font-semibold text-ink mb-1">Tanggal Transaksi:</label>
                                        <input
                                            type="date"
                                            required
                                            value={formEditRiwayatInsidental.tanggal}
                                            onChange={(e) => setFormEditRiwayatInsidental(prev => ({ ...prev, tanggal: e.target.value }))}
                                            className={inputBase}
                                        />
                                    </div>
                                    <div>
                                        <label className="block font-semibold text-ink mb-1">Jenis Transaksi:</label>
                                        <div className="p-2.5 bg-slate-50 border border-slate-200 rounded-xl font-bold text-center">
                                            <span className={`px-2 py-0.5 rounded-full text-xs font-bold ${
                                                String(formEditRiwayatInsidental.jenis).toLowerCase() === 'setor'
                                                    ? 'bg-emerald-100 text-emerald-700'
                                                    : 'bg-rose-100 text-rose-700'
                                            }`}>
                                                {formEditRiwayatInsidental.jenis}
                                            </span>
                                        </div>
                                    </div>
                                </div>

                                <div>
                                    <label className="block font-semibold text-ink mb-1">Nominal (Rp):</label>
                                    <input
                                        type="number"
                                        required
                                        min="1"
                                        placeholder="10000"
                                        value={formEditRiwayatInsidental.nominal}
                                        onChange={(e) => setFormEditRiwayatInsidental(prev => ({ ...prev, nominal: e.target.value }))}
                                        className={`${inputBase} font-mono font-bold text-base text-indigo-700`}
                                    />
                                </div>

                                <div>
                                    <label className="block font-semibold text-ink mb-1">Keterangan:</label>
                                    <input
                                        type="text"
                                        required
                                        placeholder="Keterangan iuran..."
                                        value={formEditRiwayatInsidental.keterangan}
                                        onChange={(e) => setFormEditRiwayatInsidental(prev => ({ ...prev, keterangan: e.target.value }))}
                                        className={inputBase}
                                    />
                                </div>

                                <div className="flex justify-end gap-2 pt-3 border-t border-whisper">
                                    <button
                                        type="button"
                                        onClick={() => setModalEditRiwayatInsidental(false)}
                                        className={btnOutline}
                                    >
                                        Batal
                                    </button>
                                    <button type="submit" className={btnPrimary}>
                                        Simpan Perubahan
                                    </button>
                                </div>
                            </form>
                        </div>
                    </div>
                )}
            </div>
        );
    };

    const renderTabungan = () => {
        const filtered = dataTabungan.filter(t => (t.nama || '').toLowerCase().includes(searchTerm.toLowerCase()) || String(t.nis || '').includes(searchTerm));
        
        const itemsPerPage = 10;
        const totalPages = Math.ceil(filtered.length / itemsPerPage);
        const paginatedTabungan = filtered.slice((currentPage - 1) * itemsPerPage, currentPage * itemsPerPage);

        const filteredIds = paginatedTabungan.map(t => t.id);
        const allChecked = filteredIds.length > 0 && filteredIds.every(id => selectedIds.includes(id));

        // Perhitungan Limit Tabungan untuk sub-tab Limit
        const filteredSantriForLimit = dataSantri.filter(s => {
            const matchSearch = (s.nama || '').toLowerCase().includes(searchTerm.toLowerCase()) || String(s.nis || '').includes(searchTerm);
            const matchKelas = tabunganKelasFilter === 'Semua' || String(s.kelas).trim().toLowerCase() === String(tabunganKelasFilter).trim().toLowerCase();
            return matchSearch && matchKelas;
        });

        const runningBalanceMap = computeRunningBalanceMap(dataTabungan);

        const totalSaldoAll = dataTabungan.reduce((sum, item) => {
            const nom = Number(item.nominal || item.Nominal || 0);
            const j = String(item.jenis || item.Jenis || '').toLowerCase().trim();
            const isWithdraw = j === 'tarik' || j === 'keluar' || j.includes('tarik') || j.includes('keluar') || j === 'debet' || j === 'debit';
            return isWithdraw ? sum - nom : sum + nom;
        }, 0);
        const santriWithLimitCount = dataSantri.filter(s => getSantriLimitConfig(s).limit > 0).length;
        const globalCfg = appConfig.tabunganLimitConfig || {};

        return (
            <div className="space-y-6 animate-in fade-in duration-500">
                <div className="flex flex-col xl:flex-row justify-between items-start xl:items-center gap-4 mb-6 w-full">
                    <div className="flex-1 min-w-0 pr-4">
                        <h2 className="text-2xl font-semibold tracking-tight text-ink">Tabungan Santri</h2>
                        <p className="text-sm text-steel">Catat setor & tarik tabungan, serta atur limit penarikan/jajan per hari, minggu, atau bulan.</p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                        <button 
                            onClick={() => {
                                setLimitModalData({
                                    targetType: 'Semua',
                                    selectedKelas: '',
                                    selectedNis: '',
                                    nominal: globalCfg.defaultLimit || '',
                                    periode: globalCfg.defaultPeriode || 'harian'
                                });
                                setModalType('FORM_ATUR_LIMIT_TABUNGAN');
                            }} 
                            className="px-4 py-2 bg-amber-500 hover:bg-amber-600 text-white font-medium text-sm rounded-xl flex items-center gap-2 shadow-sm transition-all"
                        >
                            <SlidersHorizontal className="w-4 h-4" /> Atur Limit Tabungan
                        </button>
                        <button onClick={() => setTabunganSubTab('iuran')} className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white font-medium text-sm rounded-xl flex items-center gap-2 shadow-sm transition-all"><Coins className="w-4 h-4" /> Tarik Kas / Iuran Otomatis</button>
                        <button onClick={() => { setFormData({ jenis: 'Setor' }); setModalType('FORM_TABUNGAN'); }} className={btnPrimary}><Plus className="w-4 h-4" /> Transaksi Tabungan</button>
                        <button onClick={() => downloadStyledExcel('Tabungan Santri', ['Tanggal', 'NIS', 'Nama', 'Jenis', 'Nominal (+/-)', 'Saldo Setelah Transaksi', 'Keterangan'], dataTabungan.map(t => {
                            const isTarik = String(t.jenis || '').toLowerCase().trim() === 'tarik' || String(t.jenis || '').toLowerCase().trim() === 'keluar';
                            const runningSaldo = runningBalanceMap[t.id] !== undefined ? runningBalanceMap[t.id] : getSantriSaldoTabungan(t.nis);
                            return [
                                t.tanggal, 
                                t.nis, 
                                t.nama, 
                                t.jenis, 
                                (!isTarik ? '+' : '-') + Number(t.nominal || 0),
                                runningSaldo,
                                t.keterangan || ''
                            ];
                        }), 'Tabungan_Santri')} className={btnOutline}><FileSpreadsheet className="w-4 h-4 text-accent" /> Unduh</button>
                    </div>
                </div>

                {/* Sub-tab Navigation */}
                <div className="flex border-b border-whisper gap-2">
                    <button 
                        onClick={() => setTabunganSubTab('transaksi')} 
                        className={`px-4 py-2.5 font-semibold text-sm border-b-2 transition-all flex items-center gap-2 ${tabunganSubTab === 'transaksi' ? 'border-accent text-accent' : 'border-transparent text-steel hover:text-ink'}`}
                    >
                        <Zap className="w-4 h-4" /> Riwayat Transaksi ({dataTabungan.length})
                    </button>
                    <button 
                        onClick={() => setTabunganSubTab('limit')} 
                        className={`px-4 py-2.5 font-semibold text-sm border-b-2 transition-all flex items-center gap-2 ${tabunganSubTab === 'limit' ? 'border-accent text-accent' : 'border-transparent text-steel hover:text-ink'}`}
                    >
                        <SlidersHorizontal className="w-4 h-4" /> Status & Pengaturan Limit Santri ({santriWithLimitCount} aktif)
                    </button>
                    <button 
                        onClick={() => setTabunganSubTab('iuran')} 
                        className={`px-4 py-2.5 font-semibold text-sm border-b-2 transition-all flex items-center gap-2 whitespace-nowrap ${tabunganSubTab === 'iuran' ? 'border-indigo-600 text-indigo-600 font-bold' : 'border-transparent text-steel hover:text-ink'}`}
                    >
                        <Coins className="w-4 h-4 text-amber-500" /> Iuran & Kas Insidental (Potong Otomatis)
                    </button>
                </div>

                {tabunganSubTab === 'transaksi' && (<>
                    <div className="bg-surface border border-whisper shadow-sm rounded-card overflow-hidden">
                        <div className="p-4 border-b border-whisper/50 flex flex-col sm:flex-row justify-between sm:justify-end items-center gap-3 bg-canvas/40">
                            <div className="relative w-full sm:w-auto">
                                <Search className="w-4 h-4 absolute left-3 top-3 text-steel" />
                                <input type="text" placeholder="Cari santri..." value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} className={`${inputBase} pl-9 w-full sm:w-64`} />
                            </div>
                            {selectedIds.length > 0 && (
                                <button onClick={() => executeBulkDelete('TABUNGAN', setDataTabungan, 'tabungan')} className="w-full sm:w-auto px-4 py-2.5 bg-rose-50 text-rose-600 font-medium text-sm rounded-xl hover:bg-rose-100 flex items-center justify-center gap-2 border border-rose-200"><Trash2 className="w-4 h-4" /> Hapus ({selectedIds.length})</button>
                            )}
                        </div>
                        <div className="overflow-x-auto hidden md:block">
                            <table className="w-full text-sm text-left">
                                <thead className="bg-canvas/60 text-steel border-b border-whisper/50">
                                    <tr>
                                        <th className="px-6 py-3 w-12 text-center"><input type="checkbox" checked={allChecked} onChange={() => toggleSelectAll(filteredIds)} className="w-4 h-4 rounded border-whisper text-accent cursor-pointer" /></th>
                                        <th className="px-6 py-3">Tanggal</th>
                                        <th className="px-6 py-3">Santri</th>
                                        <th className="px-6 py-3 text-center">Jenis</th>
                                        <th className="px-6 py-3 text-right">Nominal (+/-)</th>
                                        <th className="px-6 py-3 text-right">Saldo Berjalan</th>
                                        <th className="px-6 py-3">Keterangan</th>
                                        <th className="px-6 py-3 text-center">Aksi</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-slate-100">
                                    {paginatedTabungan.length === 0 ? (
                                        <tr><td colSpan="8" className="text-center py-8 text-steel">Belum ada catatan tabungan santri.</td></tr>
                                    ) : paginatedTabungan.map((trx) => {
                                        const isTarik = String(trx.jenis || '').toLowerCase().trim() === 'tarik' || String(trx.jenis || '').toLowerCase().trim() === 'keluar';
                                        const runningSaldo = runningBalanceMap[trx.id] !== undefined ? runningBalanceMap[trx.id] : getSantriSaldoTabungan(trx.nis);
                                        return (
                                            <tr key={trx.id} className="bg-surface hover:bg-canvas transition-colors">
                                                <td className="px-6 py-4 text-center"><input type="checkbox" checked={selectedIds.includes(trx.id)} onChange={() => toggleSelectId(trx.id)} className="w-4 h-4 rounded border-whisper text-accent cursor-pointer" /></td>
                                                <td className="px-6 py-4 whitespace-nowrap text-steel">{trx.tanggal}</td>
                                                <td className="px-6 py-4">
                                                    <div className="font-semibold text-ink">{trx.nama}</div>
                                                    <div className="text-xs text-steel flex items-center gap-1.5 mt-0.5">
                                                        <span>NIS: {trx.nis}</span>
                                                        <span>•</span>
                                                        <span className="text-slate-500 font-medium">Saldo Terkini: Rp {getSantriSaldoTabungan(trx.nis).toLocaleString('id-ID')}</span>
                                                    </div>
                                                </td>
                                                <td className="px-6 py-4 text-center">
                                                    <span className={`inline-flex px-2.5 py-1 text-xs font-semibold rounded-md border ${!isTarik ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-rose-50 text-rose-700 border-rose-200'}`}>
                                                        {trx.jenis}
                                                    </span>
                                                </td>
                                                <td className={`px-6 py-4 text-right font-bold whitespace-nowrap ${!isTarik ? 'text-emerald-600' : 'text-rose-600'}`}>
                                                    {!isTarik ? '+' : '-'} Rp {Number(trx.nominal || 0).toLocaleString('id-ID')}
                                                </td>
                                                <td className="px-6 py-4 text-right whitespace-nowrap">
                                                    <div className="font-bold text-ink text-sm">
                                                        Rp {runningSaldo.toLocaleString('id-ID')}
                                                    </div>
                                                    <div className="text-[10px] text-steel">Setelah Transaksi</div>
                                                </td>
                                                <td className="px-6 py-4 text-steel text-xs max-w-xs truncate">{trx.keterangan || '-'}</td>
                                                <td className="px-6 py-4 text-center flex gap-3 justify-center">
                                                    {String(trx.keterangan || '').toLowerCase().includes('kantin') && (
                                                        <button onClick={() => handleDetailTabungan(trx)} className="text-steel hover:text-accent transition-colors" title="Lihat Detail Belanja"><Eye className="w-4 h-4" /></button>
                                                    )}
                                                    <button onClick={() => confirmDelete('TABUNGAN', trx.id, 'Transaksi Tabungan')} className="text-rose-600 hover:text-rose-800"><Trash2 className="w-4 h-4" /></button>
                                                </td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>
                        <div className="md:hidden flex flex-col divide-y divide-whisper/50">
                            {paginatedTabungan.length === 0 ? (
                                <div className="text-center py-8 text-steel text-sm">Belum ada catatan tabungan santri.</div>
                            ) : paginatedTabungan.map((trx) => {
                                const isTarik = String(trx.jenis || '').toLowerCase().trim() === 'tarik' || String(trx.jenis || '').toLowerCase().trim() === 'keluar';
                                const runningSaldo = runningBalanceMap[trx.id] !== undefined ? runningBalanceMap[trx.id] : getSantriSaldoTabungan(trx.nis);
                                return (
                                    <div key={trx.id} className={`p-4 flex flex-col gap-3 ${selectedIds.includes(trx.id) ? 'bg-accent/5' : 'bg-surface'}`}>
                                        <div className="flex justify-between items-start gap-3">
                                            <div className="flex items-start gap-3 min-w-0">
                                                <input type="checkbox" checked={selectedIds.includes(trx.id)} onChange={() => toggleSelectId(trx.id)} className="w-4 h-4 mt-1 shrink-0 rounded border-whisper text-accent focus:ring-accent/30 cursor-pointer" />
                                                <div className="min-w-0">
                                                    <div className="font-bold text-ink truncate text-sm">{trx.nama}</div>
                                                    <div className="text-[11px] text-steel">NIS: {trx.nis} • Terkini: Rp {getSantriSaldoTabungan(trx.nis).toLocaleString('id-ID')}</div>
                                                    <div className="text-[10px] text-steel mt-0.5">{trx.tanggal}</div>
                                                    <div className="text-[10px] text-slate mt-1 line-clamp-2">{trx.keterangan || '-'}</div>
                                                </div>
                                            </div>
                                            <div className="text-right shrink-0">
                                                <div className={`text-sm font-bold ${!isTarik ? 'text-emerald-600' : 'text-rose-600'}`}>
                                                    {!isTarik ? '+' : '-'} Rp {Number(trx.nominal || 0).toLocaleString('id-ID')}
                                                </div>
                                                <div className="text-[11px] font-bold text-ink mt-0.5">
                                                    Saldo: Rp {runningSaldo.toLocaleString('id-ID')}
                                                </div>
                                                <span className={`inline-block mt-1 px-1.5 py-0.5 text-[10px] font-bold uppercase rounded border ${!isTarik ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-rose-50 text-rose-700 border-rose-200'}`}>
                                                    {trx.jenis}
                                                </span>
                                            </div>
                                        </div>
                                        <div className="flex flex-wrap items-center gap-2 justify-end w-full border-t border-whisper/50 pt-3 mt-1">
                                            {String(trx.keterangan || '').toLowerCase().includes('kantin') && (
                                                <button onClick={() => handleDetailTabungan(trx)} className="flex items-center gap-1 text-steel hover:text-accent bg-canvas hover:bg-whisper/50 font-medium text-xs px-3 py-1.5 rounded-lg border border-whisper"><Eye className="w-3.5 h-3.5" /> Detail</button>
                                            )}
                                            <button onClick={() => confirmDelete('TABUNGAN', trx.id, 'Transaksi Tabungan')} className="flex items-center gap-1 text-danger bg-dangerBg hover:bg-red-100 font-medium text-xs px-3 py-1.5 rounded-lg border border-red-100"><Trash2 className="w-3.5 h-3.5" /> Hapus</button>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                        
                        {totalPages > 0 && (
                            <div className="flex justify-center items-center gap-4 p-4 border-t border-whisper/50 bg-canvas/30">
                                <button onClick={() => setCurrentPage(p => Math.max(1, p - 1))} disabled={currentPage === 1} className="px-3 py-1.5 text-sm font-medium border border-whisper rounded-lg bg-surface hover:bg-canvas disabled:opacity-50 disabled:cursor-not-allowed text-ink">Prev</button>
                                <span className="text-sm text-steel font-medium">Hal {currentPage} dari {totalPages}</span>
                                <button onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))} disabled={currentPage === totalPages} className="px-3 py-1.5 text-sm font-medium border border-whisper rounded-lg bg-surface hover:bg-canvas disabled:opacity-50 disabled:cursor-not-allowed text-ink">Next</button>
                            </div>
                        )}
                    </div>


                </>)}

                {tabunganSubTab === 'limit' && (
                    /* Sub-tab: Status & Pengaturan Limit Santri */
                    <div className="space-y-6">
                        {/* Summary KPI Cards */}
                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                            <div className="bg-surface border border-whisper p-5 rounded-2xl shadow-sm">
                                <div className="flex items-center gap-3 mb-2">
                                    <div className="w-8 h-8 rounded-lg bg-emerald-50 text-emerald-600 flex items-center justify-center font-bold"><Wallet className="w-4 h-4" /></div>
                                    <span className="text-xs text-steel font-semibold uppercase">Total Tabungan</span>
                                </div>
                                <div className="text-xl font-bold text-ink">Rp {totalSaldoAll.toLocaleString('id-ID')}</div>
                            </div>
                            <div className="bg-surface border border-whisper p-5 rounded-2xl shadow-sm">
                                <div className="flex items-center gap-3 mb-2">
                                    <div className="w-8 h-8 rounded-lg bg-amber-50 text-amber-600 flex items-center justify-center font-bold"><ShieldAlert className="w-4 h-4" /></div>
                                    <span className="text-xs text-steel font-semibold uppercase">Santri Dibatasi</span>
                                </div>
                                <div className="text-xl font-bold text-amber-600">{santriWithLimitCount} <span className="text-xs text-steel font-normal">dari {dataSantri.length} santri</span></div>
                            </div>
                            <div className="bg-surface border border-whisper p-5 rounded-2xl shadow-sm">
                                <div className="flex items-center gap-3 mb-2">
                                    <div className="w-8 h-8 rounded-lg bg-blue-50 text-blue-600 flex items-center justify-center font-bold"><ShieldCheck className="w-4 h-4" /></div>
                                    <span className="text-xs text-steel font-semibold uppercase">Tanpa Batasan</span>
                                </div>
                                <div className="text-xl font-bold text-blue-600">{dataSantri.length - santriWithLimitCount} <span className="text-xs text-steel font-normal">santri bebas</span></div>
                            </div>
                            <div className="bg-surface border border-whisper p-5 rounded-2xl shadow-sm">
                                <div className="flex items-center gap-3 mb-2">
                                    <div className="w-8 h-8 rounded-lg bg-purple-50 text-purple-600 flex items-center justify-center font-bold"><SlidersHorizontal className="w-4 h-4" /></div>
                                    <span className="text-xs text-steel font-semibold uppercase">Default Sistem</span>
                                </div>
                                <div className="text-base font-bold text-ink">
                                    {globalCfg.defaultLimit > 0 
                                        ? `Rp ${Number(globalCfg.defaultLimit).toLocaleString('id-ID')} / ${globalCfg.defaultPeriode === 'mingguan' ? 'Minggu' : globalCfg.defaultPeriode === 'bulanan' ? 'Bulan' : 'Hari'}`
                                        : 'Tidak Dibatasi'
                                    }
                                </div>
                            </div>
                        </div>

                        {/* Search & Kelas Filter Bar */}
                        <div className="bg-surface border border-whisper shadow-sm rounded-card overflow-hidden">
                            <div className="p-4 border-b border-whisper/50 flex flex-col sm:flex-row justify-between items-center gap-3 bg-canvas/40">
                                <div className="flex items-center gap-2 w-full sm:w-auto">
                                    <span className="text-xs font-semibold text-steel uppercase">Filter Kelas:</span>
                                    <select 
                                        value={tabunganKelasFilter} 
                                        onChange={(e) => setTabunganKelasFilter(e.target.value)} 
                                        className={`${inputBase} py-1.5 text-xs w-auto`}
                                    >
                                        <option value="Semua">Semua Kelas</option>
                                        {masterKelasList.map(k => <option key={k} value={k}>{k}</option>)}
                                    </select>
                                </div>
                                <div className="relative w-full sm:w-auto">
                                    <Search className="w-4 h-4 absolute left-3 top-3 text-steel" />
                                    <input 
                                        type="text" 
                                        placeholder="Cari santri / NIS..." 
                                        value={searchTerm} 
                                        onChange={(e) => setSearchTerm(e.target.value)} 
                                        className={`${inputBase} pl-9 w-full sm:w-64`} 
                                    />
                                </div>
                            </div>

                            {/* Table List Santri & Limits */}
                            <div className="overflow-x-auto">
                                <table className="w-full text-sm text-left">
                                    <thead className="bg-canvas/60 text-steel border-b border-whisper/50">
                                        <tr>
                                            <th className="px-6 py-3">NIS</th>
                                            <th className="px-6 py-3">Nama Santri</th>
                                            <th className="px-6 py-3">Kelas</th>
                                            <th className="px-6 py-3 text-right">Saldo Tabungan</th>
                                            <th className="px-6 py-3 text-center">Aturan Limit</th>
                                            <th className="px-6 py-3 text-right">Pemakaian Periode Ini</th>
                                            <th className="px-6 py-3 text-right">Sisa Limit</th>
                                            <th className="px-6 py-3 text-center">Aksi</th>
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y divide-slate-100">
                                        {filteredSantriForLimit.length === 0 ? (
                                            <tr><td colSpan="8" className="text-center py-8 text-steel">Tidak ada santri ditemukan.</td></tr>
                                        ) : filteredSantriForLimit.map((s) => {
                                            const saldo = getSantriSaldoTabungan(s.nis);
                                            
                                            const limitCfg = getSantriLimitConfig(s);
                                            const used = getUsageInPeriod(s.nis, limitCfg.periode);
                                            const sisa = limitCfg.limit > 0 ? Math.max(0, limitCfg.limit - used) : null;
                                            const percentageUsed = limitCfg.limit > 0 ? Math.min(100, Math.round((used / limitCfg.limit) * 100)) : 0;
                                            const periodeLabel = limitCfg.periode === 'mingguan' ? 'Minggu' : limitCfg.periode === 'bulanan' ? 'Bulan' : 'Hari';

                                            return (
                                                <tr key={s.nis} className="bg-surface hover:bg-canvas transition-colors">
                                                    <td className="px-6 py-4 font-mono text-xs text-steel">{s.nis}</td>
                                                    <td className="px-6 py-4 font-semibold text-ink">{s.nama}</td>
                                                    <td className="px-6 py-4 text-steel text-xs"><span className="px-2 py-1 bg-slate-100 rounded-md font-medium">{s.kelas || '-'}</span></td>
                                                    <td className="px-6 py-4 text-right font-bold text-emerald-600">Rp {saldo.toLocaleString('id-ID')}</td>
                                                    <td className="px-6 py-4 text-center">
                                                        {limitCfg.limit > 0 ? (
                                                            <div className="inline-flex flex-col items-center">
                                                                <span className="px-2.5 py-1 text-xs font-semibold rounded-lg bg-amber-50 text-amber-700 border border-amber-200">
                                                                    Rp {limitCfg.limit.toLocaleString('id-ID')} / {periodeLabel}
                                                                </span>
                                                                {limitCfg.isCustom && <span className="text-[10px] text-steel mt-0.5 font-medium">(Khusus)</span>}
                                                            </div>
                                                        ) : (
                                                            <span className="px-2 py-0.5 text-xs text-slate-500 bg-slate-100 rounded-md font-medium">Bebas (Tanpa Limit)</span>
                                                        )}
                                                    </td>
                                                    <td className="px-6 py-4 text-right">
                                                        {limitCfg.limit > 0 ? (
                                                            <div>
                                                                <div className="font-medium text-ink">Rp {used.toLocaleString('id-ID')}</div>
                                                                <div className="w-24 bg-slate-100 h-1.5 rounded-full overflow-hidden mt-1 ml-auto">
                                                                    <div 
                                                                        className={`h-full rounded-full ${percentageUsed >= 100 ? 'bg-red-500' : percentageUsed > 75 ? 'bg-amber-500' : 'bg-emerald-500'}`} 
                                                                        style={{ width: `${percentageUsed}%` }}
                                                                    />
                                                                </div>
                                                            </div>
                                                        ) : (
                                                            <span className="text-steel text-xs">Rp {used.toLocaleString('id-ID')}</span>
                                                        )}
                                                    </td>
                                                    <td className="px-6 py-4 text-right font-bold">
                                                        {limitCfg.limit > 0 ? (
                                                            <span className={`text-xs px-2 py-1 rounded-md ${sisa <= 0 ? 'bg-rose-50 text-rose-700 font-bold' : sisa <= (limitCfg.limit * 0.25) ? 'bg-amber-50 text-amber-700' : 'text-emerald-700 bg-emerald-50'}`}>
                                                                Rp {sisa.toLocaleString('id-ID')}
                                                            </span>
                                                        ) : (
                                                            <span className="text-steel text-xs font-normal">Tak Terbatas</span>
                                                        )}
                                                    </td>
                                                    <td className="px-6 py-4 text-center">
                                                        <button 
                                                            onClick={() => {
                                                                setLimitModalData({
                                                                    targetType: 'Santri',
                                                                    selectedKelas: s.kelas || '',
                                                                    selectedNis: s.nis,
                                                                    nominal: limitCfg.limit || '',
                                                                    periode: limitCfg.periode || 'harian'
                                                                });
                                                                setModalType('FORM_ATUR_LIMIT_TABUNGAN');
                                                            }} 
                                                            className="px-3 py-1.5 text-xs font-medium text-amber-700 bg-amber-50 hover:bg-amber-100 border border-amber-200 rounded-lg flex items-center gap-1.5 mx-auto transition-colors"
                                                        >
                                                            <Edit className="w-3.5 h-3.5" /> Atur Limit
                                                        </button>
                                                    </td>
                                                </tr>
                                            );
                                        })}
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    </div>
                )}

                {tabunganSubTab === 'iuran' && renderTabunganIuran()}
            </div>
        );
    };

    const renderPenggajian = () => {
        const filtered = dataGaji.filter(g => (g.nama || '').toLowerCase().includes(searchTerm.toLowerCase()) || String(g.nip || '').includes(searchTerm));
        
        const itemsPerPage = 10;
        const totalPages = Math.ceil(filtered.length / itemsPerPage);
        const paginatedGaji = filtered.slice((currentPage - 1) * itemsPerPage, currentPage * itemsPerPage);

        const filteredIds = paginatedGaji.map(g => g.id);
        const allChecked = filteredIds.length > 0 && filteredIds.every(id => selectedIds.includes(id));
        return (
            <div className="space-y-6 animate-in fade-in duration-500">
                <div className="flex flex-col xl:flex-row justify-between items-start xl:items-center gap-4 mb-6 w-full">
                    <div className="flex-1 min-w-0 pr-4"><h2 className="text-2xl font-semibold tracking-tight text-ink">Penggajian Pegawai</h2><p className="text-sm text-steel">Catat dan bayar gaji ustadz & karyawan.</p></div>
                    <div className="flex gap-2">
                        <button onClick={() => { const d = new Date(); setFormData({ bulan: listBulan[d.getMonth()], tahun: d.getFullYear() }); setModalType('FORM_GAJI'); }} className={btnPrimary}><Plus className="w-4 h-4" /> Catat Gaji</button>
                        <button onClick={() => downloadStyledExcel('Penggajian Pegawai', ['ID', 'Tanggal', 'NIP', 'Nama', 'Periode', 'Gaji Pokok', 'Tunjangan', 'Potongan', 'Total Bersih'], dataGaji.map(g => [g.id, g.tanggal, g.nip, g.nama, g.periode, g.gajiPokok, g.tunjangan, g.potongan, g.totalBersih]), 'Penggajian')} className={btnOutline}><FileSpreadsheet className="w-4 h-4 text-accent" /> Unduh</button>
                    </div>
                </div>
                <div className="bg-surface border border-whisper shadow-sm rounded-card overflow-hidden">
                    <div className="p-4 border-b border-whisper/50 flex flex-col sm:flex-row justify-between sm:justify-end items-center gap-3 bg-canvas/40">
                        <div className="relative w-full sm:w-auto">
                            <Search className="w-4 h-4 absolute left-3 top-3 text-steel" />
                            <input type="text" placeholder="Cari pegawai..." value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} className={`${inputBase} pl-9 w-full sm:w-64`} />

                        </div>
                        {selectedIds.length > 0 && (
                            <button onClick={() => executeBulkDelete('GAJI', setDataGaji, 'gaji')} className="w-full sm:w-auto px-4 py-2.5 bg-rose-50 text-rose-600 font-medium text-sm rounded-xl hover:bg-rose-100 flex items-center justify-center gap-2 border border-rose-200"><Trash2 className="w-4 h-4" /> Hapus ({selectedIds.length})</button>
                        )}
                    </div>
                    <div className="overflow-x-auto hidden md:block">
                        <table className="w-full text-sm text-left">
                            <thead className="bg-canvas/60 text-steel border-b border-whisper/50"><tr><th className="px-6 py-3 w-12 text-center"><input type="checkbox" checked={allChecked} onChange={() => toggleSelectAll(filteredIds)} className="w-4 h-4 rounded border-whisper text-accent cursor-pointer" /></th><th className="px-6 py-3">Tanggal / ID</th><th className="px-6 py-3">Pegawai</th><th className="px-6 py-3">Periode</th><th className="px-6 py-3 text-right">Total Bersih</th><th className="px-6 py-3 text-center">Aksi</th></tr></thead>
                            <tbody className="divide-y divide-slate-100">
                                {paginatedGaji.length === 0 ? (
                                    <tr><td colSpan="100%" className="text-center py-8 text-steel">Belum ada riwayat penggajian.</td></tr>
                                ) : paginatedGaji.map((g) => (
                                    <tr key={g.id} className="bg-surface hover:bg-canvas">
                                        <td className="px-6 py-4 text-center"><input type="checkbox" checked={selectedIds.includes(g.id)} onChange={() => toggleSelectId(g.id)} className="w-4 h-4 rounded border-whisper text-accent cursor-pointer" /></td>
                                        <td className="px-6 py-4">{g.tanggal} <span className="block text-xs font-mono text-steel">{g.id}</span></td>
                                        <td className="px-6 py-4 font-medium">{g.nama} <span className="block text-xs text-steel">{g.nip}</span></td>
                                        <td className="px-6 py-4">{g.periode}</td>
                                        <td className="px-6 py-4 text-right font-semibold text-emerald-700">Rp {Number(g.totalBersih || 0).toLocaleString('id-ID')}</td>
                                        <td className="px-6 py-4 text-center flex gap-3 justify-center">
                                            <button onClick={() => {
                                                const htmlContent = `<html><head><title>Slip Gaji - ${g.nama}</title><style>body { font-family: 'Courier New', Courier, monospace; padding: 20px; color: #000; } .invoice-box { max-width: 450px; margin: auto; border: 1px solid #ddd; padding: 20px; border-radius: 8px; } .header { text-align: center; margin-bottom: 20px; border-bottom: 2px dashed #000; padding-bottom: 10px; } .header h2 { margin: 0; font-size: 20px; } .row { display: flex; justify-content: space-between; margin-bottom: 5px; font-size: 14px; } table { margin-top: 15px; border-collapse: collapse; width: 100%; } th, td { padding: 8px 0; border-bottom: 1px solid #ddd; text-align: left; font-size: 14px; } .total { font-weight: bold; font-size: 16px; margin-top: 15px; text-align: right; border-top: 2px dashed #000; padding-top: 10px; } .footer { text-align: center; margin-top: 30px; font-size: 12px; color: #555; }</style></head><body><div class="invoice-box"><div class="header"><h2>SLIP GAJI PEGAWAI</h2><div>Pesantren Tech</div></div><div class="row"><span>ID Transaksi</span><span>${g.id}</span></div><div class="row"><span>Tanggal Bayar</span><span>${g.tanggal}</span></div><div class="row"><span>Nama / NIP</span><span>${g.nama} / ${g.nip}</span></div><div class="row"><span>Periode</span><span>${g.periode}</span></div><br/><table><tbody><tr><td>Gaji Pokok</td><td style="text-align: right;">Rp ${(g.gajiPokok || 0).toLocaleString('id-ID')}</td></tr><tr><td>Tunjangan Tambahan</td><td style="text-align: right;">Rp ${(g.tunjangan || 0).toLocaleString('id-ID')}</td></tr><tr><td>Potongan</td><td style="text-align: right; color: red;">- Rp ${(g.potongan || 0).toLocaleString('id-ID')}</td></tr></tbody></table><div class="total">PENERIMAAN BERSIH: Rp ${(g.totalBersih || 0).toLocaleString('id-ID')}</div><div class="footer">Slip gaji ini dicetak oleh sistem secara otomatis dan sah sebagai bukti pembayaran.<br>Terima kasih atas dedikasi Anda.</div></div></body></html>`;
                                                executePrint(htmlContent);
                                            }} className="text-steel hover:text-ink" title="Print Slip Gaji"><Printer className="w-4 h-4" /></button>
                                            <button onClick={() => confirmDelete('GAJI', g.id, g.id)} className="text-rose-600 hover:text-rose-800"><Trash2 className="w-4 h-4" /></button>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                    <div className="md:hidden flex flex-col divide-y divide-whisper/50">
                        {paginatedGaji.length === 0 ? (
                            <div className="text-center py-8 text-steel text-sm">Belum ada riwayat penggajian.</div>
                        ) : paginatedGaji.map((g) => (
                            <div key={g.id} className={`p-4 flex flex-col gap-3 ${selectedIds.includes(g.id) ? 'bg-accent/5' : 'bg-surface'}`}>
                                <div className="flex justify-between items-start gap-3">
                                    <div className="flex items-start gap-3 min-w-0">
                                        <input type="checkbox" checked={selectedIds.includes(g.id)} onChange={() => toggleSelectId(g.id)} className="w-4 h-4 mt-1 shrink-0 rounded border-whisper text-accent focus:ring-accent/30 cursor-pointer" />
                                        <div className="min-w-0">
                                            <div className="font-bold text-ink truncate text-sm">{g.nama}</div>
                                            <div className="text-[10px] text-steel mt-0.5">{g.tanggal} • {g.periode}</div>
                                            <div className="text-[10px] text-slate font-mono mt-1">ID: {g.id}</div>
                                        </div>
                                    </div>
                                    <div className="text-right shrink-0">
                                        <div className="text-sm font-bold text-emerald-600">Rp {Number(g.totalBersih || 0).toLocaleString('id-ID')}</div>
                                        <span className="inline-block mt-1 px-1.5 py-0.5 text-[10px] font-bold uppercase rounded bg-emerald-50 text-emerald-700">Terbayar</span>
                                    </div>
                                </div>
                                <div className="flex flex-wrap items-center gap-2 justify-end w-full border-t border-whisper/50 pt-3 mt-1">
                                    <button onClick={() => {
                                        const htmlContent = `<html><head><title>Slip Gaji - ${g.nama}</title><style>body { font-family: 'Courier New', Courier, monospace; padding: 20px; color: #000; } .invoice-box { max-width: 450px; margin: auto; border: 1px solid #ddd; padding: 20px; border-radius: 8px; } .header { text-align: center; margin-bottom: 20px; border-bottom: 2px dashed #000; padding-bottom: 10px; } .header h2 { margin: 0; font-size: 20px; } .row { display: flex; justify-content: space-between; margin-bottom: 5px; font-size: 14px; } table { margin-top: 15px; border-collapse: collapse; width: 100%; } th, td { padding: 8px 0; border-bottom: 1px solid #ddd; text-align: left; font-size: 14px; } .total { font-weight: bold; font-size: 16px; margin-top: 15px; text-align: right; border-top: 2px dashed #000; padding-top: 10px; } .footer { text-align: center; margin-top: 30px; font-size: 12px; color: #555; }</style></head><body><div class="invoice-box"><div class="header"><h2>SLIP GAJI PEGAWAI</h2><div>Pesantren Tech</div></div><div class="row"><span>ID Transaksi</span><span>${g.id}</span></div><div class="row"><span>Tanggal Bayar</span><span>${g.tanggal}</span></div><div class="row"><span>Nama / NIP</span><span>${g.nama} / ${g.nip}</span></div><div class="row"><span>Periode</span><span>${g.periode}</span></div><br/><table><tbody><tr><td>Gaji Pokok</td><td style="text-align: right;">Rp ${(g.gajiPokok || 0).toLocaleString('id-ID')}</td></tr><tr><td>Tunjangan Tambahan</td><td style="text-align: right;">Rp ${(g.tunjangan || 0).toLocaleString('id-ID')}</td></tr><tr><td>Potongan</td><td style="text-align: right; color: red;">- Rp ${(g.potongan || 0).toLocaleString('id-ID')}</td></tr></tbody></table><div class="total">PENERIMAAN BERSIH: Rp ${(g.totalBersih || 0).toLocaleString('id-ID')}</div><div class="footer">Slip gaji ini dicetak oleh sistem secara otomatis dan sah sebagai bukti pembayaran.<br>Terima kasih atas dedikasi Anda.</div></div></body></html>`;
                                        executePrint(htmlContent);
                                    }} className="flex items-center gap-1 text-steel bg-canvas hover:bg-whisper/50 font-bold text-xs px-3 py-1.5 rounded-lg border border-whisper"><Printer className="w-3.5 h-3.5" /> Cetak</button>
                                    <button onClick={() => confirmDelete('GAJI', g.id, g.id)} className="flex items-center gap-1 text-danger bg-dangerBg hover:bg-red-100 font-medium text-xs px-3 py-1.5 rounded-lg border border-red-100"><Trash2 className="w-3.5 h-3.5" /> Hapus</button>
                                </div>
                            </div>
                        ))}
                    </div>
                    
                    {totalPages > 0 && (
                        <div className="flex justify-center items-center gap-4 p-4 border-t border-whisper/50 bg-canvas/30">
                            <button onClick={() => setCurrentPage(p => Math.max(1, p - 1))} disabled={currentPage === 1} className="px-3 py-1.5 text-sm font-medium border border-whisper rounded-lg bg-surface hover:bg-canvas disabled:opacity-50 disabled:cursor-not-allowed text-ink">Prev</button>
                            <span className="text-sm text-steel font-medium">Hal {currentPage} dari {totalPages}</span>
                            <button onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))} disabled={currentPage === totalPages} className="px-3 py-1.5 text-sm font-medium border border-whisper rounded-lg bg-surface hover:bg-canvas disabled:opacity-50 disabled:cursor-not-allowed text-ink">Next</button>
                        </div>
                    )}
                </div>
            </div>
        );
    };
    // --- PENCAIRAN WARUNG ---
    const [dataPencairan, setDataPencairan] = useState([]);
    const [dataWarung, setDataWarung] = useState([]);
    const [loadingPencairan, setLoadingPencairan] = useState(false);
    const [modalDetailPencairan, setModalDetailPencairan] = useState(null);
    const [detailPencairanData, setDetailPencairanData] = useState([]);
    const [modalEditPencairan, setModalEditPencairan] = useState(null);
    const [modalProsesPencairan, setModalProsesPencairan] = useState(null);
    const [modalSuksesPencairan, setModalSuksesPencairan] = useState(null);
    const [modalConfigMOU, setModalConfigMOU] = useState(null);
    const [pencairanSearchTerm, setPencairanSearchTerm] = useState('');
    const [pencairanStatusFilter, setPencairanStatusFilter] = useState('Semua');
    const [rekapExpandedWarung, setRekapExpandedWarung] = useState(null);

    const getNamaWarung = (warungId) => {
        if (!warungId) return '-';
        const w = (dataWarung || []).find(item => String(item.ID || item.id) === String(warungId));
        return w ? (w.Nama || w.nama || warungId) : warungId;
    };

    const fetchPencairanGlobal = async () => {
        setLoadingPencairan(true);
        try {
            const [pRes, wRes, cfgRes] = await Promise.all([
                supabase.from('Pencairan').select('*').order('WaktuPengajuan', { ascending: false }),
                supabase.from('Warung').select('*'),
                supabase.from('MasterConfig').select('*').in('kunci', ['pencairanFeeConfig', 'pencairanFeeHistory'])
            ]);
            if (!pRes.error) {
                setDataPencairan(pRes.data || []);
            } else {
                showNotification('Gagal memuat data pencairan', 'error');
            }
            if (!wRes.error) {
                setDataWarung(wRes.data || []);
            }
            if (cfgRes?.data && cfgRes.data.length > 0) {
                const patch = {};
                cfgRes.data.forEach(item => {
                    try {
                        patch[item.kunci] = typeof item.nilai === 'string' ? JSON.parse(item.nilai) : item.nilai;
                    } catch (e) {
                        patch[item.kunci] = item.nilai;
                    }
                });
                setAppConfig(prev => ({ ...prev, ...patch }));
            }
        } catch (e) {
            showNotification('Gagal memuat data pencairan', 'error');
        }
        setLoadingPencairan(false);
    };

    useEffect(() => {
        let interval;
        if (activeTab === 'pencairan') {
            fetchPencairanGlobal();
            interval = setInterval(() => {
                fetchPencairanGlobal();
            }, 10000); // Polling 10 detik
        }
        return () => {
            if (interval) clearInterval(interval);
        };
    }, [activeTab]);

    const handleDetailPencairan = async (idPencairan) => {
        showNotification('Memuat detail transaksi...', 'info');
        try {
            const { data, error } = await supabase.from('Transaksi').select('*').eq('IDPencairan', idPencairan);
            if (!error) {
                const detailData = (data || []).map(trx => {
                    const santri = dataSantri.find(s => String(s.nis).replace(/^0+/, '') === String(trx.SantriID).replace(/^0+/, ''));
                    return { ...trx, NamaSantri: santri ? santri.nama : '-' };
                });
                setDetailPencairanData(detailData);
                setModalDetailPencairan(idPencairan);
            } else {
                showNotification('Gagal memuat detail', 'error');
            }
        } catch (e) {
            showNotification('Gagal memuat detail', 'error');
        }
    };

    const handleOpenProsesPencairan = (item) => {
        if (!item) return;
        const warungName = getNamaWarung(item.WarungID);
        const periodeBulan = getPeriodeBulanKey(item.WaktuPengajuan);
        const feeConfig = appConfig.pencairanFeeConfig || { biayaAplikasi: 30000, biayaKader: 200000, maxPotongPersen: 50 };
        const feeHistory = appConfig.pencairanFeeHistory || {};
        
        const monthlyStatus = getWarungMonthlyFeeStatus(item.WarungID, periodeBulan, feeHistory, feeConfig);
        const safeCalc = calculateSafeDeduction(item.TotalDana, monthlyStatus.sisaAplikasi, monthlyStatus.sisaKader, feeConfig.maxPotongPersen || 50);

        setModalProsesPencairan({
            item,
            warungName,
            periodeBulan,
            monthlyStatus,
            safeCalc,
            potongAplikasi: safeCalc.potongAplikasi,
            potongKader: safeCalc.potongKader,
            catatBukuKas: true,
            catatan: ''
        });
    };

    const handleSelesaiPencairan = (idPencairan) => {
        const item = dataPencairan.find(x => x.IDPencairan === idPencairan);
        if (item) handleOpenProsesPencairan(item);
    };

    const handleKonfirmasiProsesPencairan = async (e) => {
        if (e && e.preventDefault) e.preventDefault();
        if (!modalProsesPencairan) return;
        
        const { item, warungName, periodeBulan, monthlyStatus, potongAplikasi, potongKader, catatBukuKas, catatan } = modalProsesPencairan;
        const numPotongAplikasi = Math.max(0, parseInt(String(potongAplikasi || 0).replace(/\D/g, ''), 10) || 0);
        const numPotongKader = Math.max(0, parseInt(String(potongKader || 0).replace(/\D/g, ''), 10) || 0);
        const totalPotongan = numPotongAplikasi + numPotongKader;
        const totalDana = Number(item.TotalDana || 0);
        const totalBersih = Math.max(0, totalDana - totalPotongan);

        showNotification('Memproses pencairan dan pemotongan...', 'info');

        try {
            const waktuSelesai = new Date().toISOString();
            const historyRecord = {
                idPencairan: item.IDPencairan,
                warungId: item.WarungID,
                warungName: warungName,
                periodeBulan: periodeBulan,
                totalKotor: totalDana,
                potonganAplikasi: numPotongAplikasi,
                potonganKader: numPotongKader,
                totalPotongan: totalPotongan,
                totalBersih: totalBersih,
                sisaAplikasiSetelah: Math.max(0, monthlyStatus.sisaAplikasi - numPotongAplikasi),
                sisaKaderSetelah: Math.max(0, monthlyStatus.sisaKader - numPotongKader),
                catatBukuKas: !!catatBukuKas,
                catatan: catatan || '',
                waktuPengajuan: item.WaktuPengajuan,
                waktuSelesai: waktuSelesai
            };

            const updatedHistory = {
                ...(appConfig.pencairanFeeHistory || {}),
                [item.IDPencairan]: historyRecord
            };

            // 1. Simpan history ke MasterConfig
            const updatedConfig = {
                ...appConfig,
                pencairanFeeHistory: updatedHistory
            };
            setAppConfig(updatedConfig);
            await supabase.from('MasterConfig').upsert({
                kunci: 'pencairanFeeHistory',
                nilai: JSON.stringify(updatedHistory)
            }, { onConflict: 'kunci' });

            // 2. Update status Pencairan di Supabase
            const { error: pErr } = await supabase.from('Pencairan').update({
                Status: 'Selesai',
                WaktuSelesai: waktuSelesai
            }).eq('IDPencairan', item.IDPencairan);
            if (pErr) throw pErr;

            // 3. Update status Transaksi di Supabase
            await supabase.from('Transaksi').update({
                StatusPencairan: 'Selesai'
            }).eq('IDPencairan', item.IDPencairan);

            // 4. Catat ke Buku Kas jika dipilih
            if (catatBukuKas) {
                const todayStr = new Date().toISOString().split('T')[0];
                const newKasEntries = [];
                
                if (totalBersih > 0) {
                    newKasEntries.push({
                        id: `KAS-${Date.now()}-1`,
                        tanggal: todayStr,
                        tipeKas: 'Pengeluaran',
                        sumberTujuan: 'Pencairan Warung',
                        nominal: totalBersih,
                        keterangan: `Pencairan Bersih Warung ${warungName} [${item.IDPencairan}]`
                    });
                }
                if (numPotongAplikasi > 0) {
                    newKasEntries.push({
                        id: `KAS-${Date.now()}-2`,
                        tanggal: todayStr,
                        tipeKas: 'Pemasukan',
                        sumberTujuan: 'Sewa Aplikasi Kantin',
                        nominal: numPotongAplikasi,
                        keterangan: `Potongan Sewa Aplikasi Warung ${warungName} (Bulan ${periodeBulan}) [${item.IDPencairan}]`
                    });
                }
                if (numPotongKader > 0) {
                    newKasEntries.push({
                        id: `KAS-${Date.now()}-3`,
                        tanggal: todayStr,
                        tipeKas: 'Pemasukan',
                        sumberTujuan: 'Titipan Honor Kader',
                        nominal: numPotongKader,
                        keterangan: `Potongan Iuran Kader Warung ${warungName} (Bulan ${periodeBulan}) [${item.IDPencairan}]`
                    });
                }

                if (newKasEntries.length > 0) {
                    setDataKas(prev => [...newKasEntries, ...prev]);
                    for (const ke of newKasEntries) {
                        await supabase.from('Kas').insert(ke);
                    }
                }
            }

            addLog('UPDATE', 'PENCAIRAN', `Cairkan ${item.IDPencairan} (${warungName}): Kotor Rp ${totalDana.toLocaleString('id-ID')}, Potong Rp ${totalPotongan.toLocaleString('id-ID')}, Bersih Rp ${totalBersih.toLocaleString('id-ID')}`);
            showNotification('Pencairan berhasil diproses dan dicairkan!', 'success');
            setModalProsesPencairan(null);
            if (modalDetailPencairan === item.IDPencairan) setModalDetailPencairan(null);
            setModalSuksesPencairan({
                history: historyRecord,
                warungName: warungName
            });
            fetchPencairanGlobal();
        } catch (err) {
            console.error("Gagal proses pencairan:", err);
            showNotification(`Gagal memproses pencairan: ${err.message || 'Error'}`, 'error');
        }
    };

    const handleCopyWhatsAppStruk = (hist, warungName) => {
        if (!hist) return;
        const tgl = hist.waktuSelesai ? new Date(hist.waktuSelesai).toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' }) : '-';
        const msg = 
`*BUKTI PENCAIRAN SALDO KANTIN*
---------------------------------------
Nama Warung: *${warungName}*
ID Pencairan: \`${hist.idPencairan}\`
Tanggal: ${tgl}
Periode Bulan: *${hist.periodeBulan}*

*RINCIAN DANA:*
• Total Penjualan Non-Tunai: *Rp ${Number(hist.totalKotor || 0).toLocaleString('id-ID')}*

*POTONGAN KEWAJIBAN (MOU):*
• Biaya Aplikasi: -Rp ${Number(hist.potonganAplikasi || 0).toLocaleString('id-ID')}
• Iuran Kader: -Rp ${Number(hist.potonganKader || 0).toLocaleString('id-ID')}
• Total Terpotong: *-Rp ${Number(hist.totalPotongan || 0).toLocaleString('id-ID')}*

---------------------------------------
*TOTAL BERSIH DITRANSFER:*
*Rp ${Number(hist.totalBersih || 0).toLocaleString('id-ID')}*
---------------------------------------

*SISA KEWAJIBAN BULAN INI:*
• Biaya Aplikasi: Rp ${Number(hist.sisaAplikasiSetelah || 0).toLocaleString('id-ID')}
• Iuran Kader: Rp ${Number(hist.sisaKaderSetelah || 0).toLocaleString('id-ID')}
${(hist.sisaAplikasiSetelah === 0 && hist.sisaKaderSetelah === 0) ? '✅ *Alhamdulillah, kewajiban bulan ini sudah LUNAS.*' : 'ℹ️ *Sisa akan dipotong bertahap pada pencairan berikutnya.*'}

Terima kasih atas kerja samanya.`;

        if (navigator.clipboard) {
            navigator.clipboard.writeText(msg);
            showNotification('Format rincian WA berhasil disalin!', 'success');
        }
    };

    const handleSaveConfigMOU = async (e) => {
        e?.preventDefault();
        if (!modalConfigMOU) return;
        showNotification('Menyimpan pengaturan MOU...', 'info');
        try {
            const updated = {
                ...appConfig,
                pencairanFeeConfig: modalConfigMOU
            };
            setAppConfig(updated);
            await supabase.from('MasterConfig').upsert({
                kunci: 'pencairanFeeConfig',
                nilai: JSON.stringify(modalConfigMOU)
            }, { onConflict: 'kunci' });
            showNotification('Pengaturan MOU berhasil diperbarui!', 'success');
            setModalConfigMOU(null);
        } catch (err) {
            showNotification('Gagal menyimpan pengaturan MOU', 'error');
        }
    };


    const handleOpenEditPencairan = (item) => {
        setModalEditPencairan({
            IDPencairan: item.IDPencairan,
            WarungID: item.WarungID || '',
            TotalDana: item.TotalDana || 0,
            Status: item.Status || 'Menunggu',
            WaktuPengajuan: item.WaktuPengajuan ? new Date(item.WaktuPengajuan).toISOString().slice(0, 16) : '',
            WaktuSelesai: item.WaktuSelesai ? new Date(item.WaktuSelesai).toISOString().slice(0, 16) : ''
        });
    };

    const handleSaveEditPencairan = async (e) => {
        e.preventDefault();
        if (!modalEditPencairan) return;
        showNotification('Menyimpan perubahan pencairan...', 'info');
        try {
            const updatePayload = {
                WarungID: modalEditPencairan.WarungID,
                TotalDana: Number(modalEditPencairan.TotalDana || 0),
                Status: modalEditPencairan.Status,
                WaktuPengajuan: modalEditPencairan.WaktuPengajuan ? new Date(modalEditPencairan.WaktuPengajuan).toISOString() : new Date().toISOString(),
                WaktuSelesai: modalEditPencairan.Status === 'Selesai' 
                    ? (modalEditPencairan.WaktuSelesai ? new Date(modalEditPencairan.WaktuSelesai).toISOString() : new Date().toISOString())
                    : null
            };

            const { error } = await supabase
                .from('Pencairan')
                .update(updatePayload)
                .eq('IDPencairan', modalEditPencairan.IDPencairan);

            if (error) throw error;

            // Sesuaikan status transaksi terkait jika status berubah
            if (modalEditPencairan.Status === 'Selesai') {
                await supabase.from('Transaksi').update({ StatusPencairan: 'Selesai' }).eq('IDPencairan', modalEditPencairan.IDPencairan);
            } else if (modalEditPencairan.Status === 'Menunggu') {
                await supabase.from('Transaksi').update({ StatusPencairan: 'Sedang Diajukan' }).eq('IDPencairan', modalEditPencairan.IDPencairan);
            }

            addLog('UPDATE', 'PENCAIRAN', `Edit pencairan ${modalEditPencairan.IDPencairan} (${getNamaWarung(modalEditPencairan.WarungID)}): Rp ${Number(modalEditPencairan.TotalDana || 0).toLocaleString('id-ID')} [${modalEditPencairan.Status}]`);
            showNotification('Data pencairan berhasil diperbarui!', 'success');
            setModalEditPencairan(null);
            fetchPencairanGlobal();
        } catch (err) {
            console.error(err);
            showNotification(`Gagal menyimpan perubahan: ${err.message || 'Error'}`, 'error');
        }
    };

    const handleHapusPencairan = async (item) => {
        const warungName = getNamaWarung(item.WarungID);
        const confirmDelete = window.confirm(
            `HAPUS PENCAIRAN DANA?\n\n` +
            `ID: ${item.IDPencairan}\n` +
            `Warung: ${warungName}\n` +
            `Total Dana: Rp ${Number(item.TotalDana || 0).toLocaleString('id-ID')}\n` +
            `Status: ${item.Status}\n\n` +
            `Transaksi non-tunai terkait akan dikembalikan ke status 'Belum Dicairkan' sehingga warung dapat mengajukannya kembali.\n\n` +
            `Apakah Anda yakin ingin menghapus pencairan ini?`
        );
        if (!confirmDelete) return;

        showNotification('Menghapus data pencairan...', 'info');
        try {
            // 1. Reset relasi Transaksi agar transaksi warung tidak terikat IDPencairan yang sudah dihapus
            await supabase.from('Transaksi').update({ IDPencairan: null, StatusPencairan: null }).eq('IDPencairan', item.IDPencairan);
            
            // 2. Hapus data Pencairan
            const { error } = await supabase.from('Pencairan').delete().eq('IDPencairan', item.IDPencairan);
            if (error) throw error;

            addLog('DELETE', 'PENCAIRAN', `Hapus pencairan ${item.IDPencairan} - Warung ${warungName}`);
            showNotification('Data pencairan berhasil dihapus!', 'success');
            fetchPencairanGlobal();
            if (modalDetailPencairan === item.IDPencairan) setModalDetailPencairan(null);
        } catch (err) {
            console.error(err);
            showNotification(`Gagal menghapus pencairan: ${err.message || 'Error'}`, 'error');
        }
    };

    const renderPencairanWarung = () => {
        const filtered = dataPencairan.filter(item => {
            const warungNama = getNamaWarung(item.WarungID).toLowerCase();
            const warungId = String(item.WarungID || '').toLowerCase();
            const idPencairan = String(item.IDPencairan || '').toLowerCase();
            const term = pencairanSearchTerm.toLowerCase();
            const matchSearch = warungNama.includes(term) || warungId.includes(term) || idPencairan.includes(term);
            const matchStatus = pencairanStatusFilter === 'Semua' || item.Status === pencairanStatusFilter;
            return matchSearch && matchStatus;
        });

        const now = new Date();
        const currentPeriodeKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
        const currentPeriodeLabel = now.toLocaleDateString('id-ID', { month: 'long', year: 'numeric' });

        const itemsPerPage = 10;
        const totalPages = Math.ceil(filtered.length / itemsPerPage);
        const paginatedPencairan = filtered.slice((currentPage - 1) * itemsPerPage, currentPage * itemsPerPage);

        return (
            <div className="space-y-6 animate-fade-in-up">
                <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
                    <div>
                        <h1 className="text-2xl font-bold text-ink flex items-center gap-2"><Wallet className="w-6 h-6 text-primary" /> Pencairan Warung</h1>
                        <p className="text-steel text-sm mt-1">Kelola dan pantau pengajuan pencairan dana dari seluruh merchant/warung beserta pemotongan kewajiban MOU.</p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                        <button 
                            type="button" 
                            onClick={() => setModalConfigMOU(appConfig.pencairanFeeConfig || { biayaAplikasi: 30000, biayaKader: 200000, maxPotongPersen: 50 })}
                            className={btnOutline}
                        >
                            <SlidersHorizontal className="w-4 h-4 text-accent" /> Atur Nilai MOU
                        </button>
                        <button onClick={fetchPencairanGlobal} className={btnOutline}>
                            <RefreshCw className={`w-4 h-4 ${loadingPencairan ? 'animate-spin' : ''}`} /> Refresh
                        </button>
                    </div>
                </div>

                {/* Sub-tab Navigation: Daftar Pencairan | Rekap per Warung */}
                <div className="flex border-b border-whisper gap-2">
                    <button 
                        onClick={() => setPencairanSubTab('daftar')} 
                        className={`px-4 py-2.5 font-semibold text-sm border-b-2 transition-all flex items-center gap-2 ${pencairanSubTab === 'daftar' ? 'border-accent text-accent' : 'border-transparent text-steel hover:text-ink'}`}
                    >
                        <Wallet className="w-4 h-4" /> Daftar Pencairan ({dataPencairan.length})
                    </button>
                    <button 
                        onClick={() => { setPencairanSubTab('rekap'); fetchRekapPerWarung(rekapPeriode); }} 
                        className={`px-4 py-2.5 font-semibold text-sm border-b-2 transition-all flex items-center gap-2 ${pencairanSubTab === 'rekap' ? 'border-accent text-accent' : 'border-transparent text-steel hover:text-ink'}`}
                    >
                        <BarChart3 className="w-4 h-4" /> Rekap Transaksi per Warung
                    </button>
                </div>

                {pencairanSubTab === 'daftar' ? (<>
                {/* Banner Status Kewajiban Bulanan Warung (MOU) */}
                <div className="bg-gradient-to-r from-blue-50/80 via-indigo-50/50 to-slate-50 border border-blue-100 rounded-card p-4 sm:p-5 shadow-sm">
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-3">
                        <div className="flex items-center gap-2.5">
                            <div className="p-2 bg-blue-600 text-white rounded-lg shadow-sm">
                                <Store className="w-4 h-4" />
                            </div>
                            <div>
                                <h3 className="font-bold text-ink text-sm sm:text-base flex items-center gap-2">
                                    Kewajiban Bulanan Warung (MOU)
                                    <span className="text-xs px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 font-semibold">{currentPeriodeLabel}</span>
                                </h3>
                                <p className="text-xs text-steel">Aplikasi: Rp 30.000 • Kader: Standar Rp {(appConfig.pencairanFeeConfig?.biayaKader ?? 200000).toLocaleString('id-ID')} (atau sesuai pengaturan khusus per warung). Dipotong bertahap maks. 50% per pencairan.</p>
                            </div>
                        </div>
                        <button 
                            type="button" 
                            onClick={() => setModalConfigMOU(appConfig.pencairanFeeConfig || { biayaAplikasi: 30000, biayaKader: 200000, maxPotongPersen: 50 })}
                            className="text-xs font-semibold text-accent hover:text-accent/80 flex items-center gap-1.5 self-start sm:self-auto bg-surface hover:bg-canvas px-3 py-1.5 rounded-lg border border-whisper shadow-xs"
                        >
                            <SlidersHorizontal className="w-3.5 h-3.5" /> Sesuaikan Nilai MOU
                        </button>
                    </div>
                    
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-2.5 pt-2 border-t border-blue-100/60">
                        {(dataWarung || []).map(w => {
                            const wId = String(w.ID || w.id);
                            const wName = w.Nama || w.nama || wId;
                            const status = getWarungMonthlyFeeStatus(wId, currentPeriodeKey, appConfig.pencairanFeeHistory, appConfig.pencairanFeeConfig);
                            const pct = status.targetTotal > 0 ? Math.min(100, Math.round((status.totalTerbayar / status.targetTotal) * 100)) : 100;
                            return (
                                <div key={wId} className="bg-surface/90 border border-whisper rounded-xl p-3 shadow-2xs hover:shadow-xs transition-shadow">
                                    <div className="flex justify-between items-start gap-1">
                                        <span className="font-bold text-ink text-xs truncate max-w-[150px]" title={wName}>{wName}</span>
                                        {status.isLunas ? (
                                            <span className="text-[10px] font-bold text-emerald-700 bg-emerald-50 border border-emerald-200 px-1.5 py-0.5 rounded-full shrink-0">LUNAS</span>
                                        ) : (
                                            <span className="text-[10px] font-bold text-amber-700 bg-amber-50 border border-amber-200 px-1.5 py-0.5 rounded-full shrink-0">Sisa Rp {status.totalSisa.toLocaleString('id-ID')}</span>
                                        )}
                                    </div>
                                    <div className="w-full bg-slate-100 rounded-full h-1.5 mt-2 overflow-hidden">
                                        <div className={`h-full rounded-full transition-all duration-500 ${status.isLunas ? 'bg-emerald-500' : 'bg-blue-600'}`} style={{ width: `${pct}%` }}></div>
                                    </div>
                                    <div className="flex justify-between items-center text-[10px] text-steel mt-1.5 font-medium">
                                        <span>Terbayar: Rp {status.totalTerbayar.toLocaleString('id-ID')}</span>
                                        <span>{pct}%</span>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </div>

                {/* Filter & Search Bar */}
                <div className="bg-surface border border-whisper rounded-card p-4 shadow-sm flex flex-col sm:flex-row items-center justify-between gap-3">
                    <div className="relative w-full sm:w-80">
                        <Search className="w-4 h-4 absolute left-3 top-3 text-steel" />
                        <input 
                            type="text" 
                            placeholder="Cari nama warung atau ID pencairan..." 
                            value={pencairanSearchTerm} 
                            onChange={(e) => { setPencairanSearchTerm(e.target.value); setCurrentPage(1); }} 
                            className={`${inputBase} pl-9 w-full`} 
                        />
                    </div>
                    <div className="flex items-center gap-2 w-full sm:w-auto">
                        <label className="text-xs text-steel font-medium shrink-0">Filter Status:</label>
                        <select 
                            value={pencairanStatusFilter} 
                            onChange={(e) => { setPencairanStatusFilter(e.target.value); setCurrentPage(1); }}
                            className={`${inputBase} py-2 text-xs w-full sm:w-40`}
                        >
                            <option value="Semua">Semua Status</option>
                            <option value="Menunggu">Menunggu</option>
                            <option value="Selesai">Selesai</option>
                            <option value="Ditolak">Ditolak</option>
                        </select>
                    </div>
                </div>

                <div className="bg-surface border border-whisper rounded-card p-6 shadow-sm overflow-hidden">
                    {/* Desktop Table View */}
                    <div className="overflow-x-auto hidden md:block">
                        <table className="w-full text-left border-collapse">
                            <thead>
                                <tr className="border-b border-whisper text-steel text-sm">
                                    <th className="pb-3 font-medium">ID Pencairan</th>
                                    <th className="pb-3 font-medium">Waktu Pengajuan</th>
                                    <th className="pb-3 font-medium">Warung / Merchant</th>
                                    <th className="pb-3 font-medium text-right">Pengajuan Kotor</th>
                                    <th className="pb-3 font-medium text-right">Potongan MOU</th>
                                    <th className="pb-3 font-medium text-right">Dana Bersih</th>
                                    <th className="pb-3 font-medium text-center">Status</th>
                                    <th className="pb-3 font-medium text-right">Aksi</th>
                                </tr>
                            </thead>
                            <tbody className="text-sm">
                                {loadingPencairan ? (
                                    <tr><td colSpan="8" className="text-center py-8 text-steel">Memuat data pencairan...</td></tr>
                                ) : paginatedPencairan.length === 0 ? (
                                    <tr><td colSpan="8" className="text-center py-8 text-steel">Tidak ada data pencairan yang sesuai.</td></tr>
                                ) : paginatedPencairan.map((item) => {
                                    const hist = appConfig.pencairanFeeHistory?.[item.IDPencairan];
                                    const totalDana = Number(item.TotalDana || 0);
                                    const itemPeriode = getPeriodeBulanKey(item.WaktuPengajuan);
                                    const mStatus = getWarungMonthlyFeeStatus(item.WarungID, itemPeriode, appConfig.pencairanFeeHistory, appConfig.pencairanFeeConfig);
                                    const sCalc = calculateSafeDeduction(totalDana, mStatus.sisaAplikasi, mStatus.sisaKader, appConfig.pencairanFeeConfig?.maxPotongPersen || 50);

                                    let potongDisplay = '-';
                                    let bersihDisplay = totalDana;
                                    let isEstimated = false;

                                    if (hist) {
                                        potongDisplay = `-Rp ${Number(hist.totalPotongan || 0).toLocaleString('id-ID')}`;
                                        bersihDisplay = Number(hist.totalBersih || 0);
                                    } else if (item.Status === 'Menunggu') {
                                        potongDisplay = `Est. -Rp ${sCalc.totalPotongan.toLocaleString('id-ID')}`;
                                        bersihDisplay = sCalc.totalBersih;
                                        isEstimated = true;
                                    }

                                    return (
                                        <tr key={item.IDPencairan} className="border-b border-slate-50 hover:bg-slate-50 transition-colors">
                                            <td className="py-4 font-mono text-xs font-semibold text-slate-700">{item.IDPencairan}</td>
                                            <td className="py-4 text-steel text-xs">{item.WaktuPengajuan ? formatDateTimeID(new Date(item.WaktuPengajuan)) : '-'}</td>
                                            <td className="py-4">
                                                <div className="font-semibold text-ink text-sm">{getNamaWarung(item.WarungID)}</div>
                                                <div className="text-[11px] text-steel font-mono">{item.WarungID}</div>
                                            </td>
                                            <td className="py-4 text-right font-medium text-slate-700">Rp {totalDana.toLocaleString('id-ID')}</td>
                                            <td className="py-4 text-right">
                                                <div className={isEstimated ? 'text-amber-600 font-medium text-xs' : (hist?.totalPotongan || 0) > 0 ? 'text-rose-600 font-bold text-xs' : 'text-steel text-xs'}>
                                                    {potongDisplay}
                                                </div>
                                                {hist && (hist.totalPotongan || 0) > 0 && (
                                                    <div className="text-[10px] text-steel font-mono">App: {Number(hist.potonganAplikasi || 0).toLocaleString('id-ID')} | Kdr: {Number(hist.potonganKader || 0).toLocaleString('id-ID')}</div>
                                                )}
                                                {isEstimated && sCalc.totalPotongan > 0 && (
                                                    <div className="text-[10px] text-amber-600/80">Maks. 50%</div>
                                                )}
                                            </td>
                                            <td className="py-4 text-right font-bold text-emerald-600 text-base">
                                                Rp {bersihDisplay.toLocaleString('id-ID')}
                                            </td>
                                            <td className="py-4 text-center">
                                                <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold ${
                                                    item.Status === 'Selesai' 
                                                        ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' 
                                                        : item.Status === 'Ditolak'
                                                        ? 'bg-rose-50 text-rose-700 border border-rose-200'
                                                        : 'bg-amber-50 text-amber-700 border border-amber-200'
                                                }`}>
                                                    {item.Status || 'Menunggu'}
                                                </span>
                                            </td>
                                            <td className="py-4 text-right">
                                                <div className="flex items-center justify-end gap-1.5">
                                                    <button 
                                                        onClick={() => handleDetailPencairan(item.IDPencairan)} 
                                                        className="p-1.5 text-steel hover:text-accent hover:bg-canvas rounded-lg transition-colors border border-transparent hover:border-whisper"
                                                        title="Lihat Detail Transaksi & Rincian Struk"
                                                    >
                                                        <Eye className="w-4 h-4" />
                                                    </button>
                                                    <button 
                                                        onClick={() => handleOpenEditPencairan(item)} 
                                                        className="p-1.5 text-steel hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors border border-transparent hover:border-blue-100"
                                                        title="Edit Data Pencairan"
                                                    >
                                                        <Edit className="w-4 h-4" />
                                                    </button>
                                                    {item.Status === 'Menunggu' && (
                                                        <button 
                                                            onClick={() => handleOpenProsesPencairan(item)} 
                                                            className="px-2.5 py-1 text-xs font-bold bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg transition-colors flex items-center gap-1 shadow-sm"
                                                            title="Cairkan & Hitung Potongan MOU"
                                                        >
                                                            <CheckCircle2 className="w-3.5 h-3.5" /> Cairkan & Potong
                                                        </button>
                                                    )}
                                                    <button 
                                                        onClick={() => handleHapusPencairan(item)} 
                                                        className="p-1.5 text-rose-500 hover:text-rose-700 hover:bg-rose-50 rounded-lg transition-colors border border-transparent hover:border-rose-100"
                                                        title="Hapus Pencairan"
                                                    >
                                                        <Trash2 className="w-4 h-4" />
                                                    </button>
                                                </div>
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>

                    {/* Mobile Card View */}
                    <div className="md:hidden flex flex-col divide-y divide-whisper/50">
                        {loadingPencairan ? (
                            <div className="text-center py-8 text-steel text-sm">Memuat data pencairan...</div>
                        ) : paginatedPencairan.length === 0 ? (
                            <div className="text-center py-8 text-steel text-sm">Tidak ada data pencairan yang sesuai.</div>
                        ) : paginatedPencairan.map((item) => {
                            const hist = appConfig.pencairanFeeHistory?.[item.IDPencairan];
                            const totalDana = Number(item.TotalDana || 0);
                            const itemPeriode = getPeriodeBulanKey(item.WaktuPengajuan);
                            const mStatus = getWarungMonthlyFeeStatus(item.WarungID, itemPeriode, appConfig.pencairanFeeHistory, appConfig.pencairanFeeConfig);
                            const sCalc = calculateSafeDeduction(totalDana, mStatus.sisaAplikasi, mStatus.sisaKader, appConfig.pencairanFeeConfig?.maxPotongPersen || 50);

                            let potongDisplay = '-';
                            let bersihDisplay = totalDana;
                            let isEstimated = false;

                            if (hist) {
                                potongDisplay = `-Rp ${Number(hist.totalPotongan || 0).toLocaleString('id-ID')}`;
                                bersihDisplay = Number(hist.totalBersih || 0);
                            } else if (item.Status === 'Menunggu') {
                                potongDisplay = `Est. -Rp ${sCalc.totalPotongan.toLocaleString('id-ID')}`;
                                bersihDisplay = sCalc.totalBersih;
                                isEstimated = true;
                            }

                            return (
                                <div key={item.IDPencairan} className="p-4 flex flex-col gap-3 bg-surface">
                                    <div className="flex justify-between items-start gap-2">
                                        <div className="min-w-0">
                                            <div className="font-bold text-ink text-base truncate">{getNamaWarung(item.WarungID)}</div>
                                            <div className="text-xs text-steel font-mono">{item.IDPencairan}</div>
                                            <div className="text-[11px] text-steel mt-0.5">{item.WaktuPengajuan ? formatDateTimeID(new Date(item.WaktuPengajuan)) : '-'}</div>
                                        </div>
                                        <span className={`px-2 py-0.5 text-[11px] font-semibold rounded-full shrink-0 ${
                                            item.Status === 'Selesai' 
                                                ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' 
                                                : item.Status === 'Ditolak'
                                                ? 'bg-rose-50 text-rose-700 border border-rose-200'
                                                : 'bg-amber-50 text-amber-700 border border-amber-200'
                                        }`}>
                                            {item.Status || 'Menunggu'}
                                        </span>
                                    </div>
                                    <div className="bg-slate-50 border border-whisper rounded-xl p-3 grid grid-cols-3 gap-2 text-center text-xs">
                                        <div>
                                            <span className="text-[10px] text-steel block">Kotor</span>
                                            <span className="font-semibold text-ink">Rp {totalDana.toLocaleString('id-ID')}</span>
                                        </div>
                                        <div>
                                            <span className="text-[10px] text-steel block">Potong MOU</span>
                                            <span className={`font-semibold ${isEstimated ? 'text-amber-600' : (hist?.totalPotongan || 0) > 0 ? 'text-rose-600' : 'text-steel'}`}>
                                                {potongDisplay}
                                            </span>
                                        </div>
                                        <div>
                                            <span className="text-[10px] text-steel block">Dana Bersih</span>
                                            <span className="font-bold text-emerald-600">Rp {bersihDisplay.toLocaleString('id-ID')}</span>
                                        </div>
                                    </div>
                                    <div className="flex flex-wrap items-center gap-2 justify-end pt-2 border-t border-whisper/50">
                                        <button 
                                            onClick={() => handleDetailPencairan(item.IDPencairan)} 
                                            className="flex items-center gap-1 text-steel hover:text-ink text-xs px-2.5 py-1.5 rounded-lg border border-whisper bg-surface"
                                        >
                                            <Eye className="w-3.5 h-3.5" /> Detail
                                        </button>
                                        <button 
                                            onClick={() => handleOpenEditPencairan(item)} 
                                            className="flex items-center gap-1 text-blue-600 bg-blue-50 text-xs px-2.5 py-1.5 rounded-lg border border-blue-100"
                                        >
                                            <Edit className="w-3.5 h-3.5" /> Edit
                                        </button>
                                        {item.Status === 'Menunggu' && (
                                            <button 
                                                onClick={() => handleOpenProsesPencairan(item)} 
                                                className="flex items-center gap-1 text-white bg-emerald-600 hover:bg-emerald-700 text-xs px-2.5 py-1.5 rounded-lg font-bold shadow-sm"
                                            >
                                                <CheckCircle2 className="w-3.5 h-3.5" /> Cairkan & Potong
                                            </button>
                                        )}
                                        <button 
                                            onClick={() => handleHapusPencairan(item)} 
                                            className="flex items-center gap-1 text-rose-600 bg-rose-50 text-xs px-2.5 py-1.5 rounded-lg border border-rose-100"
                                        >
                                            <Trash2 className="w-3.5 h-3.5" /> Hapus
                                        </button>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                    
                    {totalPages > 0 && (
                        <div className="flex justify-center items-center gap-4 p-4 border-t border-whisper/50 bg-canvas/30">
                            <button onClick={() => setCurrentPage(p => Math.max(1, p - 1))} disabled={currentPage === 1} className="px-3 py-1.5 text-sm font-medium border border-whisper rounded-lg bg-surface hover:bg-canvas disabled:opacity-50 disabled:cursor-not-allowed text-ink">Prev</button>
                            <span className="text-sm text-steel font-medium">Hal {currentPage} dari {totalPages}</span>
                            <button onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))} disabled={currentPage === totalPages} className="px-3 py-1.5 text-sm font-medium border border-whisper rounded-lg bg-surface hover:bg-canvas disabled:opacity-50 disabled:cursor-not-allowed text-ink">Next</button>
                        </div>
                    )}
                </div>

                {/* Modal Detail Pencairan */}
                {modalDetailPencairan && (() => {
                    const pencairanItem = dataPencairan.find(x => x.IDPencairan === modalDetailPencairan);
                    const namaWarung = pencairanItem ? getNamaWarung(pencairanItem.WarungID) : '-';
                    const hist = appConfig.pencairanFeeHistory?.[modalDetailPencairan];

                    return (
                        <FormWrapper title={`Detail Pencairan - ${modalDetailPencairan}`} onClose={() => setModalDetailPencairan(null)} customFooter={
                            <div className="px-6 py-4 bg-canvas border-t border-whisper flex flex-wrap justify-between items-center gap-3 shrink-0 rounded-b-card w-full">
                                <div>
                                    {pencairanItem && (
                                        <button 
                                            type="button" 
                                            onClick={() => handleHapusPencairan(pencairanItem)} 
                                            className="px-3 py-2 bg-rose-50 hover:bg-rose-100 text-rose-600 font-medium text-xs rounded-xl flex items-center gap-1.5 border border-rose-200"
                                        >
                                            <Trash2 className="w-3.5 h-3.5" /> Hapus Pencairan
                                        </button>
                                    )}
                                </div>
                                <div className="flex items-center gap-2">
                                    <button type="button" onClick={() => setModalDetailPencairan(null)} className={btnOutline}>Tutup</button>
                                    {hist && (
                                        <button 
                                            type="button" 
                                            onClick={() => handleCopyWhatsAppStruk(hist, namaWarung)}
                                            className="px-4 py-2.5 bg-emerald-50 hover:bg-emerald-100 text-emerald-700 font-semibold text-sm rounded-xl flex items-center gap-1.5 border border-emerald-200 shadow-2xs"
                                        >
                                            <Copy className="w-4 h-4" /> Salin Format WA
                                        </button>
                                    )}
                                    {pencairanItem && (
                                        <button 
                                            type="button" 
                                            onClick={() => {
                                                setModalDetailPencairan(null);
                                                handleOpenEditPencairan(pencairanItem);
                                            }} 
                                            className="px-4 py-2.5 bg-blue-50 hover:bg-blue-100 text-blue-700 font-medium text-sm rounded-xl flex items-center gap-1.5 border border-blue-200"
                                        >
                                            <Edit className="w-4 h-4" /> Edit
                                        </button>
                                    )}
                                    {pencairanItem?.Status === 'Menunggu' && (
                                        <button 
                                            onClick={() => {
                                                setModalDetailPencairan(null);
                                                handleOpenProsesPencairan(pencairanItem);
                                            }} 
                                            className="px-4 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-sm rounded-xl flex items-center gap-1.5 shadow-sm"
                                        >
                                            <CheckCircle2 className="w-4 h-4" /> Cairkan & Potong
                                        </button>
                                    )}
                                </div>
                            </div>
                        }>
                            <div className="space-y-4">
                                <div className="p-4 bg-slate-50 border border-slate-200 rounded-xl grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
                                    <div>
                                        <span className="text-xs text-steel block">Nama Warung:</span>
                                        <span className="font-bold text-ink text-base">{namaWarung}</span>
                                        <span className="text-xs font-mono text-steel block">{pencairanItem?.WarungID}</span>
                                    </div>
                                    <div className="sm:text-right">
                                        <span className="text-xs text-steel block">Total Dana Pengajuan:</span>
                                        <span className="font-bold text-ink text-lg">Rp {Number(pencairanItem?.TotalDana || 0).toLocaleString('id-ID')}</span>
                                    </div>
                                </div>

                                {/* Rincian Pemotongan MOU jika sudah diproses */}
                                {hist && (
                                    <div className="p-4 bg-gradient-to-r from-emerald-50/70 to-teal-50/50 border border-emerald-200 rounded-xl space-y-3">
                                        <div className="flex items-center justify-between">
                                            <div className="flex items-center gap-2">
                                                <div className="p-1.5 bg-emerald-600 text-white rounded-md">
                                                    <BadgePercent className="w-4 h-4" />
                                                </div>
                                                <span className="font-bold text-ink text-sm">Rincian Pemotongan Kewajiban (MOU)</span>
                                            </div>
                                            <button 
                                                type="button" 
                                                onClick={() => handleCopyWhatsAppStruk(hist, namaWarung)}
                                                className="flex items-center gap-1 text-xs font-semibold px-2.5 py-1 rounded-lg bg-white border border-emerald-200 text-emerald-700 hover:bg-emerald-100 shadow-2xs"
                                            >
                                                <Copy className="w-3.5 h-3.5" /> Salin Format WA
                                            </button>
                                        </div>
                                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                                            <div className="bg-white p-2.5 rounded-lg border border-emerald-100">
                                                <span className="text-steel block">Pengajuan Kotor:</span>
                                                <span className="font-bold text-ink">Rp {Number(hist.totalKotor || 0).toLocaleString('id-ID')}</span>
                                            </div>
                                            <div className="bg-white p-2.5 rounded-lg border border-emerald-100">
                                                <span className="text-steel block">Potongan Aplikasi:</span>
                                                <span className="font-bold text-rose-600">-Rp {Number(hist.potonganAplikasi || 0).toLocaleString('id-ID')}</span>
                                            </div>
                                            <div className="bg-white p-2.5 rounded-lg border border-emerald-100">
                                                <span className="text-steel block">Potongan Kader:</span>
                                                <span className="font-bold text-rose-600">-Rp {Number(hist.potonganKader || 0).toLocaleString('id-ID')}</span>
                                            </div>
                                            <div className="bg-emerald-600 text-white p-2.5 rounded-lg shadow-2xs">
                                                <span className="text-emerald-100 text-[10px] block font-medium">Bersih Ditransfer:</span>
                                                <span className="font-black text-sm">Rp {Number(hist.totalBersih || 0).toLocaleString('id-ID')}</span>
                                            </div>
                                        </div>
                                        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-1 text-[11px] text-emerald-800 pt-1 border-t border-emerald-200/60 font-medium">
                                            <span>Sisa Tanggungan Bulan Ini: Aplikasi Rp {Number(hist.sisaAplikasiSetelah || 0).toLocaleString('id-ID')} • Kader Rp {Number(hist.sisaKaderSetelah || 0).toLocaleString('id-ID')}</span>
                                            <span>{(hist.sisaAplikasiSetelah === 0 && hist.sisaKaderSetelah === 0) ? '✅ Kewajiban Bulan Ini Lunas' : 'ℹ️ Sisa dipotong bertahap di pencairan berikutnya'}</span>
                                        </div>
                                    </div>
                                )}

                                <p className="text-sm text-steel">Berikut adalah daftar rincian transaksi non-tunai yang termasuk dalam pencairan ini:</p>
                                <div className="overflow-x-auto border border-whisper rounded-xl">
                                    <table className="w-full text-left text-sm">
                                        <thead className="bg-canvas border-b border-whisper text-steel text-xs uppercase">
                                            <tr>
                                                <th className="py-2.5 px-3">Trx ID</th>
                                                <th className="py-2.5 px-3">Metode</th>
                                                <th className="py-2.5 px-3">Santri (UID/NIS)</th>
                                                <th className="py-2.5 px-3 text-right">Nominal</th>
                                            </tr>
                                        </thead>
                                        <tbody className="divide-y divide-whisper/50">
                                            {detailPencairanData.length === 0 ? (
                                                <tr><td colSpan="4" className="text-center py-6 text-steel">Data rincian transaksi tidak ditemukan atau kosong.</td></tr>
                                            ) : detailPencairanData.map((trx, tIdx) => (
                                                <tr key={tIdx} className="hover:bg-slate-50">
                                                    <td className="py-2.5 px-3 font-mono text-xs">{trx.TrxID}</td>
                                                    <td className="py-2.5 px-3 font-medium text-xs">
                                                        <span className="px-2 py-0.5 rounded bg-slate-100 text-slate-700">{trx.Metode}</span>
                                                    </td>
                                                    <td className="py-2.5 px-3">
                                                        <div className="font-bold text-ink">{trx.NamaSantri}</div>
                                                        <div className="text-xs text-steel">{trx.SantriID}</div>
                                                    </td>
                                                    <td className="py-2.5 px-3 text-right font-bold text-ink">Rp {Number(trx.TotalHarga || 0).toLocaleString('id-ID')}</td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            </div>
                        </FormWrapper>
                    );
                })()}

                {/* Modal Edit Pencairan */}
                {modalEditPencairan && (
                    <FormWrapper 
                        title={`Edit Pencairan - ${modalEditPencairan.IDPencairan}`} 
                        onClose={() => setModalEditPencairan(null)}
                        onSubmit={handleSaveEditPencairan}
                    >
                        <div className="space-y-4">
                            <div>
                                <label className="block text-sm font-medium text-ink mb-1">ID Pencairan (Tetap)</label>
                                <input 
                                    type="text" 
                                    value={modalEditPencairan.IDPencairan} 
                                    disabled 
                                    className={`${inputBase} bg-slate-100 cursor-not-allowed font-mono text-steel`} 
                                />
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-ink mb-1">Warung / Merchant</label>
                                <select 
                                    value={modalEditPencairan.WarungID || ''} 
                                    onChange={(e) => setModalEditPencairan(prev => ({ ...prev, WarungID: e.target.value }))}
                                    className={inputBase}
                                    required
                                >
                                    <option value="">Pilih Warung</option>
                                    {dataWarung.map(w => (
                                        <option key={w.ID || w.id} value={w.ID || w.id}>
                                            {w.Nama || w.nama} ({w.ID || w.id})
                                        </option>
                                    ))}
                                </select>
                            </div>
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                <div>
                                    <label className="block text-sm font-medium text-ink mb-1">Total Dana (Rp)</label>
                                    <input 
                                        type="number" 
                                        required 
                                        value={modalEditPencairan.TotalDana || ''} 
                                        onChange={(e) => setModalEditPencairan(prev => ({ ...prev, TotalDana: e.target.value }))}
                                        className={inputBase} 
                                    />
                                </div>
                                <div>
                                    <label className="block text-sm font-medium text-ink mb-1">Status Pencairan</label>
                                    <select 
                                        value={modalEditPencairan.Status || 'Menunggu'} 
                                        onChange={(e) => setModalEditPencairan(prev => ({ ...prev, Status: e.target.value }))}
                                        className={inputBase}
                                    >
                                        <option value="Menunggu">Menunggu</option>
                                        <option value="Selesai">Selesai</option>
                                        <option value="Ditolak">Ditolak</option>
                                    </select>
                                </div>
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-ink mb-1">Waktu Pengajuan</label>
                                <input 
                                    type="datetime-local" 
                                    value={modalEditPencairan.WaktuPengajuan || ''} 
                                    onChange={(e) => setModalEditPencairan(prev => ({ ...prev, WaktuPengajuan: e.target.value }))}
                                    className={inputBase} 
                                />
                            </div>
                            {modalEditPencairan.Status === 'Selesai' && (
                                <div>
                                    <label className="block text-sm font-medium text-ink mb-1">Waktu Selesai</label>
                                    <input 
                                        type="datetime-local" 
                                        value={modalEditPencairan.WaktuSelesai || ''} 
                                        onChange={(e) => setModalEditPencairan(prev => ({ ...prev, WaktuSelesai: e.target.value }))}
                                        className={inputBase} 
                                    />
                                </div>
                            )}
                        </div>
                    </FormWrapper>
                )}

                {/* MODAL PROSES PENCAIRAN & POTONGAN MOU */}
                {modalProsesPencairan && (() => {
                    const { item, warungName, periodeBulan, monthlyStatus, safeCalc, potongAplikasi, potongKader, catatBukuKas, catatan } = modalProsesPencairan;
                    const numPotAplikasi = Math.max(0, parseInt(String(potongAplikasi || 0).replace(/\D/g, ''), 10) || 0);
                    const numPotKader = Math.max(0, parseInt(String(potongKader || 0).replace(/\D/g, ''), 10) || 0);
                    const totalPot = numPotAplikasi + numPotKader;
                    const totalDana = Number(item.TotalDana || 0);
                    const totalBersih = Math.max(0, totalDana - totalPot);
                    const sisaAplikasiNanti = Math.max(0, monthlyStatus.sisaAplikasi - numPotAplikasi);
                    const sisaKaderNanti = Math.max(0, monthlyStatus.sisaKader - numPotKader);

                    return (
                        <FormWrapper 
                            title={`Proses Pencairan & Pemotongan MOU - ${item.IDPencairan}`} 
                            onClose={() => setModalProsesPencairan(null)}
                            onSubmit={handleKonfirmasiProsesPencairan}
                            customFooter={
                                <div className="px-6 py-4 bg-canvas border-t border-whisper flex justify-between items-center gap-3 shrink-0 rounded-b-card w-full">
                                    <button type="button" onClick={() => setModalProsesPencairan(null)} className={btnOutline}>
                                        Batal
                                    </button>
                                    <button type="submit" className="px-5 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-sm rounded-xl flex items-center gap-2 shadow-sm transition-all">
                                        <CheckCircle2 className="w-4 h-4" /> Konfirmasi & Selesaikan Pencairan
                                    </button>
                                </div>
                            }
                        >
                            <div className="space-y-4">
                                {/* Ringkasan Header Warung */}
                                <div className="p-4 bg-slate-50 border border-slate-200 rounded-xl grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
                                    <div>
                                        <span className="text-xs text-steel block">Warung / Merchant:</span>
                                        <span className="font-bold text-ink text-base">{warungName}</span>
                                        <span className="text-xs font-mono text-steel block">{item.WarungID} • Bulan Buku: {periodeBulan}</span>
                                    </div>
                                    <div className="sm:text-right">
                                        <span className="text-xs text-steel block">Total Pengajuan (Kotor):</span>
                                        <span className="font-black text-ink text-xl">Rp {totalDana.toLocaleString('id-ID')}</span>
                                    </div>
                                </div>

                                {/* Status Kewajiban Bulan Ini */}
                                <div className="p-4 bg-blue-50/70 border border-blue-200 rounded-xl space-y-2">
                                    <div className="flex justify-between items-center text-xs font-bold text-blue-900">
                                        <span className="flex items-center gap-1.5"><Store className="w-3.5 h-3.5" /> Tanggungan Warung Bulan Ini:</span>
                                        <span>Target Total: Rp {monthlyStatus.targetTotal.toLocaleString('id-ID')}</span>
                                    </div>
                                    <div className="grid grid-cols-2 gap-2 text-xs">
                                        <div className="bg-white p-2.5 rounded-lg border border-blue-100">
                                            <span className="text-steel block">Sewa Aplikasi:</span>
                                            <span className="font-semibold text-ink">Rp {monthlyStatus.terbayarAplikasi.toLocaleString('id-ID')} / Rp {monthlyStatus.targetAplikasi.toLocaleString('id-ID')}</span>
                                            <span className="block text-[10px] text-amber-700 mt-0.5">Sisa: Rp {monthlyStatus.sisaAplikasi.toLocaleString('id-ID')}</span>
                                        </div>
                                        <div className="bg-white p-2.5 rounded-lg border border-blue-100">
                                            <span className="text-steel block">Iuran Kader:</span>
                                            <span className="font-semibold text-ink">Rp {monthlyStatus.terbayarKader.toLocaleString('id-ID')} / Rp {monthlyStatus.targetKader.toLocaleString('id-ID')}</span>
                                            <span className="block text-[10px] text-amber-700 mt-0.5">Sisa: Rp {monthlyStatus.sisaKader.toLocaleString('id-ID')}</span>
                                        </div>
                                    </div>
                                </div>

                                {/* Form Input Pemotongan Bertahap */}
                                <div className="p-4 bg-surface border border-whisper rounded-xl space-y-3">
                                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                                        <label className="text-sm font-bold text-ink flex items-center gap-1.5">
                                            <BadgePercent className="w-4 h-4 text-emerald-600" /> Pemotongan Kali Ini:
                                        </label>
                                        <div className="flex flex-wrap items-center gap-1.5 text-xs">
                                            <button 
                                                type="button" 
                                                onClick={() => setModalProsesPencairan(prev => ({
                                                    ...prev,
                                                    potongAplikasi: safeCalc.potongAplikasi,
                                                    potongKader: safeCalc.potongKader
                                                }))}
                                                className="px-2.5 py-1 rounded-md bg-blue-50 text-blue-700 font-medium border border-blue-200 hover:bg-blue-100 text-[11px]"
                                            >
                                                50% Rekomendasi Aman
                                            </button>
                                            <button 
                                                type="button" 
                                                onClick={() => {
                                                    const maxPotong = Math.min(totalDana, monthlyStatus.totalSisa);
                                                    const potApp = Math.min(monthlyStatus.sisaAplikasi, maxPotong);
                                                    const potKdr = Math.min(monthlyStatus.sisaKader, maxPotong - potApp);
                                                    setModalProsesPencairan(prev => ({
                                                        ...prev,
                                                        potongAplikasi: potApp,
                                                        potongKader: potKdr
                                                    }));
                                                }}
                                                className="px-2.5 py-1 rounded-md bg-purple-50 text-purple-700 font-medium border border-purple-200 hover:bg-purple-100 text-[11px]"
                                            >
                                                Lunas Penuh
                                            </button>
                                            <button 
                                                type="button" 
                                                onClick={() => setModalProsesPencairan(prev => ({ ...prev, potongAplikasi: 0, potongKader: 0 }))}
                                                className="px-2.5 py-1 rounded-md bg-slate-100 text-slate-700 font-medium border border-slate-200 hover:bg-slate-200 text-[11px]"
                                            >
                                                Nol (0%)
                                            </button>
                                        </div>
                                    </div>
                                    <p className="text-[11px] text-steel">
                                        Rekomendasi sistem membatasi potongan maksimal 50% (Rp {safeCalc.maxDeduct.toLocaleString('id-ID')}) agar modal kerja warung tetap aman.
                                    </p>

                                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
                                        <div>
                                            <label className="block text-xs font-semibold text-slate-700 mb-1">
                                                Potongan Sewa Aplikasi (Rp)
                                            </label>
                                            <input 
                                                type="number"
                                                min="0"
                                                max={monthlyStatus.sisaAplikasi}
                                                value={modalProsesPencairan.potongAplikasi}
                                                onChange={(e) => setModalProsesPencairan(prev => ({ ...prev, potongAplikasi: e.target.value }))}
                                                className={inputBase}
                                            />
                                            <span className="text-[10px] text-steel mt-0.5 block">Sisa tagihan aplikasi: Rp {monthlyStatus.sisaAplikasi.toLocaleString('id-ID')}</span>
                                        </div>
                                        <div>
                                            <label className="block text-xs font-semibold text-slate-700 mb-1">
                                                Potongan Iuran Kader (Rp)
                                            </label>
                                            <input 
                                                type="number"
                                                min="0"
                                                max={monthlyStatus.sisaKader}
                                                value={modalProsesPencairan.potongKader}
                                                onChange={(e) => setModalProsesPencairan(prev => ({ ...prev, potongKader: e.target.value }))}
                                                className={inputBase}
                                            />
                                            <span className="text-[10px] text-steel mt-0.5 block">Sisa tagihan kader: Rp {monthlyStatus.sisaKader.toLocaleString('id-ID')}</span>
                                        </div>
                                    </div>

                                    {/* Hasil Kalkulasi Bersih */}
                                    <div className="p-3 bg-emerald-50/80 border border-emerald-200 rounded-xl space-y-2 mt-2">
                                        <div className="flex justify-between items-center text-xs">
                                            <span className="text-slate-600">Total Pengajuan Kotor:</span>
                                            <span className="font-semibold text-ink">Rp {totalDana.toLocaleString('id-ID')}</span>
                                        </div>
                                        <div className="flex justify-between items-center text-xs">
                                            <span className="text-slate-600">Total Potongan (Aplikasi + Kader):</span>
                                            <span className="font-bold text-rose-600">-Rp {totalPot.toLocaleString('id-ID')}</span>
                                        </div>
                                        <div className="flex justify-between items-center text-sm pt-2 border-t border-emerald-200 font-bold">
                                            <span className="text-emerald-900">DANA BERSIH DITERIMA WARUNG:</span>
                                            <span className="text-xl text-emerald-700 font-black">Rp {totalBersih.toLocaleString('id-ID')}</span>
                                        </div>
                                        <div className="text-[11px] text-emerald-800/80 pt-1">
                                            Sisa tanggungan setelah transaksi: Aplikasi Rp {sisaAplikasiNanti.toLocaleString('id-ID')} • Kader Rp {sisaKaderNanti.toLocaleString('id-ID')}
                                        </div>
                                    </div>
                                </div>

                                {/* Opsi Catat ke Buku Kas & Catatan */}
                                <div className="space-y-3 pt-1">
                                    <label className="flex items-start gap-2.5 text-xs text-ink cursor-pointer bg-slate-50 p-3 rounded-xl border border-whisper">
                                        <input 
                                            type="checkbox"
                                            checked={modalProsesPencairan.catatBukuKas}
                                            onChange={(e) => setModalProsesPencairan(prev => ({ ...prev, catatBukuKas: e.target.checked }))}
                                            className="w-4 h-4 mt-0.5 text-accent rounded border-whisper"
                                        />
                                        <div>
                                            <span className="font-bold block">Otomatis Catat ke Buku Kas</span>
                                            <span className="text-steel text-[11px] block">
                                                Mencatat pengeluaran bersih ke warung (Rp {totalBersih.toLocaleString('id-ID')}) serta mencatat kas masuk untuk sewa aplikasi & titipan kader.
                                            </span>
                                        </div>
                                    </label>
                                    <div>
                                        <label className="block text-xs font-semibold text-slate-700 mb-1">Catatan Tambahan (Opsional)</label>
                                        <input 
                                            type="text" 
                                            placeholder="Contoh: Pencairan termin 1 via transfer Mandiri..." 
                                            value={modalProsesPencairan.catatan || ''}
                                            onChange={(e) => setModalProsesPencairan(prev => ({ ...prev, catatan: e.target.value }))}
                                            className={inputBase}
                                        />
                                    </div>
                                </div>
                            </div>
                        </FormWrapper>
                    );
                })()}

                {/* MODAL SUKSES PENCAIRAN & STRUK WHATSAPP */}
                {modalSuksesPencairan && (() => {
                    const { history, warungName } = modalSuksesPencairan;
                    return (
                        <FormWrapper 
                            title="Pencairan Berhasil Diproses!" 
                            onClose={() => setModalSuksesPencairan(null)}
                            customFooter={
                                <div className="px-6 py-4 bg-canvas border-t border-whisper flex justify-between items-center gap-3 shrink-0 rounded-b-card w-full">
                                    <button 
                                        type="button" 
                                        onClick={() => handleCopyWhatsAppStruk(history, warungName)}
                                        className="px-4 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-sm rounded-xl flex items-center gap-2 shadow-sm"
                                    >
                                        <Copy className="w-4 h-4" /> Salin Format WhatsApp
                                    </button>
                                    <button 
                                        type="button" 
                                        onClick={() => setModalSuksesPencairan(null)} 
                                        className={btnOutline}
                                    >
                                        Tutup
                                    </button>
                                </div>
                            }
                        >
                            <div className="space-y-4 text-center py-2">
                                <div className="w-14 h-14 bg-emerald-100 text-emerald-600 rounded-full flex items-center justify-center mx-auto mb-1">
                                    <CheckCircle2 className="w-8 h-8" />
                                </div>
                                <h3 className="text-xl font-black text-ink">Dana Berhasil Dicairkan</h3>
                                <p className="text-xs text-steel">Status pencairan telah diperbarui menjadi Selesai dan pemotongan kewajiban MOU telah tercatat.</p>

                                <div className="bg-slate-50 border border-whisper rounded-xl p-4 text-left space-y-2.5 text-xs font-mono">
                                    <div className="flex justify-between border-b border-whisper pb-2">
                                        <span className="text-steel">ID Pencairan:</span>
                                        <span className="font-bold text-ink">{history.idPencairan}</span>
                                    </div>
                                    <div className="flex justify-between border-b border-whisper pb-2">
                                        <span className="text-steel">Warung:</span>
                                        <span className="font-bold text-ink">{warungName}</span>
                                    </div>
                                    <div className="flex justify-between">
                                        <span className="text-steel">Pengajuan Kotor:</span>
                                        <span className="font-bold text-ink">Rp {Number(history.totalKotor || 0).toLocaleString('id-ID')}</span>
                                    </div>
                                    <div className="flex justify-between text-rose-600">
                                        <span>Potongan Aplikasi:</span>
                                        <span>-Rp {Number(history.potonganAplikasi || 0).toLocaleString('id-ID')}</span>
                                    </div>
                                    <div className="flex justify-between text-rose-600">
                                        <span>Potongan Kader:</span>
                                        <span>-Rp {Number(history.potonganKader || 0).toLocaleString('id-ID')}</span>
                                    </div>
                                    <div className="flex justify-between text-sm font-bold border-t border-whisper pt-2 text-emerald-700">
                                        <span>DANA BERSIH TRANSFER:</span>
                                        <span>Rp {Number(history.totalBersih || 0).toLocaleString('id-ID')}</span>
                                    </div>
                                    <div className="flex justify-between text-[11px] text-steel border-t border-dashed border-whisper pt-2">
                                        <span>Sisa Tanggungan Bulan Ini:</span>
                                        <span>Rp {(Number(history.sisaAplikasiSetelah || 0) + Number(history.sisaKaderSetelah || 0)).toLocaleString('id-ID')}</span>
                                    </div>
                                </div>
                            </div>
                        </FormWrapper>
                    );
                })()}

                {/* MODAL CONFIG MOU */}
                {modalConfigMOU && (
                    <FormWrapper 
                        title="Pengaturan Biaya Kewajiban Warung (MOU)" 
                        onClose={() => setModalConfigMOU(null)}
                        onSubmit={handleSaveConfigMOU}
                    >
                        <div className="space-y-4">
                            <p className="text-xs text-steel">
                                Tentukan nilai standar kewajiban bulanan dan batas aman pemotongan per pencairan untuk seluruh warung.
                            </p>
                            <div>
                                <label className="block text-sm font-medium text-ink mb-1">Biaya Sewa Aplikasi (Rp / Bulan)</label>
                                <input 
                                    type="number"
                                    min="0"
                                    required
                                    value={modalConfigMOU.biayaAplikasi ?? 30000}
                                    onChange={(e) => setModalConfigMOU(prev => ({ ...prev, biayaAplikasi: Number(e.target.value) }))}
                                    className={inputBase}
                                />
                                <span className="text-[11px] text-steel mt-0.5 block">Standar MOU: Rp 30.000 / bulan.</span>
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-ink mb-1">Biaya Kader / Pendamping (Rp / Bulan)</label>
                                <input 
                                    type="number"
                                    min="0"
                                    required
                                    value={modalConfigMOU.biayaKader ?? 200000}
                                    onChange={(e) => setModalConfigMOU(prev => ({ ...prev, biayaKader: Number(e.target.value) }))}
                                    className={inputBase}
                                />
                                <span className="text-[11px] text-steel mt-0.5 block">Standar MOU: Rp 200.000 / bulan.</span>
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-ink mb-1">Maksimal Pemotongan per Pencairan (%)</label>
                                <input 
                                    type="number"
                                    min="1"
                                    max="100"
                                    required
                                    value={modalConfigMOU.maxPotongPersen ?? 50}
                                    onChange={(e) => setModalConfigMOU(prev => ({ ...prev, maxPotongPersen: Number(e.target.value) }))}
                                    className={inputBase}
                                />
                                <span className="text-[11px] text-steel mt-0.5 block">
                                    Standar rekomendasi: 50% (agar warung kecil tetap memegang minimal 50% dari uang pengajuannya untuk belanja modal).
                                </span>
                            </div>

                            {/* Pengaturan Khusus per Warung */}
                            <div className="pt-3 border-t border-whisper">
                                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-1 mb-2">
                                    <div>
                                        <label className="block text-sm font-semibold text-ink">Pengaturan Khusus per Warung (Honor Kader)</label>
                                        <span className="text-[11px] text-steel">Tiap warung bisa disetting berbeda sesuai kesepakatan</span>
                                    </div>
                                    <span className="text-[11px] text-slate-500 italic">Kosong = pakai standar umum</span>
                                </div>
                                <div className="space-y-2 max-h-56 overflow-y-auto pr-1">
                                    {(dataWarung || []).map(w => {
                                        const wId = String(w.ID || w.id);
                                        const wName = w.Nama || w.nama || wId;
                                        const currentVal = modalConfigMOU.warungConfig?.[wId]?.biayaKader ?? '';
                                        return (
                                            <div key={wId} className="flex items-center justify-between gap-3 p-2.5 rounded-lg border border-whisper bg-canvas hover:bg-surface transition-colors">
                                                <div className="min-w-0 flex-1">
                                                    <div className="text-xs font-bold text-ink truncate">{wName}</div>
                                                    <div className="text-[10px] text-steel truncate">{w.Lokasi || w.lokasi ? `${w.Lokasi || w.lokasi} • ` : ''}PJ: {w.PJ || w.pj || '-'}</div>
                                                </div>
                                                <div className="relative w-44 shrink-0">
                                                    <span className="absolute left-2.5 top-2 text-xs text-steel">Rp</span>
                                                    <input 
                                                        type="number"
                                                        min="0"
                                                        placeholder={`Standar: ${(modalConfigMOU.biayaKader ?? 200000).toLocaleString('id-ID')}`}
                                                        value={currentVal}
                                                        onChange={(e) => {
                                                            const val = e.target.value === '' ? undefined : Number(e.target.value);
                                                            setModalConfigMOU(prev => {
                                                                const wc = { ...(prev.warungConfig || {}) };
                                                                if (val === undefined || isNaN(val)) {
                                                                    if (wc[wId]) {
                                                                        const copy = { ...wc[wId] };
                                                                        delete copy.biayaKader;
                                                                        if (Object.keys(copy).length === 0) delete wc[wId];
                                                                        else wc[wId] = copy;
                                                                    }
                                                                } else {
                                                                    wc[wId] = { ...(wc[wId] || {}), biayaKader: val };
                                                                }
                                                                return { ...prev, warungConfig: wc };
                                                            });
                                                        }}
                                                        className={`${inputBase} pl-8 py-1.5 text-xs font-semibold`}
                                                    />
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            </div>
                        </div>
                    </FormWrapper>
                )}
                </>) : (
                    /* Sub-tab: Rekap Transaksi per Warung */
                    <div className="space-y-4">
                        {/* Periode Filter */}
                        <div className="bg-surface border border-whisper rounded-card p-4 shadow-sm flex flex-col xl:flex-row items-start xl:items-center justify-between gap-4">
                            <div className="flex items-center gap-3">
                                <div className="w-10 h-10 rounded-xl bg-accent/10 text-accent flex items-center justify-center shrink-0">
                                    <CalendarDays className="w-5 h-5" />
                                </div>
                                <div>
                                    <div className="text-sm font-bold text-ink">Periode Rekap Transaksi</div>
                                    <div className="text-xs text-steel mt-0.5">
                                        {rekapPeriode === 'harian' && `Hari Ini (${formatDateID(rekapStartDate)})`}
                                        {rekapPeriode === 'mingguan' && `Minggu Ini (${formatDateID(rekapStartDate)} s/d ${formatDateID(rekapEndDate)})`}
                                        {rekapPeriode === 'bulanan' && `Bulan Ini (${formatDateID(rekapStartDate)} s/d ${formatDateID(rekapEndDate)})`}
                                        {rekapPeriode === 'custom' && `Rentang Tanggal (${formatDateID(rekapStartDate)} s/d ${formatDateID(rekapEndDate)})`}
                                    </div>
                                </div>
                            </div>

                            <div className="flex flex-wrap items-center gap-2.5 w-full xl:w-auto">
                                {/* Preset Buttons */}
                                <div className="flex flex-wrap items-center gap-1 p-1 bg-canvas border border-whisper rounded-xl">
                                    {[
                                        { id: 'harian', label: 'Hari Ini' },
                                        { id: 'mingguan', label: 'Minggu Ini' },
                                        { id: 'bulanan', label: 'Bulan Ini' },
                                        { id: 'custom', label: 'Rentang Tanggal' }
                                    ].map(p => (
                                        <button 
                                            key={p.id} 
                                            onClick={() => handleSelectPeriodePreset(p.id)}
                                            className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${rekapPeriode === p.id ? 'bg-accent text-white shadow-sm' : 'text-steel hover:text-ink'}`}
                                        >
                                            {p.label}
                                        </button>
                                    ))}
                                </div>

                                {/* Date-to-Date Inputs */}
                                <div className="flex flex-wrap items-center gap-2 bg-canvas px-3 py-1.5 border border-whisper rounded-xl text-xs w-full sm:w-auto">
                                    <span className="text-steel font-medium shrink-0">Dari:</span>
                                    <input 
                                        type="date" 
                                        value={rekapStartDate} 
                                        onChange={(e) => {
                                            setRekapStartDate(e.target.value);
                                            setRekapPeriode('custom');
                                        }}
                                        className="bg-surface border border-whisper rounded-lg px-2 py-1 text-ink text-xs focus:outline-none focus:border-accent"
                                    />
                                    <span className="text-steel font-medium shrink-0">s/d</span>
                                    <input 
                                        type="date" 
                                        value={rekapEndDate} 
                                        onChange={(e) => {
                                            setRekapEndDate(e.target.value);
                                            setRekapPeriode('custom');
                                        }}
                                        className="bg-surface border border-whisper rounded-lg px-2 py-1 text-ink text-xs focus:outline-none focus:border-accent"
                                    />
                                    <button 
                                        onClick={() => fetchRekapPerWarung('custom', rekapStartDate, rekapEndDate)}
                                        className="bg-accent hover:bg-accentDark active:scale-95 text-white px-3 py-1 rounded-lg font-semibold flex items-center gap-1 shadow-sm transition-all shrink-0"
                                        title="Terapkan Filter Tanggal"
                                    >
                                        <Filter className="w-3.5 h-3.5" /> Filter
                                    </button>
                                </div>
                            </div>
                        </div>

                        {loadingRekap ? (
                            <div className="text-center py-12 text-steel"><RefreshCw className="w-5 h-5 animate-spin inline mr-2" />Memuat rekap transaksi per warung...</div>
                        ) : rekapData.length === 0 ? (
                            <div className="bg-surface border border-whisper rounded-card p-8 shadow-sm text-center">
                                <Store className="w-12 h-12 text-whisper mx-auto mb-3" />
                                <div className="font-semibold text-ink">Belum Ada Transaksi</div>
                                <div className="text-sm text-steel mt-1">Tidak ada transaksi warung pada periode {rekapPeriode === 'custom' ? `${formatDateID(rekapStartDate)} s/d ${formatDateID(rekapEndDate)}` : (rekapPeriode === 'harian' ? 'hari ini' : rekapPeriode === 'mingguan' ? 'minggu ini' : 'bulan ini')}.</div>
                            </div>
                        ) : (
                            <>
                                {/* Summary KPI Cards */}
                                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                                    <div className="bg-surface border border-whisper p-5 rounded-2xl shadow-sm">
                                        <div className="flex items-center gap-3 mb-2">
                                            <div className="w-8 h-8 rounded-lg bg-blue-50 text-blue-600 flex items-center justify-center"><Store className="w-4 h-4" /></div>
                                            <span className="text-xs text-steel font-semibold uppercase">Total Warung Aktif</span>
                                        </div>
                                        <div className="text-xl font-bold text-ink">{rekapData.length} <span className="text-xs text-steel font-normal">warung</span></div>
                                    </div>
                                    <div className="bg-surface border border-whisper p-5 rounded-2xl shadow-sm">
                                        <div className="flex items-center gap-3 mb-2">
                                            <div className="w-8 h-8 rounded-lg bg-emerald-50 text-emerald-600 flex items-center justify-center"><ShoppingBag className="w-4 h-4" /></div>
                                            <span className="text-xs text-steel font-semibold uppercase">Total Transaksi</span>
                                        </div>
                                        <div className="text-xl font-bold text-emerald-600">{rekapData.reduce((s, w) => s + w.totalTransaksi, 0).toLocaleString('id-ID')} <span className="text-xs text-steel font-normal">transaksi</span></div>
                                    </div>
                                    <div className="bg-surface border border-whisper p-5 rounded-2xl shadow-sm">
                                        <div className="flex items-center gap-3 mb-2">
                                            <div className="w-8 h-8 rounded-lg bg-amber-50 text-amber-600 flex items-center justify-center"><Wallet className="w-4 h-4" /></div>
                                            <span className="text-xs text-steel font-semibold uppercase">Total Omzet</span>
                                        </div>
                                        <div className="text-xl font-bold text-amber-600">Rp {rekapData.reduce((s, w) => s + w.totalNominal, 0).toLocaleString('id-ID')}</div>
                                    </div>
                                </div>

                                {/* Rekap Table per Warung */}
                                <div className="bg-surface border border-whisper rounded-card shadow-sm overflow-hidden">
                                    <div className="overflow-x-auto">
                                        <table className="w-full text-sm text-left">
                                            <thead className="bg-canvas/60 text-steel border-b border-whisper/50">
                                                <tr>
                                                    <th className="px-5 py-3 font-medium">Warung / Merchant</th>
                                                    <th className="px-5 py-3 text-center font-medium">Jumlah Transaksi</th>
                                                    <th className="px-5 py-3 text-right font-medium">Total Omzet</th>
                                                    <th className="px-5 py-3 text-center font-medium">Detail</th>
                                                </tr>
                                            </thead>
                                            <tbody className="divide-y divide-slate-100">
                                                {rekapData.map((w) => {
                                                    const isExpanded = rekapExpandedWarung === w.warungId;
                                                    const subView = rekapWarungSubTab[w.warungId] || 'santri';
                                                    const searchKwd = (rekapSearchSantri[w.warungId] || '').toLowerCase();
                                                    const filterTgl = rekapFilterTanggal[w.warungId] || 'ALL';
                                                    const pageSantri = rekapPagePerWarung[w.warungId] || 1;
                                                    const itemsPerPageSantri = 10;

                                                    // Filter daftar transaksi untuk santri
                                                    const allTrx = w.transaksiList || [];
                                                    const filteredTrx = allTrx.filter(trx => {
                                                        const matchSearch = 
                                                            (trx.santriNama || '').toLowerCase().includes(searchKwd) ||
                                                            String(trx.santriNis || '').includes(searchKwd) ||
                                                            String(trx.santriKelas || '').toLowerCase().includes(searchKwd) ||
                                                            (trx.itemSummary || '').toLowerCase().includes(searchKwd) ||
                                                            String(trx.TrxID || '').toLowerCase().includes(searchKwd);
                                                        
                                                        const trxDate = trx.Waktu ? new Date(trx.Waktu) : null;
                                                        const tglStr = trxDate && !isNaN(trxDate.getTime()) 
                                                            ? `${trxDate.getFullYear()}-${String(trxDate.getMonth() + 1).padStart(2, '0')}-${String(trxDate.getDate()).padStart(2, '0')}`
                                                            : (trx.Waktu ? trx.Waktu.split('T')[0] : '');

                                                        const matchDate = filterTgl === 'ALL' || tglStr === filterTgl;
                                                        return matchSearch && matchDate;
                                                    });

                                                    const totalPagesSantri = Math.max(1, Math.ceil(filteredTrx.length / itemsPerPageSantri));
                                                    const paginatedTrx = filteredTrx.slice((pageSantri - 1) * itemsPerPageSantri, pageSantri * itemsPerPageSantri);

                                                    return (
                                                        <React.Fragment key={w.warungId}>
                                                            <tr className="bg-surface hover:bg-canvas/80 transition-colors cursor-pointer" onClick={() => setRekapExpandedWarung(isExpanded ? null : w.warungId)}>
                                                                <td className="px-5 py-4">
                                                                    <div className="font-semibold text-ink flex items-center gap-2">
                                                                        <Store className="w-4 h-4 text-accent shrink-0" />
                                                                        {w.warungName}
                                                                    </div>
                                                                    <div className="text-[11px] text-steel font-mono ml-6">ID: {w.warungId}</div>
                                                                </td>
                                                                <td className="px-5 py-4 text-center">
                                                                    <span className="inline-flex items-center px-3 py-1 bg-blue-50 text-blue-700 font-bold rounded-full text-sm">{w.totalTransaksi}</span>
                                                                </td>
                                                                <td className="px-5 py-4 text-right">
                                                                    <span className="font-bold text-ink text-base">Rp {w.totalNominal.toLocaleString('id-ID')}</span>
                                                                </td>
                                                                <td className="px-5 py-4 text-center">
                                                                    <button className="p-1.5 text-steel hover:text-accent hover:bg-canvas rounded-lg transition-colors" title="Buka / Tutup Rincian">
                                                                        {isExpanded ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                                                                    </button>
                                                                </td>
                                                            </tr>
                                                            {isExpanded && (
                                                                <tr>
                                                                    <td colSpan="4" className="bg-slate-50/80 px-4 sm:px-6 py-4 border-y border-whisper">
                                                                        <div className="space-y-3">
                                                                            {/* Header Rincian & Tab Switcher */}
                                                                            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-whisper">
                                                                                <div className="flex items-center gap-2">
                                                                                    <button 
                                                                                        onClick={() => setRekapWarungSubTab(prev => ({ ...prev, [w.warungId]: 'santri' }))}
                                                                                        className={`px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-all ${subView === 'santri' ? 'bg-accent text-white shadow-sm' : 'bg-canvas text-steel hover:text-ink border border-whisper'}`}
                                                                                    >
                                                                                        <ShoppingBag className="w-3.5 h-3.5" /> Rincian Pembelian Santri ({w.totalTransaksi})
                                                                                    </button>
                                                                                    <button 
                                                                                        onClick={() => setRekapWarungSubTab(prev => ({ ...prev, [w.warungId]: 'hari' }))}
                                                                                        className={`px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-all ${subView === 'hari' ? 'bg-accent text-white shadow-sm' : 'bg-canvas text-steel hover:text-ink border border-whisper'}`}
                                                                                    >
                                                                                        <CalendarDays className="w-3.5 h-3.5" /> Ringkasan per Hari ({Object.keys(w.perHari).length})
                                                                                    </button>
                                                                                </div>
                                                                                <div className="text-xs text-steel font-medium">
                                                                                    Merchant: <span className="font-bold text-ink">{w.warungName}</span>
                                                                                </div>
                                                                            </div>

                                                                            {/* View 1: Rincian Pembelian Santri */}
                                                                            {subView === 'santri' && (
                                                                                <div className="space-y-3 animate-fade-in-up">
                                                                                    {/* Filter Bar Santri */}
                                                                                    <div className="flex flex-col sm:flex-row items-center justify-between gap-2.5">
                                                                                        <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto">
                                                                                            {/* Dropdown Filter Tanggal */}
                                                                                            <select 
                                                                                                value={filterTgl} 
                                                                                                onChange={(e) => {
                                                                                                    setRekapFilterTanggal(prev => ({ ...prev, [w.warungId]: e.target.value }));
                                                                                                    setRekapPagePerWarung(prev => ({ ...prev, [w.warungId]: 1 }));
                                                                                                }}
                                                                                                className="bg-surface border border-whisper rounded-lg px-2.5 py-1.5 text-xs text-ink focus:outline-none focus:border-accent"
                                                                                            >
                                                                                                <option value="ALL">Semua Tanggal ({allTrx.length} trx)</option>
                                                                                                {Object.entries(w.perHari).sort(([a], [b]) => b.localeCompare(a)).map(([tgl, data]) => (
                                                                                                    <option key={tgl} value={tgl}>{formatDateID(tgl)} ({data.count} trx)</option>
                                                                                                ))}
                                                                                            </select>

                                                                                            {/* Search Santri / Produk */}
                                                                                            <div className="relative flex-1 sm:w-64">
                                                                                                <Search className="w-3.5 h-3.5 absolute left-2.5 top-2.5 text-steel" />
                                                                                                <input 
                                                                                                    type="text" 
                                                                                                    placeholder="Cari santri, NIS, kelas, produk..." 
                                                                                                    value={rekapSearchSantri[w.warungId] || ''}
                                                                                                    onChange={(e) => {
                                                                                                        setRekapSearchSantri(prev => ({ ...prev, [w.warungId]: e.target.value }));
                                                                                                        setRekapPagePerWarung(prev => ({ ...prev, [w.warungId]: 1 }));
                                                                                                    }}
                                                                                                    className="w-full bg-surface border border-whisper rounded-lg pl-8 pr-3 py-1.5 text-xs text-ink focus:outline-none focus:border-accent"
                                                                                                />
                                                                                            </div>
                                                                                        </div>

                                                                                        <div className="text-xs text-steel font-medium shrink-0 self-end sm:self-center">
                                                                                            Ditemukan: <strong className="text-ink">{filteredTrx.length}</strong> transaksi (Rp {filteredTrx.reduce((s, t) => s + Number(t.TotalHarga || 0), 0).toLocaleString('id-ID')})
                                                                                        </div>
                                                                                    </div>

                                                                                    {/* Tabel Transaksi Santri */}
                                                                                    {filteredTrx.length === 0 ? (
                                                                                        <div className="text-center py-6 text-steel text-xs bg-surface border border-dashed border-whisper rounded-xl">
                                                                                            Tidak ada transaksi santri yang sesuai filter.
                                                                                        </div>
                                                                                    ) : (
                                                                                        <div className="overflow-x-auto border border-whisper rounded-xl bg-surface shadow-xs">
                                                                                            <table className="w-full text-xs">
                                                                                                <thead className="bg-canvas/70 border-b border-whisper text-steel font-medium">
                                                                                                    <tr>
                                                                                                        <th className="py-2.5 px-3 text-left">Waktu</th>
                                                                                                        <th className="py-2.5 px-3 text-left">Santri</th>
                                                                                                        <th className="py-2.5 px-3 text-left">Item yang Dibeli</th>
                                                                                                        <th className="py-2.5 px-3 text-center">Metode</th>
                                                                                                        <th className="py-2.5 px-3 text-right">Total Belanja</th>
                                                                                                        <th className="py-2.5 px-3 text-center">Struk</th>
                                                                                                    </tr>
                                                                                                </thead>
                                                                                                <tbody className="divide-y divide-whisper/50">
                                                                                                    {paginatedTrx.map((trx) => (
                                                                                                        <tr key={trx.TrxID} className="hover:bg-canvas/40 transition-colors">
                                                                                                            <td className="py-2.5 px-3 whitespace-nowrap">
                                                                                                                <div className="font-medium text-ink">{trx.Waktu ? formatDateTimeID(trx.Waktu) : '-'}</div>
                                                                                                                <div className="text-[10px] text-steel font-mono">{trx.TrxID}</div>
                                                                                                            </td>
                                                                                                            <td className="py-2.5 px-3">
                                                                                                                <div className="font-bold text-ink text-xs">{trx.santriNama}</div>
                                                                                                                <div className="text-[11px] text-steel">
                                                                                                                    {trx.santriNis !== '-' && <span>NIS: {trx.santriNis}</span>}
                                                                                                                    {trx.santriKelas !== '-' && <span className="ml-1.5">• Kelas: {trx.santriKelas}</span>}
                                                                                                                </div>
                                                                                                            </td>
                                                                                                            <td className="py-2.5 px-3">
                                                                                                                {trx.items && trx.items.length > 0 ? (
                                                                                                                    <div className="flex flex-wrap gap-1 max-w-sm">
                                                                                                                        {trx.items.map((item, iIdx) => (
                                                                                                                            <span key={iIdx} className="inline-flex items-center gap-1 px-2 py-0.5 bg-canvas border border-whisper rounded text-[11px] text-ink">
                                                                                                                                <span className="font-medium">{item.NamaProduk}</span>
                                                                                                                                <span className="text-accent font-semibold">{item.Kuantitas}x</span>
                                                                                                                            </span>
                                                                                                                        ))}
                                                                                                                    </div>
                                                                                                                ) : (
                                                                                                                    <span className="text-steel italic text-[11px]">{trx.itemSummary || 'Item tidak tercatat'}</span>
                                                                                                                )}
                                                                                                            </td>
                                                                                                            <td className="py-2.5 px-3 text-center whitespace-nowrap">
                                                                                                                <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold ${
                                                                                                                    trx.Metode === 'Tabungan' 
                                                                                                                        ? 'bg-blue-50 text-blue-700 border border-blue-200' 
                                                                                                                        : trx.Metode === 'Tunai' 
                                                                                                                        ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' 
                                                                                                                        : 'bg-canvas text-steel border border-whisper'
                                                                                                                }`}>
                                                                                                                    {trx.Metode || 'Tunai'}
                                                                                                                </span>
                                                                                                            </td>
                                                                                                            <td className="py-2.5 px-3 text-right font-bold text-ink whitespace-nowrap">
                                                                                                                Rp {Number(trx.TotalHarga || 0).toLocaleString('id-ID')}
                                                                                                            </td>
                                                                                                            <td className="py-2.5 px-3 text-center whitespace-nowrap">
                                                                                                                <button 
                                                                                                                    onClick={() => handleOpenTrxDetail(trx, w.warungName, w.warungId)}
                                                                                                                    className="p-1.5 text-steel hover:text-accent hover:bg-canvas rounded-lg transition-colors" 
                                                                                                                    title="Lihat Struk Pembelian"
                                                                                                                >
                                                                                                                    <Eye className="w-3.5 h-3.5" />
                                                                                                                </button>
                                                                                                            </td>
                                                                                                        </tr>
                                                                                                    ))}
                                                                                                </tbody>
                                                                                            </table>
                                                                                        </div>
                                                                                    )}

                                                                                    {/* Pagination Santri */}
                                                                                    {totalPagesSantri > 1 && (
                                                                                        <div className="flex items-center justify-between text-xs text-steel pt-2">
                                                                                            <div>Halaman {pageSantri} dari {totalPagesSantri}</div>
                                                                                            <div className="flex items-center gap-1.5">
                                                                                                <button 
                                                                                                    disabled={pageSantri <= 1}
                                                                                                    onClick={() => setRekapPagePerWarung(prev => ({ ...prev, [w.warungId]: pageSantri - 1 }))}
                                                                                                    className="px-2.5 py-1 bg-surface border border-whisper rounded-lg text-ink font-medium disabled:opacity-40 disabled:cursor-not-allowed hover:bg-canvas"
                                                                                                >
                                                                                                    Sebelumnya
                                                                                                </button>
                                                                                                <button 
                                                                                                    disabled={pageSantri >= totalPagesSantri}
                                                                                                    onClick={() => setRekapPagePerWarung(prev => ({ ...prev, [w.warungId]: pageSantri + 1 }))}
                                                                                                    className="px-2.5 py-1 bg-surface border border-whisper rounded-lg text-ink font-medium disabled:opacity-40 disabled:cursor-not-allowed hover:bg-canvas"
                                                                                                >
                                                                                                    Selanjutnya
                                                                                                </button>
                                                                                            </div>
                                                                                        </div>
                                                                                    )}
                                                                                </div>
                                                                            )}

                                                                            {/* View 2: Ringkasan per Hari */}
                                                                            {subView === 'hari' && (
                                                                                <div className="space-y-2 animate-fade-in-up">
                                                                                    <div className="overflow-x-auto border border-whisper rounded-xl bg-surface shadow-xs">
                                                                                        <table className="w-full text-xs">
                                                                                            <thead className="bg-canvas/70 border-b border-whisper text-steel font-medium">
                                                                                                <tr>
                                                                                                    <th className="py-2.5 px-3 text-left font-medium">Tanggal</th>
                                                                                                    <th className="py-2.5 px-3 text-center font-medium">Jumlah Transaksi</th>
                                                                                                    <th className="py-2.5 px-3 text-right font-medium">Total Omzet</th>
                                                                                                    <th className="py-2.5 px-3 text-center font-medium">Aksi</th>
                                                                                                </tr>
                                                                                            </thead>
                                                                                            <tbody className="divide-y divide-whisper/50">
                                                                                                {Object.entries(w.perHari).sort(([a], [b]) => b.localeCompare(a)).map(([tgl, data]) => (
                                                                                                    <tr key={tgl} className="hover:bg-canvas/40 transition-colors">
                                                                                                        <td className="py-2.5 px-3 font-medium text-ink">{formatDateID(tgl)}</td>
                                                                                                        <td className="py-2.5 px-3 text-center text-steel font-medium">{data.count} transaksi</td>
                                                                                                        <td className="py-2.5 px-3 text-right font-bold text-ink">Rp {data.total.toLocaleString('id-ID')}</td>
                                                                                                        <td className="py-2.5 px-3 text-center">
                                                                                                            <button 
                                                                                                                onClick={() => {
                                                                                                                    setRekapFilterTanggal(prev => ({ ...prev, [w.warungId]: tgl }));
                                                                                                                    setRekapWarungSubTab(prev => ({ ...prev, [w.warungId]: 'santri' }));
                                                                                                                    setRekapPagePerWarung(prev => ({ ...prev, [w.warungId]: 1 }));
                                                                                                                }}
                                                                                                                className="text-xs text-accent hover:underline font-semibold inline-flex items-center gap-1"
                                                                                                            >
                                                                                                                Lihat Santri ({data.count}) →
                                                                                                            </button>
                                                                                                        </td>
                                                                                                    </tr>
                                                                                                ))}
                                                                                            </tbody>
                                                                                        </table>
                                                                                    </div>
                                                                                </div>
                                                                            )}
                                                                        </div>
                                                                    </td>
                                                                </tr>
                                                            )}
                                                        </React.Fragment>
                                                    );
                                                })}
                                            </tbody>
                                        </table>
                                    </div>
                                </div>

                                {/* Unduh Rekap Buttons */}
                                <div className="flex flex-wrap items-center justify-end gap-3 pt-2">
                                    <button onClick={downloadRekapSummaryExcel} className={btnOutline}>
                                        <FileSpreadsheet className="w-4 h-4 text-accent" /> Unduh Ringkasan (Excel)
                                    </button>
                                    <button onClick={downloadRekapDetailSantriExcel} className={btnPrimary}>
                                        <Download className="w-4 h-4" /> Unduh Rincian Belanja Santri (Excel)
                                    </button>
                                </div>
                            </>
                        )}
                    </div>
                )}
            </div>
        );
    };


    const renderBukuKas = () => {
        const filtered = dataKas.filter(k => (k.keterangan || '').toLowerCase().includes(searchTerm.toLowerCase()) || (k.sumber || '').toLowerCase().includes(searchTerm.toLowerCase()) || (k.kategori || '').toLowerCase().includes(searchTerm.toLowerCase()));
        
        const itemsPerPage = 10;
        const totalPages = Math.ceil(filtered.length / itemsPerPage);
        const paginatedKas = filtered.slice((currentPage - 1) * itemsPerPage, currentPage * itemsPerPage);

        const filteredIds = paginatedKas.map(k => k.id);
        const allChecked = filteredIds.length > 0 && filteredIds.every(id => selectedIds.includes(id));
        return (
            <div className="space-y-6 animate-in fade-in duration-500">
                <div className="flex flex-col xl:flex-row justify-between items-start xl:items-center gap-4 mb-6 w-full">
                    <div className="flex-1 shrink-0"><h2 className="text-2xl font-semibold tracking-tight text-ink">Buku Kas (Lainnya)</h2><p className="text-sm text-steel">Catat pemasukan eksternal (BOS/Donatur) dan pengeluaran divisi.</p></div>
                    <div className="grid grid-cols-2 sm:flex sm:flex-wrap sm:justify-start xl:justify-end gap-3 w-full xl:w-auto shrink-0">
                        <button onClick={() => { setFormData({ newKategori: '', newKategoriType: 'pemasukan' }); setModalType('MASTER_KATEGORI_KAS'); }} className={btnOutline}><Settings className="w-4 h-4" /> Master Kategori</button>
                        <button onClick={() => { setFormData({ tipeKas: 'MASUK' }); setModalType('FORM_KAS'); }} className="bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg px-4 py-2 font-medium flex items-center gap-2 text-sm shadow-sm"><Plus className="w-4 h-4" /> Catat Pemasukan</button>
                        <button onClick={() => { setFormData({ tipeKas: 'KELUAR' }); setModalType('FORM_KAS'); }} className={btnPrimary}><Plus className="w-4 h-4" /> Catat Pengeluaran</button>
                        <button onClick={() => downloadStyledExcel('Buku Kas', ['ID', 'Tanggal', 'Tipe', 'Kategori', 'Sumber', 'Nominal', 'Keterangan'], dataKas.map(k => [k.id, k.tanggal, k.tipeKas, k.kategori, k.sumber, k.nominal, k.keterangan]), 'Buku_Kas')} className={btnOutline}><FileSpreadsheet className="w-4 h-4 text-accent" /> Unduh</button>
                    </div>
                </div>
                <div className="bg-surface border border-whisper shadow-sm rounded-card overflow-hidden">
                    <div className="p-4 border-b border-whisper/50 flex flex-col sm:flex-row justify-between sm:justify-end items-center gap-3 bg-canvas/40">
                        <div className="relative w-full sm:w-auto">
                            <Search className="w-4 h-4 absolute left-3 top-3 text-steel" />
                            <input type="text" placeholder="Cari keterangan/sumber/kategori..." value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} className={`${inputBase} pl-9 w-full sm:w-64`} />

                        </div>
                        {selectedIds.length > 0 && (
                            <button onClick={() => executeBulkDelete('KAS', setDataKas, 'kas')} className="w-full sm:w-auto px-4 py-2.5 bg-rose-50 text-rose-600 font-medium text-sm rounded-xl hover:bg-rose-100 flex items-center justify-center gap-2 border border-rose-200"><Trash2 className="w-4 h-4" /> Hapus ({selectedIds.length})</button>
                        )}
                    </div>
                    <div className="overflow-x-auto hidden md:block">
                        <table className="w-full text-sm text-left">
                            <thead className="bg-canvas/60 text-steel border-b border-whisper/50"><tr><th className="px-6 py-3 w-12 text-center"><input type="checkbox" checked={allChecked} onChange={() => toggleSelectAll(filteredIds)} className="w-4 h-4 rounded border-whisper text-accent cursor-pointer" /></th><th className="px-6 py-3">Tanggal</th><th className="px-6 py-3">Tipe & Kategori</th><th className="px-6 py-3">Keterangan / Sumber</th><th className="px-6 py-3 text-right">Nominal</th><th className="px-6 py-3 text-center">Aksi</th></tr></thead>
                            <tbody className="divide-y divide-slate-100">
                                {paginatedKas.length === 0 ? (
                                    <tr><td colSpan="100%" className="text-center py-8 text-steel">Belum ada catatan buku kas.</td></tr>
                                ) : paginatedKas.map((trx) => (
                                    <tr key={trx.id} className="bg-surface hover:bg-canvas">
                                        <td className="px-6 py-4 text-center"><input type="checkbox" checked={selectedIds.includes(trx.id)} onChange={() => toggleSelectId(trx.id)} className="w-4 h-4 rounded border-whisper text-accent cursor-pointer" /></td>
                                        <td className="px-6 py-4">{trx.tanggal}</td>
                                        <td className="px-6 py-4 flex items-center gap-2"><span className={`px-2 py-0.5 text-[10px] font-bold rounded uppercase ${trx.tipeKas === 'MASUK' ? 'bg-pale-green text-pale-greenText' : 'bg-pale-red text-pale-redText'}`}>{trx.tipeKas}</span> <span className="font-medium text-blue-700 bg-blue-50 px-2 py-0.5 rounded text-[10px] uppercase">{trx.kategori}</span></td>
                                        <td className="px-6 py-4 font-medium text-ink">{trx.sumber} <span className="block text-xs text-steel font-normal">{trx.keterangan}</span></td>
                                        <td className={`px-6 py-4 text-right font-medium ${trx.tipeKas === 'MASUK' ? 'text-emerald-600' : 'text-rose-600'}`}>{trx.tipeKas === 'MASUK' ? '+' : '-'} Rp {Number(trx.nominal || 0).toLocaleString('id-ID')}</td>
                                        <td className="px-6 py-4 text-center flex gap-3 justify-center">
                                            <button onClick={() => {
                                                const isPemasukan = trx.tipeKas === 'MASUK';
                                                const title = isPemasukan ? 'BUKTI KAS MASUK' : 'BUKTI KAS KELUAR';
                                                const subTitle = trx.kategori;
                                                const keterangan = trx.sumber;
                                                const htmlContent = `<html><head><title>Bukti Kas - ${trx.id}</title><style>body { font-family: 'Courier New', Courier, monospace; padding: 20px; color: #000; } .invoice-box { max-width: 450px; margin: auto; border: 1px solid #ddd; padding: 20px; border-radius: 8px; } .header { text-align: center; margin-bottom: 20px; border-bottom: 2px dashed #000; padding-bottom: 10px; } .header h2 { margin: 0; font-size: 20px; } .row { display: flex; justify-content: space-between; margin-bottom: 8px; font-size: 14px; } .desc { margin-top: 15px; padding: 15px; background: #f9f9f9; border: 1px solid #eee; font-size: 14px; line-height: 1.5; } .total { font-weight: bold; font-size: 18px; margin-top: 15px; text-align: right; border-top: 2px dashed #000; padding-top: 10px; } .footer { text-align: center; margin-top: 30px; font-size: 12px; color: #555; }</style></head><body><div class="invoice-box"><div class="header"><h2>${title}</h2><div>Pesantren Tech</div></div><div class="row"><span>ID Transaksi</span><span>${trx.id}</span></div><div class="row"><span>Tanggal</span><span>${trx.tanggal}</span></div><div class="row"><span>Kategori</span><span>${subTitle}</span></div><div class="desc"><strong>Keterangan / Sumber:</strong><br/>${keterangan}<br/><br/><em>Catatan Tambahan: ${trx.keterangan || '-'}</em></div><div class="total">NOMINAL: Rp ${(trx.nominal || 0).toLocaleString('id-ID')}</div><div class="footer">Dicetak oleh sistem pada ${formatDateTimeID(new Date())}</div></div></body></html>`;
                                                executePrint(htmlContent);
                                            }} className="text-blue-600 hover:text-blue-800" title="Cetak Bukti Kas"><Printer className="w-4 h-4" /></button>
                                            <button onClick={() => confirmDelete('KAS', trx.id, trx.sumber)} className="text-rose-600 hover:text-rose-800"><Trash2 className="w-4 h-4" /></button>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                    <div className="md:hidden flex flex-col divide-y divide-whisper/50">
                        {paginatedKas.length === 0 ? (
                            <div className="text-center py-8 text-steel text-sm">Belum ada catatan buku kas.</div>
                        ) : paginatedKas.map((trx) => (
                            <div key={trx.id} className={`p-4 flex flex-col gap-3 ${selectedIds.includes(trx.id) ? 'bg-accent/5' : 'bg-surface'}`}>
                                <div className="flex justify-between items-start gap-3">
                                    <div className="flex items-start gap-3 min-w-0">
                                        <input type="checkbox" checked={selectedIds.includes(trx.id)} onChange={() => toggleSelectId(trx.id)} className="w-4 h-4 mt-1 shrink-0 rounded border-whisper text-accent focus:ring-accent/30 cursor-pointer" />
                                        <div className="min-w-0">
                                            <div className="font-bold text-ink truncate text-sm">{trx.sumber}</div>
                                            <div className="text-[10px] text-steel mt-0.5">{trx.tanggal}</div>
                                            <div className="text-[10px] text-slate font-mono mt-1 line-clamp-2">{trx.keterangan}</div>
                                        </div>
                                    </div>
                                    <div className="text-right shrink-0">
                                        <div className={`text-sm font-bold ${trx.tipeKas === 'MASUK' ? 'text-emerald-600' : 'text-rose-600'}`}>{trx.tipeKas === 'MASUK' ? '+' : '-'} Rp {Number(trx.nominal || 0).toLocaleString('id-ID')}</div>
                                        <div className="mt-1 flex flex-col items-end gap-1">
                                            <span className={`inline-block px-1.5 py-0.5 text-[10px] font-bold rounded uppercase ${trx.tipeKas === 'MASUK' ? 'bg-pale-green text-pale-greenText' : 'bg-pale-red text-pale-redText'}`}>{trx.tipeKas}</span>
                                            <span className="font-medium text-blue-700 bg-blue-50 px-1.5 py-0.5 rounded text-[10px] uppercase">{trx.kategori}</span>
                                        </div>
                                    </div>
                                </div>
                                <div className="flex flex-wrap items-center gap-2 justify-end w-full border-t border-whisper/50 pt-3 mt-1">
                                    <button onClick={() => {
                                        const isPemasukan = trx.tipeKas === 'MASUK';
                                        const title = isPemasukan ? 'BUKTI KAS MASUK' : 'BUKTI KAS KELUAR';
                                        const subTitle = trx.kategori;
                                        const keterangan = trx.sumber;
                                        const htmlContent = `<html><head><title>Bukti Kas - ${trx.id}</title><style>body { font-family: 'Courier New', Courier, monospace; padding: 20px; color: #000; } .invoice-box { max-width: 450px; margin: auto; border: 1px solid #ddd; padding: 20px; border-radius: 8px; } .header { text-align: center; margin-bottom: 20px; border-bottom: 2px dashed #000; padding-bottom: 10px; } .header h2 { margin: 0; font-size: 20px; } .row { display: flex; justify-content: space-between; margin-bottom: 8px; font-size: 14px; } .desc { margin-top: 15px; padding: 15px; background: #f9f9f9; border: 1px solid #eee; font-size: 14px; line-height: 1.5; } .total { font-weight: bold; font-size: 18px; margin-top: 15px; text-align: right; border-top: 2px dashed #000; padding-top: 10px; } .footer { text-align: center; margin-top: 30px; font-size: 12px; color: #555; }</style></head><body><div class="invoice-box"><div class="header"><h2>${title}</h2><div>Pesantren Tech</div></div><div class="row"><span>ID Transaksi</span><span>${trx.id}</span></div><div class="row"><span>Tanggal</span><span>${trx.tanggal}</span></div><div class="row"><span>Kategori</span><span>${subTitle}</span></div><div class="desc"><strong>Keterangan / Sumber:</strong><br/>${keterangan}<br/><br/><em>Catatan Tambahan: ${trx.keterangan || '-'}</em></div><div class="total">NOMINAL: Rp ${(trx.nominal || 0).toLocaleString('id-ID')}</div><div class="footer">Dicetak oleh sistem pada ${formatDateTimeID(new Date())}</div></div></body></html>`;
                                        executePrint(htmlContent);
                                    }} className="flex items-center gap-1 text-steel bg-canvas hover:bg-whisper/50 font-bold text-xs px-3 py-1.5 rounded-lg border border-whisper"><Printer className="w-3.5 h-3.5" /> Cetak</button>
                                    <button onClick={() => confirmDelete('KAS', trx.id, trx.sumber)} className="flex items-center gap-1 text-danger bg-dangerBg hover:bg-red-100 font-medium text-xs px-3 py-1.5 rounded-lg border border-red-100"><Trash2 className="w-3.5 h-3.5" /> Hapus</button>
                                </div>
                            </div>
                        ))}
                    </div>
                    
                    {totalPages > 0 && (
                        <div className="flex justify-center items-center gap-4 p-4 border-t border-whisper/50 bg-canvas/30">
                            <button onClick={() => setCurrentPage(p => Math.max(1, p - 1))} disabled={currentPage === 1} className="px-3 py-1.5 text-sm font-medium border border-whisper rounded-lg bg-surface hover:bg-canvas disabled:opacity-50 disabled:cursor-not-allowed text-ink">Prev</button>
                            <span className="text-sm text-steel font-medium">Hal {currentPage} dari {totalPages}</span>
                            <button onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))} disabled={currentPage === totalPages} className="px-3 py-1.5 text-sm font-medium border border-whisper rounded-lg bg-surface hover:bg-canvas disabled:opacity-50 disabled:cursor-not-allowed text-ink">Next</button>
                        </div>
                    )}
                </div>
            </div>
        );
    };

    const renderLogAktivitas = () => {
        const itemsPerPage = 10;
        const totalPages = Math.ceil(dataLog.length / itemsPerPage);
        const paginatedLog = dataLog.slice((currentPage - 1) * itemsPerPage, currentPage * itemsPerPage);

        return (
            <div className="space-y-6 animate-in fade-in duration-500">
                <div className="flex flex-col xl:flex-row justify-between items-start xl:items-center gap-4 mb-6 w-full">
                    <div className="flex-1 min-w-0 pr-4"><h2 className="text-2xl font-semibold tracking-tight text-ink">Audit & Log Aktivitas</h2><p className="text-sm text-steel">Rekam jejak tindakan pengguna pada sistem (Anti-Fraud).</p></div>
                    <button onClick={() => downloadStyledExcel('Log Aktivitas', ['ID', 'Waktu', 'Pengguna', 'Aksi', 'Modul', 'Detail Aktivitas'], dataLog.map(l => [l.id, l.waktu, l.user, l.aksi, l.modul, l.detail]), 'Log_Aktivitas')} className={btnOutline}><FileSpreadsheet className="w-4 h-4 text-accent" /> Unduh</button>
                </div>
                <div className="bg-surface border border-whisper shadow-sm rounded-card overflow-hidden">
                    <div className="overflow-x-auto hidden md:block">
                        <table className="w-full text-sm text-left">
                            <thead className="bg-canvas/60 text-steel border-b border-whisper/50"><tr><th className="px-6 py-3">Waktu</th><th className="px-6 py-3">Pengguna</th><th className="px-6 py-3 text-center">Aksi</th><th className="px-6 py-3">Modul</th><th className="px-6 py-3 w-1/2">Detail Aktivitas</th>{currentUser?.role === 'superadmin' && <th className="px-6 py-3 text-center">Tindakan</th>}</tr></thead>
                            <tbody className="divide-y divide-slate-100">
                                {paginatedLog.map((log) => (
                                    <tr key={log.id} className="bg-surface hover:bg-canvas transition-colors">
                                        <td className="px-6 py-3 whitespace-nowrap text-steel">{log.waktu}</td>
                                        <td className="px-6 py-3 font-medium text-ink">{log.user}</td>
                                        <td className="px-6 py-3 text-center"><span className={`inline-flex px-2 py-0.5 text-[10px] font-bold rounded uppercase ${log.aksi === 'CREATE' ? 'bg-pale-green text-pale-greenText' : log.aksi === 'UPDATE' ? 'bg-blue-100 text-blue-700' : log.aksi === 'DELETE' ? 'bg-pale-red text-pale-redText' : log.aksi === 'INTEGRATION' ? 'bg-purple-100 text-purple-700' : 'bg-canvas text-steel'}`}>{log.aksi}</span></td>
                                        <td className="px-6 py-3 font-semibold text-steel">{log.modul}</td>
                                        <td className="px-6 py-3 text-steel">{log.detail}</td>
                                        {currentUser?.role === 'superadmin' && (
                                            <td className="px-6 py-3 text-center">
                                                <div className="flex items-center justify-center gap-2">
                                                    <button onClick={() => { setFormData(log); setModalType('FORM_LOG'); }} className="p-1.5 text-accent bg-accent/10 hover:bg-accent/20 rounded-lg"><Edit className="w-4 h-4" /></button>
                                                    <button onClick={() => confirmDelete('LOG', log.id, 'Log Aktivitas ini')} className="p-1.5 text-danger bg-dangerBg hover:bg-red-100 rounded-lg"><Trash2 className="w-4 h-4" /></button>
                                                </div>
                                            </td>
                                        )}
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                    <div className="md:hidden flex flex-col divide-y divide-whisper/50">
                        {paginatedLog.length === 0 ? (
                            <div className="text-center py-8 text-steel text-sm">Belum ada riwayat aktivitas.</div>
                        ) : paginatedLog.map((log) => (
                            <div key={log.id} className="p-4 flex flex-col gap-2 bg-surface">
                                <div className="flex justify-between items-start gap-3">
                                    <div className="min-w-0">
                                        <div className="font-bold text-ink text-sm truncate">{log.user}</div>
                                        <div className="text-[10px] text-steel mt-0.5">{log.waktu}</div>
                                    </div>
                                    <span className={`inline-flex px-1.5 py-0.5 text-[10px] font-bold rounded uppercase shrink-0 ${log.aksi === 'CREATE' ? 'bg-pale-green text-pale-greenText' : log.aksi === 'UPDATE' ? 'bg-blue-100 text-blue-700' : log.aksi === 'DELETE' ? 'bg-pale-red text-pale-redText' : log.aksi === 'INTEGRATION' ? 'bg-purple-100 text-purple-700' : 'bg-canvas text-steel'}`}>{log.aksi}</span>
                                </div>
                                <div>
                                    <div className="text-[10px] font-bold text-steel uppercase tracking-wider mb-0.5">{log.modul}</div>
                                    <div className="text-sm text-ink leading-snug">{log.detail}</div>
                                </div>
                                {currentUser?.role === 'superadmin' && (
                                    <div className="flex justify-end gap-2 mt-2 pt-2 border-t border-whisper/50">
                                        <button onClick={() => { setFormData(log); setModalType('FORM_LOG'); }} className="text-accent hover:text-accentDark flex items-center gap-1 text-xs"><Edit className="w-3 h-3" /> Edit</button>
                                        <button onClick={() => confirmDelete('LOG', log.id, 'Log Aktivitas ini')} className="text-danger hover:text-red-700 flex items-center gap-1 text-xs"><Trash2 className="w-3 h-3" /> Hapus</button>
                                    </div>
                                )}
                            </div>
                        ))}
                    </div>
                    
                    {totalPages > 0 && (
                        <div className="flex justify-center items-center gap-4 p-4 border-t border-whisper/50 bg-canvas/30">
                            <button onClick={() => setCurrentPage(p => Math.max(1, p - 1))} disabled={currentPage === 1} className="px-3 py-1.5 text-sm font-medium border border-whisper rounded-lg bg-surface hover:bg-canvas disabled:opacity-50 disabled:cursor-not-allowed text-ink">Prev</button>
                            <span className="text-sm text-steel font-medium">Hal {currentPage} dari {totalPages}</span>
                            <button onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))} disabled={currentPage === totalPages} className="px-3 py-1.5 text-sm font-medium border border-whisper rounded-lg bg-surface hover:bg-canvas disabled:opacity-50 disabled:cursor-not-allowed text-ink">Next</button>
                        </div>
                    )}
                </div>
            </div>
        );
    };

    const renderModals = () => {
        if (!modalType) return null;
        if (modalType === 'FORM_LOG') {
            return (
                <FormWrapper title="Edit Log Aktivitas" onClose={closeModal} onSubmit={submitLog}>
                    <div className="space-y-4">
                        <div>
                            <label className="block text-sm font-semibold text-ink mb-1.5">Aksi</label>
                            <select value={formData.aksi || ''} onChange={e => setFormData({ ...formData, aksi: e.target.value })} className={inputBase} required>
                                <option value="">Pilih Aksi</option>
                                <option value="CREATE">CREATE</option>
                                <option value="UPDATE">UPDATE</option>
                                <option value="DELETE">DELETE</option>
                                <option value="INTEGRATION">INTEGRATION</option>
                                <option value="LOGIN">LOGIN</option>
                                <option value="LOGOUT">LOGOUT</option>
                            </select>
                        </div>
                        <div>
                            <label className="block text-sm font-semibold text-ink mb-1.5">Modul</label>
                            <input type="text" value={formData.modul || ''} onChange={e => setFormData({ ...formData, modul: e.target.value })} className={inputBase} required />
                        </div>
                        <div>
                            <label className="block text-sm font-semibold text-ink mb-1.5">Detail Aktivitas</label>
                            <textarea value={formData.detail || ''} onChange={e => setFormData({ ...formData, detail: e.target.value })} className={`${inputBase} min-h-[100px] resize-y`} required />
                        </div>
                    </div>
                </FormWrapper>
            );
        }
        if (modalType === 'FORM_PAKASIR') {
            const tRef = dataTagihan.find(t => t.id === formData.id);
            const targetTagihanName = (tRef ? tRef.tagihan : formData.tagihan) || '';
            const masterRef = masterTagihanList.find(m => targetTagihanName.startsWith(m.tagihan));
            const currentSlug = masterRef?.pakasirSlug || appConfig.pakasirSlug || 'depodomain';
            const linkUrl = `https://app.pakasir.com/pay/${currentSlug}/${formData.sisa}?order_id=${formData.id}`;
            return (
                <div className="fixed inset-0 z-[100] flex items-end sm:items-center justify-center p-0 sm:p-4 bg-slate-900/50 backdrop-blur-sm animate-in fade-in">
                    <div className="bg-white rounded-t-[1.5rem] sm:rounded-2xl shadow-xl w-full max-w-lg flex flex-col max-h-[90vh] relative animate-in zoom-in-95">
                        <button onClick={closeModal} className="absolute top-4 right-4 z-[200] w-8 h-8 flex items-center justify-center rounded-full bg-whisper text-steel hover:text-ink"><X className="w-5 h-5" /></button>
                        <div className="px-6 py-4 border-b border-whisper flex items-center gap-3 bg-canvas/50 rounded-t-[1.5rem] sm:rounded-t-2xl"><div className="w-8 h-8 rounded-full bg-blue-100 flex items-center justify-center"><QrCode className="w-4 h-4 text-blue-600" /></div><div><h3 className="font-semibold text-ink">Pembayaran Online (QRIS / VA)</h3><p className="text-xs text-steel">Scan QR atau Bagikan Link ke Wali Santri</p></div></div>
                        <div className="p-6 overflow-y-auto space-y-5">
                            <div className="bg-blue-50 border border-blue-100 rounded-lg p-4 text-center"><p className="text-sm text-steel mb-1">{formData.nama} - {formData.tagihan}</p><h2 className="text-2xl font-bold text-blue-700">Rp {Number(formData.sisa).toLocaleString('id-ID')}</h2><p className="text-xs text-steel mt-2 font-mono">Order ID: {formData.id}</p></div>

                            {pakasirData.step === 'CHOOSE_METHOD' && (
                                <div className="animate-fade-in-up">
                                    <h3 className="text-lg font-bold text-ink mb-3">Pilih Metode Pembayaran</h3>
                                    <div className="space-y-3 mb-2 max-h-80 overflow-y-auto pr-2">
                                        <button onClick={() => handleGeneratePakasirQR('qris')} className="w-full flex items-center justify-between p-4 border border-whisper rounded-xl hover:bg-canvas transition-colors"><div className="flex items-center gap-3"><QrCode className="w-6 h-6 text-accent" /><span className="font-semibold text-ink">QRIS (Gopay, OVO, Dana, ShopeePay)</span></div><ArrowRight className="w-4 h-4 text-steel" /></button>
                                        <button onClick={() => handleGeneratePakasirQR('bri_va')} className="w-full flex items-center justify-between p-4 border border-whisper rounded-xl hover:bg-canvas transition-colors"><div className="flex items-center gap-3"><CreditCard className="w-6 h-6 text-blue-700" /><span className="font-semibold text-ink">BRI Virtual Account</span></div><ArrowRight className="w-4 h-4 text-steel" /></button>
                                        <button onClick={() => handleGeneratePakasirQR('bni_va')} className="w-full flex items-center justify-between p-4 border border-whisper rounded-xl hover:bg-canvas transition-colors"><div className="flex items-center gap-3"><CreditCard className="w-6 h-6 text-orange-600" /><span className="font-semibold text-ink">BNI Virtual Account</span></div><ArrowRight className="w-4 h-4 text-steel" /></button>
                                        <button onClick={() => handleGeneratePakasirQR('bsi_va')} className="w-full flex items-center justify-between p-4 border border-whisper rounded-xl hover:bg-canvas transition-colors"><div className="flex items-center gap-3"><CreditCard className="w-6 h-6 text-emerald-600" /><span className="font-semibold text-ink">BSI Virtual Account</span></div><ArrowRight className="w-4 h-4 text-steel" /></button>
                                        <button onClick={() => handleGeneratePakasirQR('cimb_niaga_va')} className="w-full flex items-center justify-between p-4 border border-whisper rounded-xl hover:bg-canvas transition-colors"><div className="flex items-center gap-3"><CreditCard className="w-6 h-6 text-red-600" /><span className="font-semibold text-ink">CIMB Niaga VA</span></div><ArrowRight className="w-4 h-4 text-steel" /></button>
                                        <button onClick={() => handleGeneratePakasirQR('danamon_va')} className="w-full flex items-center justify-between p-4 border border-whisper rounded-xl hover:bg-canvas transition-colors"><div className="flex items-center gap-3"><CreditCard className="w-6 h-6 text-amber-600" /><span className="font-semibold text-ink">Danamon VA</span></div><ArrowRight className="w-4 h-4 text-steel" /></button>
                                        <button onClick={() => handleGeneratePakasirQR('muamalat_va')} className="w-full flex items-center justify-between p-4 border border-whisper rounded-xl hover:bg-canvas transition-colors"><div className="flex items-center gap-3"><CreditCard className="w-6 h-6 text-purple-600" /><span className="font-semibold text-ink">Muamalat VA</span></div><ArrowRight className="w-4 h-4 text-steel" /></button>
                                        <button onClick={() => handleGeneratePakasirQR('ocbc_va')} className="w-full flex items-center justify-between p-4 border border-whisper rounded-xl hover:bg-canvas transition-colors"><div className="flex items-center gap-3"><CreditCard className="w-6 h-6 text-red-700" /><span className="font-semibold text-ink">OCBC VA</span></div><ArrowRight className="w-4 h-4 text-steel" /></button>
                                        <button onClick={() => handleGeneratePakasirQR('maybank_va')} className="w-full flex items-center justify-between p-4 border border-whisper rounded-xl hover:bg-canvas transition-colors"><div className="flex items-center gap-3"><CreditCard className="w-6 h-6 text-yellow-600" /><span className="font-semibold text-ink">Maybank VA</span></div><ArrowRight className="w-4 h-4 text-steel" /></button>
                                        <button onClick={() => handleGeneratePakasirQR('bnc_va')} className="w-full flex items-center justify-between p-4 border border-whisper rounded-xl hover:bg-canvas transition-colors"><div className="flex items-center gap-3"><CreditCard className="w-6 h-6 text-yellow-500" /><span className="font-semibold text-ink">Bank Neo Commerce (BNC) VA</span></div><ArrowRight className="w-4 h-4 text-steel" /></button>
                                    </div>
                                </div>
                            )}

                            {pakasirData.step === 'LOADING' && (
                                <div className="text-center py-10">
                                    <div className="w-10 h-10 border-4 border-slate-200 border-t-accent rounded-full animate-spin mx-auto mb-4"></div>
                                    <p className="text-steel font-medium">Memuat pembayaran...</p>
                                </div>
                            )}

                            {(pakasirData.step === 'SHOW_QR' || pakasirData.step === 'SHOW_VA') && (
                                <div className="text-center py-2 animate-fade-in-up">
                                    <h3 className="text-lg font-bold text-ink mb-1">{pakasirData.step === 'SHOW_QR' ? 'Scan QRIS' : 'Transfer Virtual Account'}</h3>
                                    
                                    {pakasirTimeLeft > 0 ? (
                                        <>
                                            <p className="text-sm font-bold text-red-600 mb-1">Selesaikan pembayaran sebelum waktu habis: {Math.floor(pakasirTimeLeft / 60)}:{(pakasirTimeLeft % 60).toString().padStart(2, '0')}</p>
                                            <p className="text-xs font-bold text-red-600 mb-6 px-2">⚠️ Mohon JANGAN tutup halaman ini atau keluar dari aplikasi sebelum pembayaran selesai.</p>
                                        </>
                                    ) : (
                                        <p className="text-base font-bold text-red-600 mb-6">Waktu Pembayaran Habis!</p>
                                    )}

                                    {pakasirData.isPaid ? (
                                        <div className="flex flex-col items-center justify-center py-4 px-6 bg-emerald-50 rounded-xl border border-emerald-100 w-full mb-6">
                                            <div className="w-16 h-16 bg-emerald-100 text-emerald-600 rounded-full flex items-center justify-center mb-4"><Check className="w-8 h-8" /></div>
                                            <h3 className="text-emerald-700 font-bold text-lg">Pembayaran Berhasil!</h3>
                                        </div>
                                    ) : pakasirTimeLeft > 0 ? (
                                        <>
                                            {pakasirData.step === 'SHOW_QR' && (
                                                <div className="bg-canvas border border-whisper rounded-xl p-4 flex items-center justify-center mx-auto w-64 h-64 mb-4">
                                                    <img src={`https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=` + encodeURIComponent(pakasirData.qrString)} alt="QRIS" className="w-full h-full object-contain mix-blend-multiply" />
                                                </div>
                                            )}

                                            {pakasirData.step === 'SHOW_VA' && (
                                                <div className="bg-canvas border border-whisper rounded-xl p-6 mb-4">
                                                    <p className="text-xs font-semibold text-steel uppercase mb-1">{getBankDisplayName(pakasirData.method)}</p>
                                                    <div className="text-3xl font-mono font-bold text-ink tracking-wider break-all">{pakasirData.qrString}</div>
                                                </div>
                                            )}

                                            <div className="flex gap-2 mb-6">
                                                {pakasirData.step === 'SHOW_QR' ? (
                                                    <button onClick={async () => {
                                                        try {
                                                            const res = await fetch(`https://api.qrserver.com/v1/create-qr-code/?size=500x500&data=` + encodeURIComponent(pakasirData.qrString));
                                                            const blob = await res.blob();
                                                            const url = window.URL.createObjectURL(blob);
                                                            const a = document.createElement('a');
                                                            a.style.display = 'none';
                                                            a.href = url;
                                                            a.download = `QRIS-${formData.id || Date.now()}.png`;
                                                            document.body.appendChild(a);
                                                            a.click();
                                                            window.URL.revokeObjectURL(url);
                                                        } catch(e) {
                                                            alert("Gagal mengunduh QR, silakan Screenshot layar ini.");
                                                        }
                                                    }} className="flex-1 py-3 bg-whisper hover:bg-slate-200 text-ink rounded-xl font-semibold transition-colors flex justify-center items-center gap-2"><Download className="w-4 h-4" /> Download QR</button>
                                                ) : (
                                                    <>
                                                        <button onClick={() => copyToClipboard(pakasirData.qrString)} className="flex-1 py-3 bg-whisper hover:bg-slate-200 text-ink rounded-xl font-semibold transition-colors flex justify-center items-center gap-2"><Copy className="w-4 h-4" /> Salin VA</button>
                                                        <button onClick={() => copyToClipboard(formData.sisa)} className="flex-1 py-3 bg-whisper hover:bg-slate-200 text-ink rounded-xl font-semibold transition-colors flex justify-center items-center gap-2"><Copy className="w-4 h-4" /> Salin Nominal</button>
                                                    </>
                                                )}
                                                {pakasirData.checkoutUrl && (
                                                    <a href={pakasirData.checkoutUrl} target="_blank" rel="noreferrer" className="flex-1 py-3 bg-blue-100 hover:bg-blue-200 text-blue-700 rounded-xl font-semibold transition-colors flex justify-center items-center gap-2"><ExternalLink className="w-4 h-4" /> Buka Checkout</a>
                                                )}
                                            </div>

                                            {pakasirData.isSandbox && (
                                                <button onClick={() => { setPakasirData(prev => ({ ...prev, isPaid: true })); setTimeout(() => { processPelunasanOtomatis(new Date().toISOString()); }, 1000); }} className="w-full py-3 mb-2 bg-amber-100 hover:bg-amber-200 text-amber-800 rounded-xl font-semibold transition-colors border border-amber-300">Simulasi Berhasil (Sandbox)</button>
                                            )}

                                            <button onClick={() => setPakasirData({ step: 'CHOOSE_METHOD', method: '', loading: false, qrString: '', url: '', checkoutUrl: '', isSandbox: false })} className="w-full py-3 mt-2 bg-transparent hover:bg-slate-50 text-steel rounded-xl font-semibold transition-colors">Pilih Pembayaran Lain</button>
                                        </>
                                    ) : null}
                                </div>
                            )}

                        </div>
                        <div className="px-6 py-4 bg-canvas border-t border-whisper flex justify-center items-center rounded-b-none sm:rounded-b-2xl">
                            <button type="button" onClick={closeModal} className={`${btnOutline} w-full`}>Tutup</button>
                        </div>
                    </div>
                </div>
            );
        }

        if (modalType === 'CEK_SALDO') {
            return (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-0">
                    <div className="absolute inset-0 bg-slate/60 backdrop-blur-sm" onClick={closeModal}></div>
                    <div className="relative bg-surface rounded-2xl shadow-xl w-full max-w-xl mx-auto overflow-hidden animate-in zoom-in-95 duration-200">
                        <div className="p-4 sm:p-6 border-b border-whisper flex justify-between items-center bg-canvas">
                            <h2 className="text-xl font-bold text-ink flex items-center gap-2"><Scan className="w-5 h-5 text-accent" /> Cek Saldo & Tagihan</h2>
                            <button onClick={closeModal} className="p-2 text-steel hover:text-rose-600 hover:bg-rose-50 rounded-xl transition-colors"><X className="w-5 h-5" /></button>
                        </div>
                        <div className="p-4 sm:p-6 bg-surface">
                            <form onSubmit={handleScanRFID} className="mb-6">
                                <label className="block text-sm font-medium text-steel mb-2 text-center">Scan Kartu RFID atau Ketik NIS</label>
                                <input
                                    ref={scanInputRef}
                                    autoFocus
                                    type="text"
                                    className="w-full text-center text-2xl font-bold tracking-widest p-4 border-2 border-indigo-200 rounded-xl focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/20 bg-indigo-50/50"
                                    placeholder="SCAN KARTU..."
                                    value={scanInput}
                                    onChange={(e) => setScanInput(e.target.value)}
                                    autoComplete="off"
                                />
                                <button type="submit" className="hidden">Submit</button>
                            </form>

                            {scanResult && (
                                <div className={`p-6 rounded-2xl border ${scanResult.found ? 'bg-canvas border-whisper' : 'bg-rose-50 border-rose-200'} text-center animate-in fade-in slide-in-from-bottom-4`}>
                                    {!scanResult.found ? (
                                        <div>
                                            <AlertCircle className="w-12 h-12 text-rose-500 mx-auto mb-3" />
                                            <h3 className="text-xl font-bold text-rose-700">Data Tidak Ditemukan</h3>
                                            <p className="text-rose-600 mt-1">Kartu/NIS <strong>{scanResult.code}</strong> belum terdaftar di sistem.</p>
                                        </div>
                                    ) : (
                                        <div>
                                            {(() => {
                                                const isKamar = String(scanResult.santri.nis || '').startsWith('KAS-') || (scanResult.santri.nama || '').toLowerCase().startsWith('kas ');
                                                if (isKamar) {
                                                    return (
                                                        <div>
                                                            <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-indigo-600 text-white font-mono text-xs font-bold uppercase tracking-wider mb-3 shadow-sm">
                                                                <Building2 className="w-3.5 h-3.5" /> KARTU KAS KAMAR / ASRAMA
                                                            </div>
                                                            <h3 className="text-3xl font-black text-indigo-950 tracking-tight">{scanResult.santri.nama}</h3>
                                                            <p className="text-steel font-medium mt-1">
                                                                Asrama: {scanResult.santri.kelas || 'Asrama'} • Rekening: {scanResult.santri.nis}
                                                            </p>
                                                            <div className="mt-4 p-5 rounded-2xl bg-gradient-to-br from-indigo-50 to-indigo-100/60 border border-indigo-200">
                                                                <div className="text-xs uppercase font-bold text-indigo-700 tracking-wider mb-1">
                                                                    Sisa Saldo Kas Bersama
                                                                </div>
                                                                <div className="text-4xl font-black font-mono text-indigo-900">
                                                                    Rp {scanResult.saldoTabungan.toLocaleString('id-ID')}
                                                                </div>
                                                            </div>
                                                            <div className="mt-4 p-2.5 rounded-xl bg-slate-50 border border-slate-200 text-xs text-steel flex items-center justify-center gap-2">
                                                                <ShieldCheck className="w-4 h-4 text-emerald-600" />
                                                                <span>Dilindungi PIN 6 Digit: <strong>{scanResult.santri.pin ? '••••••' : 'Default 123456'}</strong> (Wajib saat belanja di Kasir POS)</span>
                                                            </div>
                                                        </div>
                                                    );
                                                }
                                                return (
                                                    <div>
                                                        <div className="mb-6">
                                                            <h3 className="text-3xl font-black text-ink tracking-tight">{scanResult.santri.nama}</h3>
                                                            <p className="text-steel font-medium mt-1">Kelas {scanResult.santri.kelas} • NIS: {scanResult.santri.nis}</p>
                                                        </div>

                                                        <div className="grid grid-cols-2 gap-4">
                                                            <div className="bg-emerald-50 border border-emerald-100 p-4 rounded-xl">
                                                                <div className="text-emerald-700 font-semibold text-sm mb-1 uppercase tracking-wide">Saldo Tabungan</div>
                                                                <div className="text-2xl font-bold text-emerald-600">Rp {scanResult.saldoTabungan.toLocaleString('id-ID')}</div>
                                                            </div>
                                                            <div className={`border p-4 rounded-xl ${scanResult.totalTunggakan > 0 ? 'bg-rose-50 border-rose-100' : 'bg-slate-50 border-whisper'}`}>
                                                                <div className={`${scanResult.totalTunggakan > 0 ? 'text-rose-700' : 'text-slate'} font-semibold text-sm mb-1 uppercase tracking-wide`}>Total Tunggakan</div>
                                                                <div className={`text-2xl font-bold ${scanResult.totalTunggakan > 0 ? 'text-rose-600' : 'text-slate'}`}>Rp {scanResult.totalTunggakan.toLocaleString('id-ID')}</div>
                                                            </div>
                                                        </div>
                                                    </div>
                                                );
                                            })()}
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            );
        }

        if (modalType === 'IMPORT_CSV') {
            return (
                <FormWrapper title={`Import Data ${formData.type === 'santri' ? 'Santri' : 'Pegawai'} (Excel/CSV)`} onClose={closeModal} onSubmit={(e) => e.preventDefault()} customFooter={<div className="px-6 py-4 bg-canvas border-t border-whisper flex justify-end shrink-0 rounded-b-none sm:rounded-b-2xl"><button type="button" onClick={closeModal} className={btnOutline}>Tutup</button></div>}>
                    <div className="flex flex-col items-center justify-center space-y-6">
                        <button type="button" onClick={() => handleDownloadTemplate(formData.type)} className="text-blue-600 hover:text-blue-800 underline text-sm font-medium flex items-center gap-2"><DownloadCloud className="w-4 h-4" /> Download Template Excel (.xlsx)</button>
                        <div className="w-full border-2 border-dashed border-whisper bg-canvas p-8 rounded-xl flex flex-col items-center justify-center text-steel hover:bg-whisper hover:border-blue-400 transition-colors cursor-pointer relative">
                            <input type="file" accept=".xlsx, .xls, .csv" className="absolute inset-0 w-full h-full opacity-0 cursor-pointer" onChange={(e) => handleImportCSV(e, formData.type)} />
                            <FileSpreadsheet className="w-8 h-8 mb-2 text-steel" /><span className="text-sm font-medium text-center">Klik atau Drag file Excel (.xlsx) kesini</span>
                        </div>
                        <p className="text-xs text-steel text-center px-4">Pastikan menggunakan template. Data otomatis tersimpan saat file dipilih.</p>
                    </div>
                </FormWrapper>
            );
        }

        if (modalType === 'FORM_SANTRI') {
            return (
                <FormWrapper title={formData.id ? "Edit Data Santri" : "Tambah Data Santri"} onClose={closeModal} onSubmit={submitSantri}>
                    <div><label className="block text-sm font-medium text-ink mb-1">NIS (Otomatis/Manual)</label><input required name="nis" value={formData.nis || ''} onChange={handleInputChange} type="text" className={inputBase} /></div>
                    <div><label className="block text-sm font-medium text-ink mb-1">Nama Lengkap</label><input required name="nama" value={formData.nama || ''} onChange={handleInputChange} type="text" className={inputBase} /></div>
                    <div className="grid grid-cols-2 gap-4">
                        <div><label className="block text-sm font-medium text-ink mb-1">Kelas</label><select required name="kelas" value={formData.kelas || ''} onChange={handleInputChange} className={inputBase}><option value="">Pilih Kelas</option>{masterKelasList.map(k => <option key={k} value={k}>{k}</option>)}</select></div>
                        <div><label className="block text-sm font-medium text-ink mb-1">Periode</label><select required name="periode" value={formData.periode || ''} onChange={handleInputChange} className={inputBase}><option value="">Pilih Periode</option>{masterPeriodeList.map(p => <option key={p} value={p}>{p}</option>)}</select></div>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                        <div><label className="block text-sm font-medium text-ink mb-1">UID (Kartu RFID)</label><input name="uid" value={formData.uid || ''} onChange={handleInputChange} type="text" className={inputBase} placeholder="Tap Kartu / Ketik UID" /></div>
                        <div><label className="block text-sm font-medium text-ink mb-1">PIN Kasir (POS)</label><input name="pin" value={formData.pin || ''} onChange={handleInputChange} type="password" maxLength="6" className={inputBase} placeholder="Misal: 123456" /></div>
                        <div><label className="block text-sm font-medium text-ink mb-1">Password Wali</label><input required name="password" value={formData.password || ''} onChange={handleInputChange} type="text" className={inputBase} placeholder="Kata Sandi Portal" /></div>
                    </div>
                    <div className="mt-4 pt-4 border-t border-whisper">
                        <h4 className="font-semibold text-ink mb-3 flex items-center gap-2 text-sm"><BadgePercent className="w-4 h-4 text-emerald-600" /> Setting Diskon / Beasiswa (Opsional)</h4>
                        <div className="grid grid-cols-1 gap-3">
                            {masterTagihanList.map(tagihan => (
                                <div key={tagihan.tagihan} className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4">
                                    <label className="text-xs font-medium text-steel w-full sm:w-1/2">
                                        {tagihan.tagihan} (Normal: Rp {Number(tagihan.nominal || 0).toLocaleString('id-ID')})
                                    </label>
                                    <div className="relative w-full sm:w-1/2">
                                        <span className="absolute left-3 top-2.5 text-steel text-xs">Rp</span>
                                        <input 
                                            type="number" 
                                            value={formData.diskonKhusus?.[tagihan.tagihan] ?? ''} 
                                            onChange={(e) => { 
                                                const raw = e.target.value;
                                                const val = raw === '' ? '' : parseInt(raw, 10); 
                                                setFormData(prev => {
                                                    const dk = { ...(prev.diskonKhusus || {}) };
                                                    if (val === '' || isNaN(val) || val <= 0) {
                                                        delete dk[tagihan.tagihan];
                                                    } else {
                                                        dk[tagihan.tagihan] = val;
                                                    }
                                                    return { ...prev, diskonKhusus: dk };
                                                }); 
                                            }} 
                                            className={`${inputBase} pl-8 text-xs py-2`} 
                                            placeholder="Nominal Potongan per bulan" 
                                        />
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                </FormWrapper>
            );
        }

        if (modalType === 'FORM_PEGAWAI') {
            return (
                <FormWrapper title={formData.id ? "Edit Data Pegawai" : "Tambah Data Pegawai"} onClose={closeModal} onSubmit={submitPegawai}>
                    <div><label className="block text-sm font-medium text-ink mb-1">NIP (Nomor Induk Pegawai)</label><input required name="nip" value={formData.nip || ''} onChange={handleInputChange} type="text" className={inputBase} placeholder="Contoh: 9001" /></div>
                    <div><label className="block text-sm font-medium text-ink mb-1">Nama Lengkap</label><input required name="nama" value={formData.nama || ''} onChange={handleInputChange} type="text" className={inputBase} placeholder="Gelar dan Nama Lengkap" /></div>
                    <div className="grid grid-cols-2 gap-4">
                        <div><label className="block text-sm font-medium text-ink mb-1">Jabatan / Divisi</label><select required name="jabatan" value={formData.jabatan || ''} onChange={handleInputChange} className={inputBase}><option value="">Pilih Jabatan</option>{masterJabatanList.map(j => <option key={j} value={j}>{j}</option>)}</select></div>
                        <div><label className="block text-sm font-medium text-ink mb-1">Gaji Pokok Default (Rp)</label><input required name="gajiPokok" value={formData.gajiPokok || ''} onChange={handleInputChange} type="text" className={inputBase} placeholder="Contoh: 2000000" /></div>
                    </div>
                    <div><label className="block text-sm font-medium text-ink mb-1">Password Portal Pegawai</label><input required name="password" value={formData.password || ''} onChange={handleInputChange} type="text" className={inputBase} placeholder="Buat password login..." /></div>
                </FormWrapper>
            );
        }

        if (modalType === 'FORM_TABUNGAN') {
            const isSetor = (formData.jenis || 'Setor') === 'Setor';
            const currentSantriSaldo = formData.nis ? getSantriSaldoTabungan(formData.nis) : 0;
            const inputNominal = Number(formData.nominal || 0);
            const projectedSaldo = isSetor 
                ? (currentSantriSaldo + inputNominal)
                : (currentSantriSaldo - inputNominal);

            const customFooterTabungan = (
                <div className="px-6 py-4 bg-canvas border-t border-whisper flex justify-end gap-2 shrink-0 rounded-b-2xl">
                    <button type="button" onClick={closeModal} className={btnOutline}>Batal</button>
                    {isSetor && (!formData.id) && (<button type="button" onClick={() => handleOpenPakasir(true)} className="bg-blue-500 hover:bg-blue-600 text-white rounded-lg px-4 py-2 font-medium flex items-center justify-center gap-2 shadow-sm shrink-0 text-sm"><QrCode className="w-4 h-4" /> Pembayaran Online</button>)}
                    <button type="submit" className={btnPrimary}>Simpan Tunai</button>
                </div>
            );
            return (
                <FormWrapper title="Transaksi Tabungan" onClose={closeModal} onSubmit={submitTabungan} customFooter={customFooterTabungan}>
                    <div><label className="block text-sm font-medium text-ink mb-1">Pilih Santri</label><SantriCombobox dataSantri={dataSantri} formData={formData} setFormData={setFormData} disabled={!!formData.id} /></div>
                    
                    {formData.nis && (
                        <div className="mt-3 p-3.5 bg-slate-50 border border-slate-200 rounded-xl space-y-1.5">
                            <div className="flex justify-between items-center text-xs text-steel">
                                <span>Saldo Tabungan Saat Ini:</span>
                                <span className="font-bold text-ink">Rp {currentSantriSaldo.toLocaleString('id-ID')}</span>
                            </div>
                            {inputNominal > 0 && (
                                <div className="flex justify-between items-center text-xs pt-1.5 border-t border-slate-200">
                                    <span className="font-medium text-slate-700">Estimasi Saldo Setelah {formData.jenis || 'Setor'}:</span>
                                    <span className={`font-bold ${projectedSaldo < 0 ? 'text-rose-600' : 'text-emerald-600'}`}>
                                        Rp {projectedSaldo.toLocaleString('id-ID')}
                                    </span>
                                </div>
                            )}
                        </div>
                    )}

                    <div className="grid grid-cols-2 gap-4 mt-2">
                        <div><label className="block text-sm font-medium text-ink mb-1">Jenis Transaksi</label><select required name="jenis" value={formData.jenis || 'Setor'} onChange={handleInputChange} className={inputBase}><option value="Setor">Setor (Nabung / Tambah Saldo)</option><option value="Tarik">Tarik (Ambil Saldo)</option></select></div>
                        <div><label className="block text-sm font-medium text-ink mb-1">Nominal (Rp)</label><input required name="nominal" value={formData.nominal || ''} onChange={handleInputChange} type="number" className={inputBase} /></div>
                    </div>
                    <div className="mt-2"><label className="block text-sm font-medium text-ink mb-1">Keterangan Tambahan</label><input name="keterangan" value={formData.keterangan || ''} onChange={handleInputChange} type="text" className={inputBase} placeholder="Contoh: Uang saku tambahan, dll..." /></div>
                </FormWrapper>
            );
        }

        if (modalType === 'FORM_ATUR_LIMIT_TABUNGAN') {
            const santriRef = limitModalData.selectedNis ? dataSantri.find(s => s.nis === limitModalData.selectedNis) : null;
            return (
                <FormWrapper title="Atur Limit Tabungan & Jajan Santri" onClose={closeModal} onSubmit={handleSaveLimitTabungan}>
                    <div>
                        <label className="block text-sm font-medium text-ink mb-1">Target Pengaturan</label>
                        <select 
                            value={limitModalData.targetType} 
                            onChange={(e) => setLimitModalData(prev => ({ ...prev, targetType: e.target.value }))}
                            className={inputBase}
                        >
                            <option value="Semua">Semua Santri (Default Sistem)</option>
                            <option value="Kelas">Berdasarkan Kelas</option>
                            <option value="Santri">Santri Tertentu (Per Santri)</option>
                        </select>
                    </div>

                    {limitModalData.targetType === 'Kelas' && (
                        <div>
                            <label className="block text-sm font-medium text-ink mb-1">Pilih Kelas</label>
                            <select 
                                required 
                                value={limitModalData.selectedKelas} 
                                onChange={(e) => setLimitModalData(prev => ({ ...prev, selectedKelas: e.target.value }))} 
                                className={inputBase}
                            >
                                <option value="">-- Pilih Kelas --</option>
                                {masterKelasList.map(k => <option key={k} value={k}>{k}</option>)}
                            </select>
                        </div>
                    )}

                    {limitModalData.targetType === 'Santri' && (
                        <div>
                            <label className="block text-sm font-medium text-ink mb-1">Pilih Santri</label>
                            <SantriCombobox 
                                dataSantri={dataSantri} 
                                formData={{ nis: limitModalData.selectedNis }} 
                                setFormData={(val) => {
                                    const nisVal = typeof val === 'function' ? val({ nis: limitModalData.selectedNis }).nis : val.nis;
                                    const s = dataSantri.find(x => x.nis === nisVal);
                                    const currentCfg = s ? getSantriLimitConfig(s) : { limit: 0, periode: 'harian' };
                                    setLimitModalData(prev => ({ 
                                        ...prev, 
                                        selectedNis: nisVal,
                                        nominal: currentCfg.limit || '',
                                        periode: currentCfg.periode || 'harian'
                                    }));
                                }} 
                            />
                            {santriRef && (
                                <p className="text-xs text-steel mt-1">Santri terpilih: <span className="font-semibold text-ink">{santriRef.nama}</span> (Kelas {santriRef.kelas || '-'})</p>
                            )}
                        </div>
                    )}

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <div>
                            <label className="block text-sm font-medium text-ink mb-1">Periode Limit</label>
                            <select 
                                required 
                                value={limitModalData.periode} 
                                onChange={(e) => setLimitModalData(prev => ({ ...prev, periode: e.target.value }))} 
                                className={inputBase}
                            >
                                <option value="harian">Per Hari (Harian)</option>
                                <option value="mingguan">Per Minggu (Mingguan)</option>
                                <option value="bulanan">Per Bulan (Bulanan)</option>
                            </select>
                        </div>
                        <div>
                            <label className="block text-sm font-medium text-ink mb-1">Batas Maksimal (Rp)</label>
                            <input 
                                required 
                                type="number" 
                                min="0" 
                                step="1000"
                                value={limitModalData.nominal} 
                                onChange={(e) => setLimitModalData(prev => ({ ...prev, nominal: e.target.value }))} 
                                className={inputBase} 
                                placeholder="0 = Bebas (Tanpa Limit)"
                            />
                        </div>
                    </div>

                    <div>
                        <p className="text-xs text-steel mb-1.5">Pilihan Nominal Cepat:</p>
                        <div className="flex flex-wrap gap-2">
                            {[
                                { label: 'Bebas (0)', val: 0 },
                                { label: 'Rp 10.000', val: 10000 },
                                { label: 'Rp 20.000', val: 20000 },
                                { label: 'Rp 50.000', val: 50000 },
                                { label: 'Rp 100.000', val: 100000 },
                                { label: 'Rp 250.000', val: 250000 },
                                { label: 'Rp 500.000', val: 500000 }
                            ].map(item => (
                                <button
                                    type="button"
                                    key={item.val}
                                    onClick={() => setLimitModalData(prev => ({ ...prev, nominal: item.val }))}
                                    className={`px-2.5 py-1 text-xs rounded-lg border transition-all ${Number(limitModalData.nominal) === item.val ? 'bg-accent text-white border-accent' : 'bg-surface text-steel hover:bg-canvas border-whisper'}`}
                                >
                                    {item.label}
                                </button>
                            ))}
                        </div>
                    </div>

                    <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-xs text-amber-800">
                        <div className="font-semibold flex items-center gap-1.5 mb-1">
                            <AlertCircle className="w-4 h-4 text-amber-600" /> Informasi Aturan Limit:
                        </div>
                        <ul className="list-disc list-inside space-y-0.5 text-amber-700">
                            <li><strong>Per Hari</strong>: Direset otomatis setiap tengah malam (00:00).</li>
                            <li><strong>Per Minggu</strong>: Direset setiap awal pekan (Senin - Minggu).</li>
                            <li><strong>Per Bulan</strong>: Direset setiap tanggal 1 awal bulan baru.</li>
                            <li>Limit ini membatasi <strong>penarikan tabungan</strong> di Admin dan <strong>transaksi jajan di kantin POS</strong>.</li>
                        </ul>
                    </div>
                </FormWrapper>
            );
        }

        if (modalType === 'FORM_KAS') {
            const isMasuk = formData.tipeKas === 'MASUK';
            return (
                <FormWrapper title={isMasuk ? "Catat Pemasukan (BOS/Donasi)" : "Catat Pengeluaran Divisi"} onClose={closeModal} onSubmit={handleSaveBukuKas}>
                    <div><label className="block text-sm font-medium text-ink mb-1">Kategori {isMasuk ? 'Pemasukan' : 'Pengeluaran'}</label><select required name="kategori" value={formData.kategori || ''} onChange={handleInputChange} className={inputBase}><option value="">-- Pilih Kategori --</option>{kategoriKas[isMasuk ? 'pemasukan' : 'pengeluaran'].map(k => <option key={k} value={k}>{k}</option>)}</select></div>
                    <div><label className="block text-sm font-medium text-ink mb-1">{isMasuk ? 'Sumber Dana (Instansi/Donatur)' : 'Nama Kegiatan / Keperluan'}</label><input required name="sumberTujuan" value={formData.sumberTujuan || ''} onChange={handleInputChange} type="text" className={inputBase} placeholder={isMasuk ? "Contoh: Kemenag / Hamba Allah" : "Contoh: Perbaikan Atap Asrama"} /></div>
                    <div><label className="block text-sm font-medium text-ink mb-1">Nominal (Rp)</label><input required name="nominal" value={formData.nominal || ''} onChange={handleInputChange} type="number" className={inputBase} /></div>
                    <div><label className="block text-sm font-medium text-ink mb-1">Keterangan Tambahan (Opsional)</label><textarea name="keterangan" value={formData.keterangan || ''} onChange={handleInputChange} className={`${inputBase} h-20 resize-none`} placeholder="Catatan detail..."></textarea></div>
                </FormWrapper>
            );
        }

        if (modalType === 'FORM_GAJI') {
            const pRef = dataPegawai.find(p => p.nip === formData.nip);
            const currentGapok = formData.gajiPokok !== undefined ? formData.gajiPokok : (pRef ? pRef.gajiPokok : '');
            const totalB = Math.max(0, (parseInt(currentGapok) || 0) + (parseInt(formData.tunjangan) || 0) - (parseInt(formData.potongan) || 0));
            return (
                <FormWrapper title="Catat & Bayar Gaji Pegawai" onClose={closeModal} onSubmit={(e) => { e.preventDefault(); if (formData.gajiPokok === undefined) formData.gajiPokok = pRef ? pRef.gajiPokok : 0; submitGaji(e); }}>
                    <div><label className="block text-sm font-medium text-ink mb-1">Pilih Pegawai (Karyawan/Ustadz)</label><SantriCombobox dataSantri={dataSantri} formData={formData} setFormData={setFormData} disabled={!!formData.id} isPegawai={true} dataPegawai={dataPegawai} /></div>
                    <div className="grid grid-cols-2 gap-4 mt-2">
                        <div><label className="block text-sm font-medium text-ink mb-1">Bulan</label><select required name="bulan" value={formData.bulan || ''} onChange={handleInputChange} className={inputBase}>{listBulan.map(b => <option key={b} value={b}>{b}</option>)}</select></div>
                        <div><label className="block text-sm font-medium text-ink mb-1">Tahun</label><input required name="tahun" value={formData.tahun || ''} onChange={handleInputChange} type="number" className={inputBase} /></div>
                    </div>
                    <div className="mt-2 p-3 bg-canvas border border-whisper rounded-lg space-y-3">
                        <div><label className="block text-xs font-semibold text-steel mb-1">Gaji Pokok (Rp)</label><input required name="gajiPokok" value={currentGapok} onChange={handleInputChange} type="number" className={`${inputBase} bg-white`} /></div>
                        <div className="grid grid-cols-2 gap-3">
                            <div><label className="block text-xs font-semibold text-emerald-600 mb-1">Tunjangan (+)</label><input name="tunjangan" value={formData.tunjangan || ''} onChange={handleInputChange} type="number" className={inputBase} placeholder="0" /></div>
                            <div><label className="block text-xs font-semibold text-rose-600 mb-1">Potongan (-)</label><input name="potongan" value={formData.potongan || ''} onChange={handleInputChange} type="number" className={inputBase} placeholder="0" /></div>
                        </div>
                        <div className="pt-2 border-t border-whisper flex justify-between items-center"><span className="font-semibold text-sm text-ink">Total Penerimaan Bersih:</span><span className="font-bold text-lg text-emerald-700">Rp {totalB.toLocaleString('id-ID')}</span></div>
                    </div>
                </FormWrapper>
            );
        }

        if (modalType === 'FORM_TAGIHAN_SANTRI') {
            return (
                <FormWrapper title={formData.id ? "Edit Tagihan" : "Buat Tagihan Baru"} onClose={closeModal} onSubmit={submitTagihanSantri}>
                    <div><label className="block text-sm font-medium text-ink mb-1">Pilih Santri</label><SantriCombobox dataSantri={dataSantri} formData={formData} setFormData={setFormData} disabled={!!formData.id} /></div>
                    {!formData.id ? (
                        <div className="mt-2"><label className="block text-sm font-medium text-ink mb-1">Pilih Tagihan (Bisa Lebih dari 1)</label><div className="grid grid-cols-2 gap-2 p-3 border border-whisper rounded-lg bg-canvas max-h-40 overflow-y-auto">{masterTagihanList.filter(t => !String(t.portalMenu || '').includes('Sembunyikan')).map(t => (<label key={t.tagihan} className="flex items-center gap-2 text-sm cursor-pointer"><input type="checkbox" checked={(formData.selectedTagihans || []).includes(t.tagihan)} onChange={(e) => { const checked = e.target.checked; setFormData(prev => { const currentList = prev.selectedTagihans || []; const newList = checked ? [...currentList, t.tagihan] : currentList.filter(item => item !== t.tagihan); const newDetails = { ...(prev.tagihanDetails || {}) }; if (checked) { const tagRef = masterTagihanList.find(x => x.tagihan === t.tagihan); const santriRef = dataSantri.find(x => x.nis === prev.nis); newDetails[t.tagihan] = { nominalAwal: tagRef ? tagRef.nominal : 0, diskon: santriRef?.diskonKhusus?.[t.tagihan] || 0 }; } else { delete newDetails[t.tagihan]; } return { ...prev, selectedTagihans: newList, tagihanDetails: newDetails }; }); }} className="rounded border-whisper text-blue-600" /> {t.tagihan}</label>))}</div></div>
                    ) : (<div className="mt-2"><label className="block text-sm font-medium text-ink mb-1">Jenis Tagihan</label><input type="text" value={formData.tagihan} disabled className={`${inputBase} bg-whisper`} /></div>)}

                    {!formData.id ? (
                        <div className="mt-3">
                            <label className="block text-sm font-medium text-ink mb-2">Bulan Tagihan (Bisa pilih lebih dari 1)</label>
                            <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
                                {listBulan.map(b => {
                                    const isChecked = (formData.selectedBulan || []).includes(b);
                                    let badge = null;
                                    let isDisabled = false;
                                    if (formData.nis && (formData.selectedTagihans || []).length > 0) {
                                        for (const tag of formData.selectedTagihans) {
                                            const st = checkBillStatus(dataTagihan, dataPembayaran, formData.nis, tag, b, formData.tahun);
                                            if (st.status === 'ALREADY_PAID') {
                                                badge = <span className="ml-auto text-[10px] font-bold text-emerald-600 bg-emerald-50 px-1 py-0.5 rounded border border-emerald-200">Lunas</span>;
                                                isDisabled = true;
                                                break;
                                            } else if (st.status === 'IN_TAGIHAN') {
                                                badge = <span className="ml-auto text-[10px] font-bold text-amber-600 bg-amber-50 px-1 py-0.5 rounded border border-amber-200">Ada</span>;
                                                isDisabled = true;
                                                break;
                                            }
                                        }
                                    }
                                    return (
                                        <label key={b} className={`flex items-center gap-1.5 text-xs px-2 py-1.5 rounded border transition-colors ${isDisabled ? 'bg-gray-100 border-gray-200 text-gray-400 cursor-not-allowed' : 'bg-canvas border-whisper cursor-pointer hover:bg-whisper'}`}>
                                            <input type="checkbox" disabled={isDisabled} checked={isChecked && !isDisabled} onChange={(e) => handleBulanChange(b, e)} className="rounded text-blue-600 disabled:opacity-40" />
                                            <span>{b.substring(0, 3)}</span>
                                            {badge}
                                        </label>
                                    );
                                })}
                            </div>
                        </div>
                    ) : (<div className="mt-2"><label className="block text-sm font-medium text-ink mb-1">Bulan</label><select required name="bulan" value={formData.bulan || ''} onChange={handleInputChange} className={inputBase}>{listBulan.map(b => <option key={b} value={b}>{b}</option>)}</select></div>)}
                    <div className="mt-2"><label className="block text-sm font-medium text-ink mb-1">Tahun</label><input required name="tahun" value={formData.tahun || ''} onChange={handleInputChange} type="number" className={inputBase} /></div>

                    {((formData.selectedTagihans || []).length > 0 || formData.id) && (
                        <div className="mt-2 space-y-2 border-t border-whisper pt-3"><label className="block text-sm font-semibold text-ink">Rincian Nominal (Bisa disesuaikan)</label>
                            {(formData.id ? [formData.tagihan] : formData.selectedTagihans).map(tagName => {
                                const detail = formData.tagihanDetails?.[tagName] || { nominalAwal: 0, diskon: 0 }; const totalB = Math.max(0, parseInt(detail.nominalAwal || 0) - parseInt(detail.diskon || 0));
                                return (<div key={tagName} className="grid grid-cols-12 gap-2 items-end bg-canvas p-3 rounded-lg border border-whisper"><div className="col-span-12 font-medium text-sm text-ink pb-1 border-b border-whisper/50 mb-1">{tagName}</div><div className="col-span-4"><span className="text-xs text-steel block mb-1">Nominal Dasar</span><input type="number" value={detail.nominalAwal} onChange={(e) => updateTagihanDetail(tagName, 'nominalAwal', e.target.value)} className={`${inputBase} text-xs py-1.5`} /></div><div className="col-span-4"><span className="text-xs text-steel block mb-1">Potongan</span><input type="number" value={detail.diskon} onChange={(e) => updateTagihanDetail(tagName, 'diskon', e.target.value)} className={`${inputBase} text-xs py-1.5`} /></div><div className="col-span-4"><span className="text-xs text-steel block mb-1 text-right">Total Bersih</span><div className="font-semibold text-blue-700 text-sm text-right mt-2">Rp {totalB.toLocaleString('id-ID')}</div></div></div>)
                            })}
                        </div>
                    )}
                </FormWrapper>
            );
        }

        if (modalType === 'FORM_PEMBAYARAN') {
            const unpaidBills = formData.nis ? dataTagihan.filter(t => String(t.nis) === String(formData.nis) && t.status !== 'Lunas') : [];
            const selectedTunggakanIds = formData.selectedTagihanBayar || [];
            const hasSelectedUnpaid = selectedTunggakanIds.length > 0;
            const isSinglePay = selectedTunggakanIds.length === 1;
            const totalSelectedUnpaid = selectedTunggakanIds.reduce((sum, id) => { const b = unpaidBills.find(t => t.id === id); return sum + (b ? (b.nominal - (b.terbayar || 0)) : 0); }, 0);

            const customFooter = (
                <div className="px-6 py-4 bg-canvas border-t border-whisper flex justify-end gap-2 shrink-0 rounded-b-2xl">
                    <button type="button" onClick={closeModal} className={btnOutline}>Batal</button>
                    {!formData.id && (<button type="button" onClick={() => handleOpenPakasir(false)} className="bg-blue-500 hover:bg-blue-600 text-white rounded-lg px-4 py-2 font-medium flex items-center justify-center gap-2 shadow-sm shrink-0 text-sm"><QrCode className="w-4 h-4" /> Pembayaran Online</button>)}
                    <button type="submit" className={btnPrimary}>Simpan Tunai</button>
                </div>
            );

            return (
                <FormWrapper title={formData.id && formData.id.startsWith('INV') ? "Edit Transaksi" : "Catat Uang Masuk & Tunggakan"} onClose={closeModal} onSubmit={submitTambahPembayaran} customFooter={customFooter}>
                    <div><label className="block text-sm font-medium text-ink mb-1">Pilih Santri</label><SantriCombobox dataSantri={dataSantri} formData={formData} setFormData={setFormData} disabled={!!formData.id} /></div>
                    {formData.nis && !formData.id && (
                        <div className="mt-2"><label className="block text-sm font-medium text-ink mb-2">Pilih Tunggakan (Bisa Bayar Sekaligus)</label>
                            {unpaidBills.length > 0 ? (
                                <div className="flex flex-col gap-2 p-3 border border-whisper rounded-lg bg-canvas max-h-48 overflow-y-auto shadow-inner">{unpaidBills.map(t => (<label key={t.id} className={`flex items-start justify-between text-sm cursor-pointer p-2 rounded border transition-colors ${selectedTunggakanIds.includes(t.id) ? 'bg-blue-50 border-blue-200' : 'bg-white border-transparent hover:border-whisper'}`}><div className="flex items-start gap-3"><input type="checkbox" checked={selectedTunggakanIds.includes(t.id)} onChange={(e) => { const isChecked = e.target.checked; setFormData(prev => { const currentList = prev.selectedTagihanBayar || []; const newList = isChecked ? [...currentList, t.id] : currentList.filter(id => id !== t.id); let newNominal = prev.nominal; if (newList.length === 1) { const b = unpaidBills.find(x => x.id === newList[0]); if (b) newNominal = b.nominal - (b.terbayar || 0); } else { newNominal = undefined; } return { ...prev, selectedTagihanBayar: newList, nominal: newNominal }; }); }} className="mt-1 rounded border-whisper text-blue-600" /><div><div className="font-medium text-ink">{t.tagihan}</div><div className="text-xs text-steel">{t.periode}</div></div></div><span className="font-medium text-amber-600">Rp {(t.nominal - (t.terbayar || 0)).toLocaleString('id-ID')}</span></label>))}</div>
                            ) : (<div className="text-sm text-emerald-600 p-3 bg-emerald-50 rounded-lg border border-emerald-100">Santri ini tidak memiliki tunggakan (Semua Lunas).</div>)}
                            {hasSelectedUnpaid && !isSinglePay && (<div className="mt-3 p-3 bg-blue-100 border border-blue-200 rounded-lg flex justify-between items-center text-sm font-semibold text-blue-900 shadow-sm"><span>Total Bayar Semua Terpilih:</span><span>Rp {totalSelectedUnpaid.toLocaleString('id-ID')}</span></div>)}
                        </div>
                    )}
                    {(!hasSelectedUnpaid || isSinglePay) && (
                        <div className="animate-in fade-in slide-in-from-top-2">
                            {!hasSelectedUnpaid && unpaidBills.length > 0 && !formData.id && (<div className="flex items-center my-4"><div className="flex-1 border-t border-whisper"></div><span className="px-3 text-xs text-steel font-medium">ATAU CATAT MANUAL BEBAS</span><div className="flex-1 border-t border-whisper"></div></div>)}
                            {!hasSelectedUnpaid && (
                                <><div>
                                        <label className="block text-sm font-medium text-ink mb-1 mt-2">Jenis Pembayaran / Tagihan</label>
                                        <select required name="tagihan" value={formData.tagihan || ''} onChange={(e) => {
                                            const val = e.target.value;
                                            const tRef = masterTagihanList.find(t => t.tagihan === val);
                                            const santriRef = dataSantri.find(s => String(s.nis).replace(/^0+/, '') === String(formData.nis || '').replace(/^0+/, ''));
                                            const diskon = (santriRef?.diskonKhusus && santriRef.diskonKhusus[val] !== undefined && santriRef.diskonKhusus[val] !== '')
                                                ? Number(santriRef.diskonKhusus[val]) || 0
                                                : 0;
                                            const awal = tRef ? Number(tRef.nominal) || 0 : 0;
                                            const nominalBersih = Math.max(0, awal - diskon);
                                            setFormData(prev => ({
                                                ...prev,
                                                tagihan: val,
                                                nominal: nominalBersih,
                                                diskonPotongan: diskon,
                                                nominalAwal: awal
                                            }));
                                        }} className={inputBase}>
                                            <option value="">-- Pilih --</option>
                                            {masterTagihanList.filter(t => !String(t.portalMenu || '').includes('Sembunyikan')).map(t => (
                                                <option key={t.tagihan} value={t.tagihan}>{t.tagihan}</option>
                                            ))}
                                        </select>
                                        {formData.diskonPotongan > 0 && (
                                            <div className="mt-2 p-2.5 bg-emerald-50 border border-emerald-200 rounded-lg flex items-center justify-between text-xs text-emerald-800 animate-in fade-in">
                                                <span className="flex items-center gap-1.5 font-medium"><BadgePercent className="w-4 h-4 text-emerald-600" /> Potongan Santri Aktif:</span>
                                                <span className="font-bold">-Rp {Number(formData.diskonPotongan).toLocaleString('id-ID')} (Tarif Normal: Rp {Number(formData.nominalAwal || 0).toLocaleString('id-ID')})</span>
                                            </div>
                                        )}
                                    </div>
                                    {!formData.id ? (
                                        <div className="mt-3">
                                            <label className="block text-sm font-medium text-ink mb-2">Bulan Dibayar (Bisa pilih lebih dari 1)</label>
                                            <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
                                                {listBulan.map(b => {
                                                    const isChecked = (formData.selectedBulan || []).includes(b);
                                                    let badge = null;
                                                    let isDisabled = false;
                                                    if (formData.nis && formData.tagihan) {
                                                        const st = checkBillStatus(dataTagihan, dataPembayaran, formData.nis, formData.tagihan, b, formData.tahun);
                                                        if (st.status === 'ALREADY_PAID') {
                                                            badge = <span className="ml-auto text-[10px] font-bold text-emerald-600 bg-emerald-50 px-1 py-0.5 rounded border border-emerald-200">Lunas</span>;
                                                            isDisabled = true;
                                                        } else if (st.status === 'IN_TAGIHAN') {
                                                            const isCicil = st.tagihan?.status === 'Cicil' || st.tagihan?.status === 'Cicilan';
                                                            badge = <span className={`ml-auto text-[10px] font-bold px-1 py-0.5 rounded border ${isCicil ? 'text-blue-600 bg-blue-50 border-blue-200' : 'text-amber-600 bg-amber-50 border-amber-200'}`}>{isCicil ? 'Cicil' : 'Tagihan'}</span>;
                                                        }
                                                    }
                                                    return (
                                                        <label key={b} className={`flex items-center gap-1.5 text-xs px-2 py-1.5 rounded border transition-colors ${isDisabled ? 'bg-gray-100 border-gray-200 text-gray-400 cursor-not-allowed' : 'bg-canvas border-whisper cursor-pointer hover:bg-whisper'}`}>
                                                            <input type="checkbox" disabled={isDisabled} checked={isChecked && !isDisabled} onChange={(e) => handleBulanChange(b, e)} className="rounded text-blue-600 disabled:opacity-40" />
                                                            <span>{b.substring(0, 3)}</span>
                                                            {badge}
                                                        </label>
                                                    );
                                                })}
                                            </div>
                                        </div>
                                    ) : (<div className="mt-2"><label className="block text-sm font-medium text-ink mb-1">Bulan</label><select required name="bulan" value={formData.bulan || ''} onChange={handleInputChange} className={inputBase}>{listBulan.map(b => <option key={b} value={b}>{b}</option>)}</select></div>)}
                                    <div className="mt-2"><label className="block text-sm font-medium text-ink mb-1">Tahun</label><input required name="tahun" value={formData.tahun || ''} onChange={handleInputChange} type="number" className={inputBase} /></div>
                                </>
                            )}
                            <div className="mt-4"><label className="block text-sm font-medium text-ink mb-1">Uang Masuk (Rp) {isSinglePay && <span className="text-amber-600 text-xs font-normal ml-2">- Kurangi nominal jika bayar cicil</span>} {!hasSelectedUnpaid && <span className="text-blue-600 text-xs font-normal ml-2">- Berlaku PER BULAN</span>}</label><input required name="nominal" value={formData.nominal || ''} onChange={handleInputChange} type="number" className={`${inputBase} ${isSinglePay ? 'border-amber-300 bg-amber-50 focus:ring-amber-500' : ''}`} /></div>
                        </div>
                    )}
                </FormWrapper>
            );
        }

        if (modalType === 'GENERATE_MASSAL' || modalType === 'FORM_PEMBAYARAN_MASSAL') {
            const searchKwd = (formData.searchSantri || '').toLowerCase();
            const filteredSantri = dataSantri.filter(s => (s.nama || '').toLowerCase().includes(searchKwd) || String(s.nis || '').includes(searchKwd));
            const isPembayaran = modalType === 'FORM_PEMBAYARAN_MASSAL';
            return (
                <FormWrapper title={isPembayaran ? "Catat Pembayaran Massal Sekaligus" : "Generate Tagihan Massal"} onClose={closeModal} onSubmit={(e) => { e.preventDefault(); isPembayaran ? submitTambahPembayaran(e) : submitTagihanSantri(e); }}>
                    <div className={`p-3 text-sm rounded-lg mb-4 border ${isPembayaran ? 'bg-emerald-50 text-emerald-800 border-emerald-100' : 'bg-blue-50 text-blue-800 border-blue-100'}`}>Fitur ini akan {isPembayaran ? 'mencatat UANG MASUK LUNAS' : 'membuat TAGIHAN BARU'} secara massal. Nominal potongan beasiswa disesuaikan otomatis!</div>
                    <div><label className="block text-sm font-medium text-ink mb-1">Target Generate</label><select required name="targetType" value={formData.targetType || 'Semua'} onChange={handleInputChange} className={inputBase}><option value="Semua">Semua Santri Aktif</option><option value="Kelas">Pilih Berdasarkan Kelas</option><option value="Santri">Pilih Santri Spesifik</option></select></div>
                    {formData.targetType === 'Kelas' && (<div className="p-3 border border-whisper rounded-lg max-h-40 overflow-y-auto bg-canvas shadow-inner mt-2"><div className="text-xs font-semibold text-steel mb-2">Ceklis Kelas Target:</div><div className="grid grid-cols-2 gap-2">{masterKelasList.map(k => (<label key={k} className="flex items-center gap-2 text-sm cursor-pointer"><input type="checkbox" checked={(formData.selectedKelas || []).includes(k)} onChange={() => handleCheckboxChange('selectedKelas', k)} className="rounded text-blue-600" /> Kelas {k}</label>))}</div></div>)}
                    {formData.targetType === 'Santri' && (<div className="p-3 border border-whisper rounded-lg max-h-48 overflow-y-auto bg-canvas shadow-inner mt-2"><div className="flex justify-between items-center mb-2"><div className="text-xs font-semibold text-steel">Ceklis Santri Target:</div><div className="relative w-1/2"><Search className="w-3 h-3 absolute left-2 top-2 text-steel" /><input type="text" name="searchSantri" placeholder="Cari..." value={formData.searchSantri || ''} onChange={handleInputChange} className={`${inputBase} pl-7 py-1 text-xs`} /></div></div><div className="flex flex-col gap-2">{filteredSantri.map(s => (<label key={s.id} className="flex items-center gap-2 text-sm cursor-pointer"><input type="checkbox" checked={(formData.selectedSantri || []).includes(s.nis)} onChange={() => handleCheckboxChange('selectedSantri', s.nis)} className="rounded text-blue-600" /> {s.nis} - {s.nama} ({s.kelas})</label>))}</div></div>)}
                    <div className="mt-2 border-t border-whisper pt-4"><label className="block text-sm font-medium text-ink mb-1">Pilih Tagihan Target (Menampilkan Nominal Dasar)</label><div className="flex flex-col gap-2 p-3 border border-whisper rounded-lg bg-canvas max-h-48 overflow-y-auto shadow-inner">{masterTagihanList.filter(t => !String(t.portalMenu || '').includes('Sembunyikan')).map(t => (<label key={t.tagihan} className="flex justify-between items-center text-sm cursor-pointer hover:bg-whisper p-1.5 rounded"><div className="flex items-center gap-2"><input type="checkbox" checked={(formData.selectedTagihans || []).includes(t.tagihan)} onChange={() => handleCheckboxChange('selectedTagihans', t.tagihan)} className="rounded text-blue-600" /> {t.tagihan}</div><span className="text-emerald-600 font-medium text-xs">Rp {Number(t.nominal || 0).toLocaleString('id-ID')}</span></label>))}</div></div>
                    <div className="mt-3"><label className="block text-sm font-medium text-ink mb-2">Bulan (Bisa pilih lebih dari 1)</label><div className="grid grid-cols-3 sm:grid-cols-4 gap-2">{listBulan.map(b => (<label key={b} className="flex items-center gap-1.5 text-xs bg-canvas border border-whisper px-2 py-1.5 rounded cursor-pointer hover:bg-whisper"><input type="checkbox" checked={(formData.selectedBulan || []).includes(b)} onChange={(e) => handleBulanChange(b, e)} className="rounded text-blue-600" /> {b.substring(0, 3)}</label>))}</div></div>
                    <div className="mt-2"><label className="block text-sm font-medium text-ink mb-1">Tahun</label><input required name="tahun" value={formData.tahun || ''} onChange={handleInputChange} type="number" className={inputBase} /></div>
                </FormWrapper>
            );
        }

        if (modalType === 'MASTER_KATEGORI_KAS') {
            return (
                <FormWrapper title="Master Kategori Kas" onClose={closeModal} onSubmit={(e) => { e.preventDefault(); setKategoriKas(prev => ({ ...prev, [formData.newKategoriType]: [...prev[formData.newKategoriType], formData.newKategori] })); setFormData({ newKategori: '', newKategoriType: 'pemasukan' }); showNotification("Kategori ditambahkan!"); }}>
                    <div className="flex gap-2">
                        <select required name="newKategoriType" value={formData.newKategoriType || 'pemasukan'} onChange={handleInputChange} className={`${inputBase} w-1/3`}><option value="pemasukan">Pemasukan</option><option value="pengeluaran">Pengeluaran</option></select>
                        <input required name="newKategori" value={formData.newKategori || ''} onChange={handleInputChange} type="text" className={inputBase} placeholder="Nama Kategori Baru" />
                        <button type="submit" className={btnPrimary}><Plus className="w-4 h-4" /></button>
                    </div>
                    <div className="mt-4 grid grid-cols-2 gap-4">
                        <div className="p-3 bg-emerald-50 rounded-lg border border-emerald-100"><h4 className="text-xs font-bold text-emerald-800 mb-2 uppercase">Kategori Pemasukan</h4><div className="flex flex-wrap gap-1">{kategoriKas.pemasukan.map(k => (<span key={k} className="px-2 py-1 bg-white text-emerald-700 rounded text-xs border border-emerald-200 flex items-center gap-1">{k} <X className="w-3 h-3 cursor-pointer hover:text-rose-600" onClick={() => setKategoriKas(p => ({ ...p, pemasukan: p.pemasukan.filter(i => i !== k) }))} /></span>))}</div></div>
                        <div className="p-3 bg-rose-50 rounded-lg border border-rose-100"><h4 className="text-xs font-bold text-rose-800 mb-2 uppercase">Kategori Pengeluaran</h4><div className="flex flex-wrap gap-1">{kategoriKas.pengeluaran.map(k => (<span key={k} className="px-2 py-1 bg-white text-rose-700 rounded text-xs border border-rose-200 flex items-center gap-1">{k} <X className="w-3 h-3 cursor-pointer hover:text-rose-600" onClick={() => setKategoriKas(p => ({ ...p, pengeluaran: p.pengeluaran.filter(i => i !== k) }))} /></span>))}</div></div>
                    </div>
                </FormWrapper>
            );
        }

        if (['MASTER_TAGIHAN_LIST', 'MASTER_PERIODE', 'MASTER_KELAS', 'MASTER_JABATAN'].includes(modalType)) {
            const isTagihan = modalType === 'MASTER_TAGIHAN_LIST';
            const isPeriode = modalType === 'MASTER_PERIODE';
            const isJabatan = modalType === 'MASTER_JABATAN';
            const isSimple = !isTagihan;
            const simpleField = isPeriode ? 'periode' : isJabatan ? 'jabatan' : 'kelas';
            const simpleList = isPeriode ? masterPeriodeList : isJabatan ? masterJabatanList : masterKelasList;
            const simpleSetList = isPeriode ? setMasterPeriodeList : isJabatan ? setMasterJabatanList : setMasterKelasList;
            const simpleTitle = isPeriode ? 'Master Periode' : isJabatan ? 'Master Jabatan / Divisi' : 'Master Kelas';
            return (
                <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-sm animate-in fade-in">
                    <div className={`bg-white rounded-2xl shadow-xl w-full ${isTagihan ? 'max-w-xl' : 'max-w-lg'} flex flex-col max-h-[80vh] relative animate-in zoom-in-95`}>
                        <button onClick={closeModal} className="absolute top-4 right-4 z-[200] w-8 h-8 flex items-center justify-center rounded-full bg-whisper text-steel hover:text-ink hover:bg-slate-200 transition-colors shadow-sm" style={{ cursor: 'pointer', pointerEvents: 'auto' }}><X className="w-5 h-5" /></button>
                        <div className="px-6 py-4 border-b border-whisper flex justify-between items-center bg-canvas/50 rounded-t-2xl pr-14 shrink-0"><h3 className="font-semibold text-ink">{isTagihan ? 'Master Tagihan & Pakasir' : simpleTitle}</h3></div>
                        <div className="p-6 overflow-y-auto space-y-6">
                            {isTagihan ? (
                                <><form onSubmit={async (e) => {
                                    e.preventDefault();
                                    const targetTagihan = String(formData.tagihan || '').trim();
                                    if (!targetTagihan) return showNotification('Nama tagihan tidak boleh kosong!');
                                    const nom = parseInt(formData.nominal?.toString().replace(/\D/g, '') || '0', 10);
                                    const biayaAp = parseInt(formData.biaya_aplikasi?.toString().replace(/\D/g, '') || '0', 10);
                                    const isEdit = masterTagihanList.some(x => x.tagihan.toLowerCase() === targetTagihan.toLowerCase());

                                    const itemToSave = {
                                        tagihan: targetTagihan,
                                        nominal: nom,
                                        tipe: formData.tipe || 'Rutin',
                                        pakasirSlug: formData.pakasirSlug || null,
                                        pakasirApiKey: formData.pakasirApiKey || null,
                                        portalMenu: Array.isArray(formData.portalMenu) ? JSON.stringify(formData.portalMenu) : (formData.portalMenu || '[]'),
                                        biaya_aplikasi: biayaAp
                                    };

                                    // Langsung simpan ke Supabase secara atomic (tidak menghapus kategori lain)
                                    const { error } = await supabase.from('MasterTagihan').upsert(itemToSave, { onConflict: 'tagihan' });
                                    if (error) {
                                        console.error("Gagal menyimpan MasterTagihan ke Supabase:", error);
                                        showNotification(`Gagal menyimpan: ${error.message}`);
                                        return;
                                    }

                                    // Update state lokal
                                    const localItem = {
                                        ...itemToSave,
                                        portalMenu: formData.portalMenu || []
                                    };
                                    setMasterTagihanList(prev => [...prev.filter(x => x.tagihan.toLowerCase() !== targetTagihan.toLowerCase()), localItem]);
                                    addLog(isEdit ? 'UPDATE' : 'CREATE', 'MASTER TAGIHAN', `${isEdit ? 'Edit' : 'Tambah'} master tagihan: ${targetTagihan}`);
                                    showNotification(`Kategori tagihan "${targetTagihan}" berhasil disimpan!`);
                                    setFormData({});
                                }} className="flex flex-col gap-4 border border-whisper p-4 rounded-xl">
                                    <div className="text-sm font-semibold text-steel">Tambah/Edit Tagihan</div>
                                    <div className="grid grid-cols-2 gap-4"><input required name="tagihan" value={formData.tagihan || ''} onChange={handleInputChange} type="text" className={inputBase} placeholder="Nama Tagihan" /><input required name="nominal" value={formData.nominal || ''} onChange={handleInputChange} type="text" className={inputBase} placeholder="Nominal Rp" /></div>
                                    <div className="bg-blue-50/50 p-3 rounded-lg border border-blue-100"><div className="text-xs font-semibold text-blue-700 mb-2">Integrasi Pakasir API & Portal</div>
                                        <div className="grid grid-cols-2 gap-4 mb-3"><input name="pakasirSlug" value={formData.pakasirSlug || ''} onChange={handleInputChange} type="text" className={`${inputBase} text-xs py-1.5 bg-white border-blue-200`} placeholder="Project Slug Pakasir" /><input name="pakasirApiKey" value={formData.pakasirApiKey || ''} onChange={handleInputChange} type="text" className={`${inputBase} text-xs py-1.5 bg-white border-blue-200`} placeholder="API Key Pakasir" /></div>
                                        <div className="mb-3"><input name="biaya_aplikasi" value={formData.biaya_aplikasi || ''} onChange={handleInputChange} type="text" className={`${inputBase} text-xs py-1.5 bg-white border-blue-200`} placeholder="Biaya Aplikasi (Otomatis ditambahkan saat bayar online)" /></div>
                                        <div><div className="text-[10px] font-semibold text-blue-800 mb-1.5 uppercase tracking-wider">Tampilkan di Portal Wali</div><div className="flex gap-4"><label className="flex items-center gap-1.5 text-xs text-blue-900 cursor-pointer"><input type="checkbox" checked={(formData.portalMenu || []).includes('Bayar Tagihan Lain')} onChange={(e) => { const pm = formData.portalMenu || []; setFormData(p => ({ ...p, portalMenu: e.target.checked ? [...pm, 'Bayar Tagihan Lain'].filter(x => x !== 'Sembunyikan') : pm.filter(x => x !== 'Bayar Tagihan Lain') })) }} className="rounded text-blue-600 w-3.5 h-3.5" /> Bayar Tagihan Lain</label><label className="flex items-center gap-1.5 text-xs text-rose-700 cursor-pointer"><input type="checkbox" checked={(formData.portalMenu || []).includes('Sembunyikan')} onChange={(e) => setFormData(p => ({ ...p, portalMenu: e.target.checked ? ['Sembunyikan'] : [] }))} className="rounded text-rose-600 w-3.5 h-3.5" /> Sembunyikan Saja</label></div></div>
                                    </div>
                                    <div className="flex gap-2 items-center"><select name="tipe" value={formData.tipe || 'Rutin'} onChange={handleInputChange} className={`${inputBase} w-1/3`}><option value="Rutin">Rutin (Bulanan)</option><option value="Insidental">Insidental (1x)</option></select><button type="submit" className={`${btnPrimary} flex-1`}><Plus className="w-4 h-4" /> Simpan Tagihan</button></div>
                                </form>
                                    <div className="hidden md:block border border-whisper rounded-card overflow-hidden">
                                        <table className="w-full text-sm text-left block">
                                            <thead className="bg-canvas"><tr className="flex w-full"><th className="px-4 py-2 flex-1">Jenis Tagihan</th><th className="px-4 py-2 w-32 text-right">Nominal</th><th className="px-4 py-2 w-20 text-center">Aksi</th></tr></thead>
                                            <tbody className="divide-y divide-slate-100 flex flex-col w-full max-h-48 overflow-y-auto">{masterTagihanList.map(t => (<tr key={t.tagihan} className="flex w-full items-center"><td className="px-4 py-3 flex-1"><div>{t.tagihan}</div><div className="text-[10px] text-steel font-medium uppercase mt-0.5">{t.tipe} {t.pakasirSlug && <span className="ml-2 text-emerald-600">V Pakasir</span>} {t.biaya_aplikasi ? <span className="ml-2 text-blue-600 border border-blue-200 px-1 rounded bg-blue-50">App Fee: Rp {Number(t.biaya_aplikasi).toLocaleString('id-ID')}</span> : ''} {Array.isArray(t.portalMenu) && t.portalMenu.includes('Sembunyikan') && <span className="ml-2 text-rose-500 text-[9px] border border-rose-200 px-1 rounded bg-rose-50">Sembunyi</span>}</div></td><td className="px-4 py-3 w-32 text-right font-medium">Rp {Number(t.nominal || 0).toLocaleString('id-ID')}</td><td className="px-4 py-3 w-20 flex items-center justify-center gap-3"><button onClick={() => {
    let pm = [];
    if (Array.isArray(t.portalMenu)) pm = t.portalMenu;
    else if (typeof t.portalMenu === 'string' && t.portalMenu.startsWith('[')) {
        try { pm = JSON.parse(t.portalMenu); } catch(e){}
    }
    setFormData({ tagihan: t.tagihan, nominal: (t.nominal || 0).toString(), tipe: t.tipe, pakasirSlug: t.pakasirSlug || '', pakasirApiKey: t.pakasirApiKey || '', portalMenu: pm, biaya_aplikasi: t.biaya_aplikasi ? t.biaya_aplikasi.toString() : '' });
}} className="text-accent hover:text-accentDark"><Edit className="w-4 h-4" /></button><button onClick={() => confirmDelete('MASTER_TAGIHAN', t.tagihan, t.tagihan)} className="text-rose-600 hover:text-red-700"><Trash2 className="w-4 h-4" /></button></td></tr>))}</tbody>
                                        </table>
                                    </div>
                                    <div className="md:hidden flex flex-col gap-2 max-h-64 overflow-y-auto pr-1">
                                        {masterTagihanList.map(t => (
                                            <div key={t.tagihan} className="border border-whisper rounded-lg p-3 bg-surface flex justify-between items-center">
                                                <div className="min-w-0 flex-1">
                                                    <div className="font-bold text-sm text-ink truncate">{t.tagihan}</div>
                                                    <div className="text-[10px] text-steel font-medium uppercase mt-1">{t.tipe} {t.pakasirSlug && <span className="ml-2 text-emerald-600">✓ Pakasir</span>} {Array.isArray(t.portalMenu) && t.portalMenu.includes('Sembunyikan') && <span className="ml-2 text-rose-500 text-[9px] border border-rose-200 px-1 rounded bg-rose-50">Sembunyi</span>}</div>
                                                </div>
                                                <div className="flex flex-col items-end gap-2 shrink-0">
                                                    <div className="font-bold text-sm text-ink">Rp {Number(t.nominal || 0).toLocaleString('id-ID')}</div>
                                                    <div className="flex items-center gap-1">
                                                        <button onClick={() => setFormData({ tagihan: t.tagihan, nominal: t.nominal.toString(), tipe: t.tipe, pakasirSlug: t.pakasirSlug || '', pakasirApiKey: t.pakasirApiKey || '', portalMenu: Array.isArray(t.portalMenu) ? t.portalMenu : [], biaya_aplikasi: t.biaya_aplikasi ? t.biaya_aplikasi.toString() : '' })} className="text-accent flex items-center gap-1 text-[10px] font-semibold bg-accent/10 px-2 py-1 rounded"><Edit className="w-3 h-3" /> Edit</button>
                                                        <button onClick={() => confirmDelete('MASTER_TAGIHAN', t.tagihan, t.tagihan)} className="text-danger flex items-center gap-1 text-[10px] font-semibold bg-dangerBg px-2 py-1 rounded"><Trash2 className="w-3 h-3" /> Hapus</button>
                                                    </div>
                                                </div>
                                            </div>
                                        ))}
                                    </div></>
                            ) : (
                                <><form onSubmit={(e) => {
                                    e.preventDefault();
                                    const val = (formData[simpleField] || '').trim();
                                    if (!val) return;
                                    simpleSetList(prev => {
                                        if (prev.some(item => item.toLowerCase().trim() === val.toLowerCase())) return prev;
                                        return [...prev, val];
                                    });
                                    setFormData({});
                                }} className="flex gap-2"><input required name={simpleField} value={formData[simpleField] || ''} onChange={handleInputChange} type="text" className={inputBase} placeholder={`Tambah ${simpleTitle.replace('Master ', '')}`} /><button type="submit" className={btnPrimary}><Plus className="w-4 h-4" /></button></form>
                                    <div className="flex flex-wrap gap-2">{simpleList.map(item => (<span key={item} className="px-3 py-1 bg-canvas text-steel rounded-full text-sm border border-whisper flex items-center gap-2">{item} <button onClick={() => confirmDelete(modalType, item, item)} className="hover:text-rose-600"><X className="w-3 h-3" /></button></span>))}</div></>
                            )}
                        </div>
                    </div>
                </div>
            );
        }
        return null;
    };

    // === RENDER PENGATURAN (SETTINGS) ===
    const renderPengaturan = () => {
        const handleLogoUpload = (e) => {
            const file = e.target.files[0];
            if (!file) return;
            if (file.size > 500000) { showNotification('Ukuran logo maks 500KB.'); return; }
            const reader = new FileReader();
            reader.onload = (ev) => {
                setAppConfig(prev => ({ ...prev, appLogo: ev.target.result }));
                showNotification('Logo berhasil diunggah!');
            };
            reader.readAsDataURL(file);
        };

        const handleSaveBranding = async (e) => {
            e.preventDefault();
            
            // Simpan ke MasterConfig secara atomic
            const configEntries = Object.entries(appConfig).map(([kunci, nilai]) => ({
                kunci,
                nilai: typeof nilai === 'object' ? JSON.stringify(nilai) : (nilai === null || nilai === undefined ? '' : String(nilai))
            }));
            const { error: cErr } = await supabase.from('MasterConfig').upsert(configEntries, { onConflict: 'kunci' });
            if (cErr) {
                console.error("Gagal simpan branding ke MasterConfig:", cErr);
                return showNotification(`Gagal menyimpan: ${cErr.message}`);
            }
            
            // Sinkronisasi ke tabel Pengaturan untuk Portal & POS
            if (appConfig.pakasirSlug) {
                await supabase.from('Pengaturan').upsert({ Kunci: 'PAKASIR_DOMAIN', Nilai: appConfig.pakasirSlug }, { onConflict: 'Kunci' });
            }
            if (appConfig.pakasirApiKey) {
                await supabase.from('Pengaturan').upsert({ Kunci: 'PAKASIR_APIKEY', Nilai: appConfig.pakasirApiKey }, { onConflict: 'Kunci' });
            }
            if (appConfig.appName) {
                await supabase.from('Pengaturan').upsert({ Kunci: 'APP_NAME', Nilai: appConfig.appName }, { onConflict: 'Kunci' });
            }
            if (appConfig.appLogo) {
                await supabase.from('Pengaturan').upsert({ Kunci: 'APP_LOGO', Nilai: appConfig.appLogo }, { onConflict: 'Kunci' });
            }
            
            showNotification('Pengaturan Branding berhasil disimpan permanen!');
            addLog('UPDATE', 'PENGATURAN', `Branding diubah: "${appConfig.appName}"`);
        };

        const handleSaveAdmin = (e) => {
            e.preventDefault();
            const { adminUsername, adminNama, adminPassword, adminId } = formData;
            if (!adminUsername || !adminNama || !adminPassword) return;
            if (adminId) {
                setDataAdmin(prev => prev.map(a => a.id === adminId ? { ...a, username: adminUsername, nama: adminNama, password: adminPassword } : a));
                addLog('UPDATE', 'ADMIN', `Edit admin: ${adminNama}`);
            } else {
                const dup = dataAdmin.find(a => a.username === adminUsername);
                if (dup) { showNotification('Username sudah ada!'); return; }
                setDataAdmin(prev => [...prev, { id: `ADM-${Date.now()}`, username: adminUsername, nama: adminNama, password: adminPassword, role: 'superadmin' }]);
                addLog('CREATE', 'ADMIN', `Tambah admin: ${adminNama}`);
            }
            setFormData({});
            showNotification('Data admin berhasil disimpan!');
        };

        const toggleMenuAccess = async (jabatan, menuId) => {
            let updatedList = [];
            setDataRoleAccess(prev => {
                const existing = prev.find(r => r.jabatan === jabatan);
                if (existing) {
                    const menus = Array.isArray(existing.aksesMenu) ? existing.aksesMenu : [];
                    const updated = menus.includes(menuId) ? menus.filter(m => m !== menuId) : [...menus, menuId];
                    updatedList = prev.map(r => r.jabatan === jabatan ? { ...r, aksesMenu: updated } : r);
                } else {
                    updatedList = [...prev, { jabatan, aksesMenu: [menuId] }];
                }
                return updatedList;
            });

            // Cari data role yang baru saja diupdate
            const roleItem = updatedList.find(r => r.jabatan === jabatan) || { jabatan, aksesMenu: [] };
            const aksesStr = Array.isArray(roleItem.aksesMenu) ? roleItem.aksesMenu.join(',') : (roleItem.aksesMenu || '');

            // Langsung simpan atomic upsert ke Supabase
            const { error } = await supabase.from('MasterRoleAccess').upsert({
                jabatan,
                aksesMenu: aksesStr
            }, { onConflict: 'jabatan' });

            if (error) {
                console.error("Gagal simpan hak akses ke Supabase:", error);
                showNotification("Gagal menyimpan hak akses: " + error.message);
            }
        };

        const handleSaveAllRoleAccess = async () => {
            const payload = masterJabatanList.map(j => {
                const r = dataRoleAccess.find(x => x.jabatan === j);
                const menus = r ? (Array.isArray(r.aksesMenu) ? r.aksesMenu.join(',') : r.aksesMenu) : '';
                return { jabatan: j, aksesMenu: menus };
            });
            const { error } = await supabase.from('MasterRoleAccess').upsert(payload, { onConflict: 'jabatan' });
            if (error) {
                showNotification("Gagal menyimpan hak akses: " + error.message);
            } else {
                showNotification("Seluruh hak akses berhasil disimpan permanen!");
                addLog('UPDATE', 'HAK AKSES', 'Memperbarui seluruh hak akses jabatan');
            }
        };

        const menuOptions = allMenuItems.filter(m => m.id !== 'pengaturan');

        return (
            <div className="space-y-6 animate-fade-in-up">
                <div><h2 className="text-2xl font-bold tracking-tight text-ink">Pengaturan Sistem</h2><p className="text-sm text-steel mt-1">Kelola branding, akun admin, dan hak akses pengguna.</p></div>
                <div className="flex gap-2 border-b border-whisper pb-0">
                    {[{ id: 'branding', label: 'Branding' }, { id: 'admin', label: 'Manajemen Admin' }, { id: 'rbac', label: 'Hak Akses' }, { id: 'backup', label: 'Backup Data' }].map(t => (
                        <button key={t.id} onClick={() => { setSettingsTab(t.id); if (t.id === 'backup' && backupList.length === 0) fetchBackups(); }} className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors -mb-px whitespace-nowrap ${settingsTab === t.id ? 'border-accent text-accent' : 'border-transparent text-steel hover:text-ink'}`}>{t.label}</button>
                    ))}
                </div>

                {settingsTab === 'branding' && (
                    <form onSubmit={handleSaveBranding} className="bg-surface border border-whisper rounded-card p-8 space-y-6 shadow-card max-w-2xl">
                        <div><label className="block text-sm font-semibold text-ink mb-2">Nama Aplikasi</label><input name="appName" value={appConfig.appName || ''} onChange={(e) => setAppConfig(prev => ({ ...prev, appName: e.target.value }))} className={inputBase} placeholder="Nama Pesantren / Institusi" /></div>
                        <div>
                            <label className="block text-sm font-semibold text-ink mb-2">Logo Aplikasi</label>
                            <div className="flex items-center gap-6">
                                <div className="w-20 h-20 rounded-card bg-canvas border-2 border-dashed border-whisper flex items-center justify-center overflow-hidden shrink-0">
                                    {appConfig.appLogo ? <img src={appConfig.appLogo} className="w-full h-full object-contain" /> : <Wallet className="w-8 h-8 text-slate" />}
                                </div>
                                <div className="flex-1">
                                    <input type="file" accept="image/*" onChange={handleLogoUpload} className="text-sm text-steel file:mr-4 file:py-2 file:px-4 file:rounded-xl file:border-0 file:text-sm file:font-semibold file:bg-accent/10 file:text-accent hover:file:bg-accent/20 cursor-pointer" />
                                    <p className="text-xs text-slate mt-1">Format: PNG, JPG, SVG. Maks 500KB.</p>
                                </div>
                            </div>
                        </div>
                        <div className="pt-4 border-t border-whisper mt-4">
                            <div className="flex justify-between items-center mb-2">
                                <label className="block text-sm font-semibold text-ink">Kontak Pengurus (Pusat Bantuan)</label>
                                <button type="button" onClick={() => setAppConfig(prev => ({ ...prev, adminContacts: [...(prev.adminContacts || []), { nama: '', phone: '' }] }))} className="text-xs font-bold text-accent hover:text-accentDark bg-accent/10 px-2 py-1 rounded">+ Tambah Kontak</button>
                            </div>
                            {(appConfig.adminContacts || []).map((contact, idx) => (
                                <div key={idx} className="flex gap-2 mb-2 items-center">
                                    <input value={contact.nama} onChange={(e) => {
                                        const newContacts = [...(appConfig.adminContacts || [])];
                                        newContacts[idx] = { ...newContacts[idx], nama: e.target.value };
                                        setAppConfig(prev => ({ ...prev, adminContacts: newContacts }));
                                    }} className={inputBase} placeholder="Nama (Misal: Ustadz Budi)" />
                                    <input value={contact.phone} onChange={(e) => {
                                        const newContacts = [...(appConfig.adminContacts || [])];
                                        newContacts[idx] = { ...newContacts[idx], phone: e.target.value };
                                        setAppConfig(prev => ({ ...prev, adminContacts: newContacts }));
                                    }} className={inputBase} placeholder="No HP (628...)" />
                                    <button type="button" onClick={() => {
                                        const newContacts = (appConfig.adminContacts || []).filter((_, i) => i !== idx);
                                        setAppConfig(prev => ({ ...prev, adminContacts: newContacts }));
                                    }} className="p-2 text-danger hover:bg-danger/10 rounded-lg shrink-0">
                                        <Trash2 className="w-4 h-4" />
                                    </button>
                                </div>
                            ))}
                            {(appConfig.adminContacts || []).length === 0 && <p className="text-xs text-slate italic mb-2">Belum ada kontak. Klik Tambah Kontak.</p>}
                            <p className="text-xs text-slate mt-1">Daftar kontak ini akan ditampilkan di menu Pusat Bantuan pada Portal Wali.</p>
                        </div>
                        <div className="pt-4 border-t border-whisper mt-4">
                            <h3 className="text-sm font-semibold text-ink mb-3">Integrasi Pakasir (Global)</h3>
                            <div className="grid grid-cols-2 gap-4">
                                <div><label className="block text-xs font-medium text-steel mb-1">Project Slug Default</label><input name="pakasirSlug" value={appConfig.pakasirSlug || ''} onChange={(e) => setAppConfig(prev => ({ ...prev, pakasirSlug: e.target.value }))} className={inputBase} placeholder="depodomain" /></div>
                                <div><label className="block text-xs font-medium text-steel mb-1">API Key Default</label><input name="pakasirApiKey" value={appConfig.pakasirApiKey || ''} onChange={(e) => setAppConfig(prev => ({ ...prev, pakasirApiKey: e.target.value }))} className={inputBase} placeholder="xxx123" /></div>
                            </div>
                            <p className="text-xs text-steel mt-2">Digunakan untuk fitur Top-Up Tabungan, atau sebagai cadangan jika Master Tagihan tidak memiliki konfigurasi API sendiri.</p>
                        </div>
                        <button type="submit" className={btnPrimary}>Simpan Pengaturan</button>
                    </form>
                )}

                {settingsTab === 'admin' && (
                    <div className="space-y-4 max-w-3xl">
                        <form onSubmit={handleSaveAdmin} className="bg-surface border border-whisper rounded-card p-6 shadow-card">
                            <div className="text-sm font-bold text-ink mb-4">{formData.adminId ? 'Edit Admin' : 'Tambah Admin Baru'}</div>
                            <div className="grid grid-cols-3 gap-4 mb-4">
                                <div><label className="block text-xs font-semibold text-steel mb-1">Username</label><input required name="adminUsername" value={formData.adminUsername || ''} onChange={handleInputChange} className={inputBase} placeholder="username" /></div>
                                <div><label className="block text-xs font-semibold text-steel mb-1">Nama Lengkap</label><input required name="adminNama" value={formData.adminNama || ''} onChange={handleInputChange} className={inputBase} placeholder="Nama Admin" /></div>
                                <div><label className="block text-xs font-semibold text-steel mb-1">Password</label><input required name="adminPassword" value={formData.adminPassword || ''} onChange={handleInputChange} className={inputBase} placeholder="Password" /></div>
                            </div>
                            <div className="flex gap-2">
                                <button type="submit" className={btnPrimary}><Plus className="w-4 h-4" /> {formData.adminId ? 'Update' : 'Tambah'}</button>
                                {formData.adminId && <button type="button" onClick={() => setFormData({})} className={btnOutline}>Batal Edit</button>}
                            </div>
                        </form>
                        <div className="bg-surface border border-whisper rounded-card overflow-hidden shadow-card">
                            <div className="overflow-x-auto hidden md:block">
                                <table className="w-full text-sm text-left">
                                    <thead className="bg-canvas border-b border-whisper"><tr><th className="px-6 py-3 font-semibold text-steel text-xs uppercase tracking-wider">Username</th><th className="px-6 py-3 font-semibold text-steel text-xs uppercase tracking-wider">Nama</th><th className="px-6 py-3 font-semibold text-steel text-xs uppercase tracking-wider">Role</th><th className="px-6 py-3 text-center font-semibold text-steel text-xs uppercase tracking-wider">Aksi</th></tr></thead>
                                    <tbody className="divide-y divide-whisper">{dataAdmin.map(a => (
                                        <tr key={a.id} className="hover:bg-canvas transition-colors">
                                            <td className="px-6 py-3 font-mono text-sm">{a.username}</td>
                                            <td className="px-6 py-3 font-medium">{a.nama}</td>
                                            <td className="px-6 py-3"><span className="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-pale-blue text-pale-blueText uppercase tracking-wide">{a.role}</span></td>
                                            <td className="px-6 py-3 text-center">
                                                <div className="flex items-center justify-center gap-2">
                                                    <button onClick={() => setFormData({ adminId: a.id, adminUsername: a.username, adminNama: a.nama, adminPassword: a.password })} className="text-accent hover:text-accentDark"><Edit className="w-4 h-4" /></button>
                                                    <button onClick={() => { if (dataAdmin.length <= 1) { showNotification('Minimal harus ada 1 admin.'); return; } setDataAdmin(prev => prev.filter(x => x.id !== a.id)); addLog('DELETE', 'ADMIN', `Hapus admin: ${a.nama}`); }} className="text-danger hover:text-red-700"><Trash2 className="w-4 h-4" /></button>
                                                </div>
                                            </td>
                                        </tr>
                                    ))}</tbody>
                                </table>
                            </div>
                            <div className="md:hidden flex flex-col divide-y divide-whisper">
                                {dataAdmin.map(a => (
                                    <div key={a.id} className="p-4 bg-surface flex flex-col gap-3">
                                        <div className="flex justify-between items-start gap-3">
                                            <div className="min-w-0">
                                                <div className="font-bold text-ink text-sm truncate">{a.nama}</div>
                                                <div className="text-[10px] text-steel font-mono mt-0.5">{a.username}</div>
                                            </div>
                                            <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-pale-blue text-pale-blueText uppercase tracking-wide shrink-0">{a.role}</span>
                                        </div>
                                        <div className="flex items-center gap-2 justify-end mt-1 pt-3 border-t border-whisper/50">
                                            <button onClick={() => setFormData({ adminId: a.id, adminUsername: a.username, adminNama: a.nama, adminPassword: a.password })} className="flex items-center gap-1 text-accent bg-accent/5 hover:bg-accent/10 font-bold text-xs px-3 py-1.5 rounded-lg border border-accent/10"><Edit className="w-3.5 h-3.5" /> Edit</button>
                                            <button onClick={() => { if (dataAdmin.length <= 1) { showNotification('Minimal harus ada 1 admin.'); return; } setDataAdmin(prev => prev.filter(x => x.id !== a.id)); addLog('DELETE', 'ADMIN', `Hapus admin: ${a.nama}`); }} className="flex items-center gap-1 text-danger bg-dangerBg hover:bg-red-100 font-medium text-xs px-3 py-1.5 rounded-lg border border-red-100"><Trash2 className="w-3.5 h-3.5" /> Hapus</button>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    </div>
                )}

                {settingsTab === 'backup' && (
                    <div className="space-y-4 max-w-3xl animate-in fade-in">
                        <div className="bg-surface border border-whisper rounded-card p-6 shadow-card">
                            <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-6">
                                <div>
                                    <h3 className="text-lg font-bold text-ink">Manajemen Backup</h3>
                                    <p className="text-xs text-steel mt-1">Lihat dan unduh file backup harian (Otomatis setiap jam 12 malam).</p>
                                </div>
                                <button onClick={fetchBackups} className={btnOutline} disabled={loadingBackups}>
                                    <RefreshCw className={`w-4 h-4 ${loadingBackups ? 'animate-spin' : ''}`} /> Segarkan
                                </button>
                            </div>

                            <div className="mb-6 p-4 bg-blue-50 border border-blue-100 rounded-xl text-sm text-blue-800 leading-relaxed shadow-sm">
                                <div className="font-bold flex items-center gap-2 mb-1"><AlertCircle className="w-4 h-4" /> Informasi Penting</div>
                                Sistem secara otomatis akan membuat salinan (copy) dari Google Sheets utama Bapak/Ibu setiap jam 12 malam ke folder <strong>BACKUP_SISTEM_KEUANGAN</strong> di Google Drive. File di bawah ini adalah file <i>Read-Only</i> dan jika dibuka <strong>tidak akan mengubah atau mereset data live</strong> aplikasi Bapak/Ibu.
                            </div>

                            <div className="flex gap-2 mb-4">
                                <button onClick={forceBackup} disabled={loadingBackups} className={`${btnPrimary} flex items-center gap-2 px-5`}>
                                    {loadingBackups ? <RefreshCw className="w-4 h-4 animate-spin" /> : <DownloadCloud className="w-4 h-4" />}
                                    Backup Sekarang (Manual)
                                </button>
                            </div>

                            <div className="bg-canvas border border-whisper rounded-xl overflow-hidden shadow-sm">
                                <table className="w-full text-sm text-left">
                                    <thead className="bg-whisper/50 text-steel text-xs uppercase tracking-wider border-b border-whisper">
                                        <tr><th className="px-5 py-4">Nama File Spreadsheet</th><th className="px-5 py-4 w-48">Waktu Dibuat</th><th className="px-5 py-4 w-32 text-center">Aksi</th></tr>
                                    </thead>
                                    <tbody className="divide-y divide-whisper">
                                        {loadingBackups && backupList.length === 0 ? (
                                            <tr><td colSpan="3" className="px-5 py-12 text-center text-steel"><RefreshCw className="w-6 h-6 animate-spin mx-auto mb-2 text-accent" /> Memuat data backup...</td></tr>
                                        ) : backupList.length === 0 ? (
                                            <tr><td colSpan="3" className="px-5 py-12 text-center text-steel">Belum ada file backup yang ditemukan.</td></tr>
                                        ) : backupList.map((b, i) => (
                                            <tr key={i} className="hover:bg-whisper/40 transition-colors bg-white">
                                                <td className="px-5 py-4 font-medium text-ink flex items-center gap-3">
                                                    <div className="p-2 bg-emerald-50 rounded-lg"><FileSpreadsheet className="w-4 h-4 text-emerald-600" /></div>
                                                    {b.name}
                                                </td>
                                                <td className="px-5 py-4 text-steel text-xs">{b.dateCreated}</td>
                                                <td className="px-5 py-4 text-center">
                                                    <a href={b.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center justify-center gap-1.5 px-4 py-2 bg-white border border-slate-200 rounded-lg text-xs font-semibold text-accent hover:bg-slate-50 hover:border-slate-300 transition-all shadow-sm w-full">
                                                        Buka <ExternalLink className="w-3.5 h-3.5" />
                                                    </a>
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    </div>
                )}

                {settingsTab === 'rbac' && (
                    <>
                        <div className="flex justify-between items-center bg-blue-50/50 p-4 rounded-xl border border-blue-100 max-w-4xl mb-4">
                            <div>
                                <h3 className="text-sm font-bold text-blue-900">Hak Akses Jabatan (RBAC)</h3>
                                <p className="text-xs text-blue-700">Centang menu yang dapat diakses oleh masing-masing jabatan. Setiap perubahan tersimpan otomatis ke database.</p>
                            </div>
                            <button type="button" onClick={handleSaveAllRoleAccess} className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-xs font-semibold shadow-sm flex items-center gap-1.5 shrink-0">
                                <Check className="w-4 h-4" /> Simpan Semua Hak Akses
                            </button>
                        </div>
                        <div className="hidden md:block bg-surface border border-whisper rounded-card overflow-x-auto shadow-card max-w-4xl">
                            <table className="w-full text-sm text-left">
                                <thead className="bg-canvas border-b border-whisper">
                                    <tr>
                                        <th className="px-4 py-3 font-semibold text-steel text-xs uppercase tracking-wider sticky left-0 bg-canvas z-10">Jabatan / Divisi</th>
                                        {menuOptions.map(m => <th key={m.id} className="px-3 py-3 font-semibold text-steel text-xs uppercase tracking-wider text-center whitespace-nowrap">{m.label}</th>)}
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-whisper">
                                    {masterJabatanList.map(jabatan => {
                                        const roleData = dataRoleAccess.find(r => r.jabatan === jabatan);
                                        const menus = roleData ? (Array.isArray(roleData.aksesMenu) ? roleData.aksesMenu : []) : [];
                                        return (
                                            <tr key={jabatan} className="hover:bg-canvas transition-colors">
                                                <td className="px-4 py-3 font-medium text-ink sticky left-0 bg-surface z-10">{jabatan}</td>
                                                {menuOptions.map(m => (
                                                    <td key={m.id} className="px-3 py-3 text-center">
                                                        <input type="checkbox" checked={menus.includes(m.id)} onChange={() => toggleMenuAccess(jabatan, m.id)} className="w-4 h-4 rounded border-whisper text-accent focus:ring-accent/30 cursor-pointer" />
                                                    </td>
                                                ))}
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>
                        <div className="md:hidden flex flex-col gap-4">
                            {masterJabatanList.map(jabatan => {
                                const roleData = dataRoleAccess.find(r => r.jabatan === jabatan);
                                const menus = roleData ? (Array.isArray(roleData.aksesMenu) ? roleData.aksesMenu : []) : [];
                                return (
                                    <div key={jabatan} className="bg-surface border border-whisper rounded-card p-4 shadow-sm">
                                        <div className="font-bold text-ink mb-3">{jabatan}</div>
                                        <div className="grid grid-cols-2 gap-3">
                                            {menuOptions.map(m => (
                                                <label key={m.id} className="flex items-center gap-2 cursor-pointer p-2 rounded-lg hover:bg-canvas transition-colors border border-whisper/50">
                                                    <input type="checkbox" checked={menus.includes(m.id)} onChange={() => toggleMenuAccess(jabatan, m.id)} className="w-4 h-4 rounded border-whisper text-accent focus:ring-accent/30 cursor-pointer" />
                                                    <span className="text-xs font-medium text-steel">{m.label}</span>
                                                </label>
                                            ))}
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </>
                )}
            </div>
        );
    };

    // === RENDER LOGIN SCREEN ===
    const renderLoginScreen = () => (
        <div className="min-h-[100dvh] bg-canvas flex">
            <div className="hidden lg:flex lg:w-1/2 bg-ink items-center justify-center p-16 relative overflow-hidden">
                <div className="absolute inset-0 opacity-[0.03]" style={{ backgroundImage: 'radial-gradient(circle at 1px 1px, white 1px, transparent 0)', backgroundSize: '32px 32px' }}></div>
                <div className="relative z-10 text-white max-w-md">
                    <div className={`flex items-center justify-center mb-8 ${appConfig.appLogo ? '' : 'w-14 h-14 rounded-2xl bg-accent shadow-lg'}`}>
                        {appConfig.appLogo ? <img src={appConfig.appLogo} className="h-16 object-contain" /> : <Wallet className="w-7 h-7 text-white" />}
                    </div>
                    <h1 className="text-4xl font-extrabold tracking-tight leading-[1.1] mb-4">{appConfig.appName || 'PesantrenTech'}</h1>
                    <p className="text-white/60 text-lg leading-relaxed">Sistem informasi keuangan pesantren yang terintegrasi dan terpercaya.</p>
                    <div className="mt-12 flex gap-8">
                        <div><div className="text-3xl font-bold text-accent">{dataSantri.length}</div><div className="text-white/40 text-sm mt-1">Total Santri</div></div>
                        <div><div className="text-3xl font-bold text-accent">{dataPegawai.length}</div><div className="text-white/40 text-sm mt-1">Total Pegawai</div></div>
                    </div>
                </div>
            </div>
            <div className="flex-1 flex items-center justify-center p-6 sm:p-12">
                <div className="w-full max-w-sm">
                    <div className="lg:hidden flex items-center gap-3 mb-10">
                        <div className={`flex items-center justify-center ${appConfig.appLogo ? '' : 'w-10 h-10 rounded-xl bg-accent'}`}>
                            {appConfig.appLogo ? <img src={appConfig.appLogo} className="h-10 object-contain" /> : <Wallet className="w-5 h-5 text-white" />}
                        </div>
                        <span className="font-bold text-xl tracking-tight text-ink">{appConfig.appName || 'PesantrenTech'}</span>
                    </div>
                    <h2 className="text-2xl font-bold tracking-tight text-ink mb-1">Masuk ke Sistem</h2>
                    <p className="text-steel text-sm mb-8">Masukkan kredensial Anda (Username atau NIP).</p>
                    <form onSubmit={handleLogin} className="space-y-4">
                        <div>
                            <label className="block text-sm font-semibold text-ink mb-1.5">Username / NIP</label>
                            <input name="loginUser" value={formData.loginUser || ''} onChange={handleInputChange} className={inputBase} placeholder="Masukkan Username atau NIP" autoComplete="username" />
                        </div>
                        <div>
                            <label className="block text-sm font-semibold text-ink mb-1.5">Password</label>
                            <input name="loginPass" type="password" value={formData.loginPass || ''} onChange={handleInputChange} className={inputBase} placeholder="Masukkan password" autoComplete="current-password" />
                        </div>
                        {loginError && <div className="text-danger text-sm font-medium bg-dangerBg px-4 py-2.5 rounded-xl border border-red-200">{loginError}</div>}
                        <button type="submit" className={`${btnPrimary} w-full justify-center py-3`}>Masuk</button>
                    </form>
                    <p className="text-xs text-slate text-center mt-8">Hubungi administrator jika Anda belum memiliki akses.</p>
                </div>
            </div>
        </div>
    );

    // === MAIN RETURN (Login Guard) ===
    if (!mounted) return null;
    if (!isLoggedIn) return renderLoginScreen();

    return (
        <div className="min-h-[100dvh] bg-canvas text-ink font-sans selection:bg-accent/20">
            <nav className="sticky top-0 z-30 bg-surface/80 backdrop-blur-xl border-b border-whisper h-16 flex items-center justify-between px-6 sm:px-10">
                <div className="flex items-center gap-3">
                    <div className={`flex items-center justify-center ${appConfig.appLogo ? '' : 'w-9 h-9 rounded-xl bg-accent shadow-sm'}`}>
                        {appConfig.appLogo ? <img src={appConfig.appLogo} className="h-9 object-contain" /> : <Wallet className="text-white w-5 h-5" />}
                    </div>
                    <span className="font-bold text-lg tracking-tight text-ink">{appConfig.appName || 'PesantrenTech'}</span>
                </div>
                <div className="flex items-center gap-5">
                    <div className="hidden sm:flex items-center gap-2 text-sm text-steel">
                        <User className="w-4 h-4" />
                        <span className="font-medium text-ink">{currentUser?.nama}</span>
                        <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-accent/10 text-accent uppercase tracking-wider">{currentUser?.role === 'superadmin' ? 'Admin' : currentUser?.jabatan}</span>
                    </div>
                    <button onClick={handleLogout} className="flex flex-col items-center gap-0.5 text-danger hover:bg-dangerBg rounded-xl px-3 py-1.5 transition-colors" title="Keluar">
                        <ArrowDownCircle className="w-5 h-5" />
                        <span className="text-[10px] font-semibold leading-none">Keluar</span>
                    </button>
                </div>
            </nav>
            <div className="max-w-[1400px] mx-auto flex gap-0 h-[calc(100dvh-4rem)] relative">
                {/* Desktop Sidebar */}
                <aside className="hidden md:flex w-60 flex-shrink-0 flex-col gap-0.5 p-5 pr-0 pl-4 border-r border-whisper overflow-y-auto">
                    {getVisibleMenus().map(item => (
                        <button key={item.id} onClick={() => setActiveTab(item.id)} className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl transition-all font-medium text-sm ${activeTab === item.id ? 'bg-accent/10 text-accent' : 'text-steel hover:bg-canvas hover:text-ink'}`}>
                            <item.icon className={`w-[18px] h-[18px] ${activeTab === item.id ? 'text-accent' : 'text-slate'}`} /> {item.label}
                        </button>
                    ))}
                    <div className="mt-4 pt-4 border-t border-whisper px-1">
                        <button onClick={() => { setModalType('CEK_SALDO'); setScanResult(null); setScanInput(''); setTimeout(() => scanInputRef.current?.focus(), 100); }} className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl transition-all font-bold text-sm bg-indigo-50 text-indigo-600 hover:bg-indigo-100 border border-indigo-100 shadow-sm">
                            <Scan className="w-[18px] h-[18px]" /> Cek Saldo (RFID)
                        </button>
                    </div>
                </aside>

                {/* Main Content Area */}
                <main className="flex-1 overflow-y-auto pb-24 md:pb-0 relative h-full p-4 md:p-8">
                    {activeTab === 'dashboard' && renderDashboard()}
                    {activeTab === 'santri' && renderDataSantri()}
                    {activeTab === 'pegawai' && renderDataPegawai()}
                    {activeTab === 'tagihan' && renderTagihan()}
                    {activeTab === 'pembayaran' && renderPembayaran()}
                    {activeTab === 'tabungan' && renderTabungan()}
                    {activeTab === 'penggajian' && renderPenggajian()}
                    {activeTab === 'bukukas' && renderBukuKas()}
                    {activeTab === 'pencairan' && renderPencairanWarung()}
                    {activeTab === 'log' && renderLogAktivitas()}
                    {activeTab === 'pengaturan' && renderPengaturan()}
                </main>
            </div>

            {/* Mobile Bottom Navigation */}
            <div className="md:hidden fixed bottom-0 left-0 right-0 bg-surface/90 backdrop-blur-xl border-t border-whisper px-2 py-2 pb-safe flex items-center justify-around z-40">
                {[{ id: 'dashboard', icon: LayoutDashboard, label: 'Home' }, { id: 'tagihan', icon: FileText, label: 'Tagihan' }, { id: 'pembayaran', icon: CreditCard, label: 'Bayar' }].map(item => {
                    const isAllowed = getVisibleMenus().some(m => m.id === item.id);
                    if (!isAllowed) return null;
                    const isActive = activeTab === item.id;
                    return (
                        <button key={item.id} onClick={() => { setActiveTab(item.id); setShowMobileMenu(false); }} className={`flex flex-col items-center gap-1 p-2 min-w-[64px] ${isActive ? 'text-accent' : 'text-slate hover:text-steel'}`}>
                            <div className={`p-1.5 rounded-xl ${isActive ? 'bg-accent/10' : ''}`}><item.icon className={`w-5 h-5 ${isActive ? 'text-accent' : ''}`} /></div>
                            <span className={`text-[10px] font-medium ${isActive ? 'text-accent' : ''}`}>{item.label}</span>
                        </button>
                    );
                })}
                <button onClick={() => setShowMobileMenu(!showMobileMenu)} className={`flex flex-col items-center gap-1 p-2 min-w-[64px] ${showMobileMenu ? 'text-accent' : 'text-slate hover:text-steel'}`}>
                    <div className={`p-1.5 rounded-xl ${showMobileMenu ? 'bg-accent/10' : ''}`}><Menu className={`w-5 h-5 ${showMobileMenu ? 'text-accent' : ''}`} /></div>
                    <span className={`text-[10px] font-medium ${showMobileMenu ? 'text-accent' : ''}`}>Menu</span>
                </button>
            </div>

            {/* Mobile Full Menu Drawer */}
            {showMobileMenu && (
                <div className="md:hidden fixed inset-0 z-30 bg-surface/95 backdrop-blur-sm pt-16 pb-24 px-4 overflow-y-auto animate-in slide-in-from-bottom-4 fade-in duration-300">
                    <h3 className="text-xs font-bold text-steel uppercase tracking-wider mb-4 px-2">Semua Menu</h3>
                    <div className="grid grid-cols-4 gap-4">
                        {getVisibleMenus().map(item => (
                            <button key={item.id} onClick={() => { setActiveTab(item.id); setShowMobileMenu(false); }} className="flex flex-col items-center gap-2 p-3 bg-canvas border border-whisper rounded-2xl hover:border-accent/50 hover:bg-accent/5 transition-all">
                                <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${activeTab === item.id ? 'bg-accent text-white' : 'bg-surface text-steel'}`}>
                                    <item.icon className="w-5 h-5" />
                                </div>
                                <span className={`text-[11px] font-medium text-center ${activeTab === item.id ? 'text-accent font-bold' : 'text-steel'}`}>{item.label}</span>
                            </button>
                        ))}
                    </div>
                    <div className="mt-6 pt-6 border-t border-whisper">
                        <button onClick={() => { setModalType('CEK_SALDO'); setScanResult(null); setScanInput(''); setShowMobileMenu(false); setTimeout(() => scanInputRef.current?.focus(), 100); }} className="w-full flex items-center justify-center gap-2 p-4 bg-indigo-50 border border-indigo-200 rounded-2xl text-indigo-700 font-bold active:bg-indigo-100 transition-all">
                            <Scan className="w-5 h-5" /> Cek Saldo via RFID
                        </button>
                    </div>
                    <button onClick={() => setShowMobileMenu(false)} className="mt-8 w-full p-4 bg-surface text-steel font-bold rounded-2xl active:bg-whisper border border-whisper">Tutup Menu</button>
                </div>
            )}

            {renderModals()}

            {/* Modal Detail Tabungan POS (Dapat dibuka dari Tabungan & Rekap Warung) */}
            {detailTabunganModal && (
                <FormWrapper title="Detail Belanja Kantin (POS)" onClose={() => setDetailTabunganModal(null)} customFooter={
                    <div className="px-6 py-4 bg-canvas border-t border-whisper flex justify-end gap-3 shrink-0 rounded-b-card w-full">
                        <button type="button" onClick={() => setDetailTabunganModal(null)} className={btnOutline}>Tutup</button>
                    </div>
                }>
                    {detailTabunganModal.loading ? (
                        <div className="text-center py-8 text-steel"><RefreshCw className="w-5 h-5 animate-spin inline mr-2" />Memuat detail transaksi...</div>
                    ) : (
                        <div className="space-y-4">
                            {/* Header Info */}
                            <div className="p-4 bg-gradient-to-br from-slate-50 to-blue-50 border border-slate-200 rounded-xl space-y-2">
                                <div className="flex justify-between items-start">
                                    <div>
                                        <div className="text-xs text-steel">Santri / Pembeli</div>
                                        <div className="font-bold text-ink text-base">{detailTabunganModal.trx.nama}</div>
                                        {detailTabunganModal.trx.nis && detailTabunganModal.trx.nis !== '-' && (
                                            <div className="text-xs text-steel">NIS: {detailTabunganModal.trx.nis}</div>
                                        )}
                                    </div>
                                    <div className="text-right">
                                        <div className="text-xs text-steel">Total Belanja</div>
                                        <div className="font-bold text-rose-600 text-lg">Rp {Number(detailTabunganModal.trx.nominal || 0).toLocaleString('id-ID')}</div>
                                    </div>
                                </div>
                                <div className="border-t border-slate-200 pt-2 grid grid-cols-2 gap-2 text-xs">
                                    <div><span className="text-steel">Tanggal:</span> <span className="font-medium text-ink">{detailTabunganModal.trx.tanggal}</span></div>
                                    <div><span className="text-steel">Warung:</span> <span className="font-medium text-ink">{detailTabunganModal.warungName}</span></div>
                                    {detailTabunganModal.trxId && <div><span className="text-steel">TrxID:</span> <span className="font-mono text-[10px] text-steel">{detailTabunganModal.trxId}</span></div>}
                                    {detailTabunganModal.metode && <div><span className="text-steel">Metode:</span> <span className="font-medium text-ink">{detailTabunganModal.metode}</span></div>}
                                </div>
                            </div>

                            {/* Detail Items */}
                            <div>
                                <div className="flex items-center gap-2 mb-2">
                                    <ShoppingBag className="w-4 h-4 text-accent" />
                                    <span className="font-semibold text-ink text-sm">Rincian Belanjaan</span>
                                </div>
                                {detailTabunganModal.detailItems.length === 0 ? (
                                    <div className="text-center py-6 text-steel text-sm border border-dashed border-whisper rounded-xl bg-canvas/50">
                                        <Package className="w-8 h-8 mx-auto mb-2 text-whisper" />
                                        <div>Data rincian belanjaan tidak ditemukan</div>
                                        <div className="text-xs mt-1">Transaksi mungkin dilakukan sebelum pencatatan rincian aktif.</div>
                                    </div>
                                ) : (
                                    <div className="overflow-x-auto border border-whisper rounded-xl">
                                        <table className="w-full text-sm">
                                            <thead className="bg-canvas/60 text-steel border-b border-whisper/50">
                                                <tr>
                                                    <th className="py-2 px-3 text-left text-xs font-medium">Produk</th>
                                                    <th className="py-2 px-3 text-center text-xs font-medium">Qty</th>
                                                    <th className="py-2 px-3 text-right text-xs font-medium">Harga</th>
                                                    <th className="py-2 px-3 text-right text-xs font-medium">Subtotal</th>
                                                </tr>
                                            </thead>
                                            <tbody className="divide-y divide-whisper/50">
                                                {detailTabunganModal.detailItems.map((item, idx) => (
                                                    <tr key={idx} className="hover:bg-canvas/40">
                                                        <td className="py-2.5 px-3 font-medium text-ink">{item.NamaProduk}</td>
                                                        <td className="py-2.5 px-3 text-center text-steel">{item.Kuantitas}x</td>
                                                        <td className="py-2.5 px-3 text-right text-steel">Rp {Number(item.HargaSatuan || 0).toLocaleString('id-ID')}</td>
                                                        <td className="py-2.5 px-3 text-right font-medium text-ink">Rp {Number(item.Subtotal || 0).toLocaleString('id-ID')}</td>
                                                    </tr>
                                                ))}
                                            </tbody>
                                            <tfoot className="bg-canvas/60 border-t border-whisper">
                                                <tr>
                                                    <td colSpan="3" className="py-2.5 px-3 text-right font-semibold text-ink">Total:</td>
                                                    <td className="py-2.5 px-3 text-right font-bold text-emerald-600">Rp {detailTabunganModal.detailItems.reduce((s, i) => s + Number(i.Subtotal || 0), 0).toLocaleString('id-ID')}</td>
                                                </tr>
                                            </tfoot>
                                        </table>
                                    </div>
                                )}
                            </div>
                        </div>
                    )}
                </FormWrapper>
            )}
            {confirmDialog && (
                <div className="fixed inset-0 z-[110] flex items-center justify-center p-4 bg-ink/20 backdrop-blur-[3px]"><div className="bg-surface rounded-card shadow-diffused w-full max-w-sm p-8 flex flex-col items-center text-center animate-fade-in-up"><div className="w-14 h-14 rounded-2xl bg-dangerBg flex items-center justify-center mb-5"><AlertCircle className="w-7 h-7 text-danger" /></div><h3 className="font-bold text-lg text-ink mb-1">{confirmDialog.type === 'NAIK_KELAS' ? 'Konfirmasi?' : 'Hapus Data?'}</h3><p className="text-steel text-sm mb-6">{confirmDialog.type === 'NAIK_KELAS' ? 'Lanjutkan proses Kenaikan Kelas Massal?' : `Anda yakin ingin menghapus`} <strong className="text-ink">{confirmDialog.nama}</strong>?</p><div className="flex gap-3 w-full"><button onClick={() => setConfirmDialog(null)} className={`${btnOutline} flex-1 justify-center`}>Batal</button><button onClick={executeDelete} className={`${confirmDialog.type === 'NAIK_KELAS' ? btnPrimary : btnDanger} flex-1 justify-center`}>Ya, {confirmDialog.type === 'NAIK_KELAS' ? 'Lanjutkan' : 'Hapus'}</button></div></div></div>
            )}
            {notification && (<div className="fixed bottom-24 md:bottom-6 right-6 z-[120] bg-ink text-white px-6 py-3 rounded-xl shadow-diffused flex items-center gap-3 animate-fade-in-up"><div className="w-2 h-2 bg-accent rounded-full animate-pulse"></div> {notification}</div>)}
        </div>
    );
}

export default App;
