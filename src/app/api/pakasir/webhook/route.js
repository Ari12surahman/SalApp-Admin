import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "https://placeholder.supabase.co";
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "placeholder";
const supabase = createClient(supabaseUrl, supabaseKey);

export async function POST(request) {
  try {
    const payload = await request.json();
    console.log("Incoming Webhook Pakasir:", payload);

    // Pakasir webhook format bisa bervariasi, kita coba deteksi order_id dan status
    const orderId = payload.order_id || payload.transaction?.order_id || payload.data?.order_id;
    let status = (payload.status || payload.transaction?.status || payload.data?.status || '').toLowerCase();
    
    // Kadang status berupa payment_status
    if (!status && payload.payment_status) {
        status = payload.payment_status.toLowerCase();
    }

    if (!orderId) {
      return NextResponse.json({ error: 'Missing order_id' }, { status: 400 });
    }

    // Jika status berhasil
    if (['completed', 'success', 'settlement', 'paid'].includes(status)) {
      
      // Cari di PakasirOrders
      const { data: orderData, error: orderError } = await supabase
        .from('PakasirOrders')
        .select('*')
        .eq('order_id', orderId)
        .single();

      if (orderError || !orderData) {
        console.error("Order not found in PakasirOrders:", orderId);
        return NextResponse.json({ error: 'Order not found' }, { status: 404 });
      }

      if (orderData.status === 'COMPLETED') {
        return NextResponse.json({ message: 'Order already completed' }, { status: 200 });
      }

      // Update status di PakasirOrders
      await supabase.from('PakasirOrders').update({ status: 'COMPLETED' }).eq('order_id', orderId);

      // --- Proses sesuai tipe ---
      const orderPayload = orderData.payload || {};

      if (orderData.tipe === 'POS') {
        // Logika POS (sama seperti simpanTransaksiOffline)
        const trxId = orderPayload.orderId || orderId; // Gunakan orderId sebagai TrxID
        const trxData = {
           TrxID: trxId,
           SantriID: orderPayload.santriId || null,
           TotalHarga: orderPayload.total,
           WaktuTransaksi: new Date().toISOString(),
           Metode: orderPayload.method || 'QRIS',
           StatusAmbil: orderPayload.statusAmbil || 'Selesai',
           WarungID: orderPayload.warungId || 'WRG-KANTIN'
        };
        await supabase.from('Transaksi').insert([trxData]);

        if (orderPayload.items && orderPayload.items.length > 0) {
           const details = orderPayload.items.map((i) => ({
             TrxID: trxId,
             KodeProduk: i.id || '',
             NamaProduk: i.name,
             Kuantitas: i.quantity,
             HargaSatuan: i.price
           }));
           await supabase.from('DetailTransaksi').insert(details);
        }

        // Trigger Firebase Push Notification
        try {
          if (orderPayload.santriId) {
             const itemNames = orderPayload.items && orderPayload.items.length > 0 
                ? orderPayload.items.map((i) => `${i.name} (${i.quantity})`).join(', ') 
                : 'beberapa jajanan';
             const notifBody = orderPayload.buyerName
                ? `Ananda ${orderPayload.buyerName} baru saja jajan di kantin berupa ${itemNames} senilai Rp ${Number(orderPayload.total).toLocaleString('id-ID')} menggunakan ${orderPayload.method || 'QRIS'}.`
                : `Pembayaran ${orderPayload.method || 'QRIS'} senilai Rp ${Number(orderPayload.total).toLocaleString('id-ID')} berhasil.`;
                
             const origin = request.headers.get('origin') || 'https://sal-app-admin.vercel.app';
             fetch(`${origin}/api/notifikasi`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                   nis: orderPayload.santriId, 
                   title: 'Info Jajan Kantin', 
                   body: notifBody
                })
             }).catch(e => console.error('Push notif error:', e));
          }
        } catch (e) {
          console.error("Notif error", e);
        }
      } 
      else if (orderData.tipe === 'TAGIHAN_PORTAL' || orderData.tipe === 'TAGIHAN_ADMIN') {
        // Logika untuk Portal & Admin Tagihan
        const tagihanList = orderPayload.selectedTagihan || (orderPayload.tagihanData ? [orderPayload.tagihanData] : []);
        const method = orderPayload.method || 'QRIS';
        
        for (const tg of tagihanList) {
           if (!tg) continue;
           const sisa = Math.max(0, (tg.nominal || 0) - (tg.terbayar || 0));
           const amountToPay = orderPayload.isBulk ? sisa : (orderPayload.amount || sisa);

           if (amountToPay <= 0) continue;

           const totalTerbayarBaru = (tg.terbayar || 0) + amountToPay;
           const statusTrx = totalTerbayarBaru < (tg.nominal || 0) ? 'Cicil' : 'Lunas';
           const sisaTagihan = Math.max(0, (tg.nominal || 0) - totalTerbayarBaru);

           // 1. Update Tagihan
           await supabase.from('Tagihan').update({
              status: statusTrx,
              terbayar: totalTerbayarBaru
           }).eq('id', tg.id);

           // 2. Insert Pembayaran
           const idArr = orderId.split('-');
           const pksId = idArr.length > 2 ? idArr[idArr.length - 1] : Date.now().toString();
           const invId = `INV-PKS-${pksId}-${Math.floor(Math.random() * 1000)}`;
           
           await supabase.from('Pembayaran').insert([{
              id: invId,
              tanggal: new Date().toISOString().split('T')[0],
              nis: tg.nis,
              nama: tg.nama,
              tagihan: tg.tagihan + ` (Via ${method})`,
              periode: tg.periode,
              nominal: amountToPay,
              status: statusTrx === 'Cicil' ? 'Cicilan' : 'Lunas',
              sisa: sisaTagihan,
              items: JSON.stringify([{ tagihan: tg.tagihan, periode: tg.periode, nominal: amountToPay }])
           }]);
        }
      }
    } else {
      // Jika Failed / Expired
      if (['expired', 'failed', 'cancel'].includes(status)) {
        await supabase.from('PakasirOrders').update({ status: 'FAILED' }).eq('order_id', orderId);
      }
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Webhook Error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
