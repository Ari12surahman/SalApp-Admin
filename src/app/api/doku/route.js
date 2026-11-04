import { NextResponse } from 'next/server';
import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://hconlmrrerltnmryzdll.supabase.co';
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imhjb25sbXJyZXJsdG5tcnl6ZGxsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI0ODQ4NDIsImV4cCI6MjA5ODA2MDg0Mn0.uZfnUonT1eN06yyLhDWaYXe8qzoNLC2gJ6EPB8pkoGI';
const supabase = createClient(supabaseUrl, supabaseKey);

const DEFAULT_CLIENT_ID = 'BRN-0202-1793347575291';
const DEFAULT_SECRET_KEY = 'SK-vd9vdq9vK3DDdpfgcpQm';
const DOKU_BASE_URL = 'https://api.doku.com';
const DOKU_SANDBOX_BASE_URL = 'https://api-sandbox.doku.com';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export async function OPTIONS() {
  return NextResponse.json({}, { headers: corsHeaders });
}

function generateSignature(clientId, requestId, timestamp, targetPath, bodyStr, secretKey) {
  const digest = crypto.createHash('sha256').update(bodyStr, 'utf8').digest('base64');
  const component = 'Client-Id:' + clientId + '\n' +
                    'Request-Id:' + requestId + '\n' +
                    'Request-Timestamp:' + timestamp + '\n' +
                    'Request-Target:' + targetPath + '\n' +
                    'Digest:' + digest;
  const signature = crypto.createHmac('sha256', secretKey).update(component, 'utf8').digest('base64');
  return { signature: 'HMACSHA256=' + signature, digest };
}

