# Vuelos Tracker — Buenos Aires ↔ Londres

Página estática que muestra el mejor precio de vuelo encontrado cada día para varias ventanas de fecha en los próximos 2-3 meses (ida y vuelta, 14 días de estadía). Los precios se regeneran solos una vez al día con una acción de GitHub, consultando Google Flights a través de SerpApi.

## Qué hay en cada archivo

| Archivo | Para qué sirve |
|---|---|
| `index.html` | La página. No contiene datos ni claves. |
| `assets/styles.css` | Estilos propios. Todo cuelga de `.vt` para no chocar con el resto de arenin.uk. |
| `assets/app.js` | Filtros, orden y pintado de la tabla. Lee `data/vuelos.json`. |
| `data/vuelos.json` | Generado automáticamente. No lo edites a mano. |
| `data/manual.json` | Lo que sí editás vos: ruta, duración de estadía y ventanas de fecha a trackear. |
| `scripts/actualizar-vuelos.mjs` | El robot que consulta SerpApi y reescribe `vuelos.json`. |
| `.github/workflows/actualizar-vuelos.yml` | El cron diario (02:00 UTC). |

## Por qué SerpApi y no scraping directo

Google Flights, Skyscanner, Kayak y las webs de aerolíneas son buscadores dinámicos con protección anti-scraping fuerte — no hay un JSON de catálogo público como el de las tiendas de yerba mate. SerpApi (`engine=google_flights`) entrega los mismos resultados que vería un usuario en Google Flights, ya en JSON.

Se usa `departure_id=EZE` (Ezeiza) y `arrival_id=LHR` (Heathrow), los aeropuertos principales de cada ciudad. Se probó primero con los códigos de ciudad-metro (`BUE`/`LON`, que agrupan todos los aeropuertos de cada ciudad), pero para esta ruta SerpApi devolvía "hasn't returned any results for this query" — con los aeropuertos puntuales sí trae resultados.

## Probarlo en local

Hace falta un servidor, porque `fetch` no funciona abriendo el archivo directamente:

```
python3 -m http.server 8000
# abre http://localhost:8000
```

Para lanzar el actualizador a mano:

```
SERPAPI_KEY=tu-clave node scripts/actualizar-vuelos.mjs
```

## Secretos necesarios (Settings → Secrets and variables → Actions)

| Secreto | Para qué | Si falta |
|---|---|---|
| `SERPAPI_KEY` | serpapi.com — consulta a Google Flights | El workflow falla, no se toca `vuelos.json` |

Usa el mismo `SERPAPI_KEY` que ya está configurado en `yerba-mate-tracker`.

## Presupuesto de cuota

El free tier de SerpApi es 250 búsquedas/mes. La búsqueda de ida y vuelta necesita **2 llamadas por ventana** (una para conseguir el `departure_token` de la ida, otra para el viaje completo con la vuelta — ver comentario en `googleFlights()`). Con 3 ventanas de fecha eso son 6 búsquedas al día = ~180/mes. Sumado a las ~60/mes que ya usa `yerba-mate-tracker` para Amazon, el total mensual queda en ~240, cerca del límite pero sin pasarse.

## Ajustes que vas a querer tocar

- **Ventanas de fecha y duración de estadía**: `data/manual.json` → `offsetsDias` y `estadiaDias`.
- **Hora de actualización**: el cron del workflow.

## Aviso

Los precios se recogen de Google Flights una vez al día y pueden cambiar en cualquier momento. La página lo indica al usuario y enlaza siempre a una búsqueda en Google Flights para esa fecha.
