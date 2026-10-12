// Diagnostico 3: ¿el problema es solo de Sentinel-2 L2A en Copernicus?
// Mendoza, ultimos 20 dias, cuenta pixeles CON DATO en L2A y en L1C.
const axios = require('axios');
const { config } = require('./config');
const geo = { type: 'Polygon', coordinates: [[[-68.870,-33.050],[-68.864,-33.050],[-68.864,-33.055],[-68.870,-33.055],[-68.870,-33.050]]] };
const ev = (b) => `//VERSION=3
function setup(){return{input:[{bands:["${b}","dataMask"]}],output:[{id:"data",bands:1,sampleType:"FLOAT32"},{id:"dataMask",bands:1}]};}
function evaluatePixel(s){return{data:[s.${b}],dataMask:[s.dataMask]};}`;
(async () => {
  try {
    const t = await axios.post('https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token',
      new URLSearchParams({ grant_type: 'client_credentials', client_id: config.sentinel.apiUser, client_secret: config.sentinel.apiKey }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15000 });
    const desde = new Date(Date.now() - 20 * 864e5).toISOString(), hasta = new Date().toISOString();
    for (const tipo of ['sentinel-2-l2a', 'sentinel-2-l1c']) {
      const r = await axios.post('https://sh.dataspace.copernicus.eu/api/v1/statistics', {
        input: { bounds: { geometry: geo, properties: { crs: 'http://www.opengis.net/def/crs/EPSG/0/4326' } },
                 data: [{ type: tipo }] },
        aggregation: { timeRange: { from: desde, to: hasta }, aggregationInterval: { of: 'P1D' }, evalscript: ev('B04'), resx: 0.0001, resy: 0.0001 },
      }, { headers: { Authorization: 'Bearer ' + t.data.access_token, 'Content-Type': 'application/json' }, timeout: 60000, validateStatus: () => true });
      console.log('==== ' + tipo + ' · HTTP ' + r.status);
      const d = (r.data && r.data.data) || [];
      if (!d.length) console.log('RESPUESTA:', JSON.stringify(r.data).slice(0, 400));
      for (const it of d) {
        const st = it.outputs && it.outputs.data && it.outputs.data.bands && it.outputs.data.bands.B0 && it.outputs.data.bands.B0.stats;
        const f = (it.interval && it.interval.from || '').slice(0, 10);
        if (it.error) console.log(f, 'ERROR', JSON.stringify(it.error).slice(0, 200));
        else if (st) console.log(f, 'con dato', st.sampleCount - st.noDataCount, 'de', st.sampleCount, 'B04 media', st.mean);
        else console.log(f, 'sin stats');
      }
    }
  } catch (e) {
    console.log('FALLO:', e.response ? e.response.status + ' ' + JSON.stringify(e.response.data).slice(0, 400) : e.message);
  }
})();
