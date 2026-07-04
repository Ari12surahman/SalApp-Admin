import { GoogleAuth } from 'google-auth-library';
import { createClient } from '@supabase/supabase-js';

const FIREBASE_CONFIG = {
  project_id: "salapp-ac39a",
  client_email: "firebase-adminsdk-fbsvc@salapp-ac39a.iam.gserviceaccount.com",
  private_key: "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDvUPdo6JsHgLpQ\nl6eYWcMe2WiPw8eqvNQvbT2YLaYSFn4TGyxY5QzO6BFZrOD5hiUqNR+7ejr4vs61\n0jw+fGQbi3QFsG9faHLP4eqI0UQtDkPgEBIk0z91/O5WC0/srwMDZnZSuKhw/hqE\n7QFkx1UQKCqXORAH8DxkPT31PHi9XPuNeyf1I5Vr8gwTvgU0iSwt5HFlsvVaew3N\ntzJQWuKYvCfoWjE4cHWy16mcX96noEH+yidCWl867862TOkxbn4yo7DumhQibOfd\nRqDVP4cW9O5BEM4yGaV12fd6QyfXDVXHsG4orB5Y6cfA8LaZY0vGKIk+Syzkx+7e\nZ2HRa8X7AgMBAAECggEAZ3AJB/Sl8We/4A60l0KQ9hgFPEJkXlVQpxEh8tEkOyQy\nqQJxOBkEYLfoq+hvsxo6nRQqG4fYzmP2h5sPg/iS8l7jroPUl5nXKigdDbbZr1m/\nl6yKkxUllFNXFqS8DnKUrFcQpG+BCpmiD7s7A3qutxWNVyCIX84D5FWeHo3dKAcf\nBO/RiznAdw2yKyXrckbHwWRPAipIVhifsbSjsTtLDxQO5nD66r6yep0sK1slnn5p\n9y7ek6QKYLIgCjEG8HQkpfKmlS1Xc6c2jxubUfQfZwWu/6v9I7d5+yXeWInW49Ar\n0lWYdYSSJLuJebmOXhSQ+uPrNkGiy/A6C92NjLMCPQKBgQD83Nt3Jdqc6YRUU/dC\nwt9aM2fsP8vgiBdLI+UMjQfgdCv5lJ+JPmvx0mmwnCUOmHVpt4ze8YSBSkAhhTsh\neeW/s51D8WkS5kHtzLrK5BI77Pba8ZPX45ahcBmROGPHfsaZr14XJOcPye47CLAM\n5H6ITBD4+U2hgr854OXd9nLENQKBgQDySRU6SriAH4DA0dP1OnJlyzhHb5dyl1t2\nHOx03oEsdkLLE9lMit+uTy/dVRkJD9TRRyMO0uNcF5aIOuWoc7PhCoZcJQ1IdZvL\nUL4P50SSKBbdcs6Dc7xwIvroeX8dRZc9RaeD89mX03LqLavzUMuOub+XhBY/d621\ndHFUaAZHbwKBgGD9jijrmikp4Ro/gs5W1TlSEoCqD9e2G8k0oXzo86aCqQN4oKES\nEnGVVfjqS8SHcjH0t9IkLcEx69tvsTir+xZHHQGcrcMUEyHVr6h3Rw85W46rrxvW\nLkcKKqRrTsqMtDzq6VpTS1XhDMIUGQM4+dfp5XC6n65d6l+XBlTXXTopAoGAEsuQ\nlgEN5wKKnmqoorFyBmuJZiFGAmGzeqorvbU1GBnkfJSBmup7B66k6+qaEpXj0IhQ\nM+owMQizaMYI4tR289I5MhS9vw1AlLkixWEPdLcfbvZlBtWHnLtZ84bZUZAAd4Rb\nxmS4UIras0fvuuRdpijKsBpTD4FdPGJYGFApjIkCgYEAsTgrl7qLpVDbSYl7t+Hy\nOzS3qlQXn7/YEfB8sLcENk3o94lTrywKtK3lWiKJQQaJ09Ozj299aqoJeX+UZ01W\n2f5pMAkMST/f0o3cE2j9EQYlC2zf085RTExsoAirNkbBBEl7GboJPjGVdQmQvGXN\n5i2KMRnwSQNdjN+T2ggj3DE=\n-----END PRIVATE KEY-----\n"
};

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "https://placeholder.supabase.co";
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "placeholder";
const supabase = createClient(supabaseUrl, supabaseKey);

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export async function OPTIONS(req) {
  return new Response(null, { status: 200, headers: corsHeaders });
}

