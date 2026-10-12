// Diagnostico 5: la estadistica vacia, ¿es por como le pedimos la resolucion?
// Misma consulta que el sistema, sobre la #23, probando 3 formas de pedir la grilla.
const axios = require('axios');
const { config } = require('./config');
const geo = { type: 'Polygon', coordinates: [[[-79.452,-1.45],[-79.4475,-1.4495],[-79.446,-1.4525],[-79.4472,-1.4555],[-79.451,-1.456],[-79.453,-1.453],[-79.452,-1.45]]] };
const ev = `//VERSION=3
function setup(){return{input:[{bands:["B04","B08","SCL","dataMask"]}],output:[{id:"data",bands:1,sampleType:"FLOAT32"},{id:"dataMask",bands:1}]};}
function evaluatePixel(s){var ok=s.dataMask==1&&[4,5,6,7,11].indexOf(s.SCL)>=0;return{data:[(s.B08-s.B04)/(s.B08+s.B04)],dataMask:[ok?1:0]};}`;
const variantes = {
  'A resx grados (actual)': { resx: 0.0001, resy: 0.0001 },
  'B width/height':         { width: 70, height: 70 },
  'C resx metros':          { resx: 10, resy: 10 },
};
(async () => {
  try {
    const t = await axios.post('https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token',
      new URLSearchParams({ grant_type: 'client_credentials', client_id: config.sentinel.apiUser, client_secret: config.sentinel.apiKey }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15000 });
    const desde = '2026-09-10T00:00:00Z', hasta = '2026-09-13T00:00:00Z';   // incluye el 11/9 que ayer dio 77 %
    for (const [nombre, res] of Object.entries(variantes)) {
      const r = await axios.post('https://sh.dataspace.copernicus.eu/api/v1/statistics', {
        input: { bounds: { geometry: geo, properties: { crs: 'http://www.opengis.net/def/crs/EPSG/0/4326' } },
                 data: [{ type: 'sentinel-2-l2a', dataFilter: { mosaickingOrder: 'mostRecent' } }] },
        aggregation: Object.assign({ timeRange: { from: desde, to: hasta }, aggregationInterval: { of: 'P1D' }, evalscript: ev }, res),
      }, { headers: { Authorization: 'Bearer ' + t.data.access_token, 'Content-Type': 'application/json' }, timeout: 60000, validateStatus: () => true });
      const d = (r.data && r.data.data) || [];
      let linea = '';
      for (const it of d) {
        const st = it.outputs && it.outputs.data && it.outputs.data.bands && it.outputs.data.bands.B0 && it.outputs.data.bands.B0.stats;
        if (st) linea += ' ' + (it.interval.from || '').slice(0, 10) + ': limpios ' + (st.sampleCount - st.noDataCount) + '/' + st.sampleCount + ' NDVI ' + st.mean;
        else if (it.error) linea += ' ERROR ' + JSON.stringify(it.error).slice(0, 120);
      }
      console.log('==== ' + nombre + ' · HTTP ' + r.status + (d.length ? linea : ' · ' + JSON.stringify(r.data).slice(0, 300)));
    }
  } catch (e) {
    console.log('FALLO:', e.response ? e.response.status + ' ' + JSON.stringify(e.response.data).slice(0, 300) : e.message);
  }
})();
