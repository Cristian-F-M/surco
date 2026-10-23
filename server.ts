// SURCO — servidor Bun
// Sirve el frontend estático y expone la API:
//  - GET  /api/search-artists?q=TEXTO_O_CHANNEL_ID     -> busca canales de YouTube
//  - GET  /api/channel-songs?channelId=ID&pageToken=…  -> todos los videos subidos por el canal (sin Shorts), por páginas
//  - GET  /api/search-songs?q=NOMBRE&pageToken=…       -> busca canciones específicas por nombre (sin Shorts)
//  - GET  /api/suggest-original?q=TITULO&excludeId=ID   -> sugiere la versión original de una canción
//  - GET  /auth/google                                 -> inicia el login OAuth con Google
//  - GET  /auth/google/callback                        -> callback de Google, guarda los tokens
//  - GET  /api/auth/status                              -> ¿hay una sesión de YouTube activa?
//  - POST /api/auth/logout                              -> cierra sesión (borra tokens.json)
//  - GET  /api/playlists                                -> lista las playlists del usuario autenticado
//  - GET  /api/playlist-songs?playlistId=ID             -> canciones completas de una playlist (para "Mi Playlist")
//  - POST /api/add-to-playlist                          -> agrega un videoId a una playlist
//  - POST /api/remove-from-playlist                     -> quita una canción (por playlistItemId) de una playlist

import { unlink } from "fs/promises";

const PORT = Number(process.env.PORT || 3000);
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const API_KEY = process.env.GOOGLE_API_KEY || "";
const REDIRECT_URI =
  process.env.GOOGLE_REDIRECT_URI || `http://localhost:${PORT}/auth/google/callback`;
const SCOPE = "https://www.googleapis.com/auth/youtube";
const TOKENS_PATH = "./tokens.json";
const YT = "https://www.googleapis.com/youtube/v3";

type Tokens = {
  access_token: string;
  refresh_token?: string;
  expiry_date: number; // epoch ms
};

async function readTokens(): Promise<Tokens | null> {
  try {
    const file = Bun.file(TOKENS_PATH);
    if (!(await file.exists())) return null;
    return (await file.json()) as Tokens;
  } catch {
    return null;
  }
}

async function writeTokens(tokens: Tokens) {
  await Bun.write(TOKENS_PATH, JSON.stringify(tokens, null, 2));
}

// Devuelve un access_token válido, refrescándolo si hace falta.
async function getValidAccessToken(): Promise<string | null> {
  const tokens = await readTokens();
  if (!tokens) return null;

  if (tokens.expiry_date > Date.now() + 60_000) {
    return tokens.access_token;
  }
  if (!tokens.refresh_token) return null;

  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: tokens.refresh_token,
      grant_type: "refresh_token",
    }),
  });
  if (!resp.ok) return null;

  const data = await resp.json();
  const updated: Tokens = {
    access_token: data.access_token,
    refresh_token: tokens.refresh_token,
    expiry_date: Date.now() + data.expires_in * 1000,
  };
  await writeTokens(updated);
  return updated.access_token;
}

function json(data: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { "Content-Type": "application/json; charset=utf-8", ...(init.headers || {}) },
  });
}

type YoutubeFetchResult =
  | { data: any }
  | { error: "no_credentials" | "youtube_error"; status?: number; detail?: string };