export async function POST(req) {
  try {
    const { nis, title, body, icon: reqIcon } = await req.json();

    if (!nis) {
      return new Response(JSON.stringify({ error: 'NIS is required' }), { status: 400, headers: corsHeaders });
    }

    // Ambil FCM_Token dari tabel Data Santri
    const { data: santri, error } = await supabase
      .from('Data Santri')
      .select('FCM_Token')
      .eq('nis', nis)
      .single();

    if (error || !santri?.FCM_Token) {
      return new Response(JSON.stringify({ error: 'Token FCM tidak ditemukan untuk santri ini' }), { status: 404, headers: corsHeaders });
    }

    const targetToken = santri.FCM_Token;

    if (targetToken.startsWith('ExponentPushToken')) {
      // Kirim via Expo Push Service
      const expoPayload = {
        to: targetToken,
        sound: 'default',
        title: title || "Info SalApp",
        body: body || "Anda memiliki pemberitahuan baru",
        data: {
          title: title || "Info SalApp",
          body: body || "Anda memiliki pemberitahuan baru"
        }
      };

      const response = await fetch("https://exp.host/--/api/v2/push/send", {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Accept-encoding': 'gzip, deflate',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(expoPayload)
      });

      const result = await response.json();
      if (!response.ok) {
        return new Response(JSON.stringify({ error: 'Expo Push Error', details: result }), { status: 500, headers: corsHeaders });
      }

      return new Response(JSON.stringify({ success: true, message: 'Expo notification sent', result }), { status: 200, headers: corsHeaders });

    } else {
      // Autentikasi ke Google FCM untuk Web/Native standard FCM
      const auth = new GoogleAuth({
        credentials: {
          client_email: FIREBASE_CONFIG.client_email,
          private_key: FIREBASE_CONFIG.private_key
        },
        scopes: ['https://www.googleapis.com/auth/firebase.messaging']
      });

      const client = await auth.getClient();
      const tokenObj = await client.getAccessToken();
      const accessToken = tokenObj.token;

      // Siapkan Payload Pesan
      const payload = {
        message: {
          token: targetToken,
          notification: {
            title: title || "Info SalApp",
            body: body || "Anda memiliki pemberitahuan baru",
          },
          data: {
            title: title || "Info SalApp",
            body: body || "Anda memiliki pemberitahuan baru",
            icon: reqIcon || "https://salapp-wali.vercel.app/icon.png"
          },
          webpush: {
            notification: {
              icon: reqIcon || "https://salapp-wali.vercel.app/icon.png"
            },
            headers: {
              Urgency: "high"
            }
          }
        }
      };

      // Kirim ke Google FCM
      const response = await fetch("https://fcm.googleapis.com/v1/projects/" + FIREBASE_CONFIG.project_id + "/messages:send", {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + accessToken,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      const result = await response.json();

      if (!response.ok) {
        return new Response(JSON.stringify({ error: 'FCM Error', details: result }), { status: 500, headers: corsHeaders });
      }

      return new Response(JSON.stringify({ success: true, message: 'Notification sent successfully', result }), { status: 200, headers: corsHeaders });
    }

  } catch (error) {
    console.error("Error sending push:", error);
    return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: corsHeaders });
  }
}
