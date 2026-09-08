/**
 * Regenera data/vuelos.json consultando Google Flights a través de SerpApi.
 *
 * Los buscadores de vuelos (Google Flights, Skyscanner, Kayak, aerolíneas)
 * no publican un JSON de catálogo como las tiendas de yerba mate, y bloquean
 * el scraping directo. SerpApi hace de intermediario: entrega los mismos
 * resultados que vería un usuario en Google Flights, ya en JSON.
 *
 * Uso:  node scripts/actualizar-vuelos.mjs
 */

import { writeFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
const SALIDA = join(RAIZ, 'data', 'vuelos.json');
const MANUAL = join(RAIZ, 'data', 'manual.json');

const UA = 'vuelos-tracker/1.0 (+https://arenin.uk)';

/* ------------------------------------------------------------------ */

async function pedirJson(url, intentos = 3) {
  let ultimoError;
  for (let n = 1; n <= intentos; n++) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 25000);
      const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: ctrl.signal });
      clearTimeout(t);
      if (!res.ok) {
        // SerpApi (y la mayoría de APIs) mandan el detalle del error en el
        // cuerpo JSON incluso en 4xx/5xx: lo leemos para saber qué pasó
        // en vez de quedarnos solo con el código HTTP.
        let detalle = '';
        try { detalle = JSON.stringify(await res.json()); } catch { /* cuerpo no era JSON */ }
        const err = new Error(`HTTP ${res.status}${detalle ? ' - ' + detalle : ''}`);
        err.status = res.status;
        throw err;
      }
      return await res.json();
    } catch (err) {
      ultimoError = err;
      // Un 4xx es un error del pedido (parámetros mal armados, clave
      // inválida, etc.): reintentar no lo va a arreglar y solo gasta cuota
      // de SerpApi. Solo reintentamos ante fallos transitorios (red, 5xx, 429).
      if (err.status && err.status >= 400 && err.status < 500 && err.status !== 429) throw err;
      // Espera creciente: 3s, 6s. Siempre acaba, nunca da vueltas infinitas.
      if (n < intentos) await new Promise(r => setTimeout(r, 3000 * n));
    }
  }
  throw ultimoError;
}

function formatearFecha(fecha) {
  return fecha.toISOString().slice(0, 10);
}

function sumarDias(fecha, dias) {
  const copia = new Date(fecha);
  copia.setUTCDate(copia.getUTCDate() + dias);
  return copia;
}

// Link de búsqueda "manual" en Google Flights para esa fecha y ruta.
// No hace falta otra llamada a la API: Google Flights entiende consultas
// en lenguaje natural en el parámetro q.
function armarBuscarUrl({ origenNombre, destinoNombre, salida, regreso }) {
  const consulta = `Flights from ${origenNombre} to ${destinoNombre} on ${salida} through ${regreso}`;
  return `https://www.google.com/travel/flights?q=${encodeURIComponent(consulta)}`;
}

function vueloMasBarato(data) {
  const candidatos = [...(data.best_flights || []), ...(data.other_flights || [])];
  if (!candidatos.length) return null;

  let mejor = null;
  for (const c of candidatos) {
    const precio = Number(c.price);
    if (!Number.isFinite(precio) || precio <= 0) continue;
    if (!mejor || precio < mejor.price) mejor = c;
  }
  if (!mejor) return null;

  const tramos = mejor.flights || [];
  const aerolineas = [...new Set(tramos.map(t => t.airline).filter(Boolean))];

  return {
    precio: Number(mejor.price.toFixed(2)),
    aerolinea: aerolineas.join(' / ') || 'Varias',
    escalas: Math.max(0, tramos.length - 1),
    duracionMin: Number(mejor.total_duration) || null
  };
}

// La API de Google Flights de SerpApi pide el viaje de ida y vuelta en DOS
// pasos, pero OJO: las DOS llamadas necesitan outbound_date Y return_date
// (si se omite return_date en el primer paso, tira error "return_date is
// required if type is 1"). El primer paso devuelve un "departure_token" por
// cada opción de ida; repitiendo el mismo pedido con ese token en el
// segundo paso se obtiene el precio del viaje completo ida y vuelta.
function armarUrl({ apiKey, origen, destino, salidaStr, regresoStr, departureToken }) {
  let url = 'https://serpapi.com/search.json'
    + '?engine=google_flights'
    + `&departure_id=${origen}`
    + `&arrival_id=${destino}`
    + `&outbound_date=${salidaStr}`
    + `&return_date=${regresoStr}`
    + '&currency=GBP&hl=es&type=1&sort_by=2'
    + `&api_key=${apiKey}`;
  if (departureToken) url += `&departure_token=${encodeURIComponent(departureToken)}`;
  return url;
}

