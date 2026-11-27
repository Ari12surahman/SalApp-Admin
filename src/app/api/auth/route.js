import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';

export async function POST(request) {
    try {
        const body = await request.json();
        const username = String(body?.username || '').trim();
        const password = String(body?.password || '').trim();

        if (!username || !password) {
            return NextResponse.json(
                { success: false, message: 'Isi username/NIP dan password.' },
                { status: 400 }
            );
        }

        if (!supabaseUrl || !supabaseKey) {
            return NextResponse.json(
                { success: false, message: 'Konfigurasi database server belum lengkap.' },
                { status: 500 }
            );
        }

        const supabase = createClient(supabaseUrl, supabaseKey);

        // 1. Cek di tabel Admin
        const { data: adminRows, error: adminErr } = await supabase
            .from('Admin')
            .select('id, username, nama, password, role')
            .eq('username', username)
            .limit(5);

        if (!adminErr && Array.isArray(adminRows) && adminRows.length > 0) {
            const matchedAdmin = adminRows.find(a => String(a.password) === password);
            if (matchedAdmin) {
                return NextResponse.json({
                    success: true,
                    user: {
                        id: matchedAdmin.id,
                        username: matchedAdmin.username,
                        nama: matchedAdmin.nama,
                        role: matchedAdmin.role || 'superadmin',
                        jabatan: 'Super Admin',
                        loginAt: new Date().toISOString()
                    }
                });
            }
        }

        // Fallback default superadmin jika tabel Admin masih kosong
        if ((!adminRows || adminRows.length === 0) && username === 'admin' && password === 'admin123') {
            return NextResponse.json({
                success: true,
                user: {
                    id: 'ADM-1',
                    username: 'admin',
                    nama: 'Super Admin',
                    role: 'superadmin',
                    jabatan: 'Super Admin',
                    loginAt: new Date().toISOString()
                }
            });
        }

        // 2. Cek di tabel Data Pegawai
        const { data: pegawaiRows, error: pegawaiErr } = await supabase
            .from('Data Pegawai')
            .select('id, nip, nama, jabatan, password')
            .eq('nip', username)
            .limit(5);

        if (!pegawaiErr && Array.isArray(pegawaiRows) && pegawaiRows.length > 0) {
            const matchedPegawai = pegawaiRows.find(p => String(p.password) === password);
            if (matchedPegawai) {
                return NextResponse.json({
                    success: true,
                    user: {
                        id: matchedPegawai.id,
                        nama: matchedPegawai.nama,
                        role: 'pegawai',
                        jabatan: matchedPegawai.jabatan,
                        nip: matchedPegawai.nip,
                        loginAt: new Date().toISOString()
                    }
                });
            }
        }

        return NextResponse.json(
            { success: false, message: 'Username/NIP atau password salah.' },
            { status: 401 }
        );
    } catch (err) {
        console.error('Auth API Error:', err);
        return NextResponse.json(
            { success: false, message: 'Terjadi kesalahan pada server autentikasi.' },
            { status: 500 }
        );
    }
}
