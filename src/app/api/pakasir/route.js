import { NextResponse } from 'next/server';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export async function OPTIONS() {
  return NextResponse.json({}, { headers: corsHeaders });
}

export async function POST(request) {
  try {
    const { action, data } = await request.json();
    const payload = typeof data === 'string' ? JSON.parse(data) : data;

    if (action === 'requestPakasirPayment') {
      const method = payload.method || 'qris'; 
      const slug = payload.slug?.trim();
      const orderId = payload.orderId;
      const url = `https://app.pakasir.com/api/v2/create-transaction/${slug}/${orderId}`;
      
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Api-Key': payload.apiKey?.trim()
        },
        body: JSON.stringify({
          method: method,
          amount: payload.amount
        })
      });

      const responseText = await res.text();
      let responseData;
      try {
        responseData = JSON.parse(responseText);
      } catch (e) {
        responseData = { error: responseText };
      }

      return NextResponse.json(responseData, { headers: corsHeaders });
    } 
    else if (action === 'pollPakasirStatus') {
      const slug = payload.slug?.trim();
      const txnId = payload.txnId?.trim();
      const url = `https://app.pakasir.com/api/v2/transaction-status/${slug}/${txnId}`;
      
      const res = await fetch(url, {
        method: 'GET',
        headers: {
          'X-Api-Key': payload.apiKey?.trim()
        }
      });
      const responseText = await res.text();
      let responseData;
      try {
        responseData = JSON.parse(responseText);
      } catch (e) {
        responseData = { error: responseText };
      }

      return NextResponse.json(responseData, { headers: corsHeaders });
    }

    return NextResponse.json({ error: 'Unknown action' }, { status: 400, headers: corsHeaders });
  } catch (error) {
    console.error("Pakasir API Error:", error);
    return NextResponse.json({ error: error.message }, { status: 500, headers: corsHeaders });
  }
}
