// Diagnostico: que responde Copernicus HOY sobre el poligono de la #23 (90 dias)
const axios = require('axios');
const { config } = require('./config');
const geo = { type: 'Polygon', coordinates: [[[-79.452,-1.45],[-79.4475,-1.4495],[-79.446,-1.4525],[-79.4472,-1.4555],[-79.451,-1.456],[-79.453,-1.453],[-79.452,-1.45]]] };
const ev = `//VERSION=3
function setup(){return{input:[{bands:["B04","B08","SCL","dataMask"]}],output:[{id:"data",bands:1,sampleType:"FLOAT32"},{id:"dataMask",bands:1}]};}
function evaluatePixel(s){var ok=s.dataMask==1&&[4,5,6,7,11].indexOf(s.SCL)>=0;var v=(s.B08-s.B04)/(s.B08+s.B04);return{data:[v],dataMask:[ok?1:0]};}`;
(async () => {
  try {
    const t = await axios.post('https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token',
      new URLSearchParams({ grant_type: 'client_credentials', client_id: config.sentinel.apiUser, client_secret: config.sentinel.apiKey }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15000 });
    console.log('TOKEN OK');
    const desde = new Date(Date.now() - 90 * 864e5).toISOString(), hasta = new Date().toISOString();
    const r = await axios.post('https://sh.dataspace.copernicus.eu/api/v1/statistics', {
      input: { bounds: { geometry: geo, properties: { crs: 'http://www.opengis.net/def/crs/EPSG/0/4326' } },
               data: [{ type: 'sentinel-2-l2a', dataFilter: { mosaickingOrder: 'mostRecent' } }] },
      aggregation: { timeRange: { from: desde, to: hasta }, aggregationInterval: { of: 'P1D' }, evalscript: ev, resx: 0.0001, resy: 0.0001 },
    }, { headers: { Authorization: 'Bearer ' + t.data.access_token, 'Content-Type': 'application/json' }, timeout: 60000, validateStatus: () => true });
    console.log('HTTP', r.status);
    const d = (r.data && r.data.data) || [];
    console.log('PASADAS DEVUELTAS:', d.length);
    if (!d.length) console.log('RESPUESTA:', JSON.stringify(r.data).slice(0, 600));
    for (const it of d) {
      const st = it.outputs && it.outputs.data && it.outputs.data.bands && it.outputs.data.bands.B0 && it.outputs.data.bands.B0.stats;
      const f = (it.interval && it.interval.from || '').slice(0, 10);
      if (it.error) console.log(f, 'ERROR:', JSON.stringify(it.error).slice(0, 200));
      else if (st) console.log(f, 'limpios', (st.sampleCount - st.noDataCount), 'de', st.sampleCount, 'media', st.mean);
      else console.log(f, 'sin stats');
    }
  } catch (e) {
    console.log('FALLO:', e.response ? e.response.status + ' ' + JSON.stringify(e.response.data).slice(0, 400) : e.message);
  }
})();
