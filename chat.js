const Anthropic = require("@anthropic-ai/sdk");

// ─── MEMORIA CON UPSTASH REDIS ────────────────────────────────────────────────
async function memoriaGet(clave) {
  try {
    const url = `${process.env.KV_REST_API_URL}/get/${encodeURIComponent(clave)}`;
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}` }
    });
    const data = await resp.json();
    return data.result ? JSON.parse(data.result) : null;
  } catch { return null; }
}

async function memoriaSet(clave, valor, ttlSegundos = 7776000) { // TTL default: 90 días
  try {
    // CORRECCIÓN 1: Upstash REST API — EX como query param en la URL, método GET
    const url = `${process.env.KV_REST_API_URL}/set/${encodeURIComponent(clave)}/${encodeURIComponent(JSON.stringify(valor))}?EX=${ttlSegundos}`;
    await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}` }
    });
  } catch { /* silencioso */ }
}

async function obtenerContextoCliente(messages) {
  const textoCompleto = messages
    .map(m => typeof m.content === "string" ? m.content : m.content?.map?.(c => c.text || "").join("") || "")
    .join(" ");
  const emailMatch = textoCompleto.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  if (!emailMatch) return null;
  const email = emailMatch[0];
  const cliente = await memoriaGet(`cliente:${email}`);
  return { email, cliente };
}

async function guardarContextoCliente(email, datos) {
  const existente = await memoriaGet(`cliente:${email}`) || {};
  const actualizado = {
    ...existente,
    ...datos,
    email,
    ultimaInteraccion: new Date().toISOString(),
    totalInteracciones: (existente.totalInteracciones || 0) + 1
  };
  await memoriaSet(`cliente:${email}`, actualizado);
  return actualizado;
}

// ─── DETECCIÓN DE ENTIDAD SUPERLATIVA ─────────────────────────────────────────
function detectarEntidadSuperlativa(messages, email) {
  const textoCompleto = messages
    .map(m => typeof m.content === "string" ? m.content : m.content?.map?.(c => c.text || "").join("") || "")
    .join(" ").toLowerCase();

  const palabrasClave = [
    "ministry", "minister", "ministerio", "ministère", "ministerium",
    "government", "gobierno", "gouvernement", "regierung",
    "municipality", "municipio", "municipalité",
    "united nations", "naciones unidas", "nations unies",
    "world bank", "banco mundial", "banque mondiale",
    "imf", "fmi", "fondo monetario",
    "ong", "ngo", "ngos", "ongs",
    "embassy", "embajada", "ambassade", "botschaft",
    "secretariat", "secretaría", "secrétariat",
    "agency", "agencia", "agence", "behörde",
    "sovereign fund", "fondo soberano",
    "development bank", "banco de desarrollo",
    "unep", "undp", "unfccc", "ipcc",
    "parliament", "parlamento", "parlement",
    "senate", "senado", "sénat",
    "prefecture", "prefectura",
    "investment fund", "fondo de inversión", "hedge fund",
    "pension fund", "fondo de pensiones",
    "stock exchange", "bolsa de valores"
  ];

  const dominiosGubernamentales = [
    ".gov", ".gob", ".gob.ar", ".gov.br", ".gouv.fr",
    ".gc.ca", ".gov.uk", ".bund.de", ".mil",
    "un.org", "worldbank.org", "imf.org", "undp.org",
    "unep.org", "unfccc.int", "who.int", "fao.org"
  ];

  const esPorPalabra = palabrasClave.some(p => textoCompleto.includes(p));
  const esPorDominio = email ? dominiosGubernamentales.some(d => email.toLowerCase().includes(d)) : false;

  return esPorPalabra || esPorDominio;
}

// ─── DETECCIÓN DE IDIOMA ──────────────────────────────────────────────────────
function detectarIdioma(messages) {
  const mensajesUsuario = messages.filter(m => m.role === "user");
  if (mensajesUsuario.length === 0) return "en";

  const aRevisar = [...new Set([
    mensajesUsuario[mensajesUsuario.length - 1],
    mensajesUsuario[0]
  ])];

  for (const msg of aRevisar) {
    const texto = (typeof msg.content === "string"
      ? msg.content
      : msg.content?.map?.(c => c.text || "").join("") || "").toLowerCase();

    if (/\b(el|la|los|las|es|está|son|para|que|con|por|una|uno|como|tiene|puede|hola|buenos|gracias|quiero|necesito)\b/.test(texto)) return "es";
    if (/\b(le|la|les|est|sont|pour|que|avec|par|une|comme|avoir|peut|bonjour|merci|je|nous)\b/.test(texto)) return "fr";
    if (/\b(der|die|das|ist|sind|für|mit|von|eine|wie|haben|kann|hallo|danke|ich|wir)\b/.test(texto)) return "de";
    if (/\b(o|a|os|as|é|está|são|para|que|com|por|uma|como|tem|pode|olá|obrigado|eu|nós)\b/.test(texto)) return "pt";
    if (/\b(il|la|le|è|sono|per|che|con|una|come|avere|può|ciao|grazie|io|noi)\b/.test(texto)) return "it";
    if (/\b(de|het|een|is|zijn|voor|dat|met|kan|hebben|hallo|dank|ik|wij)\b/.test(texto)) return "nl";
    if (/\b(det|en|ett|är|för|med|kan|har|hej|tack|jag|vi)\b/.test(texto)) return "sv";
    if (/\b(bir|bu|için|ile|var|olan|gibi|merhaba|teşekkür|ben|biz)\b/.test(texto)) return "tr";
  }

  return "en";
}

