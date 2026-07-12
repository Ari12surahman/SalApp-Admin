"use client";


import { createClient } from '@supabase/supabase-js';
import { formatDateID, formatDateTimeID } from '../lib/utils';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "https://placeholder.supabase.co";
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "placeholder";

if (supabaseUrl === "https://placeholder.supabase.co") {
    console.error("Missing Supabase Environment Variables!");
}

const supabase = createClient(supabaseUrl, supabaseKey);

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
            cleaned[k] = row[k] === '' ? null : row[k];
        }
        return cleaned;
    });

    const fullReplaceTables = ['MasterPeriode', 'MasterJabatan', 'MasterKelas', 'MasterTagihan', 'KategoriKas', 'MasterConfig', 'MasterRoleAccess'];
    if (fullReplaceTables.includes(tableName)) {
        const dummyCol = Object.keys(cleanData[0] || {})[0];
        if (dummyCol) {
            await supabase.from(tableName).delete().not(dummyCol, 'is', null);
            const { error } = await supabase.from(tableName).insert(cleanData);
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
            if (seen.has(item.nis)) return false;
            seen.add(item.nis);
            return true;
        });
        upsertOptions = { onConflict: 'nis' };
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
        const { data: existingData } = await supabase.from(tableName).select('id');
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

import React, { useState, useEffect, useRef, useCallback } from "react";


// Import Lucide Icons
import {
    LayoutDashboard, Users, CreditCard, Wallet, TrendingUp, AlertCircle, Plus, Search, Filter, Bell,
    User, X, Trash2, Settings, FileSpreadsheet, FileText, BadgePercent, Zap, ArrowDownCircle,
    ArrowUpCircle, Edit, Printer, CheckCircle2, BarChart3, History, Activity, QrCode, Link as LinkIcon,
    Copy, ExternalLink, RefreshCw, Check, Briefcase, BookOpen, DownloadCloud, TrendingDown, Menu, ArrowRight, ArrowLeft, Eye, EyeOff, ChevronRight, Scan, Download
} from "lucide-react";