export async function POST(request) {
  try {
    const body = await request.json();
    const action = body.action || 'requestDokuPayment';
    const payload = typeof body.data === 'string' ? JSON.parse(body.data) : (body.data || body);

    // Otomatis route ke WijayaPay Gateway yang sudah aktif
    try {
      const { POST: handleWijayapay } = await import('../wijayapay/route.js');
      const forwardedReq = new Request(request.url, {
        method: 'POST',
        headers: request.headers,
        body: JSON.stringify(body)
      });
      return await handleWijayapay(forwardedReq);
    } catch (routeErr) {
      console.warn("WijayaPay router fallback to DOKU:", routeErr);
    }

    const isSandbox = Boolean(payload.isSandbox || process.env.DOKU_IS_SANDBOX === 'true' || (payload.clientId && payload.clientId.startsWith('MCH-')));
    const activeDokuUrl = isSandbox ? DOKU_SANDBOX_BASE_URL : DOKU_BASE_URL;
    const clientId = payload.clientId || DEFAULT_CLIENT_ID;
    const secretKey = payload.secretKey || DEFAULT_SECRET_KEY;

    if (action === 'requestDokuPayment') {
      const method = (payload.method || 'qris').toLowerCase();
      const amount = Number(payload.amount || payload.total || 0);
      const orderId = payload.orderId || `ORD-${Date.now()}`;
      const customerName = payload.customerName || payload.buyerName || payload.nama || 'Santri';
      const requestId = 'REQ-' + Date.now();
      const timestamp = new Date().toISOString().slice(0, 19) + 'Z';

      // 1. Simpan order ke PakasirOrders / database untuk tracking status
      try {
        await supabase.from('PakasirOrders').upsert([{
          order_id: orderId,
          tipe: payload.tipe || (orderId.startsWith('POS') ? 'POS' : orderId.startsWith('TB') ? 'TOPUP_TABUNGAN' : 'TAGIHAN_PORTAL'),
          status: 'PENDING',
          payload: {
            ...payload,
            orderId,
            amount,
            method
          }
        }]);
      } catch (dbErr) {
        console.warn('Failed saving order to database:', dbErr);
      }

      // 2. Pemilihan Endpoint DOKU
      // Jika Virtual Account bank spesifik
      const bankMap = {
        'bri_va': 'bri',
        'bri': 'bri',
        'bni_va': 'bni',
        'bni': 'bni',
        'bsi_va': 'bsm',
        'bsi': 'bsm',
        'bsm_va': 'bsm',
        'cimb_va': 'cimb',
        'cimb': 'cimb',
        'cimb_niaga_va': 'cimb',
        'danamon_va': 'danamon',
        'danamon': 'danamon',
        'permata_va': 'permata',
        'permata': 'permata',
        'mandiri_va': 'mandiri',
        'mandiri': 'mandiri',
        'doku_va': 'doku',
        'doku': 'doku'
      };

      const matchedBank = bankMap[method];

      if (matchedBank) {
        // DIRECT VIRTUAL ACCOUNT
        const targetPath = `/${matchedBank}-virtual-account/v2/payment-code`;
        const vaBody = {
          order: {
            invoice_number: orderId,
            amount: amount
          },
          virtual_account_info: {
            expired_time: 120, // 2 jam
            reusable_status: false,
            info1: 'Pembayaran SalApp',
            info2: 'Pesantren Tech'
          },
          customer: {
            name: customerName
          }
        };

        if (matchedBank === 'bni') {
          vaBody.virtual_account_info.merchant_unique_reference = Date.now().toString().slice(-10);
        }

        const bodyStr = JSON.stringify(vaBody);
        const { signature, digest } = generateSignature(clientId, requestId, timestamp, targetPath, bodyStr, secretKey);

        const dokuRes = await fetch(activeDokuUrl + targetPath, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Client-Id': clientId,
            'Request-Id': requestId,
            'Request-Timestamp': timestamp,
            'Signature': signature,
            'Digest': digest
          },
          body: bodyStr
        });

        const dokuData = await dokuRes.json();

        if (dokuRes.ok && dokuData.virtual_account_info?.virtual_account_number) {
          const vaNum = dokuData.virtual_account_info.virtual_account_number;
          const howToPay = dokuData.virtual_account_info.how_to_pay_page || '';
          const expiredDate = dokuData.virtual_account_info.expired_date || dokuData.virtual_account_info.expired_date_utc || '';

          return NextResponse.json({
            status: 'success',
            type: 'VA',
            payment: {
              va_number: vaNum,
              payment_number: vaNum,
              how_to_pay_url: howToPay,
              expired_date: expiredDate,
              order_id: orderId,
              amount: amount,
              bank: matchedBank.toUpperCase()
            }
          }, { headers: corsHeaders });
        } else {
          console.error('DOKU Direct VA Error:', dokuData);
          // Fallback ke DOKU Checkout jika direct VA bank tersebut belum siap
        }
      }

      // 3. Fallback / Standard: DOKU CHECKOUT (mendukung QRIS, Semua VA, Alfamart, dll.)
      const checkoutPath = '/checkout/v1/payment';
      const checkoutBody = {
        order: {
          amount: amount,
          invoice_number: orderId,
          currency: 'IDR',
          callback_url: payload.callbackUrl || 'https://salapp-bendahara.web.id'
        },
        payment: {
          payment_due_date: 120
        },
        customer: {
          name: customerName
        }
      };

      const bodyStr = JSON.stringify(checkoutBody);
      const { signature, digest } = generateSignature(clientId, requestId, timestamp, checkoutPath, bodyStr, secretKey);

      const chkRes = await fetch(activeDokuUrl + checkoutPath, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Client-Id': clientId,
          'Request-Id': requestId,
          'Request-Timestamp': timestamp,
          'Signature': signature,
          'Digest': digest
        },
        body: bodyStr
      });

      const chkData = await chkRes.json();

      if (chkRes.ok && chkData.response?.payment?.url) {
        const paymentInfo = chkData.response.payment;
        return NextResponse.json({
          status: 'success',
          type: 'CHECKOUT',
          payment: {
            checkout_url: paymentInfo.url,
            url: paymentInfo.url,
            token_id: paymentInfo.token_id,
            qr_string: paymentInfo.url, // URL checkout bisa dijadikan QR code jika di kasir
            order_id: orderId,
            amount: amount,
            expired_date: paymentInfo.expired_date
          }
        }, { headers: corsHeaders });
      } else {
        console.error('DOKU Checkout Error:', chkData);
        return NextResponse.json({
          status: 'error',
          message: chkData.error?.message || chkData.message?.[0] || 'Gagal memproses pembayaran DOKU'
        }, { status: 400, headers: corsHeaders });
      }
    } 
    else if (action === 'checkDokuStatus') {
      const orderId = payload.orderId;
      const { data: order } = await supabase.from('PakasirOrders').select('*').eq('order_id', orderId).maybeSingle();
      return NextResponse.json({
        status: order?.status === 'COMPLETED' ? 'SUCCESS' : (order?.status || 'PENDING'),
        isPaid: order?.status === 'COMPLETED'
      }, { headers: corsHeaders });
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400, headers: corsHeaders });
  } catch (err) {
    console.error('DOKU API Error:', err);
    return NextResponse.json({ error: err.message }, { status: 500, headers: corsHeaders });
  }
}