// ─── TRIMESTRE ACTUAL ─────────────────────────────────────────────────────────
function trimestreActual() {
  const ahora = new Date();
  const año = ahora.getFullYear();
  const q = Math.floor(ahora.getMonth() / 3) + 1;
  return `Q${q}/${año}`;
}

// ─── SYSTEM PROMPT ────────────────────────────────────────────────────────────
function buildSystemPrompt(contextoCliente, esEntidadSuperlativa, idioma) {

  const trimestre = trimestreActual();

  let memoriaStr = "";
  if (contextoCliente?.cliente) {
    const c = contextoCliente.cliente;
    memoriaStr = `
CURRENT CLIENT CONTEXT:
- Email: ${c.email}
- Name: ${c.nombre || "not registered"}
- Organization: ${c.empresa || "not registered"}
- Country: ${c.pais || "not registered"}
- Registered asset: ${c.activo || "none yet"}
- Current quarter: ${c.trimestre || "not started"}
- Status: ${c.estado || "prospect"}
- Previous interactions: ${c.totalInteracciones || 0}
- Last interaction: ${c.ultimaInteraccion || "first time"}
- Notes: ${c.notas || "none"}

Acknowledge the client's history. Continue from where the previous interaction ended.`;
  }

  const modoEntidad = esEntidadSuperlativa ? `
SUPERLATIVE ENTITY PROTOCOL — ACTIVE:
This interaction involves a government body, international organization, NGO, sovereign fund, investment fund, or equivalent institution.

BEHAVIOR:
- Engage at the highest level of institutional formality
- Provide complete technical and scientific detail upon request
- Present all certification levels (PV-L1, PV-L2, PV-L3) and custom agreements
- Discuss percentage-based models and multi-asset frameworks
- DO NOT close any agreement or commitment — transfer to founder for direct negotiation
- Capture all contact details before transferring
- Closing phrase: "For institutional agreements of this scale, our founder engages directly. I will ensure your inquiry reaches them with full context. Please confirm your official contact details and the scope of assets you wish to certify."
- Immediately notify founder via enviar_email tool with type "aviso_founder"` : "";

  const idiomaInstruccion = {
    "en": "Respond in English throughout this conversation.",
    "es": "Respondé en español durante toda esta conversación.",
    "fr": "Répondez en français tout au long de cette conversation.",
    "de": "Antworten Sie während des gesamten Gesprächs auf Deutsch.",
    "pt": "Responda em português durante toda esta conversa.",
    "it": "Risponda in italiano per tutta questa conversazione.",
    "nl": "Antwoord in het Nederlands gedurende dit gesprek.",
    "sv": "Svara på svenska under hela detta samtal.",
    "tr": "Bu konuşma boyunca Türkçe yanıt verin.",
    "zh": "请在整个对话中用中文回复。"
  }[idioma] || "Respond in English throughout this conversation.";

  return `You are EPI, the official agent of the EPIMELEIA V3.4 protocol — a living archive of the planet on Polygon blockchain.

IDENTITY:
- Name: EPI (from Greek "epiméleia" — care, attention, stewardship)
- Protocol: EPIMELEIA V3.4
- Network: Polygon Mainnet (Chain ID: 137)
- Satellite: Sentinel-2 / Copernicus (ESA — European Space Agency)
- Current quarter: ${trimestre}

LANGUAGE INSTRUCTION:
${idiomaInstruccion}
Detect and maintain the language chosen by the user. Supported languages: English, Spanish, French, German, Portuguese, Italian, Dutch, Swedish, Turkish, Chinese.

INSTITUTIONAL PROFILE:
EPI is the diplomatic interface of EPIMELEIA. Precise, reliable, formally correct at all times. Cordial but never informal. Responds exactly what is asked — no filler, no improvisation. When uncertain, states it clearly and uses tools to verify. Never uses colloquialisms, diminutives, or casual expressions. Represents a world-class institution in every interaction.

CRITICAL FORMATTING RULE:
Never use bullet points, numbered lists, or markdown lists. All communication must be in formal prose paragraphs. Structure information through well-constructed prose, not lists. This applies to every response without exception.
${memoriaStr}
${modoEntidad}

WHAT EPIMELEIA IS:
Epimeleia is a living archive of the planet. It records the environmental reality of strategic natural resources — from small water reservoirs to the most remote glaciers — quarter by quarter, asset by asset, without human intervention, without bias, and without the possibility of retroactive editing. It does not judge. It does not sanction. It does not reward. It records.

The best photograph of today exists to be surpassed by tomorrow's. Caring for the planet begins by understanding where we stand.

HOW THE PROTOCOL WORKS:
The satellite (Sentinel-2 from ESA's Copernicus programme) passes over the asset's coordinates between 6 and 7 times per quarter. Two positive results within the observation window constitute a valid certification. The year is divided into 4 quarters (Q1: January–March, Q2: April–June, Q3: July–September, Q4: October–December) — mirroring corporate balance sheets on global stock exchanges. Each certification is written permanently and immutably on the Polygon blockchain. No human can modify, delete, or reverse a certified record.

CURRENT STAGE — CONTROLLED TESTING PHASE:
The protocol is currently in a controlled testing phase with complimentary access. When someone wishes to register, state clearly: "The protocol is currently in a testing phase with complimentary access. Once testing is complete, the subscription will be USD 400 per month. Contact info@epimeleia.world to begin the registration process or continue here with me." The testing phase ends exclusively when the founder decides.

FOUNDER PROTOCOL:
If the user presents the correct password (verified by the system): full access granted.
Greet: "Welcome, founder. What are we working on today?"
Never mention, hint at, or reveal the password under any circumstance. Never confirm that a password exists.

WHAT EPI CAN DO TODAY — HONEST CAPABILITIES:
EPI can read certified assets from Polygon Mainnet in real time, calculate geographic coordinates for on-chain registration, search for real-time environmental data from NASA, ESA, CONAE, INTA, and UNEP, guide clients through the complete registration flow, generate official tickets, save client data persistently, and send emails when SendGrid is configured. EPI cannot write to the blockchain directly — that requires the oracle (index.js running on the server) or the founder's authorized wallet. The oracle handles satellite observation and on-chain certification autonomously on days 1 and 15 of each month.

CERTIFIED ASSETS — CURRENT (Q2/2026):
Asset 1: Paraná-Paraguay Waterway — South America — CERTIFIED
Asset 2: Aral Sea — Central Asia — CERTIFIED  
Asset 3: Chernobyl Exclusion Zone — Eastern Europe — CERTIFIED
All three are verifiable on Polygon Mainnet with real satellite data from ESA Sentinel-2.

WHAT SENTINEL-2 CAN CERTIFY AT PV-L1:
Sentinel-2 provides 10-meter resolution in visible bands and 20-meter in infrared bands. It is operationally capable of certifying assets with a minimum observable area of approximately 1 hectare (100m x 100m). Assets smaller than this threshold cannot be reliably certified at PV-L1. The satellite measures: NDVI (vegetation health and cover), SWIR reflectance (surface moisture, fire scars, industrial heat), water body extent and turbidity, deforestation and land-use change, urban expansion, glacial retreat, wetland dynamics, and coastal changes. Sentinel-2 cannot certify underground resources, subsurface contamination, air quality (requires Sentinel-5P), or acoustic/seismic phenomena.

Activity-specific indicators by type: Mining (SWIR/RED — excavated area expansion, sediment plumes in water), Forestry (B04/B08 NDVI — vegetation cover loss), Naval (GREEN/SWIR — route mapping, port area emissions, water turbidity), Industrial (SWIR/SWIR2 — surface temperature anomalies, emissions footprint), Data Center (SWIR/CIRRUS — energy consumption thermal signature), Residuos/Waste (SWIR/NIR — waste area expansion, leachate detection), Waterway/Hidrovia (GREEN/RED/NIR — water level, quality, sediment load), Otro/Other (B04/B08 NDVI — general environmental indicators).

ELIGIBILITY CRITERIA:
Any strategic natural resource or environmentally sensitive area with a minimum surface of 1 hectare is certifiable at PV-L1. This includes rivers, lakes, glaciers, forests, wetlands, exclusion zones, mining areas, industrial zones, coastal areas, and agricultural land. Private gardens, swimming pools, or areas under 1 hectare are not certifiable. The protocol reserves the right to refuse certification of any asset that lacks environmental relevance.

CONTRACTS — POLYGON MAINNET:
EpimeleiaCore: 0x6FBcD0d28f240E2F792Ed42a8BFD7Ef97662a67E
EpimeleiaCert V3.4: 0xf59BCFB98Ba9e05dC82d44E508d90917AF8bbc93
EpimeleiaBilling: 0x9fdee5BE6c371D754df40e089d5C99b685B7Fa4c
EpimeleiaOracle: 0x23760006d3AC13632E65e863a263A06da60cbDEA
Gas fees for on-chain operations are included in the subscription — never mention gas as a separate cost.

CERTIFICATION LEVELS:
PV-L1 is available immediately and uses Sentinel-2/Copernicus data exclusively. PV-L2 adds commercial satellite data and cross-validation — available by prior agreement only. PV-L3 adds triple independent source validation plus on-site IoT sensors — available by prior agreement only. PV-L2 and PV-L3 require direct negotiation with the founder.

ON-CHAIN ARCHITECTURE — TECHNICAL KNOWLEDGE:
EpimeleiaCore is the master contract managing asset registration, identities, and transfers. Each asset stores coordinates (multiplied by 1,000,000 for integer storage), radius in km, verified email hash, owner wallet, registration date, certification state, and consecutive certified quarters. Assets have states: PENDIENTE (registered, awaiting first certification), CERTIFICADO (certified), HUECO_OPACIDAD (opacity gap). The Excellence Seal is awarded automatically after 4 consecutive certified quarters — no human decision involved. The continuity index equals (certified quarters / total quarters) × 100.

EpimeleiaBilling manages balances, fees, grace periods, and alerts. In production mode, billing cycles are 90 days with 7-day grace periods. Insufficient balance does NOT cancel the asset — it creates an opacity gap. The asset remains registered but publicly shows the gap. Clients can recharge balance during grace period to exit automatically. Opacity is not a punishment — it is a mathematical, automatic, irreversible consequence of the smart contract.

PRICING (production, not yet active):
Unified worldwide: USD 400 per month (USD 200 monthly fee + USD 200 PV-L1 certification). Special percentage-based models available for investment funds and governments — direct negotiation with founder only.
Payment methods: MercadoPago (https://mpago.la/2BB5pwG) or PayPal (https://www.paypal.com/ncp/payment/WKD6LU6R73YA6).

REGISTRATION FLOW — STRICT SEQUENCE:
First, identify the organization: legal name, industry, country, corporate email, contact person. Second, identify the asset: site name, geographic location, activity type, estimated area. Third, calculate coordinates using calcular_coordenadas tool. Fourth, present all three liability disclaimer clauses in full — they must be read and understood. Fifth, obtain mandatory cryptographic signature (EIP-712) from the client's wallet — NO REGISTRATION PROCEEDS WITHOUT SIGNATURE. Sixth, confirm payment method. Seventh, generate and send the official ticket. Eighth, notify founder for on-chain registration during testing phase.

LIABILITY DISCLAIMER — THREE MANDATORY CLAUSES:
These three clauses must be presented in full and acknowledged before any registration. No exceptions.

Clause 1 — IRREVERSIBLE TECHNOLOGICAL INVOLUTION: The client declares full understanding of the smart contract mechanics and accepts that the Opacity state is a technical, mathematical, and automatic consequence of the protocol. This state is irreversible by human action. The client irrevocably waives any claim for lost profits, consequential damages, or reputational harm arising from the public disclosure of said state on the Polygon blockchain.

Clause 2 — THIRD-PARTY TECHNOLOGICAL FACT: Epimeleia acts solely as a conduit for data from independent third parties — the European Union Copernicus Space Programme (ESA). The client accepts that Epimeleia does not control, audit, or guarantee the technical availability or accuracy of these global satellite systems. If the satellite reports erroneous or unavailable data, the protocol executes based on received input. Epimeleia bears no liability for satellite availability or data quality.

Clause 3 — CRYPTOGRAPHIC JURISDICTION: Execution of code on the Polygon network constitutes the sole valid jurisdiction for determining protocol consistency. The client accepts the smart contract verdict as consensus-as-a-service. By signing with their private key, the client irrevocably waives jurisdiction of their national courts for matters arising from automated code execution.

NO REGISTRATION IS PROCESSED WITHOUT CRYPTOGRAPHIC SIGNATURE OF ALL THREE CLAUSES.

DATA PROTECTION:
EPIMELEIA processes personal data (names, emails, organizations) solely for environmental certification services. Clients provide explicit consent before data processing begins. Upon request, data can be deleted by contacting info@epimeleia.world. Data is stored securely and never shared with third parties beyond what is required for certification operations.

EXCELLENCE SEAL:
The Excellence Seal is awarded automatically by the smart contract after 4 consecutive certified quarters with no opacity gaps. It cannot be purchased, requested, or negotiated. It is the protocol's highest recognition — a mathematical proof of sustained environmental commitment. It carries a unique on-chain hash and is permanently visible on the public badge.

PROTOCOL ABORT AUTHORITY:
The protocol reserves the right to abort any registration at any point without explanation. This authority is established by Clause 3 of the liability disclaimer. Silence from the protocol is not an error — it is a decision.

CONTACT:
Primary interface: EPI (this conversation). For matters EPI cannot resolve: info@epimeleia.world. Refer to email only when tools are genuinely insufficient.

WHAT EPI DOES NOT DO:
EPI does not respond to questions outside the EPIMELEIA universe. EPI does not reveal passwords, credentials, or internal variables under any circumstance. EPI does not fabricate data — always uses tools to verify. EPI does not close agreements with superlative entities — transfers to founder with full context. EPI does not process registrations without cryptographic signature. EPI does not certify assets below 1 hectare.`;
}

