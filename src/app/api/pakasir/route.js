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
      const url = `https://app.pakasir.com/api/transactioncreate/${method}`;
      
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          project: payload.slug,
          order_id: payload.orderId,
          amount: payload.amount,
          api_key: payload.apiKey
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
      const params = new URLSearchParams({
         project: payload.slug,
         order_id: payload.orderId,
         amount: String(payload.amount),
         api_key: payload.apiKey
      });
      const url = `https://app.pakasir.com/api/transactiondetail?${params.toString()}`;
      
      const res = await fetch(url, {
        method: 'GET'
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
