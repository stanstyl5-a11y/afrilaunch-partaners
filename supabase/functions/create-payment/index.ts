// Edge Function : appelée par inscription.html juste après la création du compte Supabase.
// Rôle : générer une session de paiement Chariow spécifique à cette vente, et renvoyer
// l'URL de checkout au front-end pour redirection.
//
// C'est la SEULE pièce qu'on reconstruit pour ce produit — la confirmation de paiement et
// l'octroi d'accès restent gérés par le webhook global existant côté Afrilaunch (celui qui
// tourne déjà pour prd_i5ug6m), qui s'applique à tous les produits Chariow. Cette fonction
// ne fait que déclencher le paiement ; elle ne crée aucun accès elle-même.
//
// Basé sur la doc officielle : https://chariow.dev/api-reference/checkout/init-checkout

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
const CHARIOW_API_KEY = Deno.env.get("CHARIOW_API_KEY")!;

const CHARIOW_PRODUCT_ID = "prd_zd8ds0r3"; // Offre "caviar" Afrilaunch — 10 500 FCFA (recréé avec le bon type de produit)

// À ADAPTER : URL vers laquelle Chariow renvoie le client après paiement.
const REDIRECT_URL = "https://votre-domaine.com/merci.html";

// CORS : nécessaire pour que le navigateur autorise l'appel depuis inscription.html
// (que ce soit en local via file:// ou depuis ton domaine une fois en ligne).
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  // Le navigateur envoie d'abord une requête OPTIONS ("preflight") avant le vrai POST —
  // sans cette réponse, le fetch échoue silencieusement avec "Failed to fetch".
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Vérifie que l'appel vient bien d'un utilisateur qui vient de créer son compte
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

  const { email, firstName, lastName, phone } = await req.json();

  // Déduit le pays depuis l'indicatif d'appel du numéro — chaque indicatif est unique
  // parmi les pays de la zone Franc CFA que couvre Afrilaunch, donc pas d'ambiguïté possible.
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
    return new Response(
      JSON.stringify({ error: chariowData?.message ?? "Erreur lors de la création du paiement Chariow." }),
      { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const checkoutUrl = chariowData?.data?.payment?.checkout_url;
  if (!checkoutUrl) {
    return new Response(
      JSON.stringify({ error: "Réponse Chariow inattendue : pas d'URL de paiement." }),
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
