# SURCO

Busca artistas en YouTube (por nombre o por Channel ID), elige el canal correcto, escucha sus canciones, organiza y gestiona tu playlist — todo sin recargar la página en ningún momento.

## Funciones

- **Buscar**: escribe el nombre de un artista, o pega directamente su **Channel ID de YouTube** (`UCxxxxxxxxxxxxxxxxxxxxxx`) cuando el nombre no encuentre al canal correcto.
- **Buscar canciones específicas**: arriba del buscador hay un selector **Por artista / Por canción**. En modo canción escribes el nombre del tema (puedes añadir el artista para afinar, ej. `Ojitos Lindos Bad Bunny`) y ves directamente los videos musicales que coinciden, con el mismo scroll infinito, escucha y agregar/quitar.
- **Sin Shorts**: las listas de canciones (por artista y por canción) descartan los Shorts. La API de YouTube no dice si un video es un Short, así que se detectan por heurística: duración de 60 segundos o menos, o `#shorts` en el título/descripción. Limitación: un Short de 1 a 3 minutos no se puede distinguir por duración y podría colarse.
- **Elegir artista**: si la búsqueda por nombre encuentra varios canales candidatos, se muestran en tarjetas (avatar, nombre, suscriptores) para que elijas el correcto.
- **Catálogo completo con scroll infinito**: al elegir un artista se listan **todos los videos que subió su canal** (desde su playlist de "uploads", sin el tope ni el filtro de categoría de la búsqueda de YouTube), de a unas 25 canciones por tanda. Al acercarte al final de la lista se carga la siguiente automáticamente, hasta que se acaba el catálogo. Los Shorts se descartan.
- **Escuchar**: cada canción, al darle play, suena un fragmento de ~30 segundos saltando la intro (aproximación al "highlight", ya que YouTube no expone dónde está el estribillo real). El mini-reproductor muestra "Vista previa · m:ss-m:ss" con un botón "Escuchar completa" para continuar sin cortes. Si arrastras la barra de progreso, también se desactiva el corte automático.
- **Indicador de reproduccion bien visible**: la fila de la cancion que suena se resalta con fondo y borde de color; el icono de esa fila y el mini-reproductor muestran un ecualizador animado mientras esta sonando.
- **Playlist de destino global**: se elige una sola vez en el selector de arriba a la derecha (no por cancion). Todo lo que agregues va ahi.
- **Marcado automatico**: al elegir una playlist, la app ya sabe que canciones de la busqueda estan en ella y muestra "Quitar de playlist" en vez de "Agregar".
- **Quitar sin perder la vista**: tanto en la busqueda como en "Mi Playlist", quitar una cancion de la playlist NO la borra de la lista en pantalla, solo cambia su boton a "Agregar" (o "Volver a agregar" en Mi Playlist), para que puedas volver a agregarla con un clic si te arrepentiste.
- **Pestana "Mi Playlist"**: navegacion para ver todas las canciones de la playlist elegida, con las mismas acciones de escuchar, quitar y volver a agregar que en la busqueda. Se puede ordenar por:
  - Agregadas recientemente (orden por defecto)
  - Artista (agrupadas por canal)
  - Nombre (alfabetico)
  - Nombres similares (agrupa versiones/covers/remixes de una misma cancion usando el titulo base, ignorando cosas como "(Live)", "(Remix)", "feat. X", etc.)
- **Buscador en Mi Playlist**: caja de búsqueda sobre la lista (atajo `/` para ir a ella, `Esc` para limpiarla). Filtra en vivo por nombre **o artista**, ignora tildes y mayúsculas y acepta varias palabras en cualquier orden (`lopez pa` encuentra "Pa' Ti — Jennifer López"). Se combina con el orden y con el filtro "no originales"; el contador muestra "X de Y".
- **Filtro "Solo no originales"** (en Mi Playlist): marca las canciones que probablemente NO son la versión del artista, con una etiqueta que explica el motivo:
  - *Video de letra*: título con "letra", "lyrics", "lyric video" o similares (ej. `[Nombre - Letra]`).
  - *Versión alterada*: cover, karaoke, slowed, reverb, nightcore, sped up, 8D.
  - *Canal de discográfica*: el canal parece un sello o canal de letras (Records, Music Group, Sony, Universal, Lyrics…).
  - *Canal distinto al artista*: el título es "Artista - Canción" pero el canal no coincide con el artista.
- **Sugerir la original**: cada canción marcada tiene un botón **Buscar original** que muestra hasta 4 versiones candidatas (priorizando canales que coinciden con el artista, "Official", VEVO y "- Topic", y penalizando letras, covers y sellos). Desde ahí puedes escucharlas, **+ Agregar** una, o **⇄ Reemplazar** (agrega la sugerida y quita la actual; la actual sigue visible con "+ Volver a agregar").
- **Atajos de teclado** (mientras el foco no este en un campo de texto):
  - Tab: siguiente cancion. Shift+Tab: cancion anterior
  - Espacio: pausar/reanudar
  - /: ir al buscador de Mi Playlist
  - Enter: agregar la cancion activa a la playlist
  - Backspace: quitar la cancion activa de la playlist
  - Flechas izquierda/derecha: retroceder/adelantar 5 segundos
  - Flechas arriba/abajo: subir/bajar volumen
  - M: silenciar/restaurar
  - Esc: ocultar el mini-reproductor (la cancion sigue sonando)
