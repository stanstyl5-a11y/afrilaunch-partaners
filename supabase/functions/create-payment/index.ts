// trigger redeploy
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

const CHARIOW_PRODUCT_ID = "prd_vgbudta4"; // Offre "caviar" Afrilaunch — 10 500 FCFA

// À ADAPTER : URL vers laquelle Chariow renvoie le client après paiement.
const REDIRECT_URL = "https://votre-domaine.com/merci.html";

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405 });
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
    });
  }

  const { email, firstName, lastName, phone } = await req.json();

  // Sépare le numéro de téléphone brut (ex: "+225 07 00 00 00 00") en chiffres seuls.
  const digitsOnly = String(phone).replace(/[^\d]/g, "");
  const PHONE_COUNTRY_CODE = "CI"; // Côte d'Ivoire par défaut — ajuster si audience différente

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
      phone: { number: digitsOnly, country_code: PHONE_COUNTRY_CODE },
      redirect_url: REDIRECT_URL,
    }),
  });

  const chariowData = await chariowRes.json();

  if (!chariowRes.ok) {
    return new Response(
      JSON.stringify({ error: chariowData?.message ?? "Erreur lors de la création du paiement Chariow." }),
      { status: 502 },
    );
  }

  const checkoutUrl = chariowData?.data?.payment?.checkout_url;
  if (!checkoutUrl) {
    return new Response(
      JSON.stringify({ error: "Réponse Chariow inattendue : pas d'URL de paiement." }),
      { status: 502 },
    );
  }

  return new Response(JSON.stringify({ checkoutUrl }), { status: 200 });
});
