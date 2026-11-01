import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://hconlmrrerltnmryzdll.supabase.co';
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imhjb25sbXJyZXJsdG5tcnl6ZGxsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI0ODQ4NDIsImV4cCI6MjA5ODA2MDg0Mn0.uZfnUonT1eN06yyLhDWaYXe8qzoNLC2gJ6EPB8pkoGI';
const supabase = createClient(supabaseUrl, supabaseKey);

export async function POST(request) {
  console.log("=== INCOMING DOKU WEBHOOK NOTIFICATION ===");

  try {
    const rawBody = await request.text();
    let payload = {};
    try {
      payload = JSON.parse(rawBody);
    } catch (e) {
      console.warn("Failed to parse JSON body:", rawBody);
    }

    console.log("DOKU Webhook Payload:", JSON.stringify(payload, null, 2));

    // 1. Ekstraksi data baik dari format SNAP maupun Non-SNAP
    const invoiceNumber = 
      payload.order?.invoice_number || 
      payload.originalPartnerReferenceNo || 
      payload.invoice_number || 
      payload.order_id || 
      '';

    const isSuccess = 
      payload.transaction?.status === 'SUCCESS' ||
      payload.latestTransactionStatus === '00' ||
      payload.status === 'SUCCESS' ||
      payload.transactionStatusDesc?.toLowerCase() === 'success' ||
      payload.service?.status === 'SUCCESS';

    const amount = Number(
      payload.order?.amount || 
      payload.amount?.value || 
      payload.amount || 
      0
    );

    const channelName = 
      payload.channel?.id || 
      payload.service?.id || 
      payload.additionalInfo?.channelId || 
      'DOKU';

    if (!invoiceNumber) {
      console.warn("Webhook received without invoice number");
      return NextResponse.json({
        responseCode: "2005600",
        responseMessage: "Successful (No invoice number found)",
        status: "SUCCESS"
      });
    }

    // 2. Ambil data order dari Supabase
    const { data: orderData } = await supabase
      .from('PakasirOrders')
      .select('*')
      .eq('order_id', invoiceNumber)
      .maybeSingle();

    const orderPayload = orderData?.payload || {};
    const orderType = orderData?.tipe || (
      invoiceNumber.startsWith('POS') ? 'POS' : 
      invoiceNumber.startsWith('TB') ? 'TOPUP_TABUNGAN' : 
      'TAGIHAN_PORTAL'
    );

    if (isSuccess) {
      console.log(`Payment confirmed for Order: ${invoiceNumber} [${orderType}] Amount: ${amount}`);

      // 3. Update status order menjadi COMPLETED
      await supabase
        .from('PakasirOrders')
        .update({ status: 'COMPLETED' })
        .eq('order_id', invoiceNumber);

      // 4. Aksi sesuai tipe transaksi
      if (orderType === 'POS') {
        // --- TRANSAKSI KASIR POS ---
        const trxData = {
          TrxID: invoiceNumber,
          SantriID: orderPayload.santriId || null,
          TotalHarga: amount || orderPayload.total || 0,
          WaktuTransaksi: new Date().toISOString(),
          Metode: `Transfer Virtual Account (${channelName})`,
          StatusAmbil: 'Selesai',
          WarungID: orderPayload.warungId || 'WRG-KANTIN'
        };
        await supabase.from('Transaksi').upsert([trxData], { onConflict: 'TrxID' });

        if (orderPayload.items && orderPayload.items.length > 0) {
          const details = orderPayload.items.map((i) => ({
            TrxID: invoiceNumber,
            KodeProduk: i.id || '',
            NamaProduk: i.name || i.nama,
            Kuantitas: i.quantity || i.qty || 1,
            HargaSatuan: i.price || i.harga || 0
          }));
          await supabase.from('DetailTransaksi').insert(details);
        }

        // Push notifikasi ke wali santri jika santri belanja di POS
        if (orderPayload.santriId) {
          try {
            const origin = request.nextUrl?.origin || 'https://salapp-bendahara.web.id';
            fetch(`${origin}/api/notifikasi`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                nis: orderPayload.santriId,
                title: 'Info Jajan Kantin',
                body: `Ananda baru saja jajan senilai Rp ${amount.toLocaleString('id-ID')} via DOKU.`
              })
            }).catch(e => console.warn('Push notif error:', e));
          } catch {}
        }
      } 
      else if (orderType === 'TOPUP_TABUNGAN' || invoiceNumber.startsWith('TB')) {
        // --- TOP UP TABUNGAN SANTRI ---
        const santriNis = String(orderPayload.nis || orderPayload.santriId || '').trim();
        const topupAmount = amount || Number(orderPayload.amount || 0);

        if (santriNis && topupAmount > 0) {
          const cleanNis = santriNis.replace(/^0+/, '');
          
          // Ambil saldo santri saat ini
          const { data: santriList } = await supabase.from('Santri').select('*');
          const santri = (santriList || []).find(s => String(s.nis || '').replace(/^0+/, '') === cleanNis);

          if (santri) {
            const newSaldo = (Number(santri.saldo) || 0) + topupAmount;
            await supabase.from('Santri').update({ saldo: newSaldo }).eq('id', santri.id);

            // Catat di tabel Tabungan
            await supabase.from('Tabungan').insert([{
              ID: invoiceNumber,
              NIS: santri.nis,
              Nama: santri.nama,
              Jenis: 'Setor',
              Jumlah: topupAmount,
              SaldoAkhir: newSaldo,
              Tanggal: new Date().toISOString(),
              Keterangan: `Top Up Online DOKU (${channelName})`
            }]);

            // Kirim notifikasi
            try {
              const origin = request.nextUrl?.origin || 'https://salapp-bendahara.web.id';
              fetch(`${origin}/api/notifikasi`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  nis: santri.nis,
                  title: '✅ Top Up Saldo Berhasil',
                  body: `Saldo tabungan ananda ${santri.nama} berhasil ditambah Rp ${topupAmount.toLocaleString('id-ID')} via DOKU. Saldo sekarang: Rp ${newSaldo.toLocaleString('id-ID')}`
                })
              }).catch(e => console.warn('Push notif error:', e));
            } catch {}
          }
        }
      } 
      else {
        // --- PEMBAYARAN TAGIHAN / SPP ---
        const tagihanList = orderPayload.selectedTagihan || (orderPayload.tagihanData ? [orderPayload.tagihanData] : []);

        for (const tg of tagihanList) {
          if (!tg) continue;
          const sisa = Math.max(0, (tg.nominal || 0) - (tg.terbayar || 0));
          const amountToPay = orderPayload.isBulk ? sisa : (amount || sisa);

          if (amountToPay <= 0) continue;

          const totalTerbayarBaru = (tg.terbayar || 0) + amountToPay;
          const statusTrx = totalTerbayarBaru < (tg.nominal || 0) ? 'Cicil' : 'Lunas';
          const sisaTagihan = Math.max(0, (tg.nominal || 0) - totalTerbayarBaru);

          // Update Tagihan
          await supabase.from('Tagihan').update({
            status: statusTrx,
            terbayar: totalTerbayarBaru
          }).eq('id', tg.id);

          // Insert Pembayaran
          await supabase.from('Pembayaran').insert([{
            id: `INV-DOKU-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
            tanggal: new Date().toISOString().split('T')[0],
            nis: tg.nis,
            nama: tg.nama,
            tagihan: tg.tagihan + ` (Via DOKU ${channelName})`,
            periode: tg.periode,
            nominal: amountToPay,
            status: statusTrx === 'Cicil' ? 'Cicilan' : 'Lunas',
            sisa: sisaTagihan,
            items: JSON.stringify([{ tagihan: tg.tagihan, periode: tg.periode, nominal: amountToPay }])
          }]);
        }

        // Push notifikasi ke wali santri
        if (tagihanList.length > 0 && tagihanList[0]?.nis) {
          try {
            const namaTagihan = tagihanList.map(t => t.tagihan).join(', ');
            const origin = request.nextUrl?.origin || 'https://salapp-bendahara.web.id';
            fetch(`${origin}/api/notifikasi`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                nis: tagihanList[0].nis,
                title: '✅ Pembayaran Berhasil',
                body: `Pembayaran ${namaTagihan} senilai Rp ${amount.toLocaleString('id-ID')} via DOKU telah diterima lunas.`
              })
            }).catch(e => console.warn('Notif tagihan error:', e));
          } catch {}
        }
      }
    } else {
      // Jika status gagal/expired
      if (['FAILED', 'EXPIRED', 'CANCEL', '06'].includes(payload.transaction?.status || payload.latestTransactionStatus)) {
        await supabase
          .from('PakasirOrders')
          .update({ status: 'FAILED' })
          .eq('order_id', invoiceNumber);
      }
    }

    // Response standar DOKU & SNAP (200 OK)
    return NextResponse.json({
      responseCode: "2005600",
      responseMessage: "Successful",
      status: "SUCCESS"
    });
  } catch (error) {
    console.error("DOKU Webhook Error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