// Llama a la Data API de YouTube. Usa el token OAuth del usuario si hay sesión
// (así no depende de una API key), y si no, cae a GOOGLE_API_KEY si está configurada.
async function youtubeFetch(path: string, params: Record<string, string>): Promise<YoutubeFetchResult> {
  const token = await getValidAccessToken();
  const qs = new URLSearchParams(params);
  if (!token) {
    if (!API_KEY) {
      return { error: "no_credentials" };
    }
    qs.set("key", API_KEY);
  }
  const resp = await fetch(`${YT}/${path}?${qs.toString()}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
  if (!resp.ok) {
    const text = await resp.text();
    console.error(`Error de YouTube API en /${path}:`, text);
    return { error: "youtube_error", status: resp.status, detail: text };
  }
  return { data: await resp.json() };
}

function credentialsOrErrorResponse(result: { error: string; status?: number; detail?: string }) {
  if (result.error === "no_credentials") {
    return json(
      {
        error:
          "Para buscar necesitas conectar tu cuenta de YouTube, o configurar GOOGLE_API_KEY en el .env.",
      },
      { status: 401 }
    );
  }
  return json({ error: "Ocurrió un error al consultar YouTube." }, { status: 502 });
}

function mapChannel(item: any) {
  return {
    id: item.id as string,
    title: item.snippet.title as string,
    description: (item.snippet.description as string) || "",
    thumbnail:
      item.snippet.thumbnails?.medium?.url || item.snippet.thumbnails?.default?.url || "",
    subscriberCount: item.statistics?.hiddenSubscriberCount
      ? null
      : Number(item.statistics?.subscriberCount ?? NaN) || null,
  };
}

// "PT3M45S" -> milisegundos
function parseISODuration(iso: string): number {
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso || "");
  if (!match) return 0;
  const [, h, m, s] = match;
  return ((Number(h) || 0) * 3600 + (Number(m) || 0) * 60 + (Number(s) || 0)) * 1000;
}

// ---------- Helpers de canciones: filtro de Shorts, búsqueda paginada, hidratación ----------

type Song = {
  id: string;
  title: string;
  artist: string;
  thumbnail: string;
  durationMs: number;
  publishedAt: string;
};

// La API de YouTube NO expone si un video es un Short. Heurística:
// duración <= 60s (el formato clásico de Short) o #shorts en título/descripción.
// Limitación: Shorts de 1 a 3 minutos (permitidos desde 2024) no se detectan por duración.
function isLikelyShort(durationMs: number, title: string, description: string): boolean {
  if (durationMs > 0 && durationMs <= 60_000) return true;
  return /#shorts?\b/i.test(`${title} ${description}`);
}

// Trae el detalle de videos (en lotes de 50), conserva el orden original y descarta Shorts.
async function hydrateSongs(
  videoIds: string[]
): Promise<{ songs: Song[] } | { error: YoutubeFetchResult }> {
  const byId = new Map<string, Song>();
  for (let i = 0; i < videoIds.length; i += 50) {
    const batch = videoIds.slice(i, i + 50);
    const result = await youtubeFetch("videos", {
      part: "snippet,contentDetails",
      id: batch.join(","),
    });
    if ("error" in result) return { error: result };
    for (const v of result.data.items || []) {
      const durationMs = parseISODuration(v.contentDetails?.duration || "");
      if (isLikelyShort(durationMs, v.snippet?.title || "", v.snippet?.description || "")) continue;
      byId.set(v.id, {
        id: v.id as string,
        title: v.snippet.title as string,
        artist: v.snippet.channelTitle as string,
        thumbnail:
          v.snippet.thumbnails?.medium?.url || v.snippet.thumbnails?.default?.url || "",
        durationMs,
        publishedAt: v.snippet.publishedAt as string,
      });
    }
  }
  return { songs: videoIds.map((id) => byId.get(id)).filter((s): s is Song => !!s) };
}

// Busca videos musicales y devuelve una "página lógica": como descartamos Shorts, una página
// de 50 puede quedar casi vacía, así que seguimos pidiendo páginas (máx. 3) hasta juntar ~25.
async function searchSongsPage(
  baseParams: Record<string, string>,
  startToken: string
): Promise<{ songs: Song[]; nextPageToken: string | null } | { error: YoutubeFetchResult }> {
  const MIN_SONGS = 25;
  const MAX_PAGES = 3;
  const songs: Song[] = [];
  const seen = new Set<string>();
  let pageToken = startToken;
  let nextPageToken: string | null = null;

  for (let page = 0; page < MAX_PAGES; page++) {
    const params: Record<string, string> = {
      part: "snippet",
      type: "video",
      videoCategoryId: "10", // Música
      maxResults: "50",
      ...baseParams,
    };
    if (pageToken) params.pageToken = pageToken;

    const searchResult = await youtubeFetch("search", params);
    if ("error" in searchResult) return { error: searchResult };

    const videoIds: string[] = (searchResult.data.items || [])
      .map((it: any) => it.id?.videoId)
      .filter((id: string | undefined): id is string => !!id && !seen.has(id));
    videoIds.forEach((id) => seen.add(id));
    nextPageToken = searchResult.data.nextPageToken || null;

    if (videoIds.length > 0) {
      const hydrated = await hydrateSongs(videoIds);
      if ("error" in hydrated) return { error: hydrated.error };
      songs.push(...hydrated.songs);
    }

    if (songs.length >= MIN_SONGS || !nextPageToken) break;
    pageToken = nextPageToken;
  }

  return { songs, nextPageToken };
}

// El canal tiene una playlist con TODOS sus videos subidos: su id es el del canal con "UC" -> "UU".
// Es mucho mejor que search.list para listar un canal: devuelve todo (sin el tope de ~500 resultados
// ni el filtro de categoría que se comía canciones mal categorizadas) y cuesta 1 unidad en vez de 100.
const uploadsPlaylistId = (channelId: string) =>
  channelId.startsWith("UC") ? "UU" + channelId.slice(2) : channelId;

async function channelUploadsPage(
  channelId: string,
  startToken: string
): Promise<{ songs: Song[]; nextPageToken: string | null } | { error: YoutubeFetchResult }> {
  const MIN_SONGS = 25;
  const MAX_PAGES = 5; // cada página de playlistItems cuesta solo 1 unidad
  const songs: Song[] = [];
  const seen = new Set<string>();
  let playlistId = uploadsPlaylistId(channelId);
  let triedFallback = false;
  let pageToken = startToken;
  let nextPageToken: string | null = null;

  for (let page = 0; page < MAX_PAGES; page++) {
    const params: Record<string, string> = {
      part: "contentDetails",
      playlistId,
      maxResults: "50",
    };
    if (pageToken) params.pageToken = pageToken;

    let result = await youtubeFetch("playlistItems", params);

    // Si la convención UC->UU no aplica a este canal, consultamos cuál es su playlist de uploads.
    if ("error" in result && result.error === "youtube_error" && result.status === 404 && !triedFallback) {
      triedFallback = true;
      const ch = await youtubeFetch("channels", { part: "contentDetails", id: channelId });
      const uploads = "data" in ch ? ch.data.items?.[0]?.contentDetails?.relatedPlaylists?.uploads : null;
      if (uploads && uploads !== playlistId) {
        playlistId = uploads;
        params.playlistId = uploads;
        result = await youtubeFetch("playlistItems", params);
      }
    }
    if ("error" in result) return { error: result };

    const videoIds: string[] = (result.data.items || [])
      .map((it: any) => it.contentDetails?.videoId)
      .filter((id: string | undefined): id is string => !!id && !seen.has(id));
    videoIds.forEach((id) => seen.add(id));
    nextPageToken = result.data.nextPageToken || null;

    if (videoIds.length > 0) {
      const hydrated = await hydrateSongs(videoIds); // descarta Shorts y videos no disponibles
      if ("error" in hydrated) return { error: hydrated.error };
      songs.push(...hydrated.songs);
    }

    if (songs.length >= MIN_SONGS || !nextPageToken) break;
    pageToken = nextPageToken;
  }

  return { songs, nextPageToken };
}

const LYRIC_TITLE_RE =
  /\b(letra|letras|lyrics?|lyric video|con letra|karaoke|cover|slowed|reverb|nightcore|sped up|8d)\b/i;
const LABEL_CHANNEL_RE =
  /\b(records?|recordings?|discos|discogr[aá]fica|music( group| latino| publishing)?|entertainment|label|sony|universal|warner|emi|bmg|rimas|lyrics?|letras?)\b/i;

const normalizeForMatch = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const CHANNEL_ID_RE = /^UC[A-Za-z0-9_-]{22}$/;

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const { pathname } = url;

    // ---------- Buscar artistas/canales (por nombre o Channel ID) ----------
    if (pathname === "/api/search-artists" && req.method === "GET") {
      const q = url.searchParams.get("q")?.trim();
      if (!q) return json({ error: "Falta el parámetro 'q'." }, { status: 400 });

      if (CHANNEL_ID_RE.test(q)) {
        // Es un Channel ID exacto: lo buscamos directo, sin ambigüedad.
        const result = await youtubeFetch("channels", {
          part: "snippet,statistics",
          id: q,
        });
        if ("error" in result) return credentialsOrErrorResponse(result);

        const item = result.data.items?.[0];
        if (!item) return json({ artists: [], query: q });

        return json({ artists: [mapChannel(item)], query: q, exact: true });
      }

      // Búsqueda por nombre: puede haber varios canales candidatos.
      const searchResult = await youtubeFetch("search", {
        part: "snippet",
        q,
        type: "channel",
        maxResults: "8",
      });
      if ("error" in searchResult) return credentialsOrErrorResponse(searchResult);

      const channelIds: string[] = (searchResult.data.items || [])
        .map((it: any) => it.snippet?.channelId || it.id?.channelId)
        .filter(Boolean);

      if (channelIds.length === 0) return json({ artists: [], query: q });

      // Pedimos estadísticas (suscriptores) para todos los canales encontrados de una vez.
      const detailsResult = await youtubeFetch("channels", {
        part: "snippet,statistics",
        id: channelIds.join(","),
      });
      if ("error" in detailsResult) return credentialsOrErrorResponse(detailsResult);

      const artists = (detailsResult.data.items || []).map(mapChannel);
      return json({ artists, query: q, exact: false });
    }

    // ---------- Canciones (videos musicales) de un canal, una página a la vez ----------
    if (pathname === "/api/channel-songs" && req.method === "GET") {
      const channelId = url.searchParams.get("channelId")?.trim();
      if (!channelId) return json({ error: "Falta el parámetro 'channelId'." }, { status: 400 });
      const pageToken = url.searchParams.get("pageToken") || "";

      const result = await channelUploadsPage(channelId, pageToken);
      if ("error" in result) return credentialsOrErrorResponse(result.error as any);
      return json({ songs: result.songs, nextPageToken: result.nextPageToken });
    }

    // ---------- Búsqueda de canciones específicas por nombre ----------
    if (pathname === "/api/search-songs" && req.method === "GET") {
      const q = url.searchParams.get("q")?.trim();
      if (!q) return json({ error: "Falta el parámetro 'q'." }, { status: 400 });
      const pageToken = url.searchParams.get("pageToken") || "";

      const result = await searchSongsPage({ q, order: "relevance" }, pageToken);
      if ("error" in result) return credentialsOrErrorResponse(result.error as any);
      return json({ songs: result.songs, nextPageToken: result.nextPageToken });
    }

    // ---------- Sugerir la versión original de una canción (letra/discográfica/otro canal) ----------
    if (pathname === "/api/suggest-original" && req.method === "GET") {
      const q = url.searchParams.get("q")?.trim();
      const excludeId = url.searchParams.get("excludeId") || "";
      if (!q) return json({ error: "Falta el parámetro 'q'." }, { status: 400 });

      const searchResult = await youtubeFetch("search", {
        part: "snippet",
        q,
        type: "video",
        videoCategoryId: "10",
        order: "relevance",
        maxResults: "15",
      });
      if ("error" in searchResult) return credentialsOrErrorResponse(searchResult);

      const videoIds: string[] = (searchResult.data.items || [])
        .map((it: any) => it.id?.videoId)
        .filter((id: string | undefined): id is string => !!id && id !== excludeId);
      if (videoIds.length === 0) return json({ suggestions: [] });

      const hydrated = await hydrateSongs(videoIds);
      if ("error" in hydrated) return credentialsOrErrorResponse(hydrated.error as any);

      // Puntaje: favorece canales que coinciden con el artista (que aparece en la consulta)
      // y títulos "oficiales"; penaliza videos de letra, covers y canales de discográfica.
      const normQuery = normalizeForMatch(q);
      const scored = hydrated.songs.map((song) => {
        const channel = normalizeForMatch(
          song.artist.replace(/\s*-\s*topic$/i, "").replace(/vevo$/i, "")
        );
        let score = 0;
        if (channel && normQuery.includes(channel)) score += 3;
        if (/\b(official|oficial)\b/i.test(song.title)) score += 1;
        if (/\s-\s*topic$/i.test(song.artist) || /vevo$/i.test(song.artist)) score += 1;
        if (LYRIC_TITLE_RE.test(song.title)) score -= 3;
        if (LABEL_CHANNEL_RE.test(song.artist)) score -= 3;
        return { song, score };
      });
      scored.sort((a, b) => b.score - a.score);

      return json({ suggestions: scored.slice(0, 4).map((s) => s.song) });
    }

    // ---------- OAuth: iniciar login ----------
    if (pathname === "/auth/google" && req.method === "GET") {
      if (!CLIENT_ID || !CLIENT_SECRET) {
        return new Response(
          "Faltan GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET. Revisa el archivo .env (ver README.md).",
          { status: 500 }
        );
      }
      const params = new URLSearchParams({
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        response_type: "code",
        scope: SCOPE,
        access_type: "offline",
        prompt: "consent",
      });
      return Response.redirect(
        `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`,
        302
      );
    }

    // ---------- OAuth: callback ----------
    if (pathname === "/auth/google/callback" && req.method === "GET") {
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      if (error) return Response.redirect(`/?auth=error&reason=${encodeURIComponent(error)}`, 302);
      if (!code) return Response.redirect(`/?auth=error&reason=no_code`, 302);

      const resp = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: CLIENT_ID,
          client_secret: CLIENT_SECRET,
          redirect_uri: REDIRECT_URI,
          grant_type: "authorization_code",
        }),
      });

      if (!resp.ok) {
        console.error("Error intercambiando el código por tokens:", await resp.text());
        return Response.redirect(`/?auth=error&reason=token_exchange`, 302);
      }

      const data = await resp.json();
      if (!data.refresh_token) {
        // Ya existía una sesión previa: conservamos el refresh_token anterior si lo hay.
        const previous = await readTokens();
        if (previous?.refresh_token) data.refresh_token = previous.refresh_token;
      }

      await writeTokens({
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        expiry_date: Date.now() + data.expires_in * 1000,
      });

      return Response.redirect(`/?auth=success`, 302);
    }

    // ---------- Estado de autenticación ----------
    if (pathname === "/api/auth/status" && req.method === "GET") {
      // No basta con ver si tokens.json existe: el access_token pudo expirar
      // y, en apps en modo "Testing" de Google, el refresh_token expira a los 7 días.
      // Intentamos obtener un token válido de verdad para reportar el estado real.
      const token = await getValidAccessToken();
      return json({ authenticated: !!token, hasApiKey: !!API_KEY });
    }

    // ---------- Logout ----------
    if (pathname === "/api/auth/logout" && req.method === "POST") {
      await unlink(TOKENS_PATH).catch(() => {});
      return json({ ok: true });
    }

    // ---------- Listar playlists del usuario ----------
    if (pathname === "/api/playlists" && req.method === "GET") {
      const token = await getValidAccessToken();
      if (!token) return json({ error: "No hay sesión de YouTube activa." }, { status: 401 });

      const r = await fetch(
        "https://www.googleapis.com/youtube/v3/playlists?part=snippet&mine=true&maxResults=50",
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (!r.ok) {
        console.error("Error obteniendo playlists:", await r.text());
        return json({ error: "No se pudieron obtener las playlists." }, { status: 502 });
      }
      const data = await r.json();
      const playlists = (data.items || []).map((p: any) => ({
        id: p.id as string,
        title: p.snippet.title as string,
        itemCount: p.contentDetails?.itemCount ?? null,
      }));
      return json({ playlists });
    }

    // ---------- Canciones completas de una playlist (para "Mi Playlist" y para marcar "ya agregadas") ----------
    if (pathname === "/api/playlist-songs" && req.method === "GET") {
      const playlistId = url.searchParams.get("playlistId")?.trim();
      if (!playlistId) return json({ error: "Falta el parámetro 'playlistId'." }, { status: 400 });

      const token = await getValidAccessToken();
      if (!token) return json({ error: "No hay sesión de YouTube activa." }, { status: 401 });

      const rawItems: any[] = [];
      let pageToken = "";
      const SAFETY_PAGE_CAP = 20; // hasta 1000 items; suficiente para uso personal
      for (let i = 0; i < SAFETY_PAGE_CAP; i++) {
        const params = new URLSearchParams({
          part: "snippet,contentDetails",
          playlistId,
          maxResults: "50",
        });
        if (pageToken) params.set("pageToken", pageToken);

        const r = await fetch(`${YT}/playlistItems?${params.toString()}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!r.ok) {
          console.error("Error obteniendo items de playlist:", await r.text());
          return json({ error: "No se pudo leer el contenido de la playlist." }, { status: 502 });
        }
        const data = await r.json();
        rawItems.push(...(data.items || []));
        pageToken = data.nextPageToken || "";
        if (!pageToken) break;
      }

      const videoIds = rawItems.map((it) => it.contentDetails?.videoId).filter(Boolean);

      // Duraciones vía videos.list, en lotes de 50 (única forma de saber cuánto dura cada video).
      const durationByVideoId = new Map<string, number>();
      for (let i = 0; i < videoIds.length; i += 50) {
        const batch = videoIds.slice(i, i + 50);
        const detailsResult = await youtubeFetch("videos", {
          part: "contentDetails",
          id: batch.join(","),
        });
        if ("error" in detailsResult) return credentialsOrErrorResponse(detailsResult);
        for (const v of detailsResult.data.items || []) {
          durationByVideoId.set(v.id, parseISODuration(v.contentDetails?.duration || ""));
        }
      }

      const songs = rawItems
        .filter((it) => it.contentDetails?.videoId)
        .map((it) => ({
          id: it.contentDetails.videoId as string,
          playlistItemId: it.id as string,
          title: it.snippet?.title || "(video no disponible)",
          artist: it.snippet?.videoOwnerChannelTitle || it.snippet?.channelTitle || "",
          thumbnail:
            it.snippet?.thumbnails?.medium?.url || it.snippet?.thumbnails?.default?.url || "",
          durationMs: durationByVideoId.get(it.contentDetails.videoId) || 0,
          addedAt: it.contentDetails?.videoPublishedAt || it.snippet?.publishedAt || "",
          position: typeof it.snippet?.position === "number" ? it.snippet.position : 0,
        }));

      return json({ songs });
    }

    // ---------- Agregar una canción (por videoId) a una playlist ----------
    if (pathname === "/api/add-to-playlist" && req.method === "POST") {
      const token = await getValidAccessToken();
      if (!token) return json({ error: "No hay sesión de YouTube activa." }, { status: 401 });

      const body = await req.json().catch(() => null);
      if (!body?.playlistId || !body?.videoId) {
        return json({ error: "Faltan datos (playlistId, videoId)." }, { status: 400 });
      }

      const insertResp = await fetch(
        "https://www.googleapis.com/youtube/v3/playlistItems?part=snippet",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            snippet: {
              playlistId: body.playlistId,
              resourceId: { kind: "youtube#video", videoId: body.videoId },
            },
          }),
        }
      );
      if (!insertResp.ok) {
        const errText = await insertResp.text();
        console.error("Error agregando a la playlist:", errText);
        return json({ error: "No se pudo agregar la canción a la playlist." }, { status: 502 });
      }

      const inserted = await insertResp.json();
      return json({ ok: true, playlistItemId: inserted.id as string });
    }

    // ---------- Quitar una canción de una playlist (por playlistItemId) ----------
    if (pathname === "/api/remove-from-playlist" && req.method === "POST") {
      const token = await getValidAccessToken();
      if (!token) return json({ error: "No hay sesión de YouTube activa." }, { status: 401 });

      const body = await req.json().catch(() => null);
      if (!body?.playlistItemId) {
        return json({ error: "Falta el dato 'playlistItemId'." }, { status: 400 });
      }

      const deleteResp = await fetch(
        `${YT}/playlistItems?id=${encodeURIComponent(body.playlistItemId)}`,
        {
          method: "DELETE",
          headers: { Authorization: `Bearer ${token}` },
        }
      );
      if (!deleteResp.ok && deleteResp.status !== 204) {
        const errText = await deleteResp.text();
        console.error("Error quitando de la playlist:", errText);
        return json({ error: "No se pudo quitar la canción de la playlist." }, { status: 502 });
      }

      return json({ ok: true });
    }

    // ---------- Archivos estáticos ----------
    const filePath = pathname === "/" ? "/index.html" : pathname;
    const file = Bun.file(`./public${filePath}`);
    if (await file.exists()) {
      return new Response(file);
    }

    return json({ error: "No encontrado" }, { status: 404 });
  },
});

console.log(`♪ SURCO corriendo en http://localhost:${server.port}`);
if (!CLIENT_ID || !CLIENT_SECRET) {
  console.warn(
    "⚠ No configuraste GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET todavía. El botón 'Conectar con YouTube' no funcionará hasta que crees el archivo .env (ver README.md)."
  );
}
if (!API_KEY) {
  console.warn(
    "ℹ No configuraste GOOGLE_API_KEY. La búsqueda de artistas/canciones solo funcionará mientras tengas la sesión de YouTube conectada."
  );
}
