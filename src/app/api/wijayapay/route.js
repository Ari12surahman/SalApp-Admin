import { NextResponse } from 'next/server';
import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://hconlmrrerltnmryzdll.supabase.co';
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imhjb25sbXJyZXJsdG5tcnl6ZGxsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI0ODQ4NDIsImV4cCI6MjA5ODA2MDg0Mn0.uZfnUonT1eN06yyLhDWaYXe8qzoNLC2gJ6EPB8pkoGI';
const supabase = createClient(supabaseUrl, supabaseKey);

const DEFAULT_CODE_MERCHANT = process.env.WIJAYAPAY_CODE_MERCHANT || 'WP6aeb77c146ef6';
const DEFAULT_API_KEY = process.env.WIJAYAPAY_API_KEY || '802e6a184e03142089590837a6';
const WIJAYAPAY_API_URL = 'https://gateway.wijayapay.com/api';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Signature',
};

export async function OPTIONS() {
  return NextResponse.json({}, { headers: corsHeaders });
}

export async function POST(request) {
  try {
    const body = await request.json();
    const action = body.action || 'requestPayment';
    const payload = typeof body.data === 'string' ? JSON.parse(body.data) : (body.data || body);

    const codeMerchant = payload.codeMerchant || DEFAULT_CODE_MERCHANT;
    const apiKey = payload.apiKey || DEFAULT_API_KEY;

    // --- 1. ACTION: REQUEST PAYMENT (CREATE QRIS / VA) ---
    if (action === 'requestPayment' || action === 'requestDokuPayment' || action === 'requestWijayapayPayment') {
      const rawMethod = String(payload.method || payload.code_payment || 'qris').toUpperCase().trim();
      const amount = Number(payload.amount || payload.total || 0);
      const orderId = payload.orderId || payload.ref_id || `INV-${Date.now()}`;
      const customerName = payload.customerName || payload.buyerName || payload.nama || 'Santri';

      // Map method to WijayaPay payment codes
      let codePayment = 'QRIS';
      if (rawMethod.includes('BCA')) codePayment = 'BCAVA';
      else if (rawMethod.includes('BNI')) codePayment = 'BNIVA';
      else if (rawMethod.includes('BRI')) codePayment = 'BRIVA';
      else if (rawMethod.includes('BSI') || rawMethod.includes('BSM')) codePayment = 'BSIVA';
      else if (rawMethod.includes('MANDIRI')) codePayment = 'MANDIRIVA';
      else if (rawMethod.includes('CIMB')) codePayment = 'CIMBVA';
      else if (rawMethod.includes('PERMATA')) codePayment = 'PERMATAVA';
      else if (rawMethod.includes('DANAMON')) codePayment = 'DANAMONVA';
      else if (rawMethod.includes('MUAMALAT')) codePayment = 'MUAMALATVA';
      else if (rawMethod.includes('MAYBANK')) codePayment = 'MAYBANKVA';
      else if (rawMethod.includes('NEO')) codePayment = 'BANKNEOVA';
      else if (rawMethod.includes('ALFAMART')) codePayment = 'ALFAMART';
      else if (rawMethod.includes('INDOMARET')) codePayment = 'INDOMARET';
      else if (rawMethod.includes('QRIS') || rawMethod.includes('QR')) codePayment = 'QRIS';

      const signature = crypto.createHash('md5').update(codeMerchant + apiKey + orderId).digest('hex');

      // Callback URL default
      const origin = request.headers.get('origin') || request.headers.get('host') || 'https://salapp.com';
      const cleanOrigin = origin.startsWith('http') ? origin : `https://${origin}`;
      const callbackUrl = payload.callbackUrl || `${cleanOrigin}/api/wijayapay/webhook`;

      const createPayload = {
        code_merchant: codeMerchant,
        api_key: apiKey,
        code_payment: codePayment,
        ref_id: orderId,
        customer_name: customerName,
        nominal: amount,
        callback_url: callbackUrl
      };

      // Simpan ke database PakasirOrders untuk pelacakan
      try {
        await supabase.from('PakasirOrders').upsert([{
          order_id: orderId,
          tipe: payload.tipe || (orderId.startsWith('POS') ? 'POS' : orderId.startsWith('TB') ? 'TOPUP_TABUNGAN' : 'TAGIHAN_PORTAL'),
          status: 'PENDING',
          payload: {
            ...payload,
            orderId,
            amount,
            codePayment
          }
        }]);
      } catch (dbErr) {
        console.warn('Gagal mencatat order ke Supabase:', dbErr);
      }

      // Request ke WijayaPay Gateway
      const res = await fetch(`${WIJAYAPAY_API_URL}/transaction/create`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Signature': signature,
          'User-Agent': 'SalApp-Integration/1.0'
        },
        body: JSON.stringify(createPayload)
      });

      const resData = await res.json();

      if (!res.ok || resData.success === false) {
        return NextResponse.json({
          status: 'error',
          success: false,
          message: resData.message || 'Gagal membuat transaksi di WijayaPay'
        }, { status: 400, headers: corsHeaders });
      }

      const d = resData.data || {};
      const isQRIS = codePayment === 'QRIS';
      const vaNum = d.nomor_va || '';
      const qrStr = d.qr_string || '';
      const qrImg = d.qr_image || '';

      const paymentObj = {
        va_number: vaNum,
        payment_number: vaNum,
        qr_string: qrStr,
        qr_image: qrImg,
        checkout_url: d.checkout_url || '',
        amount: d.total_bayar || amount,
        total_fee: d.total_fee || 0,
        total_diterima: d.total_diterima || amount,
        trx_reference: d.trx_reference || '',
        expired: d.expired || '',
        instructions: d.tutorial_pembayaran || '',
        payment_name: d.payment_name || codePayment,
        payment_method: d.payment_method || codePayment
      };

      return NextResponse.json({
        status: 'success',
        success: true,
        type: isQRIS ? 'QRIS' : 'VA',
        orderId: orderId,
        payment: paymentObj,
        data: paymentObj
      }, { headers: corsHeaders });
    }

    // --- 2. ACTION: CHECK STATUS (CEK STATUS PEMBAYARAN) ---
    if (action === 'checkStatus' || action === 'checkDokuStatus' || action === 'checkWijayapayStatus') {
      const orderId = payload.orderId || payload.ref_id || payload.invoice_number;
      if (!orderId) {
        return NextResponse.json({ success: false, message: 'orderId / ref_id required' }, { status: 400, headers: corsHeaders });
      }

      // Cek dulu di database lokal jika sudah lunas
      try {
        const { data: dbOrder } = await supabase.from('PakasirOrders').select('*').eq('order_id', orderId).maybeSingle();
        if (dbOrder && (dbOrder.status === 'SUCCESS' || dbOrder.status === 'PAID')) {
          return NextResponse.json({
            status: 'SUCCESS',
            isPaid: true,
            success: true,
            orderId: orderId
          }, { headers: corsHeaders });
        }
      } catch (e) {}

      // Query live status ke WijayaPay
      const res = await fetch(`${WIJAYAPAY_API_URL}/get-status?code_merchant=${encodeURIComponent(codeMerchant)}&api_key=${encodeURIComponent(apiKey)}&ref_id=${encodeURIComponent(orderId)}`, {
        headers: { 'User-Agent': 'SalApp-Integration/1.0' }
      });

      const resData = await res.json();
      const statusStr = String(resData?.status_pembayaran || '').toLowerCase();
      const isPaid = statusStr === 'paid' || statusStr === 'success' || statusStr === 'settlement';

      if (isPaid) {
        try {
          await supabase.from('PakasirOrders').update({ status: 'SUCCESS' }).eq('order_id', orderId);
        } catch (e) {}
      }

      return NextResponse.json({
        status: isPaid ? 'SUCCESS' : (statusStr.toUpperCase() || 'PENDING'),
        isPaid: isPaid,
        success: true,
        orderId: orderId,
        rawStatus: statusStr,
        data: resData?.data || null
      }, { headers: corsHeaders });
    }

    // --- 3. ACTION: GET ACTIVE PAYMENT CHANNELS ---
    if (action === 'getPaymentChannels') {
      const res = await fetch(`https://wijayapay.com/api/get-payment?code_merchant=${encodeURIComponent(codeMerchant)}&api_key=${encodeURIComponent(apiKey)}`, {
        headers: { 'User-Agent': 'SalApp-Integration/1.0' }
      });
      const data = await res.json();
      return NextResponse.json(data, { headers: corsHeaders });
    }

    return NextResponse.json({ success: false, message: 'Action tidak dikenal' }, { status: 400, headers: corsHeaders });

  } catch (err) {
    console.error('Error in /api/wijayapay:', err);
    return NextResponse.json({
      status: 'error',
      success: false,
      message: err.message || 'Internal Server Error'
    }, { status: 500, headers: corsHeaders });
  }
}
