# Análisis contextual: cómo Fangio sugiere grupos

Este documento resume la investigación previa, las alternativas evaluadas y el diseño
implementado en la vista **Temas** (v1.1). El código está en `src/core/context/`
(motor puro, sin `chrome.*`), `src/ui/dashboard/context.ts` (entrada desde los registros y
preferencias) y `src/ui/dashboard/localAi.ts` (IA local opcional).

## El problema

Dadas cientos o miles de referencias (URL, título, fechas), proponer grupos que
correspondan a **una misma tarea o tema**, aunque crucen sitios: una búsqueda en Google,
una conversación con ChatGPT sobre lo mismo y luego dos o tres sitios leídos en los
minutos siguientes. Restricciones de Fangio:

- **Nada sale del equipo** (sin servidores ni APIs en la nube).
- **Sin permisos de host para leer páginas**: sólo hay título, URL y fechas; no el contenido.
- Debe funcionar con 10.000 referencias sin trabar el panel.

## Antecedentes

| Trabajo | Idea relevante | Qué tomamos |
|---|---|---|
| Jones y Klinkner, *Beyond the session timeout* (CIKM 2008) | Segmentar consultas de búsqueda en tareas combinando rasgos léxicos y temporales; el corte por tiempo solo no alcanza. | Similitud léxica **modulada** por el tiempo, no reemplazada por él. |
| Lucchese et al., *Identifying task-based sessions in search engine query logs* (WSDM 2011) | Las tareas se intercalan (cerca del 75 % de las consultas ocurre en multitarea); clustering con distancia léxica más tiempo entre consultas. | Grafo de pares con peso léxico por núcleo temporal; grupos que no son contiguos en el tiempo. |
| Chang et al., *When the Tab Comes Due* (CHI 2021) y *Tabs.do* (UIST 2021) | Las pestañas se agrupan naturalmente por tarea; sugerencias a partir de señales de comportamiento y semánticas. | Señales de comportamiento: pestaña de origen (enlace seguido), grupo de Chrome, proyecto. |
| Blondel et al., *Fast unfolding of communities in large networks* (2008) | Algoritmo de Louvain: maximiza modularidad, rápido en grafos dispersos. | Particionado del grafo de afinidad. |
| Grootendorst, *BERTopic* (2022) | c-TF-IDF: términos distintivos de una clase frente al resto. | Nombres de los grupos. |
| Mozilla, *How Firefox suggests tab groups with local AI* (2025) | Embeddings MiniLM locales y regresión logística para sugerir pestañas; T5 destilado (57 MB) para nombrar, alimentado con palabras clave c-TF-IDF. Señalan el **tiempo** como trabajo futuro. | Validó el enfoque c-TF-IDF y confirmó que el componente temporal es el aporte diferencial. |
| Hisatomi (Univ. de Kioto), póster UIST 2025 | Detección de comunidades sobre el grafo de transiciones entre pestañas, sin entrenamiento. | Refuerza grafo y comunidades en lugar de clasificadores entrenados. |
| Yan et al., *Biterm Topic Model* (WWW 2013); Yin y Wang, *GSDMM* (KDD 2014) | Modelos de tópicos para textos cortos. | Evaluados y descartados: piden fijar el número de tópicos, iteran por muestreo y no usan el tiempo. |

## Alternativas evaluadas

| Opción | Ventajas | Costos | Decisión |
|---|---|---|---|
| **Algorítmica** (TF-IDF, tiempo, estructura, Louvain, c-TF-IDF) | 0 bytes de modelo, determinista, explicable («en común: hooks ×4»), 10.000 referencias en unos 0,2 s, multilenguaje sin entrenamiento. | No entiende sinónimos ni traducciones («coche» y «auto»). | **Implementada** (siempre activa). |
| **IA integrada de Chrome** (Gemini Nano, Prompt API, en el dispositivo) | Cero bytes en la extensión; Chrome gestiona el modelo; sin permisos nuevos; entiende el sentido de los títulos. | Requiere hardware compatible y una descarga única de varios GB hecha por Chrome; no está en todos los equipos. Sin API de embeddings. | **Opcional**: nombra los grupos y marca títulos que no pertenecen. |
| Embeddings locales (MiniLM con Transformers.js u ONNX) | Similitud semántica real (sinónimos, idiomas). | De 23 MB (inglés) a unos 120 MB (multilingüe) por modelo, `wasm-unsafe-eval` en la CSP, descarga o empaquetado del modelo, CPU en equipos modestos (Firefox recibió quejas de consumo con su versión). | **No implementada** por ahora; el motor admite sumar una señal semántica más adelante. |
| Modelos de tópicos para textos cortos (BTM, GSDMM) | Bien estudiados. | Número de tópicos fijo, no deterministas, sin componente temporal. | Descartada. |

## Diseño implementado

### 1. Rasgos por referencia (`text.ts`)

- **Título limpio**: se quitan contadores («(3) Bandeja…») y se parte en segmentos por
  separadores (` - `, ` | `, ` · `…).
- **Ruido de cada sitio, aprendido de los datos**: un segmento que aparece en al menos el
  50 % (y 3 o más) de los títulos de un mismo dominio («Stack Overflow», «Mercado Libre»)
  se descarta. El nombre del sitio (etiquetas del dominio: `react.dev` da «react») se
  conserva con peso 0,3 y nunca nombra un grupo.
- **Lo que buscaste**: la consulta se extrae de la URL de Google, Bing, DuckDuckGo, Yahoo,
  Ecosia, Brave, YouTube, Amazon, Mercado Libre, GitHub, Stack Overflow y Wikipedia
  (peso 1,3: es la intención más explícita).