// Import Recharts dengan parameter bundle untuk mencegah error lodash missing modules
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from "recharts";

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
    const [masterTagihanList, setMasterTagihanList] = useState([
        { tagihan: 'SPP Bulanan', nominal: 150000, tipe: 'Rutin', pakasirSlug: 'depodomain', pakasirApiKey: 'xxx123' },
        { tagihan: 'Uang Pangkal', nominal: 500000, tipe: 'Insidental', pakasirSlug: '', pakasirApiKey: '' },
    ]);
    const [kategoriKas, setKategoriKas] = useState({ pemasukan: ['Dana BOS', 'Sumbangan', 'Lainnya'], pengeluaran: ['Operasional', 'Sarana Prasarana', 'Kesehatan', 'Lainnya'] });
    const [masterJabatanList, setMasterJabatanList] = useState(['Kepala Sekolah', 'Pengajar', 'Administrasi', 'Dapur', 'Kebersihan']);
    const listBulan = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];

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
                    const tables = ['Santri', 'Pegawai', 'Admin', 'Tagihan', 'Pembayaran', 'Tabungan', 'Kas', 'Gaji', 'Logs', 'MasterPeriode', 'MasterJabatan', 'MasterKelas', 'MasterTagihan'];
                    const result = {};
                    for (const t of tables) {
                        let actualT = t;
                        if (t === 'Santri') actualT = 'Data Santri';
                        if (t === 'Pegawai') actualT = 'Data Pegawai';

                        const { data } = await supabase.from(actualT).select('*');
                        result[t] = data ? sortSupabaseData(actualT, data) : [];
                    }
                    const jsonString = JSON.stringify(result);

                    try {
                        const data = JSON.parse(jsonString);
                        if (data.Santri && data.Santri.length > 0) setDataSantri(data.Santri);
                        if (data.Pegawai && data.Pegawai.length > 0) setDataPegawai(data.Pegawai);
                        if (data.Tagihan && data.Tagihan.length > 0) setDataTagihan(data.Tagihan);
                        if (data.Pembayaran && data.Pembayaran.length > 0) setDataPembayaran(data.Pembayaran);
                        if (data.Tabungan && data.Tabungan.length > 0) setDataTabungan(data.Tabungan);
                        if (data.Kas && data.Kas.length > 0) setDataKas(data.Kas);
                        if (data.Gaji && data.Gaji.length > 0) setDataGaji(data.Gaji);
                        if (data.Logs && data.Logs.length > 0) setDataLog(data.Logs);
                        // Muat Master Periode dari Spreadsheet
                        if (data.MasterPeriode && data.MasterPeriode.length > 0) {
                            setMasterPeriodeList(data.MasterPeriode.map(item => item.periode).filter(Boolean));
                        }
                        // Muat Master Jabatan dari Spreadsheet
                        if (data.MasterJabatan && data.MasterJabatan.length > 0) {
                            setMasterJabatanList(data.MasterJabatan.map(item => item.jabatan).filter(Boolean));
                        }
                        // Muat Master Kelas dari Spreadsheet
                        if (data.MasterKelas && data.MasterKelas.length > 0) {
                            setMasterKelasList(data.MasterKelas.map(item => item.kelas).filter(Boolean));
                        }
                        // Muat Master Tagihan dari Spreadsheet
                        if (data.MasterTagihan && data.MasterTagihan.length > 0) {
                            setMasterTagihanList(data.MasterTagihan);
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
                            data.MasterConfig.forEach(item => { if (item.kunci) cfg[item.kunci] = item.nilai; });
                            setAppConfig(prev => ({ ...prev, ...cfg }));
                        }
                        // Muat Role Access
                        if (data.MasterRoleAccess && data.MasterRoleAccess.length > 0) {
                            setDataRoleAccess(data.MasterRoleAccess.map(r => ({
                                ...r,
                                aksesMenu: typeof r.aksesMenu === 'string' ? r.aksesMenu.split(',').filter(Boolean) : (r.aksesMenu || [])
                            })));
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
                        const tables = ['Santri', 'Pegawai', 'Admin', 'Tagihan', 'Pembayaran', 'Tabungan', 'Kas', 'Gaji', 'Logs', 'MasterPeriode', 'MasterJabatan', 'MasterKelas', 'MasterTagihan'];
                        const result = {};
                        for (const t of tables) {
                            let actualT = t;
                            if (t === 'Santri') actualT = 'Data Santri';
                            if (t === 'Pegawai') actualT = 'Data Pegawai';

                            const { data } = await supabase.from(actualT).select('*');
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
                            updateIfChanged('Tagihan', setDataTagihan);
                            updateIfChanged('Pembayaran', setDataPembayaran);
                            updateIfChanged('Tabungan', setDataTabungan);
                            updateIfChanged('Kas', setDataKas);
                            updateIfChanged('Gaji', setDataGaji);
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
                const { data } = await supabase.from('Tagihan').select('*');
                if (data) {
                    const serverStr = JSON.stringify(data.reverse());
                    if (!window['_pending_Tagihan'] && (!window['lastWrite_Tagihan'] || Date.now() - window['lastWrite_Tagihan'] >= 30000)) {
                        window['lastSync_Tagihan'] = serverStr;
                        setDataTagihan(data);
                    }
                }
            })
            .subscribe();

        return () => {
            clearInterval(interval);
            supabase.removeChannel(tagihanChannel);
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
    useEffect(() => { if (isLoaded) debouncedSync('MasterTagihan', masterTagihanList); }, [masterTagihanList, isLoaded]);
    useEffect(() => {
        if (isLoaded) {
            const flat = [...kategoriKas.pemasukan.map(k => ({ kategori: k, tipe: 'pemasukan' })), ...kategoriKas.pengeluaran.map(k => ({ kategori: k, tipe: 'pengeluaran' }))];
            debouncedSync('KategoriKas', flat);
        }
    }, [kategoriKas, isLoaded]);
    // Sync Admin, Config, RoleAccess
    useEffect(() => { if (isLoaded) debouncedSync('Admin', dataAdmin); }, [dataAdmin, isLoaded]);
    useEffect(() => {
        if (isLoaded) {
            const flat = Object.entries(appConfig).map(([kunci, nilai]) => ({ kunci, nilai: nilai || '' }));
            debouncedSync('MasterConfig', flat);
        }
    }, [appConfig, isLoaded]);
    useEffect(() => {
        if (isLoaded) {
            debouncedSync('MasterRoleAccess', dataRoleAccess.map(r => ({ jabatan: r.jabatan, aksesMenu: Array.isArray(r.aksesMenu) ? r.aksesMenu.join(',') : r.aksesMenu })));
        }
    }, [dataRoleAccess, isLoaded]);

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
                const tRef = dataTagihan.find(t => String(t.nis).replace(/^0+/, '') === String(formData.nis).replace(/^0+/, '') && String(t.tagihan).toLowerCase().trim() === String(tagName).toLowerCase().trim() && formatPeriodeStr(t.periode).toLowerCase().trim() === formatPeriodeStr(pStr).toLowerCase().trim());

                if (tRef) {
                    if (modalType === 'FORM_TAGIHAN_SANTRI') {
                        showNotification(`Tagihan ${tagName} periode ${pStr} sudah ADA! (${tRef.status})`);
                        e.preventDefault();
                        return;
                    } else {
                        if (String(tRef.status).toLowerCase() === 'lunas') {
                            showNotification(`Tagihan ${tagName} periode ${pStr} sudah LUNAS!`);
                            e.preventDefault();
                            return;
                        } else if (String(tRef.status).toLowerCase() === 'cicil' || String(tRef.status).toLowerCase() === 'cicilan') {
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

    const addLog = (aksi, modul, detail) => setDataLog(prev => [{ id: `LOG-${Date.now()}`, waktu: formatDateTimeID(new Date()), user: currentUser?.nama || 'Sistem', aksi, modul, detail }, ...prev]);
    const confirmDelete = (type, id, nama) => setConfirmDialog({ type, id, nama });

    const executeDelete = () => {
        let deletedName = confirmDialog.nama;

        // === BULK DELETE ===
        if (confirmDialog.type === 'BULK') {
            const ids = confirmDialog.id;
            const bType = confirmDialog.bulkType;
            if (bType === 'SANTRI') setDataSantri(prev => prev.filter(s => !ids.includes(s.id)));
            if (bType === 'PEGAWAI') setDataPegawai(prev => prev.filter(p => !ids.includes(p.id)));
            if (bType === 'TAGIHAN') setDataTagihan(prev => prev.filter(t => !ids.includes(t.id)));
            if (bType === 'PEMBAYARAN') {
                const deletedTxs = dataPembayaran.filter(p => ids.includes(p.id));
                setDataTagihan(prev => {
                    let updatedTags = [...prev];
                    deletedTxs.forEach(deletedTrx => {
                        const itemsToReverse = deletedTrx.items && deletedTrx.items.length > 0 
                                               ? deletedTrx.items 
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
            if (bType === 'TABUNGAN') setDataTabungan(prev => prev.filter(t => !ids.includes(t.id)));
            if (bType === 'KAS') setDataKas(prev => prev.filter(k => !ids.includes(k.id)));
            if (bType === 'GAJI') setDataGaji(prev => prev.filter(g => !ids.includes(g.id)));
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

        if (confirmDialog.type === 'SANTRI') setDataSantri(prev => prev.filter(s => s.id !== confirmDialog.id));
        if (confirmDialog.type === 'PEGAWAI') setDataPegawai(prev => prev.filter(p => p.id !== confirmDialog.id));
        if (confirmDialog.type === 'TAGIHAN_SANTRI') setDataTagihan(prev => prev.filter(t => t.id !== confirmDialog.id));
        if (confirmDialog.type === 'PEMBAYARAN') {
            const deletedTrx = dataPembayaran.find(p => p.id === confirmDialog.id);
            if (deletedTrx) {
                setDataTagihan(prev => {
                    const updatedTags = [...prev];
                    const itemsToReverse = deletedTrx.items && deletedTrx.items.length > 0 
                                           ? deletedTrx.items 
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
        if (confirmDialog.type === 'TABUNGAN') setDataTabungan(prev => prev.filter(t => t.id !== confirmDialog.id));
        if (confirmDialog.type === 'KAS') setDataKas(prev => prev.filter(k => k.id !== confirmDialog.id));
        if (confirmDialog.type === 'GAJI') setDataGaji(prev => prev.filter(g => g.id !== confirmDialog.id));
        if (confirmDialog.type === 'MASTER_PERIODE') setMasterPeriodeList(prev => prev.filter(p => p !== confirmDialog.id));
        if (confirmDialog.type === 'MASTER_KELAS') setMasterKelasList(prev => prev.filter(k => k !== confirmDialog.id));
        if (confirmDialog.type === 'MASTER_TAGIHAN') setMasterTagihanList(prev => prev.filter(t => t.tagihan !== confirmDialog.id));
        if (confirmDialog.type === 'MASTER_JABATAN') setMasterJabatanList(prev => prev.filter(j => j !== confirmDialog.id));

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
                    body: JSON.stringify({ action: 'pollPakasirStatus', data: { slug, amount: formData.sisa, orderId: formData.id, apiKey } })
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

            if (paymentData && (paymentData.payment_number || paymentData.checkout_url || paymentData.qr_string)) {
                const isQris = method === 'QRIS' || method === 'qris';
                const checkoutUrl = paymentData.checkout_url || paymentData.url || '';
                const qrStr = paymentData.payment_number || paymentData.qr_string || '';

                const strData = JSON.stringify(data || {}).toLowerCase();
                const isSandboxApi = strData.includes('"sandbox"') || strData.includes('sandbox.pakasir.com') || String(qrStr).toUpperCase().includes('SANDBOX') || String(checkoutUrl).toUpperCase().includes('SANDBOX') || String(qrStr) === '123123123';

                console.log("IS SANDBOX:", isSandboxApi, "qrString:", qrStr, "checkout_url:", checkoutUrl);
                // We pass uniqueOrderId as txId or orderId if needed. In Admin, they use formData.id for state, but we should probably just keep it as is.
                setPakasirTimeLeft(900);
                setPakasirData(prev => ({ ...prev, loading: false, step: isQris ? 'SHOW_QR' : 'SHOW_VA', qrString: qrStr, checkoutUrl: checkoutUrl, isSandbox: isSandboxApi }));
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
            setDataPembayaran(prev => {
                const updated = [...prev];
                const idx = updated.findIndex(p => p.id === formData.id);
                if (idx > -1) {
                    const invRef = updated[idx];
                    updated[idx] = { ...invRef, status: 'Lunas', sisa: 0, tagihan: invRef.tagihan + ' (Via QRIS)' };
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
                            const itemsToProcess = invRef.items && invRef.items.length > 0 ? invRef.items : [{ tagihan: invRef.tagihan.replace(' (Via QRIS)', ''), periode: invRef.periode, nominal: invRef.nominal }];

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
                return updated;
            });
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
                body: JSON.stringify({ action: 'pollPakasirStatus', data: { slug, amount: formData.sisa, orderId: formData.id, apiKey } })
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
                nominalAngka = parseInt(String(formData.nominal || '').replace(/\D/g, ''), 10);
                const tRef = dataTagihan.find(t => t.id === formData.selectedTagihanBayar[0]);
                tagihanNames = tRef?.tagihan || 'Tagihan'; linkedIds = [tRef?.id];
                pInvoiceStr = tRef?.periode || pInvoiceStr;
                itemsToPay.push({ tagihan: tagihanNames, periode: pInvoiceStr, nominal: nominalAngka });
            } else {
                let total = 0; const names = [];
                formData.selectedTagihanBayar.forEach(tid => {
                    const tRef = dataTagihan.find(t => t.id === tid);
                    if (tRef) {
                        const sisa = tRef.nominal - (tRef.terbayar || 0);
                        total += sisa; names.push(tRef.tagihan); linkedIds.push(tRef.id);
                        itemsToPay.push({ tagihan: tRef.tagihan, periode: tRef.periode, nominal: sisa });
                    }
                });
                nominalAngka = total; tagihanNames = names.join(', ').substring(0, 30) + '...';
                pInvoiceStr = itemsToPay[0]?.periode || 'Multi-Periode';
            }
        } else {
            let nominalPerBulan = parseInt(String(formData.nominal || '').replace(/\D/g, ''), 10);
            tagihanNames = formData.tagihan || 'Pembayaran Manual';

            const selectedB = formData.selectedBulan || [];
            if (selectedB.length > 0) {
                selectedB.forEach(bln => {
                    const pStr = `${bln} ${formData.tahun || new Date().getFullYear()}`;
                    itemsToPay.push({ tagihan: tagihanNames, periode: pStr, nominal: nominalPerBulan });
                });
                nominalAngka = nominalPerBulan * selectedB.length;
                pInvoiceStr = selectedB.length > 1 ? `${selectedB[0]} - ${selectedB[selectedB.length - 1]} ${formData.tahun || new Date().getFullYear()}` : `${selectedB[0]} ${formData.tahun || new Date().getFullYear()}`;
            } else {
                nominalAngka = nominalPerBulan;
                itemsToPay.push({ tagihan: tagihanNames, periode: pInvoiceStr, nominal: nominalAngka });
            }
        }

        if (!nominalAngka || nominalAngka <= 0) return showNotification("Nominal tidak valid!");
        const newTrx = { id: tempId, tanggal: new Date().toISOString().split('T')[0], nis: santriTerpilih.nis, nama: santriTerpilih.nama, tagihan: tagihanNames, periode: pInvoiceStr, nominal: nominalAngka, status: 'Pending', sisa: nominalAngka, linkedTagihans: linkedIds, items: itemsToPay };
        setDataPembayaran(prev => [newTrx, ...prev]);

        setFormData({ ...formData, id: tempId, nama: santriTerpilih.nama, tagihan: tagihanNames, sisa: nominalAngka });
        setPakasirData({ step: 'CHOOSE_METHOD', method: '', qrString: null, loading: false, url: '', isPaid: false, checkoutUrl: '' });
        setModalType('FORM_PAKASIR');
    };

    const submitTambahPembayaran = (e) => {
        e.preventDefault();
        const periodeStr = formData.bulan && formData.tahun ? `${formData.bulan} ${formData.tahun}` : 'Juni 2026';

        if (formData.id && formData.id.startsWith('INV')) {
            let nominalAngka = parseInt(String(formData.nominal || '').replace(/\D/g, ''), 10);
            setDataPembayaran(prev => prev.map(p => p.id === formData.id ? { ...p, nominal: nominalAngka, periode: periodeStr } : p));
            showNotification(`Transaksi diperbarui!`); closeModal(); return;
        }

        if (modalType === 'FORM_PEMBAYARAN_MASSAL') {
            const selectedTags = formData.selectedTagihans || [];
            const selectedB = formData.selectedBulan || [];
            if (selectedTags.length === 0 || selectedB.length === 0) return showNotification('Lengkapi pilihan!');

            let targetSantri = formData.targetType === 'Kelas' ? dataSantri.filter(s => (formData.selectedKelas || []).includes(s.kelas)) : formData.targetType === 'Santri' ? dataSantri.filter(s => (formData.selectedSantri || []).includes(s.nis)) : dataSantri;

            const newTags = []; const newTrxs = [];
            targetSantri.forEach(santri => {
                const itemsToPay = []; let totalBayar = 0;
                selectedTags.forEach(tagName => {
                    selectedB.forEach(bln => {
                        const pStr = `${bln} ${formData.tahun}`;
                        const isDup = dataTagihan.some(t => String(t.nis).replace(/^0+/, '') === String(santri.nis).replace(/^0+/, '') && String(t.tagihan).toLowerCase().trim() === String(tagName).toLowerCase().trim() && formatPeriodeStr(t.periode).toLowerCase().trim() === formatPeriodeStr(pStr).toLowerCase().trim());
                        if (isDup) return;
                        const tRef = masterTagihanList.find(t => t.tagihan === tagName);
                        const diskon = santri.diskonKhusus?.[tagName] || 0;
                        const finalNominal = Math.max(0, (tRef?.nominal || 0) - diskon);
                        if (finalNominal > 0) {
                            itemsToPay.push({ tagihan: tagName, periode: pStr, nominal: finalNominal }); totalBayar += finalNominal;
                            newTags.push({ id: `TGH-${Math.floor(Math.random() * 100000) + '-' + Date.now()}`, tanggal: new Date().toISOString().split('T')[0], nis: santri.nis, nama: santri.nama, tagihan: tagName, periode: pStr, nominalAwal: tRef?.nominal || 0, diskon: diskon, nominal: finalNominal, terbayar: finalNominal, status: 'Lunas' });
                        }
                    });
                });
                if (itemsToPay.length > 0) {
                    const tagihanNames = itemsToPay.map(i => i.tagihan).join(', ');
                    const pInvoiceStr = itemsToPay.length > 1 ? `${selectedB[0]} - ${selectedB[selectedB.length - 1]} ${formData.tahun}` : `${selectedB[0]} ${formData.tahun}`;
                    newTrxs.push({ id: `INV-${Math.floor(Math.random() * 100000) + '-' + Date.now()}`, tanggal: new Date().toISOString().split('T')[0], nis: santri.nis, nama: santri.nama, tagihan: tagihanNames.length > 30 ? tagihanNames.substring(0, 30) + '...' : tagihanNames, periode: pInvoiceStr, nominal: totalBayar, status: 'Lunas', sisa: 0, items: itemsToPay });
                }
            });
            setDataTagihan(prev => [...newTags, ...prev]); setDataPembayaran(prev => [...newTrxs, ...prev]);
            addLog('CREATE', 'PEMBAYARAN MASSAL', `Menerima ${newTrxs.length} pembayaran massal`);
            showNotification(`${newTrxs.length} Transaksi Massal dicatat!`);
            // Kirim notifikasi ke semua santri yang terkena pembayaran massal
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
                const tRef = dataTagihan.find(t =>
                    String(t.nis).replace(/^0+/, '') === String(santriTerpilih.nis).replace(/^0+/, '') &&
                    String(t.tagihan).toLowerCase().trim() === String(tagihanName).toLowerCase().trim() &&
                    formatPeriodeStr(t.periode).toLowerCase().trim() === formatPeriodeStr(pStr).toLowerCase().trim()
                );
                if (tRef && String(tRef.status).toLowerCase() === 'lunas') {
                    alert(`PERINGATAN: Tagihan ${tagihanName} periode ${pStr} SUDAH LUNAS!\n\nPembayaran dibatalkan otomatis agar tidak double.`);
                    return;
                }
            }
        }

        if (formData.selectedTagihanBayar?.length > 0) {
            if (formData.selectedTagihanBayar.length === 1) {
                const tagihanId = formData.selectedTagihanBayar[0]; const tRef = dataTagihan.find(t => t.id === tagihanId);
                let nominalAngka = parseInt(String(formData.nominal || '').replace(/\D/g, ''), 10);
                const totalTerbayarBaru = (tRef.terbayar || 0) + nominalAngka;
                let statusTrx = 'Lunas'; let sisaTagihan = 0;
                if (totalTerbayarBaru < tRef.nominal) { statusTrx = 'Cicil'; sisaTagihan = tRef.nominal - totalTerbayarBaru; }
                setDataTagihan(prev => prev.map(t => t.id === tagihanId ? { ...t, status: statusTrx, terbayar: totalTerbayarBaru } : t));
                const newTrx = { id: `INV-${Math.floor(Math.random() * 10000) + '-' + Date.now()}`, tanggal: new Date().toISOString().split('T')[0], nis: santriTerpilih.nis, nama: santriTerpilih.nama, tagihan: tRef.tagihan, periode: tRef.periode, nominal: nominalAngka, status: statusTrx === 'Cicil' ? 'Cicilan' : 'Lunas', sisa: sisaTagihan, items: [{ tagihan: tRef.tagihan, periode: tRef.periode, nominal: nominalAngka }] };
                setDataPembayaran(prev => [newTrx, ...prev]);
                addLog('CREATE', 'PEMBAYARAN', `Menerima pembayaran Rp ${nominalAngka.toLocaleString('id-ID')} dari ${santriTerpilih.nama}`);
                showNotification(`Pembayaran Rp ${nominalAngka.toLocaleString('id-ID')} dicatat!`);
                triggerPushNotification(santriTerpilih.nis, 'Pembayaran Tagihan', `Alhamdulillah, pembayaran Rp ${nominalAngka.toLocaleString('id-ID')} untuk ${tRef.tagihan} (${tRef.periode}) Ananda ${santriTerpilih.nama} berhasil dicatat.`);
            } else {
                const itemsToPay = []; let totalPayment = 0;
                const updatedTagsData = [];

                formData.selectedTagihanBayar.forEach(tagihanId => {
                    const tRef = dataTagihan.find(t => t.id === tagihanId);
                    if (tRef) {
                        const sisa = Number(tRef.nominal) - (Number(tRef.terbayar) || 0);
                        updatedTagsData.push({ id: tagihanId, terbayar: tRef.nominal, status: 'Lunas' });
                        itemsToPay.push({ tagihan: tRef.tagihan, periode: tRef.periode, nominal: sisa });
                        totalPayment += sisa;
                    }
                });

                setDataTagihan(prevTags => {
                    return prevTags.map(t => {
                        const upd = updatedTagsData.find(u => u.id === t.id);
                        return upd ? { ...t, terbayar: upd.terbayar, status: upd.status } : t;
                    });
                });
                const tagihanNames = itemsToPay.map(i => i.tagihan).join(', ');
                const newTrx = { id: `INV-${Math.floor(Math.random() * 100000) + '-' + Date.now()}`, tanggal: new Date().toISOString().split('T')[0], nis: santriTerpilih.nis, nama: santriTerpilih.nama, tagihan: tagihanNames.length > 30 ? tagihanNames.substring(0, 30) + '...' : tagihanNames, periode: itemsToPay[0]?.periode || 'Multi-Periode', nominal: totalPayment, status: 'Lunas', sisa: 0, items: itemsToPay };
                setDataPembayaran(prev => [newTrx, ...prev]);
                addLog('CREATE', 'PEMBAYARAN', `Menerima pembayaran ${itemsToPay.length} tagihan dari ${santriTerpilih.nama}`);
                showNotification(`Pembayaran ${itemsToPay.length} tagihan sekaligus berhasil!`);
                triggerPushNotification(santriTerpilih.nis, 'Pembayaran Tagihan', `Alhamdulillah, pembayaran ${itemsToPay.length} tagihan sekaligus (Total Rp ${totalPayment.toLocaleString('id-ID')}) untuk Ananda ${santriTerpilih.nama} berhasil dicatat.`);
            }
            closeModal(); return;
        }

        const selectedB = formData.selectedBulan || [];
        if (selectedB.length === 0) return showNotification('Pilih minimal 1 bulan!');
        let nominalPerBulan = parseInt(String(formData.nominal || '').replace(/\D/g, ''), 10);
        const itemsToPay = []; let totalPayment = 0;
        const updatedBulanMap = {};
        selectedB.forEach(bln => {
            const pStr = `${bln} ${formData.tahun}`;
            updatedBulanMap[pStr] = true;
            itemsToPay.push({ tagihan: formData.tagihan, periode: pStr, nominal: nominalPerBulan }); totalPayment += nominalPerBulan;
        });

        // Cari dan lunaskan Tagihan yang relevan di state dataTagihan
        setDataTagihan(prevTags => {
            const updatedTags = [...prevTags];
            selectedB.forEach(bln => {
                const pStr = `${bln} ${formData.tahun}`;
                const idx = updatedTags.findIndex(t => String(t.nis).replace(/^0+/, '') === String(formData.nis).replace(/^0+/, '') && String(t.tagihan).toLowerCase().trim() === String(formData.tagihan).toLowerCase().trim() && formatPeriodeStr(t.periode).toLowerCase().trim() === formatPeriodeStr(pStr).toLowerCase().trim());

                if (idx > -1) {
                    const t = updatedTags[idx];
                    const currentTerbayar = (t.terbayar || 0) + nominalPerBulan;
                    const statusTrx = currentTerbayar >= t.nominal ? 'Lunas' : 'Cicil';
                    updatedTags[idx] = { ...t, terbayar: currentTerbayar, status: statusTrx };
                } else {
                    updatedTags.unshift({
                        id: generateInvoiceId(formData.tagihan, updatedTags),
                        tanggal: new Date().toISOString().split('T')[0],
                        nis: santriTerpilih.nis,
                        nama: santriTerpilih.nama,
                        tagihan: formData.tagihan,
                        periode: pStr,
                        nominalAwal: nominalPerBulan,
                        diskon: 0,
                        nominal: nominalPerBulan,
                        terbayar: nominalPerBulan,
                        status: 'Lunas'
                    });
                }
            });
            return updatedTags;
        });

        const pInvoiceStr = itemsToPay.length > 1 ? `${selectedB[0]} - ${selectedB[selectedB.length - 1]} ${formData.tahun}` : `${selectedB[0]} ${formData.tahun}`;
        
        let trxStatus = 'Lunas';
        let trxSisa = 0;
        if (itemsToPay.length === 1) {
            const tRef = dataTagihan.find(t => String(t.nis).replace(/^0+/, '') === String(formData.nis).replace(/^0+/, '') && String(t.tagihan).toLowerCase().trim() === String(formData.tagihan).toLowerCase().trim() && formatPeriodeStr(t.periode).toLowerCase().trim() === formatPeriodeStr(itemsToPay[0].periode).toLowerCase().trim());
            if (tRef && tRef.nominal > (tRef.terbayar || 0) + itemsToPay[0].nominal) {
                trxStatus = 'Cicilan';
                trxSisa = tRef.nominal - ((tRef.terbayar || 0) + itemsToPay[0].nominal);
            } else if (tRef && tRef.nominal > tRef.terbayar) {
                // Already calculated in the loop, check the updated Tagihan state conceptually
                trxSisa = tRef.nominal - tRef.terbayar;
                if(trxSisa > 0) trxStatus = 'Cicilan';
            }
        }
        
        const newTrx = { id: `INV-${Math.floor(Math.random() * 10000) + '-' + Date.now()}`, tanggal: new Date().toISOString().split('T')[0], nis: formData.nis, nama: santriTerpilih.nama, tagihan: formData.tagihan, periode: pInvoiceStr, nominal: totalPayment, status: trxStatus, sisa: trxSisa, items: itemsToPay };
        setDataPembayaran(prev => [newTrx, ...prev]);
        addLog('CREATE', 'PEMBAYARAN MANUAL', `Menerima pembayaran manual Rp ${totalPayment.toLocaleString('id-ID')} dari ${santriTerpilih.nama}`);
        showNotification(`Pembayaran Rp ${totalPayment.toLocaleString('id-ID')} dicatat!`);
        triggerPushNotification(santriTerpilih.nis, 'Pembayaran Tagihan', `Alhamdulillah, pembayaran Rp ${totalPayment.toLocaleString('id-ID')} untuk ${formData.tagihan} Ananda ${santriTerpilih.nama} berhasil dicatat.`);
        closeModal();
    };

    const submitTagihanSantri = (e) => {
        e.preventDefault();
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
                    const disk = parseInt(String(detail.diskon).replace(/\D/g, ''), 10) || 0;
                    const finalNominal = Math.max(0, awal - disk);

                    const isDup = dataTagihan.some(t => String(t.nis).replace(/^0+/, '') === String(formData.nis).replace(/^0+/, '') && String(t.tagihan).toLowerCase().trim() === String(tagName).toLowerCase().trim() && formatPeriodeStr(t.periode).toLowerCase().trim() === formatPeriodeStr(periodeStr).toLowerCase().trim());
                    if (isDup) {
                        alert(`PERINGATAN: Tagihan ${tagName} periode ${periodeStr} SUDAH ADA!\n\nPembuatan tagihan dibatalkan agar tidak duplikat.`);
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
            const newSantri = { id: Date.now(), nis: targetNis, nama: formData.nama, kelas: formData.kelas, periode: formData.periode, status: 'Aktif', diskonKhusus: formData.diskonKhusus || {}, password: formData.password, uid: formData.uid || '', pin: formData.pin || '' };
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

        if (formData.id) {
            setDataPegawai(prev => prev.map(p => p.id === formData.id ? { ...p, ...formData, nip: targetNip } : p));
            addLog('UPDATE', 'PEGAWAI', `Memperbarui data: ${formData.nama}`);
            showNotification('Data Pegawai diperbarui!');
        } else {
            const newPegawai = { id: Date.now(), nip: targetNip, nama: formData.nama, jabatan: formData.jabatan, gajiPokok: parseInt(String(formData.gajiPokok).replace(/\D/g, ''), 10) || 0, password: formData.password };
            setDataPegawai(prev => [...prev, newPegawai]);
            addLog('CREATE', 'PEGAWAI', `Menambahkan pegawai: ${formData.nama} (NIP: ${newPegawai.nip})`);
            showNotification('Pegawai ditambahkan!');
        }
        closeModal();
    };

    const submitTabungan = (e) => {
        e.preventDefault();
        const s = dataSantri.find(s => String(s.nis) === String(formData.nis)) || { nama: 'Unknown' };
        const nom = parseInt(String(formData.nominal || '').replace(/\D/g, ''), 10) || 0;
        setDataTabungan(prev => [{ id: `TB-${Date.now()}`, tanggal: new Date().toISOString().split('T')[0], nis: formData.nis, nama: s.nama, jenis: formData.jenis || 'Setor', nominal: nom, keterangan: formData.keterangan || '' }, ...prev]);
        addLog('CREATE', 'TABUNGAN', `${formData.jenis || 'Setor'} Rp ${nom.toLocaleString('id-ID')} - ${s.nama}`);
        showNotification(`Tabungan dicatat!`);
        triggerPushNotification(formData.nis, 'Info Tabungan', `Transaksi ${formData.jenis || 'Setor'} Tabungan Rp ${nom.toLocaleString('id-ID')} untuk Ananda ${s.nama} berhasil dicatat.`);
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
            const saldoTabungan = dataTabungan.filter(t => t.nis === santri.nis).reduce((sum, item) => item.jenis === 'Setor' ? sum + item.nominal : sum - item.nominal, 0);
            const totalTunggakan = dataTagihan.filter(t => t.nis === santri.nis && t.status !== 'Lunas').reduce((sum, item) => sum + (item.nominal - (item.terbayar || 0)), 0);

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
                            id: Date.now() + Math.random(),
                            nis: String(cells[0] || '').trim(),
                            nama: String(cells[1] || '').trim(),
                            kelas: String(cells[2] || '').trim(),
                            periode: String(cells[3] || '').trim(),
                            status: 'Aktif', diskonKhusus: {},
                            password: String(cells[4] || '123456').trim()
                        });
                    } else {
                        newData.push({
                            id: Date.now() + Math.random(),
                            nip: String(cells[0] || '').trim(),
                            nama: String(cells[1] || '').trim(),
                            jabatan: String(cells[2] || '').trim(),
                            gajiPokok: parseInt(String(cells[3] || '').replace(/\D/g, ''), 10) || 0,
                            password: String(cells[4] || '123456').trim()
                        });
                    }
                }

                if (newData.length > 0) {
                    if (type === 'santri') setDataSantri(prev => [...newData, ...prev]);
                    else setDataPegawai(prev => [...newData, ...prev]);
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
        const totalTabungan = dataTabungan.reduce((sum, item) => item.jenis === 'Setor' ? sum + item.nominal : sum - item.nominal, 0);
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
        const filteredIds = filteredSantri.map(s => s.id);
        const allChecked = filteredIds.length > 0 && filteredIds.every(id => selectedIds.includes(id));
        const someChecked = selectedIds.filter(id => filteredIds.includes(id)).length > 0;
        return (
            <div className="space-y-5 animate-fade-in-up">
                <div className="flex flex-col xl:flex-row justify-between items-start xl:items-center gap-4 mb-6 w-full">
                    <div className="flex-1 min-w-0 pr-4"><h2 className="text-2xl font-bold tracking-tight text-ink">Data Santri</h2><p className="text-sm text-steel mt-1">Kelola master santri dan diskon khusus.</p></div>
                    <div className="grid grid-cols-2 sm:flex sm:flex-wrap sm:justify-start xl:justify-end gap-3 w-full xl:w-auto">
                        <button onClick={() => { setFormData({ diskonKhusus: {} }); setModalType('FORM_SANTRI'); }} className={btnPrimary}><Plus className="w-4 h-4" /> Tambah Santri</button>
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
                                {filteredSantri.length === 0 ? (
                                    <tr><td colSpan="100%" className="text-center py-8 text-steel">Belum ada data santri.</td></tr>
                                ) : filteredSantri.map((santri, idx) => (
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
                        {filteredSantri.length === 0 ? (
                            <div className="text-center py-8 text-steel text-sm">Belum ada data santri.</div>
                        ) : filteredSantri.map((santri, idx) => (
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
                </div>
            </div>
        );
    };

    const renderDataPegawai = () => {
        const filtered = dataPegawai.filter(p => (p.nama || '').toLowerCase().includes(searchTerm.toLowerCase()) || String(p.nip || '').includes(searchTerm));
        const filteredIds = filtered.map(p => p.id);
        const allChecked = filteredIds.length > 0 && filteredIds.every(id => selectedIds.includes(id));
        const someChecked = selectedIds.filter(id => filteredIds.includes(id)).length > 0;
        return (
            <div className="space-y-5 animate-fade-in-up">
                <div className="flex flex-col xl:flex-row justify-between items-start xl:items-center gap-4 mb-6 w-full">
                    <div className="flex-1 min-w-0 pr-4"><h2 className="text-2xl font-bold tracking-tight text-ink">Data Pegawai</h2><p className="text-sm text-steel mt-1">Kelola Ustadz & Karyawan.</p></div>
                    <div className="grid grid-cols-2 sm:flex sm:flex-wrap sm:justify-start xl:justify-end gap-3 w-full xl:w-auto">
                        <button onClick={() => { setFormData({}); setModalType('FORM_PEGAWAI'); }} className={btnPrimary}><Plus className="w-4 h-4" /> Tambah Pegawai</button>
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
                                {filtered.length === 0 ? (
                                    <tr><td colSpan="100%" className="text-center py-8 text-steel">Belum ada data pegawai.</td></tr>
                                ) : filtered.map((p, idx) => (
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
                        {filtered.length === 0 ? (
                            <div className="text-center py-8 text-steel text-sm">Belum ada data pegawai.</div>
                        ) : filtered.map((p, idx) => (
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
                </div>
            </div>
        );
    };

    const renderTagihan = () => {
        const filtered = dataTagihan.filter(t => (t.nama || '').toLowerCase().includes(searchTerm.toLowerCase()) || String(t.nis || '').includes(searchTerm));
        const filteredIds = filtered.map(t => t.id);
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
                                {filtered.length === 0 ? (
                                    <tr><td colSpan="100%" className="text-center py-8 text-steel">Tidak ada tagihan ditemukan.</td></tr>
                                ) : filtered.map((trx, idx) => (
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
                        {filtered.length === 0 ? (
                            <div className="text-center py-8 text-steel text-sm">Tidak ada tagihan ditemukan.</div>
                        ) : filtered.map((trx, idx) => (
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
                </div>
            </div>
        );
    };

    const renderPembayaran = () => {
        const filtered = dataPembayaran.filter(t => (masterTagihanFilter === 'Semua Tagihan' || t.tagihan.includes(masterTagihanFilter)) && ((t.nama || '').toLowerCase().includes(searchTerm.toLowerCase()) || String(t.nis || '').includes(searchTerm)));
        const filteredIds = filtered.map(t => t.id);
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
                                {filtered.length === 0 ? (
                                    <tr><td colSpan="100%" className="text-center py-8 text-steel">Belum ada transaksi pembayaran.</td></tr>
                                ) : filtered.map((trx) => (
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
                        {filtered.length === 0 ? (
                            <div className="text-center py-8 text-steel text-sm">Belum ada transaksi pembayaran.</div>
                        ) : filtered.map((trx) => (
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
                </div>
            </div>
        );
    };

    const renderTabungan = () => {
        const filtered = dataTabungan.filter(t => (t.nama || '').toLowerCase().includes(searchTerm.toLowerCase()) || String(t.nis || '').includes(searchTerm));
        const filteredIds = filtered.map(t => t.id);
        const allChecked = filteredIds.length > 0 && filteredIds.every(id => selectedIds.includes(id));
        return (
            <div className="space-y-6 animate-in fade-in duration-500">
                <div className="flex flex-col xl:flex-row justify-between items-start xl:items-center gap-4 mb-6 w-full">
                    <div className="flex-1 min-w-0 pr-4"><h2 className="text-2xl font-semibold tracking-tight text-ink">Tabungan Santri</h2><p className="text-sm text-steel">Catat uang masuk (Setor) dan keluar (Tarik).</p></div>
                    <div className="flex gap-2">
                        <button onClick={() => { setFormData({ jenis: 'Setor' }); setModalType('FORM_TABUNGAN'); }} className={btnPrimary}><Plus className="w-4 h-4" /> Transaksi Tabungan</button>
                        <button onClick={() => downloadStyledExcel('Tabungan Santri', ['Tanggal', 'NIS', 'Nama', 'Jenis', 'Nominal', 'Keterangan'], dataTabungan.map(t => [t.tanggal, t.nis, t.nama, t.jenis, t.nominal, t.keterangan]), 'Tabungan_Santri')} className={btnOutline}><FileSpreadsheet className="w-4 h-4 text-accent" /> Unduh</button>
                    </div>
                </div>
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
                            <thead className="bg-canvas/60 text-steel border-b border-whisper/50"><tr><th className="px-6 py-3 w-12 text-center"><input type="checkbox" checked={allChecked} onChange={() => toggleSelectAll(filteredIds)} className="w-4 h-4 rounded border-whisper text-accent cursor-pointer" /></th><th className="px-6 py-3">Tanggal</th><th className="px-6 py-3">Santri</th><th className="px-6 py-3 text-center">Jenis</th><th className="px-6 py-3 text-right">Nominal</th><th className="px-6 py-3">Keterangan</th><th className="px-6 py-3 text-center">Aksi</th></tr></thead>
                            <tbody className="divide-y divide-slate-100">
                                {filtered.length === 0 ? (
                                    <tr><td colSpan="100%" className="text-center py-8 text-steel">Belum ada catatan tabungan santri.</td></tr>
                                ) : filtered.map((trx) => (
                                    <tr key={trx.id} className="bg-surface hover:bg-canvas">
                                        <td className="px-6 py-4 text-center"><input type="checkbox" checked={selectedIds.includes(trx.id)} onChange={() => toggleSelectId(trx.id)} className="w-4 h-4 rounded border-whisper text-accent cursor-pointer" /></td>
                                        <td className="px-6 py-4">{trx.tanggal}</td><td className="px-6 py-4 font-medium">{trx.nama}</td>
                                        <td className="px-6 py-4 text-center"><span className={`inline-flex px-2 py-1 text-xs font-medium rounded-md ${trx.jenis === 'Setor' ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700'}`}>{trx.jenis}</span></td>
                                        <td className="px-6 py-4 text-right font-medium">Rp {Number(trx.nominal || 0).toLocaleString('id-ID')}</td><td className="px-6 py-4 text-steel">{trx.keterangan}</td>
                                        <td className="px-6 py-4 text-center flex gap-3 justify-center"><button onClick={() => confirmDelete('TABUNGAN', trx.id, 'Transaksi Tabungan')} className="text-rose-600 hover:text-rose-800"><Trash2 className="w-4 h-4" /></button></td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                    <div className="md:hidden flex flex-col divide-y divide-whisper/50">
                        {filtered.length === 0 ? (
                            <div className="text-center py-8 text-steel text-sm">Belum ada catatan tabungan santri.</div>
                        ) : filtered.map((trx) => (
                            <div key={trx.id} className={`p-4 flex flex-col gap-3 ${selectedIds.includes(trx.id) ? 'bg-accent/5' : 'bg-surface'}`}>
                                <div className="flex justify-between items-start gap-3">
                                    <div className="flex items-start gap-3 min-w-0">
                                        <input type="checkbox" checked={selectedIds.includes(trx.id)} onChange={() => toggleSelectId(trx.id)} className="w-4 h-4 mt-1 shrink-0 rounded border-whisper text-accent focus:ring-accent/30 cursor-pointer" />
                                        <div className="min-w-0">
                                            <div className="font-bold text-ink truncate text-sm">{trx.nama}</div>
                                            <div className="text-[10px] text-steel mt-0.5">{trx.tanggal}</div>
                                            <div className="text-[10px] text-slate mt-1 line-clamp-2">{trx.keterangan}</div>
                                        </div>
                                    </div>
                                    <div className="text-right shrink-0">
                                        <div className={`text-sm font-bold ${trx.jenis === 'Setor' ? 'text-emerald-600' : 'text-rose-600'}`}>{trx.jenis === 'Setor' ? '+' : '-'} Rp {Number(trx.nominal || 0).toLocaleString('id-ID')}</div>
                                        <span className={`inline-block mt-1 px-1.5 py-0.5 text-[10px] font-bold uppercase rounded ${trx.jenis === 'Setor' ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700'}`}>{trx.jenis}</span>
                                    </div>
                                </div>
                                <div className="flex flex-wrap items-center gap-2 justify-end w-full border-t border-whisper/50 pt-3 mt-1">
                                    <button onClick={() => confirmDelete('TABUNGAN', trx.id, 'Transaksi Tabungan')} className="flex items-center gap-1 text-danger bg-dangerBg hover:bg-red-100 font-medium text-xs px-3 py-1.5 rounded-lg border border-red-100"><Trash2 className="w-3.5 h-3.5" /> Hapus</button>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            </div>
        );
    };

    const renderPenggajian = () => {
        const filtered = dataGaji.filter(g => (g.nama || '').toLowerCase().includes(searchTerm.toLowerCase()) || String(g.nip || '').includes(searchTerm));
        const filteredIds = filtered.map(g => g.id);
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
                                {filtered.length === 0 ? (
                                    <tr><td colSpan="100%" className="text-center py-8 text-steel">Belum ada riwayat penggajian.</td></tr>
                                ) : filtered.map((g) => (
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
                        {filtered.length === 0 ? (
                            <div className="text-center py-8 text-steel text-sm">Belum ada riwayat penggajian.</div>
                        ) : filtered.map((g) => (
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
                </div>
            </div>
        );
    };
    // --- PENCAIRAN WARUNG ---
    const [dataPencairan, setDataPencairan] = useState([]);
    const [loadingPencairan, setLoadingPencairan] = useState(false);
    const [modalDetailPencairan, setModalDetailPencairan] = useState(null);
    const [detailPencairanData, setDetailPencairanData] = useState([]);

    const fetchPencairanGlobal = async () => {
        setLoadingPencairan(true);
        try {
            const { data, error } = await supabase.from('Pencairan').select('*').order('WaktuPengajuan', { ascending: false });
            if (!error) {
                setDataPencairan(data || []);
            } else {
                showNotification('Gagal memuat data pencairan', 'error');
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
                    const santri = dataSantri.find(s => s.nis === trx.SantriID);
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

    const handleSelesaiPencairan = async (idPencairan) => {
        if (!confirm('Tandai pencairan ini sebagai Selesai?')) return;
        showNotification('Menyimpan status...', 'info');
        try {
            const { error } = await supabase.from('Pencairan').update({ Status: 'Selesai', WaktuSelesai: new Date().toISOString() }).eq('IDPencairan', idPencairan);
            if (!error) {
                await supabase.from('Transaksi').update({ StatusPencairan: 'Selesai' }).eq('IDPencairan', idPencairan);
                showNotification('Status berhasil diupdate!', 'success');
                fetchPencairanGlobal();
                if (modalDetailPencairan === idPencairan) setModalDetailPencairan(null);
            } else {
                showNotification('Gagal mengupdate status: ' + error.message, 'error');
            }
        } catch (e) {
            showNotification('Error menyimpan status', 'error');
        }
    };

    const renderPencairanWarung = () => {
        return (
            <div className="space-y-6 animate-fade-in-up">
                <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
                    <div>
                        <h1 className="text-2xl font-bold text-ink flex items-center gap-2"><Wallet className="w-6 h-6 text-primary" /> Pencairan Warung</h1>
                        <p className="text-steel text-sm mt-1">Kelola dan pantau pengajuan pencairan dana dari seluruh warung.</p>
                    </div>
                    <button onClick={fetchPencairanGlobal} className={btnOutline}>
                        <RefreshCw className={`w-4 h-4 ${loadingPencairan ? 'animate-spin' : ''}`} /> Refresh
                    </button>
                </div>

                <div className="bg-surface border border-whisper rounded-card p-6 shadow-sm overflow-hidden">
                    <div className="overflow-x-auto">
                        <table className="w-full text-left border-collapse">
                            <thead>
                                <tr className="border-b border-whisper text-steel text-sm">
                                    <th className="pb-3 font-medium">ID Pencairan</th>
                                    <th className="pb-3 font-medium">Waktu Pengajuan</th>
                                    <th className="pb-3 font-medium">Warung</th>
                                    <th className="pb-3 font-medium text-right">Total Dana</th>
                                    <th className="pb-3 font-medium text-center">Status</th>
                                    <th className="pb-3 font-medium text-right">Aksi</th>
                                </tr>
                            </thead>
                            <tbody className="text-sm">
                                {loadingPencairan ? (
                                    <tr><td colSpan="6" className="text-center py-8 text-steel">Memuat data...</td></tr>
                                ) : dataPencairan.length === 0 ? (
                                    <tr><td colSpan="6" className="text-center py-8 text-steel">Belum ada pengajuan pencairan.</td></tr>
                                ) : dataPencairan.map((item, idx) => (
                                    <tr key={idx} className="border-b border-slate-50 hover:bg-slate-50 transition-colors">
                                        <td className="py-4 text-ink font-medium">{item.IDPencairan}</td>
                                        <td className="py-4 text-steel">{formatDateTimeID(new Date(item.WaktuPengajuan))}</td>
                                        <td className="py-4 text-ink font-medium">{item.NamaWarung || item.WarungID}</td>
                                        <td className="py-4 text-ink font-bold text-right">Rp {Number(item.TotalDana || 0).toLocaleString('id-ID')}</td>
                                        <td className="py-4 text-center">
                                            <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${item.Status === 'Selesai' ? 'bg-successBg text-success' : 'bg-warning/20 text-warning'}`}>
                                                {item.Status}
                                            </span>
                                        </td>
                                        <td className="py-4 text-right space-x-2">
                                            <button onClick={() => handleDetailPencairan(item.IDPencairan)} className="text-primary hover:underline text-xs font-bold">Detail</button>
                                            {item.Status === 'Menunggu' && (
                                                <button onClick={() => handleSelesaiPencairan(item.IDPencairan)} className="text-success hover:underline text-xs font-bold ml-2">Cairkan/Selesai</button>
                                            )}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>

                {/* Modal Detail Pencairan */}
                {modalDetailPencairan && (
                    <FormWrapper title={`Detail Pencairan - ${modalDetailPencairan}`} onClose={() => setModalDetailPencairan(null)} customFooter={
                        <div className="px-6 py-4 bg-canvas border-t border-whisper flex justify-end gap-3 shrink-0 rounded-b-card">
                            <button type="button" onClick={() => setModalDetailPencairan(null)} className={btnOutline}>Tutup</button>
                            {dataPencairan.find(x => x.IDPencairan === modalDetailPencairan)?.Status === 'Menunggu' && (
                                <button onClick={() => handleSelesaiPencairan(modalDetailPencairan)} className={btnPrimary}>Tandai Selesai</button>
                            )}
                        </div>
                    }>
                        <div className="space-y-4">
                            <p className="text-sm text-steel mb-4">Berikut adalah daftar rincian transaksi non-tunai yang termasuk dalam pencairan ini:</p>
                            <div className="overflow-x-auto border border-whisper rounded-lg">
                                <table className="w-full text-left text-sm">
                                    <thead className="bg-canvas border-b border-whisper text-steel">
                                        <tr>
                                            <th className="py-2 px-3">Trx ID</th>
                                            <th className="py-2 px-3">Metode</th>
                                            <th className="py-2 px-3">Santri (UID/NIS)</th>
                                            <th className="py-2 px-3 text-right">Nominal</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {detailPencairanData.length === 0 ? (
                                            <tr><td colSpan="4" className="text-center py-4">Data kosong</td></tr>
                                        ) : detailPencairanData.map((trx, tIdx) => (
                                            <tr key={tIdx} className="border-b border-whisper last:border-0 hover:bg-slate-50">
                                                <td className="py-2 px-3 font-mono text-xs">{trx.TrxID}</td>
                                                <td className="py-2 px-3 font-medium text-xs">{trx.Metode}</td>
                                                <td className="py-2 px-3">
                                                    <div className="font-bold text-ink">{trx.NamaSantri}</div>
                                                    <div className="text-xs text-steel">{trx.SantriID}</div>
                                                </td>
                                                <td className="py-2 px-3 text-right font-bold text-ink">Rp {Number(trx.TotalHarga || 0).toLocaleString('id-ID')}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    </FormWrapper>
                )}
            </div>
        );
    };


    const renderBukuKas = () => {
        const filtered = dataKas.filter(k => (k.keterangan || '').toLowerCase().includes(searchTerm.toLowerCase()) || (k.sumber || '').toLowerCase().includes(searchTerm.toLowerCase()) || (k.kategori || '').toLowerCase().includes(searchTerm.toLowerCase()));
        const filteredIds = filtered.map(k => k.id);
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
                                {filtered.length === 0 ? (
                                    <tr><td colSpan="100%" className="text-center py-8 text-steel">Belum ada catatan buku kas.</td></tr>
                                ) : filtered.map((trx) => (
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
                        {filtered.length === 0 ? (
                            <div className="text-center py-8 text-steel text-sm">Belum ada catatan buku kas.</div>
                        ) : filtered.map((trx) => (
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
                </div>
            </div>
        );
    };

    const renderLogAktivitas = () => {
        return (
            <div className="space-y-6 animate-in fade-in duration-500">
                <div className="flex flex-col xl:flex-row justify-between items-start xl:items-center gap-4 mb-6 w-full">
                    <div className="flex-1 min-w-0 pr-4"><h2 className="text-2xl font-semibold tracking-tight text-ink">Audit & Log Aktivitas</h2><p className="text-sm text-steel">Rekam jejak tindakan pengguna pada sistem (Anti-Fraud).</p></div>
                    <button onClick={() => downloadStyledExcel('Log Aktivitas', ['ID', 'Waktu', 'Pengguna', 'Aksi', 'Modul', 'Detail Aktivitas'], dataLog.map(l => [l.id, l.waktu, l.user, l.aksi, l.modul, l.detail]), 'Log_Aktivitas')} className={btnOutline}><FileSpreadsheet className="w-4 h-4 text-accent" /> Unduh</button>
                </div>
                <div className="bg-surface border border-whisper shadow-sm rounded-card overflow-hidden">
                    <div className="overflow-x-auto hidden md:block">
                        <table className="w-full text-sm text-left">
                            <thead className="bg-canvas/60 text-steel border-b border-whisper/50"><tr><th className="px-6 py-3">Waktu</th><th className="px-6 py-3">Pengguna</th><th className="px-6 py-3 text-center">Aksi</th><th className="px-6 py-3">Modul</th><th className="px-6 py-3 w-1/2">Detail Aktivitas</th></tr></thead>
                            <tbody className="divide-y divide-slate-100">
                                {dataLog.map((log) => (
                                    <tr key={log.id} className="bg-surface hover:bg-canvas transition-colors">
                                        <td className="px-6 py-3 whitespace-nowrap text-steel">{log.waktu}</td>
                                        <td className="px-6 py-3 font-medium text-ink">{log.user}</td>
                                        <td className="px-6 py-3 text-center"><span className={`inline-flex px-2 py-0.5 text-[10px] font-bold rounded uppercase ${log.aksi === 'CREATE' ? 'bg-pale-green text-pale-greenText' : log.aksi === 'UPDATE' ? 'bg-blue-100 text-blue-700' : log.aksi === 'DELETE' ? 'bg-pale-red text-pale-redText' : log.aksi === 'INTEGRATION' ? 'bg-purple-100 text-purple-700' : 'bg-canvas text-steel'}`}>{log.aksi}</span></td>
                                        <td className="px-6 py-3 font-semibold text-steel">{log.modul}</td>
                                        <td className="px-6 py-3 text-steel">{log.detail}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                    <div className="md:hidden flex flex-col divide-y divide-whisper/50">
                        {dataLog.length === 0 ? (
                            <div className="text-center py-8 text-steel text-sm">Belum ada riwayat aktivitas.</div>
                        ) : dataLog.map((log) => (
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
                            </div>
                        ))}
                    </div>
                </div>
            </div>
        );
    };

    const renderModals = () => {
        if (!modalType) return null;
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
                                        <button onClick={() => handleGeneratePakasirQR('qris')} className="w-full flex items-center justify-between p-4 border border-whisper rounded-xl hover:bg-canvas transition-colors"><div className="flex items-center gap-3"><QrCode className="w-6 h-6 text-accent" /><span className="font-semibold text-ink">QRIS (Gopay, OVO, Dana)</span></div><ArrowRight className="w-4 h-4 text-steel" /></button>
                                        <button onClick={() => handleGeneratePakasirQR('bni_va')} className="w-full flex items-center justify-between p-4 border border-whisper rounded-xl hover:bg-canvas transition-colors"><div className="flex items-center gap-3"><CreditCard className="w-6 h-6 text-orange-600" /><span className="font-semibold text-ink">BNI Virtual Account</span></div><ArrowRight className="w-4 h-4 text-steel" /></button>
                                        <button onClick={() => handleGeneratePakasirQR('bri_va')} className="w-full flex items-center justify-between p-4 border border-whisper rounded-xl hover:bg-canvas transition-colors"><div className="flex items-center gap-3"><CreditCard className="w-6 h-6 text-blue-700" /><span className="font-semibold text-ink">BRI Virtual Account</span></div><ArrowRight className="w-4 h-4 text-steel" /></button>
                                        <button onClick={() => handleGeneratePakasirQR('cimb_niaga_va')} className="w-full flex items-center justify-between p-4 border border-whisper rounded-xl hover:bg-canvas transition-colors"><div className="flex items-center gap-3"><CreditCard className="w-6 h-6 text-red-600" /><span className="font-semibold text-ink">CIMB Niaga VA</span></div><ArrowRight className="w-4 h-4 text-steel" /></button>
                                        <button onClick={() => handleGeneratePakasirQR('permata_va')} className="w-full flex items-center justify-between p-4 border border-whisper rounded-xl hover:bg-canvas transition-colors"><div className="flex items-center gap-3"><CreditCard className="w-6 h-6 text-emerald-600" /><span className="font-semibold text-ink">Permata VA</span></div><ArrowRight className="w-4 h-4 text-steel" /></button>
                                        <button onClick={() => handleGeneratePakasirQR('sampoerna_va')} className="w-full flex items-center justify-between p-4 border border-whisper rounded-xl hover:bg-canvas transition-colors"><div className="flex items-center gap-3"><CreditCard className="w-6 h-6 text-red-500" /><span className="font-semibold text-ink">Sahabat Sampoerna VA</span></div><ArrowRight className="w-4 h-4 text-steel" /></button>
                                        <button onClick={() => handleGeneratePakasirQR('bnc_va')} className="w-full flex items-center justify-between p-4 border border-whisper rounded-xl hover:bg-canvas transition-colors"><div className="flex items-center gap-3"><CreditCard className="w-6 h-6 text-yellow-500" /><span className="font-semibold text-ink">BNC VA</span></div><ArrowRight className="w-4 h-4 text-steel" /></button>
                                        <button onClick={() => handleGeneratePakasirQR('maybank_va')} className="w-full flex items-center justify-between p-4 border border-whisper rounded-xl hover:bg-canvas transition-colors"><div className="flex items-center gap-3"><CreditCard className="w-6 h-6 text-yellow-600" /><span className="font-semibold text-ink">Maybank VA</span></div><ArrowRight className="w-4 h-4 text-steel" /></button>
                                        <button onClick={() => handleGeneratePakasirQR('atm_bersama_va')} className="w-full flex items-center justify-between p-4 border border-whisper rounded-xl hover:bg-canvas transition-colors"><div className="flex items-center gap-3"><CreditCard className="w-6 h-6 text-blue-500" /><span className="font-semibold text-ink">ATM Bersama VA</span></div><ArrowRight className="w-4 h-4 text-steel" /></button>
                                        <button onClick={() => handleGeneratePakasirQR('artha_graha_va')} className="w-full flex items-center justify-between p-4 border border-whisper rounded-xl hover:bg-canvas transition-colors"><div className="flex items-center gap-3"><CreditCard className="w-6 h-6 text-blue-800" /><span className="font-semibold text-ink">Artha Graha VA</span></div><ArrowRight className="w-4 h-4 text-steel" /></button>
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
                                                    <p className="text-xs font-semibold text-steel uppercase mb-1">Bank {pakasirData.method?.replace('_va', '')}</p>
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
                            {masterTagihanList.filter(t => t.tipe === 'Rutin').map(tagihan => (
                                <div key={tagihan.tagihan} className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4"><label className="text-xs font-medium text-steel w-full sm:w-1/2">{tagihan.tagihan} (Normal: Rp {Number(tagihan.nominal || 0).toLocaleString('id-ID')})</label><div className="relative w-full sm:w-1/2"><span className="absolute left-3 top-2.5 text-steel text-xs">Rp</span><input type="number" value={formData.diskonKhusus?.[tagihan.tagihan] || ''} onChange={(e) => { const val = e.target.value === '' ? '' : parseInt(e.target.value, 10); setFormData(prev => ({ ...prev, diskonKhusus: { ...(prev.diskonKhusus || {}), [tagihan.tagihan]: val } })); }} className={`${inputBase} pl-8 text-xs py-2`} placeholder="Nominal Potongan" /></div></div>
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
                    <div className="grid grid-cols-2 gap-4 mt-2">
                        <div><label className="block text-sm font-medium text-ink mb-1">Jenis Transaksi</label><select required name="jenis" value={formData.jenis || 'Setor'} onChange={handleInputChange} className={inputBase}><option value="Setor">Setor (Nabung)</option><option value="Tarik">Tarik (Ambil)</option></select></div>
                        <div><label className="block text-sm font-medium text-ink mb-1">Nominal (Rp)</label><input required name="nominal" value={formData.nominal || ''} onChange={handleInputChange} type="number" className={inputBase} /></div>
                    </div>
                    <div className="mt-2"><label className="block text-sm font-medium text-ink mb-1">Keterangan Tambahan</label><input name="keterangan" value={formData.keterangan || ''} onChange={handleInputChange} type="text" className={inputBase} placeholder="Contoh: Uang jajan, dll..." /></div>
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
                        <div className="mt-3"><label className="block text-sm font-medium text-ink mb-2">Bulan Tagihan (Bisa pilih lebih dari 1)</label><div className="grid grid-cols-3 sm:grid-cols-4 gap-2">{listBulan.map(b => (<label key={b} className="flex items-center gap-1.5 text-xs bg-canvas border border-whisper px-2 py-1.5 rounded cursor-pointer hover:bg-whisper"><input type="checkbox" checked={(formData.selectedBulan || []).includes(b)} onChange={(e) => handleBulanChange(b, e)} className="rounded text-blue-600" /> {b.substring(0, 3)}</label>))}</div></div>
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
                                <><div><label className="block text-sm font-medium text-ink mb-1 mt-2">Jenis Pembayaran / Tagihan</label><select required name="tagihan" value={formData.tagihan || ''} onChange={(e) => { const val = e.target.value; const tRef = masterTagihanList.find(t => t.tagihan === val); setFormData(prev => ({ ...prev, tagihan: val, nominal: tRef ? tRef.nominal : prev.nominal })); }} className={inputBase}><option value="">-- Pilih --</option>{masterTagihanList.filter(t => !String(t.portalMenu || '').includes('Sembunyikan')).map(t => <option key={t.tagihan} value={t.tagihan}>{t.tagihan}</option>)}</select></div>
                                    {!formData.id ? (<div className="mt-3"><label className="block text-sm font-medium text-ink mb-2">Bulan Dibayar (Bisa pilih lebih dari 1)</label><div className="grid grid-cols-3 sm:grid-cols-4 gap-2">{listBulan.map(b => (<label key={b} className="flex items-center gap-1.5 text-xs bg-canvas border border-whisper px-2 py-1.5 rounded cursor-pointer hover:bg-whisper"><input type="checkbox" checked={(formData.selectedBulan || []).includes(b)} onChange={(e) => handleBulanChange(b, e)} className="rounded text-blue-600" /> {b.substring(0, 3)}</label>))}</div></div>) : (<div className="mt-2"><label className="block text-sm font-medium text-ink mb-1">Bulan</label><select required name="bulan" value={formData.bulan || ''} onChange={handleInputChange} className={inputBase}>{listBulan.map(b => <option key={b} value={b}>{b}</option>)}</select></div>)}
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
                                <><form onSubmit={(e) => { e.preventDefault(); const nom = parseInt(formData.nominal?.toString().replace(/\D/g, '') || '0', 10); setMasterTagihanList(prev => [...prev.filter(x => x.tagihan !== formData.tagihan), { tagihan: formData.tagihan, nominal: nom, tipe: formData.tipe || 'Rutin', pakasirSlug: formData.pakasirSlug, pakasirApiKey: formData.pakasirApiKey, portalMenu: formData.portalMenu || [] }]); addLog(masterTagihanList.some(x => x.tagihan === formData.tagihan) ? 'UPDATE' : 'CREATE', 'MASTER TAGIHAN', `${masterTagihanList.some(x => x.tagihan === formData.tagihan) ? 'Edit' : 'Tambah'} master tagihan: ${formData.tagihan}`); setFormData({}); }} className="flex flex-col gap-4 border border-whisper p-4 rounded-xl">
                                    <div className="text-sm font-semibold text-steel">Tambah/Edit Tagihan</div>
                                    <div className="grid grid-cols-2 gap-4"><input required name="tagihan" value={formData.tagihan || ''} onChange={handleInputChange} type="text" className={inputBase} placeholder="Nama Tagihan" /><input required name="nominal" value={formData.nominal || ''} onChange={handleInputChange} type="text" className={inputBase} placeholder="Nominal Rp" /></div>
                                    <div className="bg-blue-50/50 p-3 rounded-lg border border-blue-100"><div className="text-xs font-semibold text-blue-700 mb-2">Integrasi Pakasir API & Portal</div>
                                        <div className="grid grid-cols-2 gap-4 mb-3"><input name="pakasirSlug" value={formData.pakasirSlug || ''} onChange={handleInputChange} type="text" className={`${inputBase} text-xs py-1.5 bg-white border-blue-200`} placeholder="Project Slug Pakasir" /><input name="pakasirApiKey" value={formData.pakasirApiKey || ''} onChange={handleInputChange} type="text" className={`${inputBase} text-xs py-1.5 bg-white border-blue-200`} placeholder="API Key Pakasir" /></div>
                                        <div><div className="text-[10px] font-semibold text-blue-800 mb-1.5 uppercase tracking-wider">Tampilkan di Portal Wali</div><div className="flex gap-4"><label className="flex items-center gap-1.5 text-xs text-blue-900 cursor-pointer"><input type="checkbox" checked={(formData.portalMenu || []).includes('Bayar Tagihan Lain')} onChange={(e) => { const pm = formData.portalMenu || []; setFormData(p => ({ ...p, portalMenu: e.target.checked ? [...pm, 'Bayar Tagihan Lain'].filter(x => x !== 'Sembunyikan') : pm.filter(x => x !== 'Bayar Tagihan Lain') })) }} className="rounded text-blue-600 w-3.5 h-3.5" /> Bayar Tagihan Lain</label><label className="flex items-center gap-1.5 text-xs text-rose-700 cursor-pointer"><input type="checkbox" checked={(formData.portalMenu || []).includes('Sembunyikan')} onChange={(e) => setFormData(p => ({ ...p, portalMenu: e.target.checked ? ['Sembunyikan'] : [] }))} className="rounded text-rose-600 w-3.5 h-3.5" /> Sembunyikan Saja</label></div></div>
                                    </div>
                                    <div className="flex gap-2 items-center"><select name="tipe" value={formData.tipe || 'Rutin'} onChange={handleInputChange} className={`${inputBase} w-1/3`}><option value="Rutin">Rutin (Bulanan)</option><option value="Insidental">Insidental (1x)</option></select><button type="submit" className={`${btnPrimary} flex-1`}><Plus className="w-4 h-4" /> Simpan Tagihan</button></div>
                                </form>
                                    <div className="hidden md:block border border-whisper rounded-card overflow-hidden">
                                        <table className="w-full text-sm text-left block">
                                            <thead className="bg-canvas"><tr className="flex w-full"><th className="px-4 py-2 flex-1">Jenis Tagihan</th><th className="px-4 py-2 w-32 text-right">Nominal</th><th className="px-4 py-2 w-20 text-center">Aksi</th></tr></thead>
                                            <tbody className="divide-y divide-slate-100 flex flex-col w-full max-h-48 overflow-y-auto">{masterTagihanList.map(t => (<tr key={t.tagihan} className="flex w-full items-center"><td className="px-4 py-3 flex-1"><div>{t.tagihan}</div><div className="text-[10px] text-steel font-medium uppercase mt-0.5">{t.tipe} {t.pakasirSlug && <span className="ml-2 text-emerald-600">V Pakasir</span>} {Array.isArray(t.portalMenu) && t.portalMenu.includes('Sembunyikan') && <span className="ml-2 text-rose-500 text-[9px] border border-rose-200 px-1 rounded bg-rose-50">Sembunyi</span>}</div></td><td className="px-4 py-3 w-32 text-right font-medium">Rp {Number(t.nominal || 0).toLocaleString('id-ID')}</td><td className="px-4 py-3 w-20 flex items-center justify-center gap-3"><button onClick={() => setFormData({ tagihan: t.tagihan, nominal: t.nominal.toString(), tipe: t.tipe, pakasirSlug: t.pakasirSlug || '', pakasirApiKey: t.pakasirApiKey || '', portalMenu: Array.isArray(t.portalMenu) ? t.portalMenu : [] })} className="text-accent hover:text-accentDark"><Edit className="w-4 h-4" /></button><button onClick={() => confirmDelete('MASTER_TAGIHAN', t.tagihan, t.tagihan)} className="text-rose-600 hover:text-red-700"><Trash2 className="w-4 h-4" /></button></td></tr>))}</tbody>
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
                                                        <button onClick={() => setFormData({ tagihan: t.tagihan, nominal: t.nominal.toString(), tipe: t.tipe, pakasirSlug: t.pakasirSlug || '', pakasirApiKey: t.pakasirApiKey || '', portalMenu: Array.isArray(t.portalMenu) ? t.portalMenu : [] })} className="text-accent flex items-center gap-1 text-[10px] font-semibold bg-accent/10 px-2 py-1 rounded"><Edit className="w-3 h-3" /> Edit</button>
                                                        <button onClick={() => confirmDelete('MASTER_TAGIHAN', t.tagihan, t.tagihan)} className="text-danger flex items-center gap-1 text-[10px] font-semibold bg-dangerBg px-2 py-1 rounded"><Trash2 className="w-3 h-3" /> Hapus</button>
                                                    </div>
                                                </div>
                                            </div>
                                        ))}
                                    </div></>
                            ) : (
                                <><form onSubmit={(e) => { e.preventDefault(); simpleSetList(prev => [...prev, formData[simpleField]]); setFormData({}); }} className="flex gap-2"><input required name={simpleField} value={formData[simpleField] || ''} onChange={handleInputChange} type="text" className={inputBase} placeholder={`Tambah ${simpleTitle.replace('Master ', '')}`} /><button type="submit" className={btnPrimary}><Plus className="w-4 h-4" /></button></form>
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

        const handleSaveBranding = (e) => {
            e.preventDefault();
            showNotification('Pengaturan Branding berhasil disimpan!');
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

        const toggleMenuAccess = (jabatan, menuId) => {
            setDataRoleAccess(prev => {
                const existing = prev.find(r => r.jabatan === jabatan);
                if (existing) {
                    const menus = Array.isArray(existing.aksesMenu) ? existing.aksesMenu : [];
                    const updated = menus.includes(menuId) ? menus.filter(m => m !== menuId) : [...menus, menuId];
                    return prev.map(r => r.jabatan === jabatan ? { ...r, aksesMenu: updated } : r);
                }
                return [...prev, { jabatan, aksesMenu: [menuId] }];
            });
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
            {confirmDialog && (
                <div className="fixed inset-0 z-[110] flex items-center justify-center p-4 bg-ink/20 backdrop-blur-[3px]"><div className="bg-surface rounded-card shadow-diffused w-full max-w-sm p-8 flex flex-col items-center text-center animate-fade-in-up"><div className="w-14 h-14 rounded-2xl bg-dangerBg flex items-center justify-center mb-5"><AlertCircle className="w-7 h-7 text-danger" /></div><h3 className="font-bold text-lg text-ink mb-1">{confirmDialog.type === 'NAIK_KELAS' ? 'Konfirmasi?' : 'Hapus Data?'}</h3><p className="text-steel text-sm mb-6">{confirmDialog.type === 'NAIK_KELAS' ? 'Lanjutkan proses Kenaikan Kelas Massal?' : `Anda yakin ingin menghapus`} <strong className="text-ink">{confirmDialog.nama}</strong>?</p><div className="flex gap-3 w-full"><button onClick={() => setConfirmDialog(null)} className={`${btnOutline} flex-1 justify-center`}>Batal</button><button onClick={executeDelete} className={`${confirmDialog.type === 'NAIK_KELAS' ? btnPrimary : btnDanger} flex-1 justify-center`}>Ya, {confirmDialog.type === 'NAIK_KELAS' ? 'Lanjutkan' : 'Hapus'}</button></div></div></div>
            )}
            {notification && (<div className="fixed bottom-24 md:bottom-6 right-6 z-[120] bg-ink text-white px-6 py-3 rounded-xl shadow-diffused flex items-center gap-3 animate-fade-in-up"><div className="w-2 h-2 bg-accent rounded-full animate-pulse"></div> {notification}</div>)}
        </div>
    );
}

export default App;
