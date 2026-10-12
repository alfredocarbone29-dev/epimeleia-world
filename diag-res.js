// Diagnostico 6: ¿la estadistica sale vacia segun el RANGO DE FECHAS que pedimos?
const axios = require('axios');
const { config } = require('./config');
const geo = { type: 'Polygon', coordinates: [[[-79.452,-1.45],[-79.4475,-1.4495],[-79.446,-1.4525],[-79.4472,-1.4555],[-79.451,-1.456],[-79.453,-1.453],[-79.452,-1.45]]] };
const ev = `//VERSION=3
function setup(){return{input:[{bands:["B04","B08","SCL","dataMask"]}],output:[{id:"data",bands:1,sampleType:"FLOAT32"},{id:"dataMask",bands:1}]};}
function evaluatePixel(s){var ok=s.dataMask==1&&[4,5,6,7,11].indexOf(s.SCL)>=0;return{data:[(s.B08-s.B04)/(s.B08+s.B04)],dataMask:[ok?1:0]};}`;
const D = 864e5, ahora = Date.now(), hoy0 = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z').getTime();
const variantes = {
  '1 · 90 dias hasta AHORA (como el sistema)': [ahora - 90 * D, ahora],
  '2 · 90 dias hasta HOY 00:00':               [hoy0 - 90 * D, hoy0],
  '3 · 90 dias hasta hace 2 dias':             [ahora - 92 * D, ahora - 2 * D],
  '4 · 35 dias desde el 1/9 al 6/10':          [Date.parse('2026-09-01T00:00:00Z'), Date.parse('2026-10-06T00:00:00Z')],
};
(async () => {
  try {
    const t = await axios.post('https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token',
      new URLSearchParams({ grant_type: 'client_credentials', client_id: config.sentinel.apiUser, client_secret: config.sentinel.apiKey }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15000 });
    for (const [nombre, rango] of Object.entries(variantes)) {
      const desde = new Date(rango[0]).toISOString(), hasta = new Date(rango[1]).toISOString();
      const r = await axios.post('https://sh.dataspace.copernicus.eu/api/v1/statistics', {
        input: { bounds: { geometry: geo, properties: { crs: 'http://www.opengis.net/def/crs/EPSG/0/4326' } },
                 data: [{ type: 'sentinel-2-l2a', dataFilter: { mosaickingOrder: 'mostRecent' } }] },
        aggregation: { timeRange: { from: desde, to: hasta }, aggregationInterval: { of: 'P1D' }, evalscript: ev, resx: 0.0001, resy: 0.0001 },
      }, { headers: { Authorization: 'Bearer ' + t.data.access_token, 'Content-Type': 'application/json' }, timeout: 60000, validateStatus: () => true });
      const d = (r.data && r.data.data) || [];
      let linea = '', conDato = 0, mejor = null;
      for (const it of d) {
        const st = it.outputs && it.outputs.data && it.outputs.data.bands && it.outputs.data.bands.B0 && it.outputs.data.bands.B0.stats;
        if (st) { const l = st.sampleCount - st.noDataCount; if (l > 0) { conDato++; if (!mejor || l > mejor.l) mejor = { l, f: (it.interval.from || '').slice(0, 10) }; } }
        else if (it.error) linea = ' ERROR ' + JSON.stringify(it.error).slice(0, 120);
      }
      console.log('==== ' + nombre + ' · HTTP ' + r.status + ' · pasadas ' + d.length + ' · con dato ' + conDato +
        (mejor ? ' · mejor ' + mejor.f + ' (' + mejor.l + ' limpios)' : '') + linea + (d.length ? '' : ' · ' + JSON.stringify(r.data).slice(0, 300)));
    }
  } catch (e) {
    console.log('FALLO:', e.response ? e.response.status + ' ' + JSON.stringify(e.response.data).slice(0, 300) : e.message);
  }
})();