async function buscarConCodigos({ apiKey, origen, destino, salidaStr, regresoStr }) {
  // Paso 1: búsqueda normal, para conseguir el departure_token de una opción de ida.
  const idaData = await pedirJson(armarUrl({ apiKey, origen, destino, salidaStr, regresoStr }));
  if (idaData.error) throw new Error(`SerpApi (ida): ${idaData.error}`);

  const candidatosIda = [...(idaData.best_flights || []), ...(idaData.other_flights || [])];
  const idaConToken = candidatosIda.find(c => c.departure_token);
  if (!idaConToken) throw new Error('Sin vuelos de ida para esta ventana');

  // Paso 2: mismo pedido + el departure_token del paso 1, que ya devuelve
  // el precio del viaje completo ida y vuelta.
  const vueltaData = await pedirJson(armarUrl({ apiKey, origen, destino, salidaStr, regresoStr, departureToken: idaConToken.departure_token }));
  if (vueltaData.error) throw new Error(`SerpApi (vuelta): ${vueltaData.error}`);

  const mejor = vueloMasBarato(vueltaData);
  if (!mejor) throw new Error('Sin resultados de ida y vuelta para esta ventana');
  return mejor;
}

async function googleFlights({ apiKey, ruta, offsetDias, estadiaDias, hoy }) {
  const salida = sumarDias(hoy, offsetDias);
  const regreso = sumarDias(salida, estadiaDias);
  const salidaStr = formatearFecha(salida);
  const regresoStr = formatearFecha(regreso);

  // Los códigos de área metropolitana (ej. BUE junta EZE+AEP, LON junta
  // LHR+LGW+STN+LTN+LCY) traen más opciones y precios más baratos que un
  // aeropuerto puntual — Google Flights arma sus combinados más baratos
  // mezclando aeropuertos secundarios. Pero a veces SerpApi no devuelve
  // resultados para un código de área en una ventana de fechas puntual; si
  // eso pasa, reintentamos con los aeropuertos principales como respaldo
  // en vez de perder la ventana entera.
  try {
    return {
      salida: salidaStr,
      regreso: regresoStr,
      ...(await buscarConCodigos({ apiKey, origen: ruta.origen, destino: ruta.destino, salidaStr, regresoStr })),
      buscarUrl: armarBuscarUrl({
        origenNombre: ruta.origenNombre,
        destinoNombre: ruta.destinoNombre,
        salida: salidaStr,
        regreso: regresoStr
      })
    };
  } catch (err) {
    console.error(`  Códigos de área (${ruta.origen}/${ruta.destino}) fallaron (${err.message}), reintentando con aeropuertos puntuales (${ruta.origenRespaldo}/${ruta.destinoRespaldo})`);
    return {
      salida: salidaStr,
      regreso: regresoStr,
      ...(await buscarConCodigos({ apiKey, origen: ruta.origenRespaldo, destino: ruta.destinoRespaldo, salidaStr, regresoStr })),
      buscarUrl: armarBuscarUrl({
        origenNombre: ruta.origenNombre,
        destinoNombre: ruta.destinoNombre,
        salida: salidaStr,
        regreso: regresoStr
      })
    };
  }
}

/* --- Montaje final ---------------------------------------------------- */

async function main() {
  const apiKey = process.env.SERPAPI_KEY;
  if (!apiKey) {
    console.error('Falta SERPAPI_KEY. No se puede consultar Google Flights, no se toca vuelos.json.');
    process.exit(1);
  }

  const manual = JSON.parse(await readFile(MANUAL, 'utf8'));
  const { estadiaDias, offsetsDias, ruta } = manual;
  const hoy = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z');

  const items = [];
  const errores = [];

  for (const offsetDias of offsetsDias) {
    try {
      const item = await googleFlights({ apiKey, ruta, offsetDias, estadiaDias, hoy });
      console.log(`Ventana +${offsetDias}d: £${item.precio} (${item.aerolinea}, ${item.escalas} escalas)`);
      items.push(item);
    } catch (err) {
      console.error(`Ventana +${offsetDias}d falló: ${err.message}`);
      errores.push(`+${offsetDias}d`);
    }
  }

  if (!items.length) {
    console.error('Ninguna ventana devolvió resultados. No se toca vuelos.json.');
    process.exit(1);
  }

  const salida = {
    actualizado: new Date().toISOString(),
    fuentesConError: errores,
    ruta: { origen: ruta.origen, destino: ruta.destino },
    estadiaDias,
    items
  };

  await writeFile(SALIDA, JSON.stringify(salida, null, 2) + '\n', 'utf8');
  console.log(`Escritas ${items.length} ventanas en data/vuelos.json`);
}

main().catch(err => { console.error(err); process.exit(1); });
