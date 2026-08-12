// Edge Function : appelée par inscription.html juste après la création du compte Supabase.
// Rôle : générer une session de paiement Chariow spécifique à cette vente, et renvoyer
// l'URL de checkout au front-end pour redirection.
//
// Sécurité renforcée (audit 2026-08-12) :
//  1. CORS restreint aux domaines Afrilaunch (plus de wildcard *)
//  2. Validation stricte des entrées utilisateur côté serveur
//  3. Rate limiting : 1 tentative max par 5 minutes par utilisateur
//
// Basé sur la doc officielle : https://chariow.dev/api-reference/checkout/init-checkout

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
const CHARIOW_API_KEY = Deno.env.get("CHARIOW_API_KEY")!;

const CHARIOW_PRODUCT_ID = "prd_zd8ds0r3"; // Offre "caviar" Afrilaunch — 10 500 FCFA

// URL vers laquelle Chariow renvoie le client après paiement.
const REDIRECT_URL = "https://afrilaunch-partenariat.vercel.app/merci.html";

// =============================================================
// CORRECTIF 1 — CORS restreint aux domaines Afrilaunch uniquement
// =============================================================
const ALLOWED_ORIGINS = [
  "https://afrilaunch-partenariat.vercel.app",
  "https://afrilaunch.space",
  "https://www.afrilaunch.space",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
];

function getCorsHeaders(requestOrigin: string | null): Record<string, string> {
  const origin = requestOrigin ?? "";
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin)
    ? origin
    : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

// =============================================================
// CORRECTIF 2 — Validation stricte des entrées utilisateur
// =============================================================
function validateInputs(body: unknown): {
  valid: boolean; error?: string;
  data?: { email: string; firstName: string; lastName: string; phone: string };
} {
  if (!body || typeof body !== "object") {
    return { valid: false, error: "Corps de requête invalide." };
  }
  const raw = body as Record<string, unknown>;
  const email = String(raw.email ?? "").trim().toLowerCase();
  const firstName = String(raw.firstName ?? "").trim().slice(0, 100);
  const lastName = String(raw.lastName ?? "").trim().slice(0, 100);
  const phone = String(raw.phone ?? "").trim().slice(0, 30);

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) return { valid: false, error: "Adresse email invalide." };

  const phoneDigits = phone.replace(/[^\d]/g, "");
  if (phoneDigits.length < 8 || phoneDigits.length > 15) {
    return { valid: false, error: "Numéro de téléphone invalide. Inclus ton indicatif (ex: +225...)." };
  }
  if (firstName.length === 0) return { valid: false, error: "Le prénom est requis." };
  if (lastName.length === 0) return { valid: false, error: "Le nom est requis." };

  return { valid: true, data: { email, firstName, lastName, phone } };
}