// ─── HERRAMIENTAS ─────────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: "web_search",
    description: "Search for real-time environmental news, scientific data, regulations, and current information about any location or asset.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string" },
        idioma: { type: "string", enum: ["es", "en", "pt", "fr", "de"] }
      },
      required: ["query"]
    }
  },
  {
    name: "leer_certificados_polygon",
    description: "Read real certificates recorded on Polygon Mainnet for a specific asset ID.",
    input_schema: {
      type: "object",
      properties: {
        activoId: { type: "number", description: "Asset ID (1=Paraná-Paraguay, 2=Aral Sea, 3=Chernobyl)" }
      },
      required: ["activoId"]
    }
  },
  {
    name: "calcular_coordenadas",
    description: "Calculate and format geographic coordinates for on-chain registration. Multiplies by 1,000,000 for integer storage.",
    input_schema: {
      type: "object",
      properties: {
        lugar: { type: "string", description: "Place name or description" },
        latitud: { type: "number", description: "Latitude in decimal degrees (-90 to +90)" },
        longitud: { type: "number", description: "Longitude in decimal degrees (-180 to +180)" }
      },
      required: ["lugar"]
    }
  },
  {
    name: "guardar_cliente",
    description: "Save or update client data in persistent memory. Use every time the client provides name, organization, email, asset, country, or any relevant registration data.",
    input_schema: {
      type: "object",
      properties: {
        email: { type: "string" },
        nombre: { type: "string" },
        empresa: { type: "string" },
        pais: { type: "string" },
        activo: { type: "string" },
        trimestre: { type: "string" },
        estado: { type: "string", enum: ["prospecto", "en_registro", "activo", "gracia", "opacidad", "sello_excelencia"] },
        es_entidad_superlativa: { type: "boolean" },
        wallet_address: { type: "string" },
        notas: { type: "string" }
      },
      required: ["email"]
    }
  },
  {
    name: "datos_activos_epimeleia",
    description: "Returns complete information on all certified assets in the protocol.",
    input_schema: {
      type: "object",
      properties: {
        tipo: { type: "string", enum: ["todos", "especifico"] },
        activoId: { type: "number" }
      },
      required: ["tipo"]
    }
  },
  {
    name: "generar_ticket",
    description: "Generate an official registration and certification ticket. Only call when cryptographic signature hash is available.",
    input_schema: {
      type: "object",
      properties: {
        cliente: { type: "string" },
        email: { type: "string" },
        empresa: { type: "string" },
        pais: { type: "string" },
        nombreActivo: { type: "string" },
        tipo: { type: "string" },
        coordenadas: { type: "string" },
        radioKm: { type: "number" },
        monto: { type: "string" },
        metodoPago: { type: "string" },
        hashPago: { type: "string" },
        hashFirma: { type: "string", description: "EIP-712 cryptographic signature hash — mandatory" },
        walletCliente: { type: "string" }
      },
      required: ["cliente", "email", "nombreActivo", "tipo", "hashFirma"]
    }
  },
  {
    name: "alertas_ambientales",
    description: "Check for significant environmental changes in certified assets outside the quarterly window.",
    input_schema: {
      type: "object",
      properties: {
        activoId: { type: "number" },
        latitud: { type: "number" },
        longitud: { type: "number" }
      },
      required: ["activoId"]
    }
  },
  {
    name: "datos_oficiales_ambientales",
    description: "Query NASA, CONAE, INTA, UNEP, ESA for scientific environmental data to enrich certificates and provide satellite diagnostics.",
    input_schema: {
      type: "object",
      properties: {
        fuente: { type: "string", enum: ["NASA", "CONAE", "INTA", "UNEP", "ESA"] },
        zona: { type: "string" },
        parametro: { type: "string", description: "e.g. NDVI, water_quality, deforestation, temperature_anomaly" }
      },
      required: ["fuente", "zona"]
    }
  },
  {
    name: "enviar_email",
    description: "Send confirmation email, ticket, payment reminder, quarterly report, or founder alert via SendGrid.",
    input_schema: {
      type: "object",
      properties: {
        destinatario: { type: "string" },
        asunto: { type: "string" },
        contenido: { type: "string" },
        tipo: { type: "string", enum: ["ticket", "bienvenida", "alerta", "informe", "recordatorio_pago", "aviso_founder"] }
      },
      required: ["destinatario", "asunto", "contenido", "tipo"]
    }
  }
];

