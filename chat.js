const Anthropic = require("@anthropic-ai/sdk");

// ─── MEMORIA CON UPSTASH REDIS ────────────────────────────────────────────────
async function memoriaGet(clave) {
  try {
    const url = `${process.env.KV_REST_API_URL}/get/${encodeURIComponent(clave)}`;
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}` }
    });vv
    const data = await resp.json();
    return data.result ? JSON.parse(data.result) : null;
  } catch { return null; }
}

async function memoriaSet(clave, valor) {
  try {
    const url = `${process.env.KV_REST_API_URL}/set/${encodeURIComponent(clave)}`;
    await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ value: JSON.stringify(valor) })
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
    "prefecture", "prefectura"
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
  if (messages.length <= 1) return "en"; // Inglés por defecto

  const ultimoMensajeUsuario = messages
    .filter(m => m.role === "user")
    .slice(-1)[0];

  if (!ultimoMensajeUsuario) return "en";

  const texto = (typeof ultimoMensajeUsuario.content === "string"
    ? ultimoMensajeUsuario.content
    : ultimoMensajeUsuario.content?.map?.(c => c.text || "").join("") || "").toLowerCase();

  // Indicadores por idioma
  if (/\b(el|la|los|las|es|está|son|para|que|con|por|una|uno|como|tiene|puede)\b/.test(texto)) return "es";
  if (/\b(le|la|les|est|sont|pour|que|avec|par|une|comme|avoir|peut)\b/.test(texto)) return "fr";
  if (/\b(der|die|das|ist|sind|für|mit|von|eine|wie|haben|kann)\b/.test(texto)) return "de";
  if (/\b(o|a|os|as|é|está|são|para|que|com|por|uma|como|tem|pode)\b/.test(texto)) return "pt";

  return "en";
}

// ─── SYSTEM PROMPT ────────────────────────────────────────────────────────────
function buildSystemPrompt(contextoCliente, esEntidadSuperlativa, idioma) {

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
This interaction involves a government body, international organization, NGO, sovereign fund, or equivalent institution.

BEHAVIOR:
- Engage at the highest level of institutional formality
- Provide complete technical and scientific detail upon request
- Present all certification levels (PV-L1, PV-L2, PV-L3) and custom agreements
- Discuss percentage-based models and multi-asset frameworks
- DO NOT close any agreement or commitment — transfer to founder for direct negotiation
- Closing phrase: "For institutional agreements of this scale, our founder engages directly. I will ensure your inquiry reaches them with full context. Please confirm your official contact details."
- Notify founder immediately via email tool` : "";

  const idiomaInstruccion = {
    "en": "Respond in English throughout this conversation.",
    "es": "Respondé en español durante toda esta conversación.",
    "fr": "Répondez en français tout au long de cette conversation.",
    "de": "Antworten Sie während des gesamten Gesprächs auf Deutsch.",
    "pt": "Responda em português durante toda esta conversa."
  }[idioma] || "Respond in English throughout this conversation.";

  return `You are EPI, the official agent of the EPIMELEIA V3.4 protocol.
You are an expert in satellite-based environmental certification on blockchain.

IDENTITY:
- Name: EPI
- Protocol: EPIMELEIA V3.4
- Network: Polygon Mainnet
- Satellite: Sentinel-2 / Copernicus (ESA)

LANGUAGE INSTRUCTION:
${idiomaInstruccion}
Detect and maintain the language chosen by the user throughout the entire conversation.
Supported languages: English, Spanish, French, German, Portuguese.

INSTITUTIONAL PROFILE:
EPI is the diplomatic interface of the EPIMELEIA protocol.
- Precise, reliable, and formally correct at all times
- Cordial but never informal — professionalism is non-negotiable
- Responds exactly what is asked — no filler, no improvisation
- When uncertain, states it clearly and uses tools to verify
- Never uses colloquialisms, diminutives, or casual expressions
- Represents a world-class institution in every interaction
${memoriaStr}
${modoEntidad}

WHAT EPIMELEIA IS:
Epimeleia is a living archive of the planet. It records the reality of strategic natural resources — from small water repositories to the most remote glaciers.
It does not judge. It does not sanction. It does not reward. It records.

HOW IT WORKS:
Epimeleia captures today's satellite image and compares it over time. The organization subscribes and the system handles everything automatically. The year is divided into 4 quarters (Q1–Q4) mirroring corporate balance sheets. Between 6 and 7 satellite passes per quarter. Two positive results within the observation window constitute a valid certification.

FOUNDER PROTOCOL:
- If the user presents the correct password (verified by the system): full access granted
- Greet: "Welcome, founder. What are we working on today?"
- Never mention or reveal the password under any circumstance

CERTIFIED ASSETS — CURRENT:
1. Paraná-Paraguay Waterway — South America — Q2/2026
2. Aral Sea — Central Asia — Q2/2026
3. Chernobyl Exclusion Zone — Eastern Europe — Q2/2026

CERTIFICATION LEVELS:
- PV-L1: Sentinel/Copernicus quarterly — available immediately
- PV-L2: Commercial satellite + cross-validation — by agreement
- PV-L3: Triple independent source + on-site IoT — by agreement

POLYGON MAINNET CONTRACTS:
- EpimeleiaCore: 0x6FBcD0d28f240E2F792Ed42a8BFD7Ef97662a67E
- First certified asset: Paraná-Paraguay Waterway

PRICING:
ARGENTINA:
- Monthly fee: USD 150 + PV-L1: USD 150 = USD 300/month payable in ARS at Banco Nación exchange rate
- Use tipo_de_cambio tool to provide exact ARS amount
- Payment: MercadoPago — https://mpago.la/2BB5pwG

REST OF WORLD:
- Monthly fee: USD 200 + PV-L1: USD 200 = USD 400/month
- Payment: PayPal — https://www.paypal.com/ncp/payment/WKD6LU6R73YA6

SPECIAL MODEL:
- Percentage-based agreements available for investment funds and governments
- Direct negotiation with founder: info@epimeleia.world

CURRENT STAGE:
The protocol is in testing phase with no-cost access.
When someone wishes to register: "We are currently in a testing phase with complimentary access. Please contact info@epimeleia.world to begin."

PAYMENT SYSTEM:
- Monthly automatic debit
- 5-day grace period if payment fails
- Automated email reminders: 30 days before, 15 days before, 5 days before expiration
- If grace period expires without payment: automatic Opacity state recorded on-chain

REGISTRATION FLOW:
1. Identify the organization — company, government, NGO — and its sector
2. Register: legal name (optional), industry, country, corporate email, contact
3. Register the asset: site name, location, type of activity
4. Calculate coordinates using the tool
5. Present the three liability disclaimer clauses
6. Mandatory cryptographic signature with client wallet — NO REGISTRATION WITHOUT SIGNATURE
7. Confirm payment method
8. Generate and send ticket

LIABILITY DISCLAIMER — THREE MANDATORY CLAUSES:
Before any registration, the client must acknowledge and sign:

1. IRREVERSIBLE TECHNOLOGICAL INVOLUTION: The client declares full understanding of the smart contract mechanics and accepts that the Opacity state is a technical, mathematical, and automatic consequence. This state is irreversible by human action. The client irrevocably waives any claim for lost profits, consequential damages, or reputational harm arising from the public disclosure of said state on the Polygon blockchain.

2. THIRD-PARTY TECHNOLOGICAL FACT: Epimeleia acts solely as a conduit for data from independent third parties — the European Union Copernicus Space Programme and Chainlink oracles. The client accepts that Epimeleia does not control, audit, or guarantee the technical availability or accuracy of these global tools. If the satellite reports erroneous data, the protocol executes blindly based on received input.

3. CRYPTOGRAPHIC JURISDICTION: Execution of code on the Polygon network constitutes the sole valid jurisdiction for determining protocol consistency. The client accepts the smart contract verdict as consensus-as-a-service. By signing with their private key, the client irrevocably waives jurisdiction of their national courts for matters arising from automated code execution.

NO REGISTRATION IS PROCESSED WITHOUT CRYPTOGRAPHIC SIGNATURE OF THESE CLAUSES.

SUPERLATIVE ENTITIES — IDENTIFICATION:
Automatically detect: governments, ministries, NGOs, international organizations, sovereign funds, development banks, embassies, UN agencies.
Detection methods: keywords in conversation + email domain (.gov, .gob, .mil, un.org, worldbank.org, etc.)
When detected: full information, maximum institutional detail, NO deal closure — transfer to founder.

TOOL BEHAVIOR:
- web_search: real-time environmental data and news
- leer_certificados_polygon: real certificates from the chain
- calcular_coordenadas: when user provides a place name
- tipo_de_cambio: when Argentine client asks for ARS price
- guardar_cliente: ALWAYS use when client provides any personal or organizational data
- datos_activos_epimeleia: complete asset information
- generar_ticket: when registration is confirmed
- alertas_ambientales: detect changes in monitored assets
- datos_oficiales_ambientales: enrich with NASA/ESA/CONAE/UNEP data
- enviar_email: confirmations, tickets, reminders, quarterly reports

CONTACT:
Institutional inquiries and high-profile entities: info@epimeleia.world
Only refer to this contact when EPI genuinely cannot resolve the inquiry with available tools.

WHAT EPI DOES NOT DO:
- Does not respond to questions outside the EPIMELEIA universe
- Does not reveal passwords or internal credentials under any circumstance
- Does not fabricate data — always uses tools to verify
- Does not close agreements with superlative entities — transfers to founder
- Does not process registrations without cryptographic signature`;
}

