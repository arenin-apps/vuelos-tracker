/* Vuelos Tracker Buenos Aires-Londres — front-end.
   No hay claves de API aquí: los datos llegan ya preparados desde data/vuelos.json,
   que regenera cada día una acción de GitHub consultando Google Flights vía SerpApi. */
(function () {
  'use strict';

  var DATA_URL = 'data/vuelos.json';
  var HORAS_PARA_CADUCAR = 48;

  var state = {
    items: [],
    actualizado: null,
    soloDirectos: false
  };

  var $ = function (id) { return document.getElementById(id); };

  /* --- Idiomas ---------------------------------------------------------
     El español manda: es lo que está escrito en el HTML y lo que ve
     cualquiera que llegue sin haber elegido nada. */

  var IDIOMA_CLAVE = 'vt_idioma';
  var idioma = 'es';

  var TEXTOS = {
    en: {
      h1: 'Flights Buenos Aires ↔ London',
      lede: 'The cheapest fare found each day for the next 2-3 months, round trip with a 14-day stay.',
      datos: 'Data',
      titulo_tabla: 'Upcoming travel windows',
      sub_tabla: 'Each row is the cheapest fare found for that departure date, with a 14-day stay.',
      solo_directos: 'Direct flights only',
      ordenar_por: 'Sort by',
      orden_fecha: 'Departure date',
      orden_asc: 'Price: low to high',
      orden_desc: 'Price: high to low',
      col_salida: 'Departure',
      col_regreso: 'Return',
      col_precio: 'Price',
      col_aerolinea: 'Airline',
      col_escalas: 'Stops',
      col_duracion: 'Duration',
      vacio_titulo: 'No flights match this filter',
      vacio_texto: 'Try unchecking "Direct flights only".',
      error_titulo: 'Flights could not be loaded',
      aviso: 'Prices are collected once a day from Google Flights and may change at any time. Always check the final price with the airline or agency before buying.',
      boton: 'Español',
      boton_aria: 'Cambiar a español',
      al_dia: 'Up to date',
      desfasado: 'May be out of date',
      sin_fecha: 'No date',
      sin_conexion: 'Offline',
      cargando: 'Checking',
      fecha_desconocida: 'Unknown date',
      reintenta: 'Try again in a few minutes. Technical detail: ',
      ver_vuelo: 'See flight',
      sin_enlace: 'No link',
      directo: 'Direct',
      escala: '{n} stop',
      escalas_pl: '{n} stops',
      vacio_datos: 'The flights file is empty.',
      servidor: 'The server replied '
    },
    es: {
      boton: 'English',
      boton_aria: 'Switch to English',
      al_dia: 'Al día',
      desfasado: 'Pueden estar desfasados',
      sin_fecha: 'Sin fecha',
      sin_conexion: 'Sin conexión',
      cargando: 'Comprobando',
      fecha_desconocida: 'Fecha desconocida',
      reintenta: 'Vuelve a intentarlo en unos minutos. Detalle técnico: ',
      ver_vuelo: 'Ver vuelo',
      sin_enlace: 'Sin enlace',
      directo: 'Directo',
      escala: '{n} escala',
      escalas_pl: '{n} escalas',
      vacio_datos: 'El archivo de vuelos está vacío.',
      servidor: 'El servidor respondió '
    }
  };

  // Los textos fijos en español viven en el HTML, así que los guardamos
  // al arrancar para poder volver a ellos sin recargar la página.
  var ORIGINAL_ES = {};

  function t(clave, valores) {
    var texto = (TEXTOS[idioma] && TEXTOS[idioma][clave]) || ORIGINAL_ES[clave] || clave;
    if (valores) {
      Object.keys(valores).forEach(function (k) {
        texto = texto.replace('{' + k + '}', valores[k]);
      });
    }
    return texto;
  }

  function guardarOriginales() {
    document.querySelectorAll('#vt-app [data-i18n]').forEach(function (el) {
      ORIGINAL_ES[el.dataset.i18n] = el.textContent;
    });
  }

  function aplicarIdioma() {
    document.querySelectorAll('#vt-app [data-i18n]').forEach(function (el) {
      el.textContent = t(el.dataset.i18n);
    });

    var btn = $('vt-lang');
    btn.textContent = t('boton');
    btn.setAttribute('aria-label', t('boton_aria'));
    document.documentElement.lang = idioma;

    pintarEstado();
    aplicar();
  }

  function cambiarIdioma() {
    idioma = idioma === 'es' ? 'en' : 'es';
    try { localStorage.setItem(IDIOMA_CLAVE, idioma); } catch (e) { /* modo privado */ }
    aplicarIdioma();
  }

  /* --- utilidades seguras --------------------------------------------- */

  // Escapa el texto que venga del JSON antes de meterlo en el HTML.
  function esc(valor) {
    return String(valor == null ? '' : valor)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // Solo dejamos pasar http(s): así una URL manipulada no puede ejecutar código.
  function urlSegura(valor) {
    try {
      var u = new URL(valor, window.location.href);
      return (u.protocol === 'https:' || u.protocol === 'http:') ? u.href : '';
    } catch (e) { return ''; }
  }

  function libras(n) { return '£' + Number(n).toFixed(0); }

  function fechaCorta(iso) {
    var f = new Date(iso + 'T00:00:00Z');
    return f.toLocaleDateString(idioma === 'en' ? 'en-GB' : 'es-ES', {
      day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC'
    });
  }

  function duracionTexto(min) {
    if (!min) return '—';
    var h = Math.floor(min / 60);
    var m = min % 60;
    return h + 'h' + (m ? ' ' + m + 'm' : '');
  }

  function escalasTexto(n) {
    if (n === 0) return t('directo');
    return n === 1 ? t('escala', { n: n }) : t('escalas_pl', { n: n });
  }

  /* --- carga de datos -------------------------------------------------- */

  function cargar() {
    fetch(DATA_URL, { cache: 'no-cache' })
      .then(function (r) {
        if (!r.ok) throw new Error(t('servidor') + r.status);
        return r.json();
      })
      .then(function (data) {
        if (!data || !Array.isArray(data.items) || !data.items.length) {
          throw new Error(t('vacio_datos'));
        }
        state.items = data.items.filter(function (i) {
          return i && typeof i.precio === 'number' && i.precio > 0 && i.salida;
        });
        state.actualizado = data.actualizado || null;

        pintarEstado();
        aplicar();
      })
      .catch(function (err) {
        $('vt-error').hidden = false;
        $('vt-error-detail').textContent = t('reintenta') + err.message;
        $('vt-status-badge').textContent = t('sin_conexion');
        $('vt-status-badge').setAttribute('data-state', 'error');
        $('vt-update-text').textContent = '';
      });
  }

  function pintarEstado() {
    var badge = $('vt-status-badge');
    if (!state.actualizado) {
      $('vt-update-text').textContent = t('fecha_desconocida');
      badge.textContent = t('sin_fecha');
      badge.setAttribute('data-state', 'stale');
      return;
    }
    var fecha = new Date(state.actualizado);
    var horas = (Date.now() - fecha.getTime()) / 36e5;
    $('vt-update-text').textContent = fecha.toLocaleString(idioma === 'en' ? 'en-GB' : 'es-ES', {
      day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit'
    });
    if (horas > HORAS_PARA_CADUCAR) {
      badge.textContent = t('desfasado');
      badge.setAttribute('data-state', 'stale');
    } else {
      badge.textContent = t('al_dia');
      badge.setAttribute('data-state', 'fresh');
    }
  }

  /* --- filtros y orden -------------------------------------------------- */

  function filtrar() {
    return state.items.filter(function (i) {
      if (state.soloDirectos && i.escalas !== 0) return false;
      return true;
    });
  }

  function aplicar() {
    var orden = $('vt-sort').value;
    var filas = filtrar().slice();

    if (orden === 'price-asc') filas.sort(function (a, b) { return a.precio - b.precio; });
    else if (orden === 'price-desc') filas.sort(function (a, b) { return b.precio - a.precio; });
    else filas.sort(function (a, b) { return a.salida.localeCompare(b.salida); });

    pintarTabla(filas);
  }

  function pintarTabla(datos) {
    var tbody = $('vt-tbody');
    tbody.innerHTML = '';
    $('vt-empty').hidden = datos.length > 0;

    datos.forEach(function (item) {
      var href = urlSegura(item.buscarUrl);

      var tr = document.createElement('tr');
      tr.innerHTML =
        '<td data-col="fechas"><span class="vt-fecha">' + esc(fechaCorta(item.salida)) + '</span></td>' +
        '<td data-col="fechas"><span class="vt-fecha">' + esc(fechaCorta(item.regreso)) + '</span></td>' +
        '<td class="vt-num" data-col="precio"><span class="vt-price">' + libras(item.precio) + '</span></td>' +
        '<td><span class="vt-tag">' + esc(item.aerolinea) + '</span></td>' +
        '<td class="' + (item.escalas === 0 ? 'vt-escalas--directo' : '') + '">' + esc(escalasTexto(item.escalas)) + '</td>' +
        '<td>' + esc(duracionTexto(item.duracionMin)) + '</td>' +
        '<td data-col="link">' + (href
          ? '<a class="vt-go" href="' + esc(href) + '" target="_blank" rel="noopener noreferrer sponsored">' + t('ver_vuelo') + '</a>'
          : '<span class="vt-note">' + t('sin_enlace') + '</span>') + '</td>';
      tbody.appendChild(tr);
    });
  }

  /* --- eventos ---------------------------------------------------------- */

  function init() {
    guardarOriginales();
    try {
      var guardado = localStorage.getItem(IDIOMA_CLAVE);
      if (guardado === 'en' || guardado === 'es') idioma = guardado;
    } catch (e) { /* modo privado */ }

    $('vt-lang').addEventListener('click', cambiarIdioma);
    if (idioma === 'en') aplicarIdioma();

    $('vt-sort').addEventListener('change', aplicar);
    $('vt-solo-directos').addEventListener('change', function (e) {
      state.soloDirectos = e.target.checked;
      aplicar();
    });

    cargar();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
