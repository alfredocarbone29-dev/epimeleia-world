// Diagnostico 4: ¿nuestra cuenta puede bajar una FOTO (Process API) aunque la
// estadistica (Statistical API) venga vacia? Pide una foto color de Mendoza.
// Foto vacia pesa menos de ~2 KB. Foto real pesa decenas de KB.
const axios = require('axios');
const fs = require('fs');
const { config } = require('./config');
const ev = `//VERSION=3
function setup(){return{input:["B02","B03","B04","dataMask"],output:{bands:4}};}
function evaluatePixel(s){return[2.5*s.B04,2.5*s.B03,2.5*s.B02,s.dataMask];}`;
(async () => {
  try {
    const t = await axios.post('https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token',
      new URLSearchParams({ grant_type: 'client_credentials', client_id: config.sentinel.apiUser, client_secret: config.sentinel.apiKey }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15000 });
    const desde = new Date(Date.now() - 30 * 864e5).toISOString(), hasta = new Date().toISOString();
    for (const tipo of ['sentinel-2-l2a', 'sentinel-2-l1c']) {
      const r = await axios.post('https://sh.dataspace.copernicus.eu/api/v1/process', {
        input: { bounds: { bbox: [-68.33, -34.66, -68.30, -34.64], properties: { crs: 'http://www.opengis.net/def/crs/EPSG/0/4326' } },
                 data: [{ type: tipo, dataFilter: { timeRange: { from: desde, to: hasta }, mosaickingOrder: 'leastCC' } }] },
        output: { width: 256, height: 256, responses: [{ identifier: 'default', format: { type: 'image/png' } }] },
        evalscript: ev,
      }, { headers: { Authorization: 'Bearer ' + t.data.access_token, 'Content-Type': 'application/json' },
           responseType: 'arraybuffer', timeout: 60000, validateStatus: () => true });
      const buf = Buffer.from(r.data);
      console.log('==== ' + tipo + ' · HTTP ' + r.status + ' · foto de ' + buf.length + ' bytes');
      if (r.status !== 200) console.log('RESPUESTA:', buf.toString().slice(0, 400));
      else fs.writeFileSync('/tmp/foto-' + tipo + '.png', buf);
    }
  } catch (e) {
    console.log('FALLO:', e.message);
  }
})();