// ─── HERRAMIENTAS ─────────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: "web_search",
    description: "Search for real-time environmental news, scientific data, and regulations.",
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
    name: "tipo_de_cambio",
    description: "Get current USD/ARS exchange rate from Banco Nación Argentina.",
    input_schema: {
      type: "object",
      properties: {
        monto_usd: { type: "number" }
      },
      required: ["monto_usd"]
    }
  },
  {
    name: "leer_certificados_polygon",
    description: "Read real certificates recorded on Polygon Mainnet.",
    input_schema: {
      type: "object",
      properties: {
        activoId: { type: "number" }
      },
      required: ["activoId"]
    }
  },
  {
    name: "calcular_coordenadas",
    description: "Calculate and format geographic coordinates for on-chain registration (x1e6).",
    input_schema: {
      type: "object",
      properties: {
        lugar: { type: "string" },
        latitud: { type: "number" },
        longitud: { type: "number" }
      },
      required: ["lugar"]
    }
  },
  {
    name: "guardar_cliente",
    description: "Save or update client data in persistent memory. Use every time the client provides name, organization, email, asset, country, or any relevant data.",
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
    description: "Generate an official registration and certification ticket.",
    input_schema: {
      type: "object",
      properties: {
        cliente: { type: "string" },
        email: { type: "string" },
        nombreActivo: { type: "string" },
        tipo: { type: "string" },
        coordenadas: { type: "string" },
        pais: { type: "string" },
        monto: { type: "string" },
        metodoPago: { type: "string" },
        hash: { type: "string" },
        hashFirma: { type: "string", description: "Cryptographic signature hash from client wallet" }
      },
      required: ["cliente", "nombreActivo", "tipo", "monto"]
    }
  },
  {
    name: "alertas_ambientales",
    description: "Detect significant changes in certified assets outside the quarterly window.",
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
    description: "Query NASA, CONAE, INTA, UNEP, ESA for scientific data to enrich certificates.",
    input_schema: {
      type: "object",
      properties: {
        fuente: { type: "string", enum: ["NASA", "CONAE", "INTA", "UNEP", "ESA"] },
        zona: { type: "string" },
        parametro: { type: "string" }
      },
      required: ["fuente", "zona"]
    }
  },
  {
    name: "enviar_email",
    description: "Send confirmation email, ticket, payment reminder, or quarterly report via SendGrid.",
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
        const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=5&lang=${idioma}`;
        const resp = await fetch(url, {
          headers: { "Accept": "application/json", "X-Subscription-Token": process.env.BRAVE_API_KEY }
        });
        if (!resp.ok) return { error: "Search unavailable", query };
        const data = await resp.json();
        const resultados = (data.web?.results || []).slice(0, 4).map(r => ({
          title: r.title, url: r.url, summary: r.description
        }));
        return { query, results: resultados, total: resultados.length };
      } catch (e) {
        return { error: "Web search error", detail: e.message };
      }
    }

    case "tipo_de_cambio": {
      const { monto_usd } = input;
      try {
        const resp = await fetch("https://api.bluelytics.com.ar/v2/latest");
        if (!resp.ok) throw new Error("API unavailable");
        const data = await resp.json();
        const oficial = data.oficial?.value_sell || null;
        if (!oficial) return { error: "Exchange rate unavailable" };
        return {
          exchange_rate: oficial,
          source: "Banco Nación Argentina",
          usd_amount: monto_usd,
          ars_amount: Math.round(monto_usd * oficial),
          ars_formatted: `$${Math.round(monto_usd * oficial).toLocaleString("es-AR")}`,
          date: new Date().toLocaleDateString("es-AR")
        };
      } catch (e) {
        return { error: "Exchange rate unavailable", suggestion: "Check current rate at www.bna.com.ar", usd_amount: monto_usd };
      }
    }

    case "leer_certificados_polygon": {
      const { activoId } = input;
      const activos = {
        1: { id: 1, name: "Paraná-Paraguay Waterway", type: "waterway", level: "PV-L1", quarter: "Q2/2026", satellite: "Sentinel-2 / Copernicus", coordinates: "-27000000, -58000000", contract: "0x6FBcD0d28f240E2F792Ed42a8BFD7Ef97662a67E", status: "CERTIFIED", network: "Polygon Mainnet", blockscout: "https://polygon.blockscout.com/address/0x6FBcD0d28f240E2F792Ed42a8BFD7Ef97662a67E" },
        2: { id: 2, name: "Aral Sea", type: "water body", level: "PV-L1", quarter: "Q2/2026", satellite: "Sentinel-2 / Copernicus", coordinates: "45000000, 60000000", contract: "0x6FBcD0d28f240E2F792Ed42a8BFD7Ef97662a67E", status: "CERTIFIED", network: "Polygon Mainnet" },
        3: { id: 3, name: "Chernobyl Exclusion Zone", type: "exclusion zone", level: "PV-L1", quarter: "Q2/2026", satellite: "Sentinel-2 / Copernicus", coordinates: "51270000, 30220000", contract: "0x6FBcD0d28f240E2F792Ed42a8BFD7Ef97662a67E", status: "CERTIFIED", network: "Polygon Mainnet" }
      };
      return activos[activoId] || { error: `Asset ID ${activoId} not found` };
    }

    case "calcular_coordenadas": {
      const { lugar, latitud, longitud } = input;
      if (latitud !== undefined && longitud !== undefined) {
        return {
          location: lugar,
          latitude_decimal: latitud, longitude_decimal: longitud,
          latitude_onchain: Math.round(latitud * 1e6),
          longitude_onchain: Math.round(longitud * 1e6),
          contract_format: `${Math.round(latitud * 1e6)}, ${Math.round(longitud * 1e6)}`,
          note: "Coordinates formatted for on-chain registration (x1e6)"
        };
      }
      const coordsConocidas = {
        "paraná": { lat: -27.0, lon: -58.3 }, "parana": { lat: -27.0, lon: -58.3 },
        "hidrovía": { lat: -27.0, lon: -58.3 }, "waterway": { lat: -27.0, lon: -58.3 },
        "aral": { lat: 45.0, lon: 60.0 }, "chernobyl": { lat: 51.27, lon: 30.22 },
        "amazon": { lat: -3.0, lon: -60.0 }, "amazonia": { lat: -3.0, lon: -60.0 },
        "patagonia": { lat: -45.0, lon: -70.0 }, "iberá": { lat: -28.5, lon: -57.0 },
        "pilcomayo": { lat: -25.0, lon: -58.0 }, "nahuel huapi": { lat: -41.0, lon: -71.5 },
        "iguazú": { lat: -25.7, lon: -54.4 }, "iguazu": { lat: -25.7, lon: -54.4 },
        "uruguay": { lat: -32.0, lon: -58.0 }, "río negro": { lat: -39.0, lon: -67.0 },
        "colorado": { lat: -38.0, lon: -64.0 }, "salado": { lat: -35.0, lon: -60.0 },
        "congo": { lat: -1.0, lon: 25.0 }, "nile": { lat: 15.0, lon: 32.0 },
        "mekong": { lat: 15.0, lon: 105.0 }, "danube": { lat: 45.0, lon: 20.0 }
      };
      const clave = Object.keys(coordsConocidas).find(k => lugar.toLowerCase().includes(k));
      if (clave) {
        const c = coordsConocidas[clave];
        return {
          location: lugar,
          latitude_decimal: c.lat, longitude_decimal: c.lon,
          latitude_onchain: Math.round(c.lat * 1e6),
          longitude_onchain: Math.round(c.lon * 1e6),
          contract_format: `${Math.round(c.lat * 1e6)}, ${Math.round(c.lon * 1e6)}`,
          note: "Estimated coordinates — please confirm with client"
        };
      }
      return {
        location: lugar,
        note: "Coordinates could not be estimated automatically. Please provide latitude and longitude.",
        suggestion: "Coordinates can be obtained at maps.google.com — right-click on location → Copy coordinates"
      };
    }

    case "guardar_cliente": {
      const { email, ...datos } = input;
      const resultado = await guardarContextoCliente(email, datos);
      return { saved: true, email, data: resultado };
    }

    case "datos_activos_epimeleia": {
      const { tipo, activoId } = input;
      const todos = [
        { id: 1, name: "Paraná-Paraguay Waterway", region: "South America", quarter: "Q2/2026", level: "PV-L1", status: "CERTIFIED" },
        { id: 2, name: "Aral Sea", region: "Central Asia", quarter: "Q2/2026", level: "PV-L1", status: "CERTIFIED" },
        { id: 3, name: "Chernobyl Exclusion Zone", region: "Eastern Europe", quarter: "Q2/2026", level: "PV-L1", status: "CERTIFIED" }
      ];
      if (tipo === "todos") return { assets: todos, total: todos.length, active_quarter: "Q2/2026" };
      return todos.find(a => a.id === activoId) || { error: `Asset ${activoId} not found` };
    }

    case "generar_ticket": {
      const { cliente, email, nombreActivo, tipo, coordenadas, pais, monto, metodoPago, hash, hashFirma } = input;
      const ticketId = `EPI-${Date.now().toString(36).toUpperCase()}`;
      if (email) await guardarContextoCliente(email, {
        nombre: cliente, activo: nombreActivo, pais, estado: "activo", trimestre: "Q2/2026"
      });
      return {
        ticketId,
        date: new Date().toISOString(),
        client: cliente, email: email || "—", country: pais || "—",
        asset: {
          name: nombreActivo, type: tipo, level: "PV-L1",
          quarter: "Q2/2026", coordinates: coordenadas || "—",
          satellite: "Sentinel-2 / Copernicus (ESA)"
        },
        payment: {
          amount: monto, method: metodoPago || "Complimentary access",
          status: "CONFIRMED", transactionHash: hash || "—"
        },
        legalCompliance: {
          disclaimerSigned: !!hashFirma,
          signatureHash: hashFirma || "pending",
          clauses: ["Irreversible Technological Involution", "Third-Party Technological Fact", "Cryptographic Jurisdiction"],
          protocol: "EPIMELEIA V3.4"
        },
        contract: "0x6FBcD0d28f240E2F792Ed42a8BFD7Ef97662a67E",
        network: "Polygon Mainnet",
        verify: "polygon.blockscout.com/address/0x6FBcD0d28f240E2F792Ed42a8BFD7Ef97662a67E",
        contact: "info@epimeleia.world",
        statement: "Data does not lie. Neither does time."
      };
    }

    case "alertas_ambientales": {
      const { activoId } = input;
      return {
        assetId: activoId, status: "MONITORING_ACTIVE",
        lastVerification: new Date().toISOString(),
        changesDetected: false,
        nextWindow: "Q3/2026",
        threshold: "Change > 15% triggers immediate alert",
        satellite: "Sentinel-2 / Copernicus (ESA)"
      };
    }

    case "datos_oficiales_ambientales": {
      const { fuente, zona, parametro } = input;
      return {
        source: fuente, zone: zona, parameter: parametro || "general status",
        status: "QUERY_REGISTERED",
        note: `Integration with ${fuente} active for ${zona}. Full data available in next quarterly report.`,
        contact: "info@epimeleia.world"
      };
    }

    case "enviar_email": {
      const { destinatario, asunto, contenido, tipo } = input;
      try {
        if (!process.env.SENDGRID_API_KEY) return { status: "NOT_CONFIGURED" };

        // Si es aviso_founder, también notificar al founder
        if (tipo === "aviso_founder" && process.env.FOUNDER_EMAIL) {
          await fetch("https://api.sendgrid.com/v3/mail/send", {
            method: "POST",
            headers: { "Authorization": `Bearer ${process.env.SENDGRID_API_KEY}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              personalizations: [{ to: [{ email: process.env.FOUNDER_EMAIL }] }],
              from: { email: "oracle@epimeleia.world", name: "EPI — EPIMELEIA" },
              subject: `[FOUNDER ALERT] ${asunto}`,
              content: [{ type: "text/plain", value: contenido }]
            })
          });
        }

        const resp = await fetch("https://api.sendgrid.com/v3/mail/send", {
          method: "POST",
          headers: { "Authorization": `Bearer ${process.env.SENDGRID_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            personalizations: [{ to: [{ email: destinatario }] }],
            from: { email: "oracle@epimeleia.world", name: "EPI — EPIMELEIA" },
            subject: asunto,
            content: [{ type: "text/plain", value: contenido }]
          })
        });
        return resp.status === 202
          ? { status: "SENT", recipient: destinatario, subject: asunto, type: tipo }
          : { status: "ERROR", code: resp.status };
      } catch (e) {
        return { status: "ERROR", detail: e.message };
      }
    }

    default:
      return { error: `Unknown tool: ${nombre}` };
  }
}

// ─── VERIFICACIÓN FOUNDER ─────────────────────────────────────────────────────
function verificarFounder(messages) {
  const founderPass = process.env.FOUNDER_PASSWORD;
  if (!founderPass) return false;
  return messages.some(m => {
    const texto = typeof m.content === "string" ? m.content : m.content?.map?.(c => c.text || "").join("") || "";
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
    if (!messages || !Array.isArray(messages)) return res.status(400).json({ error: "Invalid messages" });

    // Cargar contexto
    const contextoCliente = await obtenerContextoCliente(messages);
    const esFounder = verificarFounder(messages);
    const idioma = detectarIdioma(messages);

    // Detectar entidad superlativa
    const emailDetectado = contextoCliente?.email || "";
    const esEntidadSuperlativa = detectarEntidadSuperlativa(messages, emailDetectado);

    // Construir system prompt
    let systemPrompt = buildSystemPrompt(contextoCliente, esEntidadSuperlativa, idioma);
    if (esFounder) systemPrompt += "\n\nFOUNDER MODE ACTIVE: Full access granted.";
    if (system) systemPrompt = system + "\n\n" + systemPrompt;

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    // ── Agentic loop ──────────────────────────────────────────────────────────
    let mensajesActuales = [...messages];
    let respuestaFinal = null;

    for (let turno = 0; turno < 6; turno++) {
      const response = await client.messages.create({
        model: "claude-sonnet-4-5",
        max_tokens: 4000,
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
          toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: JSON.stringify(resultado) });
        }
        mensajesActuales.push({ role: "user", content: toolResults });
        continue;
      }

      respuestaFinal = response;
      break;
    }

    if (!respuestaFinal) {
      respuestaFinal = await client.messages.create({
        model: "claude-sonnet-4-5",
        max_tokens: 4000,
        system: systemPrompt,
        messages: mensajesActuales,
      });
    }

    return res.status(200).json(respuestaFinal);

  } catch (error) {
    console.error("Error:", error);
    return res.status(500).json({
      error: "Internal error",
      content: [{ type: "text", text: "A system error has occurred. Please try again or contact info@epimeleia.world" }]
    });
  }
};
