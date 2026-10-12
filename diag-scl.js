// Diagnostico 2: que ve Sentinel-2 pixel por pixel (clase SCL), sin filtrar nada.
// Compara Ecuador (#23) con Mendoza (seco). Clases: 4=vegetacion 5=suelo 6=agua
// 7=sin clasificar 8/9=nube 10=cirro 3=sombra de nube 0=sin dato 1=saturado
const axios = require('axios');
const { config } = require('./config');
const zonas = {
  ECUADOR_23: [[[-79.452,-1.45],[-79.4475,-1.4495],[-79.446,-1.4525],[-79.4472,-1.4555],[-79.451,-1.456],[-79.453,-1.453],[-79.452,-1.45]]],
  MENDOZA:    [[[-68.870,-33.050],[-68.864,-33.050],[-68.864,-33.055],[-68.870,-33.055],[-68.870,-33.050]]],
};
const ev = `//VERSION=3
function setup(){return{input:[{bands:["SCL","dataMask"]}],output:[{id:"data",bands:1,sampleType:"FLOAT32"},{id:"dataMask",bands:1}]};}
function evaluatePixel(s){return{data:[s.SCL],dataMask:[s.dataMask]};}`;
(async () => {
  try {
    const t = await axios.post('https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token',
      new URLSearchParams({ grant_type: 'client_credentials', client_id: config.sentinel.apiUser, client_secret: config.sentinel.apiKey }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15000 });
    const desde = new Date(Date.now() - 45 * 864e5).toISOString(), hasta = new Date().toISOString();
    for (const [nombre, coords] of Object.entries(zonas)) {
      const r = await axios.post('https://sh.dataspace.copernicus.eu/api/v1/statistics', {
        input: { bounds: { geometry: { type: 'Polygon', coordinates: coords }, properties: { crs: 'http://www.opengis.net/def/crs/EPSG/0/4326' } },
                 data: [{ type: 'sentinel-2-l2a', dataFilter: { mosaickingOrder: 'mostRecent' } }] },
        aggregation: { timeRange: { from: desde, to: hasta }, aggregationInterval: { of: 'P1D' }, evalscript: ev, resx: 0.0001, resy: 0.0001 },
        calculations: { default: { histograms: { default: { binWidth: 1, lowEdge: 0, highEdge: 12 } } } },
      }, { headers: { Authorization: 'Bearer ' + t.data.access_token, 'Content-Type': 'application/json' }, timeout: 60000, validateStatus: () => true });
      console.log('==== ' + nombre + ' · HTTP ' + r.status);
      const d = (r.data && r.data.data) || [];
      if (!d.length) console.log('RESPUESTA:', JSON.stringify(r.data).slice(0, 500));
      for (const it of d) {
        const b = it.outputs && it.outputs.data && it.outputs.data.bands && it.outputs.data.bands.B0;
        const f = (it.interval && it.interval.from || '').slice(0, 10);
        if (it.error) { console.log(f, 'ERROR', JSON.stringify(it.error).slice(0, 200)); continue; }
        if (!b) { console.log(f, 'sin stats'); continue; }
        const h = (b.histogram && b.histogram.bins || []).map(x => Math.round(x.lowEdge) + ':' + x.count).filter(x => !x.endsWith(':0')).join(' ');
        console.log(f, 'pix', b.stats.sampleCount, 'sinDato', b.stats.noDataCount, 'SCL media', b.stats.mean, '| clases', h);
      }
    }
  } catch (e) {
    console.log('FALLO:', e.response ? e.response.status + ' ' + JSON.stringify(e.response.data).slice(0, 400) : e.message);
  }
})();