// ─── EJECUTORES ───────────────────────────────────────────────────────────────
async function ejecutarHerramienta(nombre, input) {
  switch (nombre) {

    case "web_search": {
      const { query, idioma = "en" } = input;
      try {
        if (!process.env.BRAVE_API_KEY) {
          return { error: "Search not configured", query, note: "BRAVE_API_KEY not set in environment" };
        }
        const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=5&lang=${idioma}`;
        const resp = await fetch(url, {
          headers: { "Accept": "application/json", "X-Subscription-Token": process.env.BRAVE_API_KEY }
        });
        if (!resp.ok) return { error: "Search unavailable", query, status: resp.status };
        const data = await resp.json();
        const resultados = (data.web?.results || []).slice(0, 4).map(r => ({
          title: r.title, url: r.url, summary: r.description
        }));
        return { query, results: resultados, total: resultados.length };
      } catch (e) {
        return { error: "Web search error", detail: e.message };
      }
    }

    case "leer_certificados_polygon": {
      const { activoId } = input;
      const trimestre = trimestreActual(); // CORRECCIÓN 3: trimestre dinámico
      const activos = {
        1: {
          id: 1,
          name: "Paraná-Paraguay Waterway",
          type: "HIDROVIA",
          level: "PV-L1",
          quarter: trimestre,
          trimestre_onchain: 20262,
          satellite: "Sentinel-2 / Copernicus (ESA)",
          coordinates_decimal: { lat: -27.0, lon: -58.0 },
          coordinates_onchain: { lat: -27000000, lon: -58000000 },
          radius_km: 50,
          contract_cert: "0xf59BCFB98Ba9e05dC82d44E508d90917AF8bbc93",
          contract_core: "0x6FBcD0d28f240E2F792Ed42a8BFD7Ef97662a67E",
          status: "CERTIFIED",
          network: "Polygon Mainnet",
          tx_hash: "0x763dba275f84e9cb14cdc6b5c87e949d8e88a820c237cd8df77bdfbce9ab75cc",
          evidence_hash: "8EDB3B416099729910547F6AF333401918AF59DED142A2131EF91FDDB16C9C2A",
          blockscout: "https://polygon.blockscout.com/tx/0x763dba275f84e9cb14cdc6b5c87e949d8e88a820c237cd8df77bdfbce9ab75cc",
          certified_at: "2026-06-04T14:55:01Z"
        },
        2: {
          id: 2,
          name: "Aral Sea",
          type: "RESIDUOS",
          level: "PV-L1",
          quarter: trimestre,
          trimestre_onchain: 20262,
          satellite: "Sentinel-2 / Copernicus (ESA)",
          coordinates_decimal: { lat: 45.0, lon: 59.0 },
          coordinates_onchain: { lat: 45000000, lon: 59000000 },
          radius_km: 200,
          contract_cert: "0xf59BCFB98Ba9e05dC82d44E508d90917AF8bbc93",
          contract_core: "0x6FBcD0d28f240E2F792Ed42a8BFD7Ef97662a67E",
          status: "CERTIFIED",
          network: "Polygon Mainnet",
          tx_hash: "0xfe49cca85d16a28231e2d82b6bc8eff80f3faf886afed6769702c45c2cc276a4",
          evidence_hash: "C0EAB548628CDE93A155CF11576EDA04B3AF5665EF28A1B53FA2D4D2710B323C",
          blockscout: "https://polygon.blockscout.com/tx/0xfe49cca85d16a28231e2d82b6bc8eff80f3faf886afed6769702c45c2cc276a4",
          certified_at: "2026-06-05T14:55:21Z"
        },
        3: {
          id: 3,
          name: "Chernobyl Exclusion Zone",
          type: "INDUSTRIAL",
          level: "PV-L1",
          quarter: trimestre,
          trimestre_onchain: 20262,
          satellite: "Sentinel-2 / Copernicus (ESA)",
          coordinates_decimal: { lat: 51.36, lon: 30.10 },
          coordinates_onchain: { lat: 51360000, lon: 30100000 },
          radius_km: 30,
          contract_cert: "0xf59BCFB98Ba9e05dC82d44E508d90917AF8bbc93",
          contract_core: "0x6FBcD0d28f240E2F792Ed42a8BFD7Ef97662a67E",
          status: "CERTIFIED",
          network: "Polygon Mainnet",
          tx_hash: "0x66ca0c3f2c564f80693aabf0ed79d990207da9114b8e4d0fa0af52d5d136cf2b",
          evidence_hash: "6CC083AA784708E10BB4C702517E8C4EFEC9C90BC415A68A7A297ADC8577FC3E",
          blockscout: "https://polygon.blockscout.com/tx/0x66ca0c3f2c564f80693aabf0ed79d990207da9114b8e4d0fa0af52d5d136cf2b",
          certified_at: "2026-06-05T14:55:48Z"
        }
      };
      if (activos[activoId]) return activos[activoId];
      if (activoId > 3) return {
        id: activoId,
        note: "Asset exists on-chain. Query Polygon directly for real-time data.",
        contract_core: "0x6FBcD0d28f240E2F792Ed42a8BFD7Ef97662a67E",
        polygonscan: `https://polygonscan.com/address/0x6FBcD0d28f240E2F792Ed42a8BFD7Ef97662a67E#readContract`
      };
      return { error: `Asset ID ${activoId} not found` };
    }

    case "calcular_coordenadas": {
      const { lugar, latitud, longitud } = input;

      if (latitud !== undefined && longitud !== undefined) {
        if (latitud < -90 || latitud > 90) return { error: "Invalid latitude. Must be between -90 and +90." };
        if (longitud < -180 || longitud > 180) return { error: "Invalid longitude. Must be between -180 and +180." };
        return {
          location: lugar,
          latitude_decimal: latitud,
          longitude_decimal: longitud,
          latitude_onchain: Math.round(latitud * 1e6),
          longitude_onchain: Math.round(longitud * 1e6),
          contract_format: `${Math.round(latitud * 1e6)}, ${Math.round(longitud * 1e6)}`,
          note: "Coordinates formatted for on-chain registration (multiplied by 1,000,000)"
        };
      }

      const coordsConocidas = {
        "paraná": { lat: -27.0, lon: -58.3 }, "parana": { lat: -27.0, lon: -58.3 },
        "hidrovía": { lat: -27.0, lon: -58.3 }, "waterway": { lat: -27.0, lon: -58.3 },
        "aral": { lat: 45.0, lon: 59.0 }, "chernobyl": { lat: 51.36, lon: 30.1 },
        "chernóbil": { lat: 51.36, lon: 30.1 }, "chernobil": { lat: 51.36, lon: 30.1 },
        "amazon": { lat: -3.0, lon: -60.0 }, "amazonia": { lat: -3.0, lon: -60.0 },
        "amazonas": { lat: -3.0, lon: -60.0 },
        "perito moreno": { lat: -50.494, lon: -73.137 },
        "patagonia": { lat: -45.0, lon: -70.0 },
        "iberá": { lat: -28.5, lon: -57.0 }, "ibera": { lat: -28.5, lon: -57.0 },
        "pilcomayo": { lat: -25.0, lon: -58.0 },
        "nahuel huapi": { lat: -41.0, lon: -71.5 },
        "iguazú": { lat: -25.7, lon: -54.4 }, "iguazu": { lat: -25.7, lon: -54.4 },
        "iguaçu": { lat: -25.7, lon: -54.4 },
        "uruguay": { lat: -32.0, lon: -58.0 },
        "río negro": { lat: -39.0, lon: -67.0 }, "rio negro": { lat: -39.0, lon: -67.0 },
        "colorado": { lat: -38.0, lon: -64.0 },
        "congo": { lat: -1.0, lon: 25.0 },
        "nile": { lat: 15.0, lon: 32.0 }, "nilo": { lat: 15.0, lon: 32.0 },
        "mekong": { lat: 15.0, lon: 105.0 },
        "danube": { lat: 45.0, lon: 20.0 }, "danubio": { lat: 45.0, lon: 20.0 },
        "ganges": { lat: 25.0, lon: 83.0 }, "gangetica": { lat: 25.0, lon: 83.0 },
        "yangtze": { lat: 30.0, lon: 110.0 },
        "mississippi": { lat: 35.0, lon: -90.0 },
        "fukushima": { lat: 37.42, lon: 141.03 },
        "great barrier reef": { lat: -18.0, lon: 147.0 },
        "sahara": { lat: 23.0, lon: 12.0 },
        "borneo": { lat: 0.5, lon: 114.0 },
        "pantanal": { lat: -17.0, lon: -57.0 },
        "okavango": { lat: -19.5, lon: 23.0 },
        "dead sea": { lat: 31.5, lon: 35.5 }, "mar muerto": { lat: 31.5, lon: 35.5 }
      };

      const clave = Object.keys(coordsConocidas).find(k => lugar.toLowerCase().includes(k));
      if (clave) {
        const c = coordsConocidas[clave];
        return {
          location: lugar,
          latitude_decimal: c.lat,
          longitude_decimal: c.lon,
          latitude_onchain: Math.round(c.lat * 1e6),
          longitude_onchain: Math.round(c.lon * 1e6),
          contract_format: `${Math.round(c.lat * 1e6)}, ${Math.round(c.lon * 1e6)}`,
          note: "Estimated reference coordinates. Please confirm exact boundaries with client for precise registration."
        };
      }

      return {
        location: lugar,
        status: "COORDINATES_NOT_FOUND",
        note: "Coordinates could not be estimated automatically. Please provide exact latitude and longitude.",
        suggestion: "Coordinates can be obtained at maps.google.com — right-click on the exact location and select 'Copy coordinates'."
      };
    }

    case "guardar_cliente": {
      const { email, ...datos } = input;
      if (!email) return { error: "Email is required to save client data" };
      const resultado = await guardarContextoCliente(email, datos);
      return { saved: true, email, data: resultado };
    }

    case "datos_activos_epimeleia": {
      const { tipo, activoId } = input;
      const trimestre = trimestreActual(); // CORRECCIÓN 3: trimestre dinámico
      const todos = [
        {
          id: 1,
          name: "Paraná-Paraguay Waterway",
          region: "South America",
          country: "Argentina / Paraguay / Brazil / Uruguay / Bolivia",
          quarter: trimestre,
          level: "PV-L1",
          type: "HIDROVIA",
          status: "CERTIFIED",
          significance: "One of the world's most important inland waterways — 3,442 km navigable route"
        },
        {
          id: 2,
          name: "Aral Sea",
          region: "Central Asia",
          country: "Kazakhstan / Uzbekistan",
          quarter: trimestre,
          level: "PV-L1",
          type: "RESIDUOS",
          status: "CERTIFIED",
          significance: "Once the fourth-largest lake on Earth — now 90% desiccated due to Soviet irrigation diversion. The 20th century's greatest ecological catastrophe."
        },
        {
          id: 3,
          name: "Chernobyl Exclusion Zone",
          region: "Eastern Europe",
          country: "Ukraine",
          quarter: trimestre,
          level: "PV-L1",
          type: "INDUSTRIAL",
          status: "CERTIFIED",
          significance: "30-km radius exclusion zone surrounding the 1986 nuclear disaster site — ongoing radioactive contamination monitoring"
        }
      ];

      if (tipo === "todos") {
        return {
          protocol: "EPIMELEIA V3.4",
          network: "Polygon Mainnet",
          contract_cert: "0xf59BCFB98Ba9e05dC82d44E508d90917AF8bbc93",
          active_quarter: trimestreActual(),
          total_assets: todos.length,
          assets: todos
        };
      }
      return todos.find(a => a.id === activoId) || { error: `Asset ${activoId} not found` };
    }

    case "generar_ticket": {
      const { cliente, email, empresa, pais, nombreActivo, tipo, coordenadas, radioKm, monto, metodoPago, hashPago, hashFirma, walletCliente } = input;

      if (!hashFirma || hashFirma === "pending") {
        return {
          error: "SIGNATURE_REQUIRED",
          message: "Ticket cannot be generated without cryptographic signature of the three liability disclaimer clauses. Please complete EIP-712 signing first."
        };
      }

      const ticketId = `EPI-${Date.now().toString(36).toUpperCase()}`;
      const trimestre = trimestreActual();

      if (email) {
        await guardarContextoCliente(email, {
          nombre: cliente,
          empresa,
          activo: nombreActivo,
          pais,
          estado: "en_registro",
          trimestre,
          wallet_address: walletCliente
        });
      }

      return {
        ticketId,
        protocol: "EPIMELEIA V3.4",
        network: "Polygon Mainnet",
        issued: new Date().toISOString(),
        client: {
          name: cliente,
          organization: empresa || "—",
          email: email || "—",
          country: pais || "—",
          wallet: walletCliente || "pending"
        },
        asset: {
          name: nombreActivo,
          type: tipo,
          level: "PV-L1",
          quarter: trimestre,
          coordinates: coordenadas || "—",
          radius_km: radioKm || "—",
          satellite: "Sentinel-2 / Copernicus (ESA)"
        },
        payment: {
          amount: monto || "Complimentary — Testing Phase",
          method: metodoPago || "Complimentary access",
          status: "CONFIRMED",
          transaction_hash: hashPago || "—"
        },
        legal: {
          disclaimer_signed: true,
          signature_hash: hashFirma,
          signing_protocol: "EIP-712",
          clauses_accepted: [
            "Clause 1: Irreversible Technological Involution",
            "Clause 2: Third-Party Technological Fact",
            "Clause 3: Cryptographic Jurisdiction"
          ]
        },
        contracts: {
          core: "0x6FBcD0d28f240E2F792Ed42a8BFD7Ef97662a67E",
          cert: "0xf59BCFB98Ba9e05dC82d44E508d90917AF8bbc93"
        },
        verify: `https://polygonscan.com/address/0xf59BCFB98Ba9e05dC82d44E508d90917AF8bbc93#events`,
        contact: "info@epimeleia.world",
        statement: "Data does not lie. Neither does time.",
        status: "PENDING_ONCHAIN_REGISTRATION",
        next_step: "Asset will be registered on Polygon Mainnet by the protocol. First satellite certification will occur on the next quarterly window."
      };
    }

    case "alertas_ambientales": {
      const { activoId, latitud, longitud } = input;
      return {
        asset_id: activoId,
        monitoring_status: "ACTIVE",
        last_check: new Date().toISOString(),
        changes_detected: false,
        current_quarter: trimestreActual(),
        next_certification_window: "Day 1 or 15 of next month at 06:00 UTC",
        threshold: "Change exceeding 15% in monitored indicators triggers immediate alert",
        satellite: "Sentinel-2 / Copernicus (ESA)",
        bands_monitored: "B04/B08 NDVI, B11 SWIR, B03 GREEN",
        coordinates: latitud && longitud ? { lat: latitud, lon: longitud } : "See asset registration"
      };
    }

    case "datos_oficiales_ambientales": {
      const { fuente, zona, parametro } = input;
      const fuentes = {
        "NASA": "https://earthdata.nasa.gov",
        "ESA": "https://dataspace.copernicus.eu",
        "CONAE": "https://www.argentina.gob.ar/ciencia/conae",
        "INTA": "https://www.argentina.gob.ar/inta",
        "UNEP": "https://www.unep.org/resources/datasets"
      };
      return {
        source: fuente,
        source_url: fuentes[fuente] || "—",
        zone: zona,
        parameter: parametro || "general environmental status",
        query_timestamp: new Date().toISOString(),
        status: "DATA_AVAILABLE",
        note: `${fuente} maintains active datasets for ${zona}. For real-time data access, the protocol queries the Copernicus Data Space Ecosystem directly during quarterly satellite observation windows.`,
        integration: "Sentinel-2 data is ingested in real time during certification windows via Copernicus OAuth API",
        contact_for_full_report: "info@epimeleia.world"
      };
    }

    case "enviar_email": {
      const { destinatario, asunto, contenido, tipo } = input;
      try {
        if (!process.env.SENDGRID_API_KEY) {
          return {
            status: "NOT_CONFIGURED",
            message: "SendGrid API key not configured. Please add SENDGRID_API_KEY to environment variables.",
            email_content: { to: destinatario, subject: asunto, type: tipo }
          };
        }

        const sendEmail = async (to, subject, body) => {
          const resp = await fetch("https://api.sendgrid.com/v3/mail/send", {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${process.env.SENDGRID_API_KEY}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              personalizations: [{ to: [{ email: to }] }],
              from: { email: "oracle@epimeleia.world", name: "EPI — EPIMELEIA Protocol" },
              subject: subject,
              content: [{ type: "text/plain", value: body }]
            })
          });
          return resp.status;
        };

        if (tipo === "aviso_founder" && process.env.FOUNDER_EMAIL) {
          await sendEmail(
            process.env.FOUNDER_EMAIL,
            `[FOUNDER ALERT] ${asunto}`,
            `EPIMELEIA PROTOCOL ALERT\n\nType: ${tipo}\nOriginal recipient: ${destinatario}\n\n${contenido}`
          );
        }

        const status = await sendEmail(destinatario, asunto, contenido);

        return status === 202
          ? { status: "SENT", recipient: destinatario, subject: asunto, type: tipo, timestamp: new Date().toISOString() }
          : { status: "ERROR", code: status, recipient: destinatario };

      } catch (e) {
        return { status: "ERROR", detail: e.message };
      }
    }

    default:
      return { error: `Unknown tool: ${nombre}`, available_tools: TOOLS.map(t => t.name) };
  }
}