- **Descartar** (solo en la busqueda): quita la cancion de la lista en pantalla, sin tocar YouTube.

Todo corre en un unico servidor hecho con Bun (Bun.serve), sin frameworks. El frontend es HTML/CSS/JS plano que habla con la API por fetch, y usa la YouTube IFrame Player API para la reproduccion.

## 1. Instalar Bun

Si no lo tienes:

```bash
curl -fsSL https://bun.sh/install | bash
```

## 2. Crear credenciales de Google

1. Ve a Google Cloud Console y crea un proyecto (o usa uno existente).
2. En APIs y servicios -> Biblioteca, busca YouTube Data API v3 y activala.
3. En APIs y servicios -> Pantalla de consentimiento OAuth:
   - Tipo de usuario: Externo (si no tienes Google Workspace).
   - Completa nombre de la app, correo de soporte, etc.
   - En "Usuarios de prueba" agrega tu propia cuenta de Gmail (mientras la app no este publicada, solo esas cuentas podran conectarse).
4. En APIs y servicios -> Credenciales -> Crear credenciales -> ID de cliente de OAuth:
   - Tipo de aplicacion: Aplicacion web.
   - En URI de redireccion autorizados agrega exactamente:
     ```
     http://localhost:3000/auth/google/callback
     ```
   - Guarda y copia el Client ID y el Client secret.
5. Opcional pero recomendado, para poder buscar sin conectar tu cuenta primero: en Credenciales -> Crear credenciales -> Clave de API, crea una API Key. (Agregar/quitar canciones de una playlist siempre requiere estar conectado, con o sin esto.)

## 3. Configurar el proyecto

```bash
cp .env.example .env
```

Edita .env y pega tus credenciales:

```
GOOGLE_CLIENT_ID=tu_client_id
GOOGLE_CLIENT_SECRET=tu_client_secret
GOOGLE_REDIRECT_URI=http://localhost:3000/auth/google/callback
GOOGLE_API_KEY=tu_api_key_opcional
PORT=3000
```

## 4. Ejecutar

```bash
bun run start
```

Abre http://localhost:3000.

## Notas tecnicas

- Los tokens de Google se guardan localmente en tokens.json (excluido del control de versiones). Es una app pensada para uso personal/local, con un solo usuario a la vez.
- El refresh_token solo llega la primera vez que autorizas la app. Si necesitas re-generarlo, borra tokens.json y vuelve a conectar; Google fuerza un nuevo consentimiento gracias a prompt=consent.
- Importante: mientras tu app de Google Cloud este en modo "Testing" (no publicada), el refresh_token expira a los 7 dias. Si algo deja de funcionar, borra tokens.json y conectate de nuevo. El estado de conexion que muestra la app valida el token real (no solo si el archivo existe).
- Para listar un artista se usa la playlist de "uploads" de su canal (`UU…`, derivada del Channel ID): trae todo el catálogo y cada página cuesta solo 1 unidad de cuota. Como incluye todo lo que sube el canal, puede haber videos que no son canciones (entrevistas, making-of); si no te interesan, usa "Descartar".
- La búsqueda **por nombre de canción** sí usa `search.list` (cuesta 100 unidades por página) y filtra por la categoría "Música" de YouTube (`videoCategoryId=10`); un video mal categorizado puede no aparecer ahí.
- El fragmento de "vista previa" es una heuristica (empieza al 25% de la duracion, dura 30s); no hay forma de saber por API donde esta el estribillo real de una cancion.
- Detectar "no originales" es una **heurística sobre el título y el nombre del canal**: YouTube no indica quién es el artista original, así que puede haber falsos positivos (ej. un artista cuyo canal se llama "... Music") y falsos negativos (un video de letra subido con título limpio).
- Cuota extra: **Buscar original** y la búsqueda por canción hacen una búsqueda (100 unidades) por clic o por página. Como los Shorts se descartan, una página de `search.list` puede quedar casi vacía, así que el servidor pide hasta 3 páginas (hasta ~300 unidades) por carga para juntar unas 25 canciones.
- El agrupamiento por "nombres similares" normaliza los titulos quitando parentesis/corchetes, "feat./ft.", y puntuacion, asi que covers, remixes y versiones en vivo de una misma cancion quedan juntos.
- Los atajos de teclado se desactivan automaticamente mientras el foco esta en un campo de texto, select o similar, para no interferir con la busqueda o cualquier formulario.
- El Channel ID de un artista lo puedes obtener desde la propia pagina del canal en YouTube (menu "Acerca de", o en la URL si es del tipo youtube.com/channel/UC...).
- Si mueves el proyecto a un dominio o puerto distinto, actualiza GOOGLE_REDIRECT_URI en .env y el URI de redireccion autorizado en Google Cloud Console (deben coincidir exactamente).
- Cada llamada a la Data API de YouTube consume cuota del proyecto (10,000 unidades/dia gratis por defecto). search.list cuesta 100 unidades por llamada; el resto de llamadas (videos.list, playlistItems.list/insert/delete, channels.list) cuestan 1 unidad cada una.

## Estructura

```
surco/
├── server.ts          # servidor Bun: rutas de API + OAuth + estaticos
├── public/
│   ├── index.html
│   ├── style.css
│   └── app.js          # toda la interaccion, via fetch (sin recargas)
├── .env.example
├── package.json
└── tokens.json          # se crea solo, al conectar tu cuenta (no se versiona)
```
