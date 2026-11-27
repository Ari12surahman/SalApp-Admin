import { NextResponse } from 'next/server';
import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://hconlmrrerltnmryzdll.supabase.co';
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imhjb25sbXJyZXJsdG5tcnl6ZGxsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI0ODQ4NDIsImV4cCI6MjA5ODA2MDg0Mn0.uZfnUonT1eN06yyLhDWaYXe8qzoNLC2gJ6EPB8pkoGI';
const supabase = createClient(supabaseUrl, supabaseKey);

const DEFAULT_CODE_MERCHANT = process.env.WIJAYAPAY_CODE_MERCHANT || 'WP6aeb77c146ef6';
const DEFAULT_API_KEY = process.env.WIJAYAPAY_API_KEY || '802e6a184e03142089590837a6';

export async function POST(request) {
  console.log("=== INCOMING WIJAYAPAY WEBHOOK NOTIFICATION ===");

  try {
    const rawBody = await request.text();
    let payload = {};
    try {
      payload = JSON.parse(rawBody);
    } catch (e) {
      console.warn("Gagal parse body JSON:", rawBody);
    }

    console.log("WijayaPay Webhook Payload:", JSON.stringify(payload, null, 2));

    const rawData = payload.data || payload;
    const invoiceNumber = rawData.ref_id || payload.ref_id || payload.order_id || payload.invoice_number || '';
    const statusPembayaran = String(payload.status || rawData.status || rawData.status_pembayaran || payload.status_pembayaran || '').toLowerCase();
    const isSuccess = statusPembayaran === 'paid' || statusPembayaran === 'success' || statusPembayaran === 'settlement' || statusPembayaran === 'berhasil';
    const amount = Number(rawData.total_dibayar || rawData.total_bayar || rawData.nominal || payload.total_bayar || payload.total_dibayar || payload.nominal || payload.amount || 0);
    const channelName = rawData.payment_methode || rawData.payment_method || rawData.payment_name || rawData.code_payment || payload.payment_method || payload.payment_name || payload.code_payment || 'WijayaPay';
    const trxRef = rawData.trx_reference || payload.trx_reference || '';

    // Verifikasi X-Signature jika tersedia
    const incomingSignature = request.headers.get('x-signature') || '';
    if (incomingSignature && invoiceNumber) {
      const expectedSignature = crypto.createHash('md5').update(DEFAULT_CODE_MERCHANT + DEFAULT_API_KEY + invoiceNumber).digest('hex');
      if (incomingSignature.toLowerCase() !== expectedSignature.toLowerCase()) {
        console.warn("Invalid X-Signature from WijayaPay:", incomingSignature, "Expected:", expectedSignature);
      }
    }

    if (!invoiceNumber) {
      console.warn("Webhook diterima tanpa ref_id / invoice number");
      return NextResponse.json({ success: true, message: "No ref_id provided" });
    }

    // 1. Ambil data order dari Supabase
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
      console.log(`Pembayaran Berhasil untuk Order: ${invoiceNumber} [${orderType}] Sebesar: Rp ${amount}`);

      // 2. Update status order menjadi COMPLETED
      await supabase
        .from('PakasirOrders')
        .update({ status: 'COMPLETED' })
        .eq('order_id', invoiceNumber);

      // 3. Eksekusi sesuai tipe transaksi
      if (orderType === 'POS') {
        // --- TRANSAKSI KASIR POS (IDEMPOTENT) ---
        const { data: existingTrx } = await supabase
          .from('Transaksi')
          .select('TrxID')
          .eq('TrxID', invoiceNumber)
          .maybeSingle();

        if (!existingTrx) {
          const trxData = {
            TrxID: invoiceNumber,
            SantriID: orderPayload.santriId || null,
            TotalHarga: orderPayload.total || amount || 0,
            Waktu: new Date().toISOString(),
            Metode: `Transfer Online (${channelName})`,
            StatusPencairan: 'Belum Diajukan',
            StatusAmbil: orderPayload.statusAmbil || 'Sudah Diambil',
            WarungID: orderPayload.warungId || 'WRG-KANTIN',
            Catatan: `WijayaPay Ref: ${trxRef}`
          };

          const { error: trxErr } = await supabase.from('Transaksi').upsert([trxData], { onConflict: 'TrxID' });
          if (trxErr) console.error("Gagal insert Transaksi POS:", trxErr);

          if (Array.isArray(orderPayload.items)) {
            const detailRows = orderPayload.items.map((item) => ({
              TrxID: invoiceNumber,
              ProdukID: item.id || item.produkId || '',
              NamaProduk: item.name || item.nama || item.namaProduk || '',
              HargaSatuan: item.price || item.harga || 0,
              Kuantitas: item.quantity || item.qty || 1,
              Subtotal: (item.price || item.harga || 0) * (item.quantity || item.qty || 1)
            }));
            await supabase.from('DetailTransaksi').upsert(detailRows);

            // Kurangi stok produk sekali saja
            for (const item of orderPayload.items) {
              const pid = item.id || item.produkId;
              const qty = item.quantity || item.qty || 1;
              if (pid) {
                const { data: pData } = await supabase.from('Produk').select('Stok').eq('ID', pid).maybeSingle();
                if (pData) {
                  const currentStock = Number(pData.Stok || 0);
                  const newStock = Math.max(0, currentStock - qty);
                  await supabase.from('Produk').update({ Stok: newStock }).eq('ID', pid);
                }
              }
            }
          }
        }
      } else if (
        orderType === 'TOPUP_TABUNGAN' ||
        invoiceNumber.startsWith('TB-') ||
        orderPayload?.tagihanData?.tagihan === 'Tabungan'
      ) {
        // --- SETOR / TOP UP TABUNGAN SANTRI (IDEMPOTENT) ---
        const tg = orderPayload.tagihanData || {};
        const santriNis = String(orderPayload.nis || orderPayload.santriId || tg.nis || '').trim();
        const finalNominal = Number(
          orderPayload.bayarAmount || orderPayload.nominal || tg.sisa || tg.nominal || orderPayload.amount || amount || 0
        );
        const tbId = invoiceNumber.startsWith('TB-')
          ? invoiceNumber.split('_')[0]
          : `TAB-${invoiceNumber.replace(/[^a-zA-Z0-9_-]/g, '')}`;

        if (santriNis && finalNominal > 0) {
          const { data: existingTab } = await supabase
            .from('Tabungan')
            .select('id')
            .eq('id', tbId)
            .maybeSingle();

          if (!existingTab) {
            let santriNama = String(orderPayload.nama || tg.nama || '').trim();
            if (!santriNama) {
              const cleanNis = santriNis.replace(/^0+/, '');
              const { data: santriRows } = await supabase.from('Santri').select('nis, nama');
              const matched = (santriRows || []).find(
                (s) => String(s.nis || '').replace(/^0+/, '') === cleanNis
              );
              santriNama = matched?.nama || `Santri (${santriNis})`;
            }

            const tgl = new Date().toISOString().split('T')[0];
            const extraKet = tg.keterangan ? `${tg.keterangan} ` : '';
            const ket = `${extraKet}Setor Tabungan Online (${channelName}${trxRef ? ` - Ref: ${trxRef}` : ''})`.trim();

            const { error: tabErr } = await supabase.from('Tabungan').upsert([{
              id: tbId,
              tanggal: tgl,
              nis: santriNis,
              nama: santriNama,
              jenis: 'Setor',
              nominal: finalNominal,
              keterangan: ket
            }], { onConflict: 'id' });
            if (tabErr) console.error('Gagal insert Tabungan online:', tabErr);
          }
        }

      } else {
        // --- TAGIHAN PORTAL / ADMIN (SPP, DSP, GEDUNG, DLL) ---
        const tglBayar = new Date().toISOString().split('T')[0];
        const methodSuffix = ` (Via ${channelName})`;
        const tgPayload = orderPayload.tagihanData || {};
        const pendingTrx = tgPayload.pendingTrx || orderPayload.pendingTrx || null;

        // Kasus A: Dibuat dari Admin Pembayaran / Tagihan dengan pendingTrx (INV-...)
        if (pendingTrx && pendingTrx.id) {
          const invId = String(pendingTrx.id);
          const { data: existingPay } = await supabase
            .from('Pembayaran')
            .select('id')
            .eq('id', invId)
            .maybeSingle();

          if (!existingPay) {
            const itemsArr = Array.isArray(pendingTrx.items)
              ? pendingTrx.items
              : (typeof pendingTrx.items === 'string' ? JSON.parse(pendingTrx.items || '[]') : []);
            const linkedIds = Array.isArray(pendingTrx.linkedTagihans) ? pendingTrx.linkedTagihans : [];

            const payRow = {
              id: invId,
              tanggal: tglBayar,
              nis: pendingTrx.nis || tgPayload.nis || '',
              nama: pendingTrx.nama || tgPayload.nama || '',
              tagihan: String(pendingTrx.tagihan || tgPayload.tagihan || 'Pembayaran Tagihan').includes('(Via ')
                ? String(pendingTrx.tagihan || tgPayload.tagihan)
                : `${pendingTrx.tagihan || tgPayload.tagihan || 'Pembayaran Tagihan'}${methodSuffix}`,
              periode: pendingTrx.periode || '-',
              nominal: Number(pendingTrx.nominal || orderPayload.amount || amount || 0),
              status: 'Lunas',
              sisa: 0,
              items: JSON.stringify(itemsArr),
              linkedTagihans: linkedIds.length > 0 ? JSON.stringify(linkedIds) : null
            };
            const { error: payErr } = await supabase.from('Pembayaran').upsert([payRow], { onConflict: 'id' });
            if (payErr) console.error('Gagal insert Pembayaran pendingTrx:', payErr);

            // Update status Tagihan terkait
            if (linkedIds.length > 0) {
              for (const tid of linkedIds) {
                const { data: tRow } = await supabase.from('Tagihan').select('*').eq('id', tid).maybeSingle();
                if (tRow) {
                  const payNom = linkedIds.length === 1 ? Number(payRow.nominal || 0) : Number(tRow.nominal || 0);
                  const newTerbayar = Math.min(Number(tRow.nominal || 0), Number(tRow.terbayar || 0) + payNom);
                  const newStatus = newTerbayar >= Number(tRow.nominal || 0) ? 'Lunas' : 'Cicil';
                  await supabase.from('Tagihan').update({ status: newStatus, terbayar: newTerbayar }).eq('id', tid);
                }
              }
            }
          }
        } else {
          // Kasus B: Pembayaran langsung pada TGH-... atau bulk tagihan portal
          const tagihanList = Array.isArray(orderPayload.selectedBulkItems) && orderPayload.selectedBulkItems.length > 0
            ? orderPayload.selectedBulkItems
            : (tgPayload?.id ? [tgPayload] : []);

          for (const tg of tagihanList) {
            if (!tg?.id) continue;
            const { data: tRow } = await supabase.from('Tagihan').select('*').eq('id', tg.id).maybeSingle();
            const ref = tRow || tg;
            const nominalTagihan = Number(ref.nominal || 0);
            const terbayarLama = Number(ref.terbayar || 0);
            const sisaLama = Math.max(0, nominalTagihan - terbayarLama);
            const amountToPay = orderPayload.isBulk
              ? sisaLama
              : Number(orderPayload.bayarAmount || orderPayload.amount || tg.sisa || sisaLama || amount || 0);

            if (amountToPay <= 0) continue;

            const orderSuffix = String(invoiceNumber.split('_').pop() || Date.now()).replace(/[^a-zA-Z0-9]/g, '');
            const invId = `INV-${ref.id}-${orderSuffix}`;
            const { data: existingPay } = await supabase
              .from('Pembayaran')
              .select('id')
              .eq('id', invId)
              .maybeSingle();

            if (!existingPay) {
              const totalTerbayarBaru = terbayarLama + amountToPay;
              const statusTrx = totalTerbayarBaru < nominalTagihan ? 'Cicil' : 'Lunas';
              const sisaTagihan = Math.max(0, nominalTagihan - totalTerbayarBaru);

              if (tRow) {
                await supabase.from('Tagihan').update({
                  status: statusTrx,
                  terbayar: totalTerbayarBaru
                }).eq('id', ref.id);
              }

              const { error: payErr } = await supabase.from('Pembayaran').upsert([{
                id: invId,
                tanggal: tglBayar,
                nis: ref.nis || '',
                nama: ref.nama || '',
                tagihan: `${ref.tagihan || 'Tagihan'}${methodSuffix}`,
                periode: ref.periode || '-',
                nominal: amountToPay,
                status: statusTrx === 'Cicil' ? 'Cicilan' : 'Lunas',
                sisa: sisaTagihan,
                items: JSON.stringify([{ tagihan: ref.tagihan || 'Tagihan', periode: ref.periode || '-', nominal: amountToPay }]),
                linkedTagihans: JSON.stringify([ref.id])
              }], { onConflict: 'id' });
              if (payErr) console.error('Gagal insert Pembayaran webhook:', payErr);
            }
          }
        }
      }
    }

    return NextResponse.json({
      status: true,
      success: true,
      message: "Webhook processed successfully"
    });

  } catch (err) {
    console.error("Error processing WijayaPay Webhook:", err);
    return NextResponse.json({
      success: false,
      message: err.message
    }, { status: 500 });
  }
}