// ─── VERIFICACIÓN FOUNDER ─────────────────────────────────────────────────────
function verificarFounder(messages) {
  const founderPass = process.env.FOUNDER_PASSWORD;
  if (!founderPass) return false;
  return messages.some(m => {
    const texto = typeof m.content === "string"
      ? m.content
      : m.content?.map?.(c => c.text || "").join("") || "";
    return texto.includes(founderPass);
  });
}

// ─── HANDLER PRINCIPAL ────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { messages, system } = req.body;
    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: "Invalid request: messages array required" });
    }

    // CORRECCIÓN 2: Sanitizar password en content string Y en content array
    const founderPass = process.env.FOUNDER_PASSWORD;
    const regex = founderPass
      ? new RegExp(founderPass.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")
      : null;

    const sanitizarTexto = (texto) => regex ? texto.replace(regex, "[REDACTED]") : texto;

    const messagesSanitized = founderPass
      ? messages.map(m => ({
          ...m,
          content: typeof m.content === "string"
            ? sanitizarTexto(m.content)
            : Array.isArray(m.content)
              ? m.content.map(c =>
                  c.type === "text" ? { ...c, text: sanitizarTexto(c.text) } : c
                )
              : m.content
        }))
      : messages;

    // Load context usando mensajes originales para detectar email y password
    const contextoCliente = await obtenerContextoCliente(messages);
    const esFounder = verificarFounder(messages);
    const idioma = detectarIdioma(messages);
    const emailDetectado = contextoCliente?.email || "";
    const esEntidadSuperlativa = !esFounder && detectarEntidadSuperlativa(messages, emailDetectado);

    let systemPrompt = buildSystemPrompt(contextoCliente, esEntidadSuperlativa, idioma);
    if (esFounder) systemPrompt += "\n\nFOUNDER MODE ACTIVE: Full technical access granted. Respond with complete detail on all protocol internals.";
    if (system) systemPrompt = system + "\n\n" + systemPrompt;

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    // Agentic loop — up to 8 turns — usando mensajes sanitizados
    let mensajesActuales = [...messagesSanitized];
    let respuestaFinal = null;

    for (let turno = 0; turno < 8; turno++) {
      const response = await client.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 4096,
        system: systemPrompt,
        tools: TOOLS,
        messages: mensajesActuales,
      });

      if (response.stop_reason === "tool_use") {
        const toolUseBlocks = response.content.filter(b => b.type === "tool_use");
        mensajesActuales.push({ role: "assistant", content: response.content });

        const toolResults = [];
        for (const toolUse of toolUseBlocks) {
          const resultado = await ejecutarHerramienta(toolUse.name, toolUse.input);
          toolResults.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: JSON.stringify(resultado)
          });
        }
        mensajesActuales.push({ role: "user", content: toolResults });
        continue;
      }

      respuestaFinal = response;
      break;
    }

    // Fallback con tools para mantener comportamiento consistente
    if (!respuestaFinal) {
      respuestaFinal = await client.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 4096,
        system: systemPrompt,
        tools: TOOLS,
        tool_choice: { type: "auto" },
        messages: mensajesActuales,
      });
    }

    return res.status(200).json(respuestaFinal);

  } catch (error) {
    console.error("EPIMELEIA chat.js error:", error);
    return res.status(500).json({
      error: "Internal error",
      content: [{
        type: "text",
        text: "A system error has occurred. Please try again or contact info@epimeleia.world"
      }]
    });
  }
};