- **Palabras de la URL** (`/how-to-use-react-hooks`), peso 0,4, sin ids ni hashes.
- Tokens en minúsculas y sin acentos, sin palabras vacías (es/en/pt), con un *stemming*
  conservador común a los tres idiomas (plurales, `-iones`, `-ies`, gerundio inglés,
  `reactjs` como `react`) y **bigramas sólo de palabras contiguas** («rodado 29»).
- **Tipo de sitio**: búsqueda, chat con IA (ChatGPT, Claude, Gemini, Perplexity, Copilot…),
  video o sitio.

### 2. Grafo de afinidad (`engine.ts`)

TF-IDF por referencia (los términos de una sola referencia pesan la mitad: no conectan
nada) y pares candidatos por índice invertido (sólo se comparan referencias que comparten
algún término; las listas de más de 400 se ignoran por poco informativas). Peso de un par:

    w = léxico · (0,45 + 0,55 · T) + 0,35 · origen + 0,25 · mismo grupo de Chrome + 0,20 · mismo proyecto
    T = 0,65 · e^(−Δ / 45 min) + 0,35 · e^(−Δ / 3 días)

`Δ` es la distancia mínima entre instantes de **actividad real** (apertura, último acceso).
Las fechas masivas (foto inicial al instalar, archivado o reapertura en lote) se excluyen
porque simularían coincidencias. Sin palabras en común sólo unen la pestaña de origen, el
grupo de Chrome o el proyecto: **el tiempo solo nunca agrupa**. Se descartan los pesos
menores a 0,1 y se conservan los 12 vecinos más fuertes de cada referencia.

### 3. Comunidades y nombres

- **Louvain** determinista (mismo resultado para la misma entrada). Las comunidades de más
  de 50 se vuelven a partir con una resolución mayor. Las de menos de 3 se descartan, salvo
  que una referencia suelta tenga al menos el 60 % de su peso (y 0,25 o más) hacia un
  grupo: entonces se suma a él.
- **Nombre** por c-TF-IDF: términos presentes en al menos el 25 % del grupo y raros en el
  resto; se eligen hasta 3 que no se solapen, con la forma escrita más frecuente
  (prefiriendo mayúsculas: «React» antes que «react»).
- **Afinidad** (0 a 1): 50 % conductancia (peso interno frente a enlaces hacia afuera),
  30 % peso medio interno, 20 % densidad.
- **Recorrido**: miembros en orden cronológico con su tipo (búsqueda, IA, video, sitio).
- Orden de las sugerencias: afinidad por tamaño por recencia (vida media de 14 días).

### 4. IA local opcional (`localAi.ts`)

Si `LanguageModel` existe y el equipo califica, el botón **Nombrar con IA local** envía a
Gemini Nano, en el dispositivo, las palabras clave y hasta 10 títulos de cada grupo, con
la salida restringida por JSON Schema (`name`, `outliers`). Los índices devueltos se
validan y la IA nunca puede «sacar» más de la mitad de un grupo. Si Chrome todavía no
descargó el modelo, se pide confirmación explícita antes de iniciar la descarga.

## Resultados

- Pruebas unitarias (`tests/context.test.ts`): búsqueda, ChatGPT y 3 sitios agrupados sin
  ruido; ruido de sitio aprendido (dos temas en Stack Overflow no se mezclan); el tiempo
  solo no agrupa; una cadena de pestañas de origen sin palabras comunes sí; determinismo;
  10.000 referencias en unos 0,2 s con grupos puros.
- E2E en Chromium real (`npm run test:e2e:views`): ver
  [TESTING.md](TESTING.md#vistas-y-análisis-contextual-v11).

## Limitaciones

- Sin contenido de página: dos títulos sin palabras en común sólo se unen por estructura
  (pestaña de origen, grupo, proyecto).
- Sinónimos y traducciones no se reconocen sin una capa semántica.
- Tras reiniciar el navegador, «último acceso» puede reflejar la restauración de la sesión.
- Las preferencias de la vista (sugerencias descartadas, nombres) viven en este navegador
  (`localStorage`), no en la base ni en las copias.

## Referencias

- R. Jones, K. L. Klinkner. *Beyond the session timeout: automatic hierarchical segmentation of search topics in query logs*. CIKM 2008.
- C. Lucchese, S. Orlando, R. Perego, F. Silvestri, G. Tolomei. *Identifying task-based sessions in search engine query logs*. WSDM 2011. https://doi.org/10.1145/1935826.1935875
- J. C. Chang, N. Hahn, Y. Kim et al. *When the Tab Comes Due: Challenges in the Cost Structure of Browser Tab Usage*. CHI 2021.
- J. C. Chang, Y. Kim, V. Miller, M. X. Liu, B. A. Myers, A. Kittur. *Tabs.do: Task-Centric Browser Tab Management*. UIST 2021.
- V. D. Blondel, J.-L. Guillaume, R. Lambiotte, E. Lefebvre. *Fast unfolding of communities in large networks*. J. Stat. Mech. 2008.
- M. Grootendorst. *BERTopic: Neural topic modeling with a class-based TF-IDF procedure*. 2022.
- X. Yan, J. Guo, Y. Lan, X. Cheng. *A Biterm Topic Model for Short Texts*. WWW 2013.
- J. Yin, J. Wang. *A Dirichlet Multinomial Mixture Model-based Approach for Short Text Clustering*. KDD 2014.
- Mozilla. *Under the hood: How Firefox suggests tab groups with local AI*. 2025. https://blog.mozilla.org/en/mozilla/ai/ai-tech/ai-tab-groups/
- Chrome for Developers. *Prompt API* (extensiones). https://developer.chrome.com/docs/extensions/ai/prompt-api
