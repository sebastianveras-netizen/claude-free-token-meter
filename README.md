# claude-free-token-meter

Extensión de navegador (Chrome, Edge y Brave, Manifest V3) que **estima**, de forma 100 % local, cuánto contexto llevas acumulado en una conversación de [claude.ai](https://claude.ai), cuánto saldo aproximado te queda en la ventana gratuita y qué puedes hacer para gastar menos.

> **Aviso importante.** Esta extensión es un proyecto independiente y no está afiliada a Anthropic. No conoce los tokens reales que consume Claude, ni el límite real de tu cuenta, ni el contexto interno de Claude, ni el tamaño real de tus Proyectos. **Toda cifra que muestra es una estimación**, expresada como aproximación o como rango probable.

---

## Índice

1. [Descripción](#descripción)
2. [Arquitectura](#arquitectura)
3. [Instalación](#instalación)
4. [Configuración](#configuración)
5. [Calibración](#calibración)
6. [Funcionamiento](#funcionamiento)
7. [Modelo matemático](#modelo-matemático)
8. [Decisiones de diseño y correcciones](#decisiones-de-diseño-y-correcciones)
9. [Limitaciones](#limitaciones)
10. [Privacidad](#privacidad)
11. [Seguridad y Manifest V3](#seguridad-y-manifest-v3)
12. [Rendimiento](#rendimiento)
13. [Ahorro de tokens](#ahorro-de-tokens)
14. [¿Por qué los resultados son aproximados?](#por-qué-los-resultados-son-aproximados)
15. [¿Cómo reducir el consumo de contexto?](#cómo-reducir-el-consumo-de-contexto)
16. [Desarrollo y contribuciones](#desarrollo-y-contribuciones)

---

## Descripción

Claude vuelve a leer **toda** la conversación en cada mensaje que envías. Por eso el coste de un mensaje no depende solo de lo que escribes, sino de todo lo que ya está en el contexto: mensajes anteriores, archivos adjuntos, imágenes, artefactos y el material del Proyecto. Eso es el *efecto bola de nieve*: cada mensaje cuesta más que el anterior.

`claude-free-token-meter` dibuja un widget flotante sobre claude.ai que:

- Estima el **tamaño del contexto** y lo desglosa por fuente (mensajes, documentos, imágenes, artefactos, Proyecto).
- Estima el **coste del próximo mensaje** si lo envías ahora (contexto + borrador).
- Estima el **consumo acumulado** de la ventana global de 5 horas y el **saldo restante**, con un rango probable que se estrecha a medida que calibras.
- Muestra una **salud del contexto** de 0 a 100 y una **precisión estimada** de sus propias cifras.
- Estima cuántos **mensajes similares** te quedan.
- Analiza tu contexto y te propone **recomendaciones de ahorro** ordenadas por impacto, y lleva un **historial de ahorro**.

Todo el cálculo se hace en tu navegador. No hay servidores, ni APIs externas, ni telemetría.

---

## Arquitectura

### Archivos

```
claude-free-token-meter/
├── manifest.json   Manifest V3. Permiso "storage" y host https://claude.ai/*
├── content.js      Toda la lógica (sin dependencias, sin build)
├── styles.css      Estilos del widget (prefijo cftm-, colgando de #cftm-root)
├── LICENSE         Licencia MIT
└── README.md
```

No hay *service worker*, ni página de fondo, ni popup. El `content.js` es el único código en ejecución y solo corre en `https://claude.ai/*`.

### Capas lógicas dentro de `content.js`

| Capa | Responsabilidad |
|---|---|
| Constantes y configuración | Fórmulas, umbrales, claves de almacenamiento. |
| Selectores | Localización de mensajes, compositor, adjuntos, imágenes y artefactos. Se apoya en `data-testid`, roles y `aria-*` antes que en clases CSS, porque las clases de claude.ai cambian a menudo. |
| Context Sources | Cinco fuentes independientes con un contrato común (ver abajo). |
| Agregación | Suma, porcentajes, principal consumidor, coste del próximo mensaje. |
| Estado global | Ventana de 5 h, consumo, envíos, calibraciones y ahorro en `chrome.storage.local`, sincronizados entre pestañas con `chrome.storage.onChanged`. |
| Registro de consumo | Detección de acciones del usuario (Enter, botón enviar, Retry, Regenerate, Continue, Rewrite). Nunca desde el `MutationObserver`. |
| Calibración, saldo y precisión | Presupuesto efectivo, rango probable, confianza y `precisionScore`. |
| Analizador de ahorro | Recomendaciones dinámicas y modo ultra ahorro. |
| Interfaz | Widget `#cftm-root`: arrastrable, colapsable, compacto o expandido, tema claro u oscuro. |
| Ciclo de vida | Observers, temporizadores y listeners; limpieza completa en `beforeunload` y `pagehide`. |

### Contrato de Context Sources

Cada fuente devuelve exactamente:

```js
{
  source: "mensajes" | "documentos" | "imagenes" | "artefactos" | "proyecto",
  estimatedTokens: number,
  confidence: "alta" | "media" | "baja" | "muy_baja"
}
```

Esta uniformidad permite añadir fuentes nuevas sin tocar la agregación.

---

## Instalación

La extensión no está publicada en ninguna tienda. Se instala como extensión descomprimida.

1. Descarga o clona esta carpeta. Debe contener `manifest.json`, `content.js`, `styles.css` y `README.md` en el mismo nivel.
2. Abre la página de extensiones:
   - Chrome: `chrome://extensions`
   - Edge: `edge://extensions`
   - Brave: `brave://extensions`
3. Activa el **Modo de desarrollador**.
4. Pulsa **Cargar descomprimida** y selecciona la carpeta `claude-free-token-meter`.
5. Abre o recarga [claude.ai](https://claude.ai). El widget aparece abajo a la derecha.

Si actualizas los archivos, pulsa el botón de recarga de la extensión en la misma página y recarga claude.ai.

---

## Configuración

Todo se configura desde el widget (modo expandido). Los valores se guardan en `chrome.storage.local`.

| Ajuste | Valor inicial | Descripción |
|---|---|---|
| Presupuesto gratuito | 65 000 | Tu mejor suposición del presupuesto por ventana, en tokens estimados. Es solo el punto de partida: la calibración lo corrige. |
| Tokens estimados del Proyecto | 5 000 | Tamaño que supones para el material del Proyecto. Claude no expone el valor real. |
| Contexto del Proyecto | Automático | *Automático* lo incluye solo si hay indicios visibles de Proyecto. *Siempre* lo incluye. *Nunca* lo excluye. |
| Tema | Automático | Automático, claro u oscuro. |
| Modo | Compacto | Compacto o expandido. |

Además puedes **arrastrar** el widget, **colapsarlo** a un botón flotante y **reiniciar la ventana** manualmente.

---

## Calibración

El presupuesto real de tu cuenta es desconocido y puede variar. La calibración es la forma de acercarte a él.

1. Usa Claude con normalidad.
2. Cuando Claude te bloquee por límite de uso, pulsa **Claude me bloqueó aquí**.
3. La extensión guarda `{ timestamp, consumoEstimado }`, donde `consumoEstimado` es el consumo acumulado estimado de la ventana en ese momento.
4. Se conservan como máximo **25 registros**; al llegar a 26 se descarta el más antiguo.
5. El presupuesto efectivo pasa a ser un **promedio ponderado** en el que las calibraciones recientes pesan más (ver [modelo matemático](#9-presupuesto-efectivo-y-calibración)).

La confianza de la calibración se muestra así:

| Calibraciones | Confianza |
|---|---|
| 0 a 2 | Baja |
| 3 a 10 | Media |
| 11 o más | Alta |

Ejemplo: `Confianza: Alta (12 calibraciones)`.

Consejos:

- Calibra solo cuando el bloqueo sea por el límite de la ventana de 5 horas, no por otros límites.
- Si el consumo estimado en ese momento es muy bajo (menos de 500 tokens), la extensión rechaza la calibración, porque casi seguro hubo otra causa de bloqueo.
- Si quieres empezar de cero, borra los datos de la extensión desde la página de extensiones del navegador.

---

## Funcionamiento

### Qué se registra como consumo

El consumo se registra **solo** cuando hay una acción explícita del usuario:

- Envío normal.
- Enter sin Shift en el compositor.
- Botón de enviar.
- Retry.
- Regenerate.
- Continue.
- Rewrite.

**Nunca** se registra desde el `MutationObserver`. El observer solo recalcula el contexto para mostrarlo.

Para evitar duplicados hay un *cooldown* de **800 ms** entre registros. Además:

- Un Enter solo cuenta si el compositor tiene texto o adjuntos y no hay una composición IME en curso.
- El envío por Enter o por botón se **confirma** unos instantes después comprobando que el compositor se vació. Si no se vació, no se registra nada.

### Ventana global de 5 horas

- Dura **18 000 000 ms** (5 h) y es **global**: no depende del chat.
- Arranca con el **primer envío registrado**. Hasta entonces se muestra «Ventana sin iniciar».
- Al cumplirse las 5 horas se **reinicia automáticamente** (consumo a 0). La siguiente ventana arranca con el siguiente envío.
- Puedes **reiniciarla manualmente**. El reinicio manual también deja la ventana sin iniciar.
- Se sincroniza entre todas las pestañas de claude.ai mediante `chrome.storage.onChanged`. Las escrituras concurrentes se serializan con la API Web Locks cuando está disponible.
- Cambiar de chat **recalcula el contexto, pero no reinicia la ventana**.

### Detección de cambio de chat (SPA)

claude.ai es una SPA de React. No basta con escuchar `history.pushState`, porque una extensión no ve las llamadas de la página en su mundo aislado. Se combinan cuatro mecanismos:

1. Evento `popstate`.
2. Comparación de la URL en cada ciclo del observer.
3. `MutationObserver` sobre el documento.
4. Verificación secundaria cada **2000 ms**.

Al detectar un cambio de chat se descartan las cachés del chat anterior y se recalcula el contexto.

---

## Modelo matemático

Todas las constantes son aproximaciones y están agrupadas al principio de `content.js` para poder ajustarlas.

### 1. Mensajes

Para cada mensaje (del usuario o de Claude):

1. Se clona el nodo.
2. Se eliminan del clon los elementos que no son contenido (botones, iconos SVG, estilos, elementos ocultos).
3. Se extraen los bloques `<pre>` y se suman sus caracteres.
4. Se extraen los `<code>` que quedaron fuera de `<pre>` (código en línea) y se suman sus caracteres.
5. Se eliminan esos nodos del clon.
6. Los caracteres restantes son texto.

Esto evita el doble conteo de `<pre><code>`, porque el `<code>` de dentro de un `<pre>` ya se contó con el `<pre>`.

```
tokensTexto   = caracteresTexto / 3.2
tokensCodigo  = caracteresCodigo / 2.8
tokensMensaje = round(tokensTexto + tokensCodigo)
tokensMensajes = Σ tokensMensaje
```

Confianza: **alta**.

### 2. Documentos

Se detectan PDF, DOCX, XLSX, CSV, TXT, JSON, XML, ZIP y código fuente con una detección de seis niveles:

1. Tarjetas visibles.
2. Botones asociados.
3. `aria-label`.
4. `title`.
5. Texto descriptivo.
6. Nombre y extensión.

La **deduplicación es estricta**: cada archivo se identifica por la clave `nombre normalizado + tamaño + tipo`. Un mismo archivo que aparece en el compositor y luego en el mensaje enviado, o en varios de los niveles anteriores, se cuenta una sola vez.

**Con tamaño visible** (1 KB = 1024 bytes):

```
tokensBase      = (KB × caracteresUtilesPorKB[tipo]) / 3.2
tokensDocumento = round(tokensBase × multiplicador[tipo])
```

| Tipo | Caracteres útiles por KB | Multiplicador | Tokens aprox. por KB |
|---|---|---|---|
| TXT | 1024 | 1.00 | 320 |
| XML | 1024 | 1.10 | 352 |
| JSON | 1024 | 1.10 | 352 |
| Código | 1024 | 1.15 | 368 |
| CSV | 1024 | 1.20 | 384 |
| DOCX | 250 | 1.25 | 98 |
| PDF | 250 | 1.30 | 102 |
| XLSX | 250 | 1.35 | 105 |
| ZIP | 250 | 1.50 | 117 |

**Sin tamaño visible** se usa un valor fijo por tipo:

| Tipo | Tokens |
|---|---|
| PDF | 2500 |
| DOCX | 2000 |
| XLSX | 2500 |
| CSV | 2200 |
| JSON | 1800 |
| Código | 1800 |
| ZIP | 3500 |
| TXT | 1500 |
| XML | 1800 |
| Tipo desconocido | 1500 |

Cada documento se limita a un máximo de **200 000 tokens** estimados. Si un tipo no se reconoce pero hay tamaño, se usan los parámetros de los formatos contenedor (250 caracteres útiles por KB y multiplicador 1.25).

Confianza: **media** si existe tamaño, **baja** si no. Si hay varios documentos, la confianza de la fuente es **baja** cuando más de la mitad de sus tokens proviene de archivos sin tamaño visible.

### 3. Imágenes

Solo se cuentan imágenes **adjuntas**. Se ignoran avatares, logotipos e iconos de la interfaz.

Clasificación por el lado mayor de la imagen (dimensiones naturales; si no están disponibles, las mostradas):

| Tamaño | Lado mayor | Tokens |
|---|---|---|
| Pequeña | hasta 512 px | 500 |
| Mediana | hasta 1280 px | 1000 |
| Grande | más de 1280 px | 2000 |

Si no se pueden medir, se asume mediana. Confianza: **muy baja**. Las imágenes son la fuente menos precisa de la estimación y el widget lo indica.

### 4. Artefactos

Se detectan artefactos de código, Markdown, HTML y documentos generados por Claude.

- Contenido visible: se estima con el motor de mensajes (texto y código). Confianza **alta**.
- Contenido colapsado: **1000 tokens** por artefacto. Confianza **baja**.

### 5. Proyecto

```
tokensProyecto = tokensProyectoEstimados   (valor inicial 5000, editable)
```

Se incluye según el modo elegido (automático, siempre o nunca). Confianza: **muy baja**. El widget advierte de que Claude no expone públicamente el tamaño real del contexto de los Proyectos.

### 6. Contexto total

```
tokensContextoTotal =
    tokensMensajes + tokensAdjuntos + tokensImagenes
  + tokensArtefactos + tokensProyecto
```

El widget muestra el desglose por fuente, el porcentaje de cada una y el **principal consumidor**.

### 7. Efecto bola de nieve

```
costoProximoMensaje = tokensContextoTotal + tokensBorrador
```

`tokensBorrador` se calcula sobre el texto del compositor con la misma fórmula de mensajes. Los adjuntos que aún están en el compositor ya forman parte del contexto total, así que no se suman dos veces. Se actualiza en tiempo real y se muestra como:

> Costo estimado si envías ahora: ≈ X

### 8. Consumo de un envío

Cada vez que se registra una acción:

| Acción | Consumo estimado |
|---|---|
| Envío normal, Enter, botón enviar | `tokensContextoTotal + tokensBorrador` (medidos justo antes de enviar) |
| Retry, Regenerate, Rewrite | `tokensContextoTotal − tokensUltimaRespuesta` (la respuesta anterior se descarta) |
| Continue | `tokensContextoTotal` |

La respuesta que genera Claude **no se suma aparte**: se contará en el siguiente envío, porque pasará a formar parte del contexto. Así no hay doble conteo.

```
consumoVentana = Σ consumo de cada envío registrado dentro de la ventana
```

### 9. Presupuesto efectivo y calibración

Sea `n` el número de calibraciones y `c₀ … c₍ₙ₋₁₎` sus consumos estimados, con `c₀` la más reciente.

```
peso_i       = 0.85 ^ i                       (i = 0 la más reciente)
calibrado    = Σ(peso_i × c_i) / Σ(peso_i)
λ            = n / (n + 2)                    (0 si n = 0)
presupuestoEfectivo = λ × calibrado + (1 − λ) × presupuestoManual
```

Con `n = 0` manda el presupuesto manual. Con `n = 10`, `λ ≈ 0.83`. El presupuesto efectivo nunca baja de 1000 para evitar divisiones por cero.

### 10. Saldo restante y rango probable

```
saldoRestante = max(0, presupuestoEfectivo − consumoVentana)
```

La amplitud relativa del rango depende de cuántas calibraciones hay, de lo dispersas que son y de cuánto del contexto proviene de fuentes poco fiables:

```
anchoBase   = 0.50 / √(1 + n)
cv          = desviación ponderada de las calibraciones / calibrado   (0 si n < 2, máximo 1)
fraccionIncierta = Σ tokens_fuente × pesoConfianza / tokensContextoTotal
              con pesoConfianza: alta 0 · media 0.25 · baja 0.60 · muy_baja 1.00
ancho       = clamp( anchoBase × (1 + cv) + 0.25 × fraccionIncierta , 0.05 , 0.85 )

Mínimo = max(0, presupuestoEfectivo × (1 − ancho) − consumoVentana)
Máximo = max(0, presupuestoEfectivo × (1 + ancho) − consumoVentana)
```

Con más calibraciones, `anchoBase` baja, así que el rango se estrecha. El widget lo muestra como:

> ≈ X tokens restantes · Rango probable: mínimo X, máximo Y

### 11. Confianza de la calibración

Según el número de calibraciones: 0 a 2 baja, 3 a 10 media, 11 o más alta.

### 12. Precisión estimada

```
fracTam      = documentosConTamaño / documentos      (1 si no hay documentos)
precisionScore = clamp( 30
                       + min(40, 4 × n)
                       + 20 × fracTam
                       − min(15, 3 × imagenes)
                       − (hayProyecto ? 12 : 0)
                       − min(10, 2 × documentosSinTamaño) , 5 , 95 )
```

Es un porcentaje de 0 a 100 que **nunca supera el 95 %**, porque ninguna estimación local puede ser exacta. Ejemplo: `Precisión estimada: 81 %`.

### 13. Salud del contexto

```
ratio = tokensContextoTotal / presupuestoEfectivo

P1 (carga)       = min(55, 110 × ratio)
P2 (longitud)    = min(20, max(0, turnosUsuario − 6))
P3 (dominancia)  = si total ≥ 3000 y cuotaPrincipal > 0.60:
                     min(15, (cuotaPrincipal − 0.60) × 37.5), si no 0
P4 (adjuntos)    = min(10, 5 × adjuntosConMasDe10000Tokens)

contextHealthScore = clamp( round(100 − P1 − P2 − P3 − P4) , 0 , 100 )
```

| Puntuación | Estado |
|---|---|
| 80 a 100 | Excelente |
| 60 a 79 | Bueno |
| 40 a 59 | Pesado |
| 0 a 39 | Crítico |

Se muestra como `Salud del contexto: 83/100`.

### 14. Mensajes restantes

Se calcula con el promedio de los **últimos 10 envíos** registrados:

```
promedio = media de los últimos 10 consumos (si no hay envíos, no se muestra)
mensajesSimilares = floor(saldoRestante / promedio)       (solo si promedio > 0)
```

Como cada mensaje es más caro que el anterior, se muestra además una cifra con crecimiento de contexto. Si `C` es el costo del próximo mensaje, `Δ` el aumento medio entre envíos consecutivos (mínimo 0) y `S` el saldo:

```
Σ_{k=0}^{m−1} (C + k·Δ) ≤ S
m = floor( ( −(C − Δ/2) + √((C − Δ/2)² + 2·Δ·S) ) / Δ )      si Δ > 0
m = floor( S / C )                                           si Δ = 0
```

Se muestra como `≈ X mensajes similares restantes` y, debajo, `≈ Y con el contexto creciendo`. Todos los casos con divisor cero se protegen y muestran un guion.

### 15. Ahorro histórico

```
tokensAhorradosAcumulados
```

Se incrementa por tres vías, siempre con estimaciones:

- **Chat nuevo.** Al abrir un chat nuevo tras un chat con al menos 3000 tokens de contexto, se anota como ahorro pendiente el contexto del chat anterior. Se acredita cuando se registra el **primer envío** del chat nuevo, no antes, porque solo entonces se evita realmente el coste.
- **Documentos dominantes eliminados.** Si desaparece del compositor un documento grande antes de enviar, su estimación se anota como ahorro pendiente.
- **Reducción significativa del contexto.** Se mide sobre mensajes, documentos e imágenes (los artefactos y el Proyecto cambian de estimación al abrir paneles o editar ajustes, y no son reducciones reales). Si ese contexto baja al menos un 15 % y al menos 2000 tokens respecto al máximo reciente del mismo chat, y la bajada se mantiene en dos ciclos consecutivos y al menos 1,5 s, se anota la diferencia. No se evalúa durante los primeros 2,5 s de un chat, mientras la página termina de cargar.

El ahorro pendiente se acredita en el siguiente envío registrado. Los dos últimos casos comparten un único mecanismo de referencia para que no se cuenten dos veces.

---

## Decisiones de diseño y correcciones

Antes de implementar se auditó el diseño. Estas son las correcciones y decisiones que conviene conocer:

1. **Fórmula de documentos.** `(KB × 250) / 3.2` sirve para formatos contenedor (PDF, DOCX, XLSX, ZIP), donde solo una fracción del peso del archivo es texto útil. Para formatos de texto plano (TXT, JSON, CSV, XML, código) subestimaba unas cuatro veces, porque casi todo el archivo es texto. Se usa `250` caracteres útiles por KB para los contenedores y `1024` para los de texto. Los multiplicadores originales se conservan; el XML, que no tenía uno, usa 1.10 como el JSON.
2. **Valores por defecto de TXT y XML.** No tenían un valor fijo para cuando falta el tamaño; se añadieron 1500 y 1800.
3. **Consumo acumulado frente a contexto total.** Son magnitudes distintas. El contexto es una «foto» del chat; el consumo es la suma de lo que cuesta cada envío, y cada envío vuelve a leer el contexto entero.
4. **Ventana de contexto frente a límite de uso.** El saldo depende del límite de uso, que no se conoce. Por eso es un parámetro calibrable y no una constante.
5. **Ventana de 5 horas.** Arranca con el primer envío registrado, no al abrir la página, porque ese es el comportamiento que cabe esperar de una ventana de uso. Es una suposición y se documenta como tal.
6. **Condiciones de carrera entre pestañas.** Leer, modificar y escribir `chrome.storage.local` desde varias pestañas puede perder actualizaciones. Se serializa con Web Locks cuando existe, y si no, se relee justo antes de escribir.
7. **Confirmación del envío.** Un Enter con el compositor vacío o durante una composición IME no es un envío. El envío por Enter se confirma comprobando que el compositor se vació, sin usar el `MutationObserver` para registrar.
8. **Ahorro por chat nuevo.** Se acredita en el primer envío del chat nuevo, no al abrirlo, para no inflar el historial con chats que nunca se usan.
9. **Calibración.** Se rechaza si el consumo estimado es menor de 500 tokens y se mezcla con el presupuesto manual (`λ = n / (n + 2)`) para que una sola calibración no domine.
10. **Estilos y CSP.** La interfaz no escribe estilos como texto en el DOM; solo usa el CSSOM (`element.style.setProperty`) y clases de `styles.css`. Así funciona aunque la página tenga una CSP estricta.
11. **Sin `innerHTML`.** Los nombres de archivo y los textos de la página son datos no confiables. Se insertan siempre con `textContent`.

---

## Limitaciones

- **No lee la red ni las respuestas internas de Claude**, así que no puede conocer los tokens reales. Estima a partir de lo que ve en pantalla.
- **No ve todo lo que entra en el contexto**: instrucciones del sistema, memoria, herramientas, resultados de búsqueda web, conectores o pensamiento extendido no visibles.
- **El tokenizador es una aproximación** (caracteres por token). El español y otros idiomas suelen generar más tokens por carácter que el inglés; la calibración absorbe parte de ese sesgo.
- **El límite real varía** según el plan, el modelo, la carga del servicio y otros factores. Lo que se calibra es un valor efectivo en unidades de la propia estimación, no el límite de Anthropic.
- **La interfaz de claude.ai cambia.** Los selectores pueden dejar de funcionar sin aviso. Los cambios de DOM son la causa más probable de una cifra incorrecta.
- **Las ediciones de mensajes anteriores** no se registran como consumo.
- **Los datos no se comparten entre dispositivos ni entre perfiles del navegador.**
- **Los Proyectos y las imágenes** son fuentes de confianza muy baja.
- La precisión depende de la calibración; sin ella, el saldo es solo una orientación.

---

## Privacidad

- **Cero red.** El código no contiene `fetch`, `XMLHttpRequest`, `WebSocket`, `sendBeacon` ni carga scripts, estilos, fuentes o imágenes remotos.
- **Sin servidores, sin backend, sin analíticas, sin telemetría, sin almacenamiento remoto.**
- **El contenido de tus conversaciones nunca se guarda.** Se lee en memoria para contar caracteres y se descarta. Solo se almacenan cifras: presupuesto, inicio de ventana, consumo estimado, tokens de los últimos envíos, calibraciones y ahorro.
- **No se guardan identificadores de chat, nombres de archivo ni texto de mensajes.**
- **Permisos mínimos:** solo `storage` y el host `https://claude.ai/*`.

Puedes comprobarlo tú mismo:

```bash
grep -nE "fetch|XMLHttpRequest|WebSocket|sendBeacon|eval|new Function|innerHTML" content.js
```

El comando no debe devolver ninguna coincidencia.

Datos guardados en `chrome.storage.local`:

| Clave | Contenido |
|---|---|
| `cftm_settings` | Presupuesto manual, tokens del Proyecto, modo del Proyecto, tema, modo del widget, posición, colapsado. |
| `cftm_state` | Inicio de ventana, consumo de la ventana, últimos envíos (instante, tokens, tipo), calibraciones y ahorro acumulado. |

---

## Seguridad y Manifest V3

- Manifest V3, sin *background*, sin *service worker* y sin `host_permissions` fuera de claude.ai.
- CSP de las páginas de la extensión: `script-src 'self'; object-src 'self'`.
- Sin `eval`, sin `new Function`, sin `unsafe-eval`, sin `unsafe-inline` y sin scripts remotos.
- Ningún texto de la página se interpreta como HTML.
- El widget vive en `#cftm-root` y todas sus clases usan el prefijo `cftm-`. Las mutaciones originadas dentro de `#cftm-root` se ignoran para evitar bucles.

---

## Rendimiento

El objetivo es **menos de 5 ms por actualización** en uso normal y **sin fugas de memoria**.

- `MutationObserver` con *debounce* de **300 ms**.
- `WeakMap` como caché por nodo: un mensaje ya terminado no se vuelve a analizar mientras su longitud no cambie.
- Procesamiento incremental: durante la generación de una respuesta solo se recalcula el último mensaje.
- Reutilización de resultados cuando el DOM relevante no ha cambiado.
- Las mutaciones dentro de `#cftm-root` se ignoran.
- En `beforeunload` y `pagehide` se limpian observers, temporizadores y listeners.

El primer cálculo en una conversación muy larga puede superar los 5 ms, porque debe analizar todos los mensajes una vez. Las actualizaciones posteriores son incrementales.

---

## Ahorro de tokens

### Analizar ahorro

El botón **Analizar ahorro** genera recomendaciones dinámicas a partir de tu contexto actual. Cada una se clasifica por impacto, según qué parte del contexto total podría ahorrarse:

| Impacto | Ahorro respecto al contexto total |
|---|---|
| Alto | 25 % o más |
| Medio | Entre 10 % y 25 % |
| Bajo | Menos del 10 % |

Cada recomendación incluye el **ahorro estimado** (≈ X tokens por mensaje). Ejemplos de lo que puede detectar: un documento que domina el contexto, una conversación larga que conviene resumir, imágenes que no hacen falta, bloques de código demasiado grandes, un borrador muy largo o varias preguntas que se podrían agrupar en un único envío.

### Modo ultra ahorro

El botón **Analizar ahorro extremo** busca los mayores candidatos a reducir:

- PDF gigantes.
- DOCX grandes.
- CSV grandes.
- JSON extensos.
- Logs extensos.
- Código excesivo.
- Conversaciones largas.

Muestra el **ahorro potencial máximo** (≈ X tokens por mensaje) y ordena las recomendaciones por impacto. El máximo nunca supera el 90 % del contexto total y las recomendaciones que se solapan no se suman dos veces.

---

## ¿Por qué los resultados son aproximados?

1. **No hay acceso a los tokens reales.** Anthropic no expone en la página el recuento de tokens ni el límite de tu cuenta.
2. **El tokenizador es desconocido para la extensión.** Se usa una razón fija de caracteres por token (3.2 para texto y 2.8 para código) que varía según el idioma y el contenido.
3. **Los archivos adjuntos son opacos.** Solo se ve su nombre y, a veces, su tamaño. El texto que Claude extrae de un PDF o de un XLSX puede ser muy distinto de lo que sugiere su peso en disco.
4. **Las imágenes se codifican de forma interna**, por lo que se estiman por tramos.
5. **El tamaño del contexto de un Proyecto no es visible.**
6. **El límite de uso no es fijo.** Cambia con el plan, el modelo y la demanda.
7. **Hay contexto invisible**: instrucciones del sistema, memoria, herramientas y razonamiento interno.

Por eso la extensión muestra rangos, indica la confianza de cada fuente y reduce la amplitud del rango solo cuando tú aportas datos reales mediante calibraciones.

---

## ¿Cómo reducir el consumo de contexto?

Ordenadas por impacto típico:

1. **Abre un chat nuevo cuando cambies de tema.** Es el ahorro más grande, porque el contexto vuelve casi a cero.
2. **Resume antes de continuar.** Cuando una conversación se alarga, pide a Claude un resumen de unos 300 tokens y empieza un chat nuevo con él.
3. **No adjuntes el archivo completo.** Pega solo la sección, la función o las filas que importan.
4. **Evita adjuntar de nuevo lo que ya está en el chat.** Cada copia se vuelve a leer en cada mensaje.
5. **Agrupa preguntas.** Un mensaje con tres preguntas cuesta un envío; tres mensajes cuestan tres lecturas del contexto.
6. **Quita imágenes que no aporten.** Reduce su tamaño o recórtalas antes de subirlas.
7. **Reduce los logs.** Filtra las líneas relevantes en lugar de pegar el registro completo.
8. **Cuidado con Retry y Regenerate.** Cada uno vuelve a leer el contexto. Mejora el mensaje antes de repetirlo.
9. **Pide respuestas más cortas** cuando no necesites explicaciones largas: la respuesta también pasa a formar parte del contexto.
10. **Revisa el material de tus Proyectos.** Todo lo que contienen puede entrar en cada mensaje.

---

## Desarrollo y contribuciones

- Antes de publicar un cambio, comprueba la sintaxis con `node --check content.js` y ejecuta el `grep` de la sección [Privacidad](#privacidad).

- No hay dependencias ni paso de compilación. Edita `content.js`, `styles.css` o `manifest.json` y recarga la extensión.
- Si claude.ai cambia su estructura, los selectores del apartado correspondiente de `content.js` son lo primero que hay que actualizar.
- Las contribuciones son bienvenidas. Mantén estas reglas:
  - Ninguna llamada de red de ningún tipo.
  - Ningún `innerHTML`, `eval` ni `new Function`.
  - Toda cifra visible debe expresarse como estimación.
- Licencia: [MIT](LICENSE).