Deno.serve(async (req) => {
  const requestOrigin = req.headers.get("Origin");
  const corsHeaders = getCorsHeaders(requestOrigin);

  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const authHeader = req.headers.get("Authorization") ?? "";
  const accessToken = authHeader.replace("Bearer ", "");

  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });

  const { data: userData, error: userError } = await supabase.auth.getUser(accessToken);
  if (userError || !userData?.user) {
    return new Response(JSON.stringify({ error: "Session invalide, reconnecte-toi." }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Client admin (clé service) — utilisé pour tout accès à "payments" dans cette fonction.
  // On l'utilise aussi pour la vérification "déjà payé" ci-dessous : une lecture avec la
  // clé anonyme dépendrait des règles RLS de la table, qui peuvent bloquer silencieusement
  // la lecture même quand la ligne existe. La clé service contourne ça, comme le webhook.
  const adminClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  const CAVIAR_PRODUCT_IDS = ["prd_zd8ds0r3", "prd_vgbudta4", "prd_qotgnzgn"];
  const { data: existingPayments } = await adminClient
    .from("payments")
    .select("id")
    .eq("user_id", userData.user.id)
    .eq("status", "completed")
    .in("product_id", CAVIAR_PRODUCT_IDS)
    .limit(1);

  if (existingPayments && existingPayments.length > 0) {
    return new Response(JSON.stringify({ alreadyPaid: true }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // =============================================================
  // CORRECTIF 3 — Rate Limiting : 1 tentative max par 5 minutes
  // =============================================================
  const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const { data: recentAttempts } = await adminClient
    .from("payments")
    .select("created_at")
    .eq("user_id", userData.user.id)
    .eq("status", "pending")
    .gt("created_at", fiveMinutesAgo)
    .limit(1);

  if (recentAttempts && recentAttempts.length > 0) {
    return new Response(
      JSON.stringify({ error: "Veuillez patienter quelques minutes avant une nouvelle tentative de paiement." }),
      { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  // Lecture et validation stricte du body
  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Corps de requête JSON invalide." }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const validation = validateInputs(rawBody);
  if (!validation.valid || !validation.data) {
    return new Response(JSON.stringify({ error: validation.error }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const { email, firstName, lastName, phone } = validation.data;

  // Déduit le pays depuis l'indicatif d'appel du numéro
  const CALLING_CODE_TO_COUNTRY: Record<string, string> = {
    "229": "BJ", // Bénin
    "226": "BF", // Burkina Faso
    "237": "CM", // Cameroun
    "236": "CF", // Centrafrique
    "242": "CG", // Congo
    "225": "CI", // Côte d'Ivoire
    "241": "GA", // Gabon
    "240": "GQ", // Guinée Équatoriale
    "245": "GW", // Guinée-Bissau
    "223": "ML", // Mali
    "227": "NE", // Niger
    "221": "SN", // Sénégal
    "235": "TD", // Tchad
    "228": "TG", // Togo
  };

  const digitsWithCode = String(phone).replace(/[^\d]/g, "");
  const callingCode = Object.keys(CALLING_CODE_TO_COUNTRY).find((code) => digitsWithCode.startsWith(code));

  if (!callingCode) {
    return new Response(
      JSON.stringify({ error: "Indicatif de pays introuvable dans le numéro. Fais-le commencer par ton indicatif (ex: +225, +226...)." }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const country = CALLING_CODE_TO_COUNTRY[callingCode];
  const digitsOnly = digitsWithCode.slice(callingCode.length);

  const chariowRes = await fetch("https://api.chariow.com/v1/checkout", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${CHARIOW_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      product_id: CHARIOW_PRODUCT_ID,
      email,
      first_name: firstName,
      last_name: lastName,
      phone: { number: digitsOnly, country_code: country },
      redirect_url: REDIRECT_URL,
    }),
  });

  const chariowData = await chariowRes.json();

  if (!chariowRes.ok) {
    // Message générique — pas de détail interne Chariow exposé au client
    return new Response(
      JSON.stringify({ error: "Erreur lors de la création du paiement. Réessaie ou contacte le support." }),
      { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const checkoutUrl = chariowData?.data?.payment?.checkout_url;
  if (!checkoutUrl) {
    return new Response(
      JSON.stringify({ error: "Réponse de paiement inattendue. Contacte le support." }),
      { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  // Crée la ligne "payments" en attente dès maintenant, avec reference = l'id de vente
  // renvoyé par Chariow — c'est exactement ce que le webhook existant (chariow-webhook)
  // s'attend à trouver via payments.reference quand la confirmation arrivera, au lieu de
  // passer par son chemin de secours "référence inconnue".
  const purchase = chariowData?.data?.purchase;
  if (purchase?.id) {
    const { error: insertError } = await adminClient.from("payments").insert({
      user_id: userData.user.id,
      reference: purchase.id,
      amount: purchase.amount?.value ?? 0,
      currency: purchase.amount?.currency ?? "XOF",
      status: "pending",
      product_id: CHARIOW_PRODUCT_ID,
    });
    if (insertError) {
      // On ne bloque pas le paiement pour ça — le webhook a un chemin de secours qui
      // fonctionne même sans cette ligne pré-créée (voir audit). On log juste pour suivi.
      console.error("Échec insertion payments (non bloquant):", insertError.message);
    }
  }

  return new Response(JSON.stringify({ checkoutUrl }), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
