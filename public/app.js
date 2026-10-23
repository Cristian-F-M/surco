// SURCO — frontend
// Toda la interacción se hace con fetch(); nunca se recarga la página.

const state = {
  // vista activa
  activeView: "search", // 'search' | 'playlist'

  // búsqueda de artistas
  query: "",
  artists: [],
  selectedArtist: null,

  // canciones del artista (infinite scroll)
  songs: [],
  songsNextPageToken: null,
  loadingMoreSongs: false,
  searchMode: "artist", // 'artist' | 'song'
  songsSource: null, // { type: 'channel', channelId } | { type: 'query', q }

  // auth / playlist global
  authenticated: false,
  playlists: null,
  playlistsPromise: null,
  selectedPlaylistId: "",

  // fuente de verdad de "qué está en la playlist elegida"
  playlistItemMap: new Map(), // videoId -> playlistItemId
  playlistSongs: [], // detalle completo para la vista "Mi Playlist"
  playlistSongsLoaded: false,
  playlistRenderOrder: [], // orden visual actual (según el sort elegido)
  currentSort: "recent",
  filterNonOriginal: false,
  playlistQuery: "",
  loadingSource: null, // fuente (búsqueda) a la que pertenece la carga en curso
  suggestions: new Map(), // songId -> { status: 'loading'|'done'|'error', items: [] }

  // reproducción
  activeSongId: null,
  previewMode: false,
  previewStart: 0,
  previewEnd: 0,
  pendingSong: null,
};

const els = {
  tabSearch: document.getElementById("tab-search"),
  tabPlaylist: document.getElementById("tab-playlist"),
  playlistTabCount: document.getElementById("playlist-tab-count"),
  viewSearch: document.getElementById("view-search"),
  viewPlaylist: document.getElementById("view-playlist"),

  form: document.getElementById("search-form"),
  input: document.getElementById("artist-input"),
  searchBtn: document.getElementById("search-btn"),
  hint: document.getElementById("search-hint"),

  artistResults: document.getElementById("artist-results"),
  artistCount: document.getElementById("artist-count"),
  artistList: document.getElementById("artist-list"),
  artistCardTemplate: document.getElementById("artist-card-template"),

  results: document.getElementById("results"),
  resultsTitle: document.getElementById("results-title"),
  resultsCount: document.getElementById("results-count"),
  backBtn: document.getElementById("back-to-artists-btn"),
  songList: document.getElementById("song-list"),
  songSentinel: document.getElementById("song-list-sentinel"),
  songListEnd: document.getElementById("song-list-end"),
  rowTemplate: document.getElementById("song-row-template"),
  groupTemplate: document.getElementById("song-group-template"),

  emptyState: document.getElementById("empty-state"),
  connectBtn: document.getElementById("connect-btn"),
  playlistGlobal: document.getElementById("playlist-global"),
  playlistSelect: document.getElementById("global-playlist-select"),
  toastStack: document.getElementById("toast-stack"),

  playlistViewTitle: document.getElementById("playlist-view-title"),
  playlistViewCount: document.getElementById("playlist-view-count"),
  playlistNoSelection: document.getElementById("playlist-no-selection"),
  playlistLoading: document.getElementById("playlist-loading"),
  playlistEmpty: document.getElementById("playlist-empty"),
  playlistGroups: document.getElementById("playlist-song-groups"),
  sortButtons: Array.from(document.querySelectorAll(".sort-options .sort-btn")),
  modeButtons: Array.from(document.querySelectorAll(".mode-toggle .sort-btn")),
  playlistSearch: document.getElementById("playlist-search-input"),
  filterChip: document.getElementById("filter-nonoriginal"),
  filterCount: document.getElementById("filter-nonoriginal-count"),
  playlistFilterEmpty: document.getElementById("playlist-filter-empty"),
};

// ---------- utilidades ----------

function formatDuration(ms) {
  if (!ms) return "";
  const totalSeconds = Math.round(ms / 1000);
  const m = Math.floor(totalSeconds / 60);
  const s = String(totalSeconds % 60).padStart(2, "0");
  return `${m}:${s}`;
}

function formatSubs(count) {
  if (count == null) return "";
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M suscriptores`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K suscriptores`;
  return `${count} suscriptores`;
}

function showToast(message, type = "default") {
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.textContent = message;
  els.toastStack.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transition = "opacity 0.25s ease";
    setTimeout(() => toast.remove(), 250);
  }, 3800);
}

function stripHtml(text) {
  const div = document.createElement("div");
  div.textContent = text || "";
  return div.textContent;
}

function getSongObjectById(id) {
  if (!id) return null;
  const found = state.songs.find((s) => s.id === id) || state.playlistSongs.find((s) => s.id === id);
  if (found) return found;
  for (const entry of state.suggestions.values()) {
    const sug = entry.items.find((s) => s.id === id);
    if (sug) return sug;
  }
  return null;
}

// ---------- navegación por pestañas ----------

function switchView(view) {
  state.activeView = view;
  els.tabSearch.classList.toggle("active", view === "search");
  els.tabPlaylist.classList.toggle("active", view === "playlist");
  els.viewSearch.hidden = view !== "search";
  els.viewPlaylist.hidden = view !== "playlist";
  if (view === "playlist") onEnterPlaylistView();
}

els.tabSearch.addEventListener("click", () => switchView("search"));
els.tabPlaylist.addEventListener("click", () => switchView("playlist"));

// ---------- autenticación ----------

async function refreshAuthStatus() {
  try {
    const r = await fetch("/api/auth/status");
    const data = await r.json();
    state.authenticated = !!data.authenticated;
  } catch {
    state.authenticated = false;
  }
  renderAuthArea();
  if (state.authenticated) {
    loadPlaylistsIntoSelect();
  } else {
    els.playlistGlobal.hidden = true;
  }
}

function renderAuthArea() {
  if (state.authenticated) {
    els.connectBtn.textContent = "✓ Conectado con YouTube — cerrar sesión";
    els.connectBtn.classList.add("connected");
  } else {
    els.connectBtn.textContent = "Conectar con YouTube";
    els.connectBtn.classList.remove("connected");
  }
}

els.connectBtn.addEventListener("click", async () => {
  if (state.authenticated) {
    await fetch("/api/auth/logout", { method: "POST" });
    state.authenticated = false;
    state.playlists = null;
    state.playlistsPromise = null;
    resetPlaylistSelection();
    els.playlistGlobal.hidden = true;
    renderAuthArea();
    showToast("Cerraste la sesión de YouTube.");
  } else {
    window.location.href = "/auth/google";
  }
});

async function ensurePlaylists() {
  if (state.playlists) return state.playlists;
  if (state.playlistsPromise) return state.playlistsPromise;
  state.playlistsPromise = fetch("/api/playlists")
    .then(async (r) => {
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        if (r.status === 401) {
          state.authenticated = false;
          renderAuthArea();
          throw new Error("Tu sesión de YouTube expiró. Conéctate de nuevo.");
        }
        throw new Error(data.error || `No se pudieron cargar las playlists (${r.status}).`);
      }
      state.playlists = data.playlists;
      return state.playlists;
    })
    .finally(() => {
      state.playlistsPromise = null;
    });
  return state.playlistsPromise;
}

async function loadPlaylistsIntoSelect() {
  els.playlistGlobal.hidden = false;
  els.playlistSelect.disabled = true;
  try {
    const playlists = await ensurePlaylists();
    els.playlistSelect.innerHTML = '<option value="">Elige una playlist…</option>';
    if (playlists.length === 0) {
      els.playlistSelect.innerHTML = '<option value="">No tienes playlists todavía</option>';
    } else {
      for (const pl of playlists) {
        const opt = document.createElement("option");
        opt.value = pl.id;
        opt.textContent = pl.title;
        els.playlistSelect.appendChild(opt);
      }
    }
  } catch (err) {
    showToast(err.message || "No se pudieron cargar tus playlists.", "error");
    els.playlistGlobal.hidden = true;
  } finally {
    els.playlistSelect.disabled = false;
  }
}

function clearPlaylistSearch() {
  state.playlistQuery = "";
  if (els.playlistSearch) els.playlistSearch.value = "";
}

function resetPlaylistSelection() {
  state.selectedPlaylistId = "";
  state.suggestions = new Map();
  clearPlaylistSearch();
  state.playlistItemMap = new Map();
  state.playlistSongs = [];
  state.playlistSongsLoaded = false;
  refreshAllAddButtons();
  renderPlaylistTabCount();
  if (state.activeView === "playlist") showPlaylistState("no-selection");
}

els.playlistSelect.addEventListener("change", async () => {
  const playlistId = els.playlistSelect.value;
  state.selectedPlaylistId = playlistId;
  state.suggestions = new Map();
  clearPlaylistSearch();
  state.playlistItemMap = new Map();
  state.playlistSongs = [];
  state.playlistSongsLoaded = false;
  refreshAllAddButtons();
  renderPlaylistTabCount();

  if (!playlistId) {
    if (state.activeView === "playlist") showPlaylistState("no-selection");
    return;
  }

  els.playlistViewTitle.textContent =
    els.playlistSelect.selectedOptions[0]?.textContent || "Mi Playlist";

  els.playlistSelect.disabled = true;
  if (state.activeView === "playlist") showPlaylistState("loading");
  try {
    const r = await fetch(`/api/playlist-songs?playlistId=${encodeURIComponent(playlistId)}`);
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || "No se pudo leer la playlist.");

    state.playlistSongs = data.songs || [];
    state.playlistSongsLoaded = true;
    state.playlistItemMap = new Map(state.playlistSongs.map((s) => [s.id, s.playlistItemId]));
    refreshAllAddButtons();
    renderPlaylistTabCount();

    if (state.activeView === "playlist") {
      if (state.playlistSongs.length === 0) {
        showPlaylistState("empty");
      } else {
        showPlaylistState("groups");
        renderPlaylistView();
      }
    }
  } catch (err) {
    showToast(err.message || "No se pudo leer el contenido de la playlist.", "error");
    if (state.activeView === "playlist") showPlaylistState("no-selection");
  } finally {
    els.playlistSelect.disabled = false;
  }
});

// mensajes que vienen del callback de OAuth (?auth=success|error)
function handleAuthRedirectParams() {
  const url = new URL(window.location.href);
  const auth = url.searchParams.get("auth");
  if (auth === "success") {
    showToast("Conectado con YouTube correctamente.", "success");
  } else if (auth === "error") {
    const reason = url.searchParams.get("reason") || "desconocido";
    showToast(`No se pudo conectar con YouTube (${reason}).`, "error");
  }
  if (auth) {
    url.searchParams.delete("auth");
    url.searchParams.delete("reason");
    window.history.replaceState({}, "", url.pathname);
  }
}

// ---------- agregar / quitar (compartido entre ambas vistas) ----------

function refreshAllAddButtons() {
  document.querySelectorAll(".song-row").forEach((row) => {
    const songId = row.dataset.id;
    const context = row.dataset.context;
    const btn = row.querySelector(".btn-add");
    if (btn && songId) setAddButtonState(btn, songId, context);
  });
}

function setAddButtonState(btn, songId, context) {
  const inPlaylist = state.playlistItemMap.has(songId);
  btn.disabled = false;
  if (inPlaylist) {
    btn.textContent = "✕ Quitar de playlist";
    btn.classList.add("in-playlist");
  } else {
    btn.textContent = context === "playlist" ? "+ Volver a agregar" : "+ Agregar";
    btn.classList.remove("in-playlist");
  }
}

function renderPlaylistTabCount() {
  const count = state.playlistSongsLoaded ? state.playlistSongs.length : 0;
  els.playlistTabCount.hidden = !state.selectedPlaylistId;
  els.playlistTabCount.textContent = String(count);
}

async function addSongToPlaylist(song) {
  if (!state.authenticated) {
    showToast("Conéctate con YouTube primero (botón arriba a la derecha).", "error");
    return false;
  }
  if (!state.selectedPlaylistId) {
    showToast("Elige primero una playlist de destino (arriba a la derecha).", "error");
    els.playlistSelect.focus();
    return false;
  }
  if (state.playlistItemMap.has(song.id)) return true;

  try {
    const r = await fetch("/api/add-to-playlist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ playlistId: state.selectedPlaylistId, videoId: song.id }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || "Error al agregar la canción.");

    state.playlistItemMap.set(song.id, data.playlistItemId);
    if (!state.playlistSongs.find((s) => s.id === song.id)) {
      state.playlistSongs.unshift({
        ...song,
        playlistItemId: data.playlistItemId,
        position: (state.playlistSongs[0]?.position ?? 0) + 1,
      });
    }
    refreshAllAddButtons();
    renderPlaylistTabCount();
    if (state.activeView === "playlist") renderPlaylistView();
    showToast(`"${song.title}" se agregó a la playlist.`, "success");
    return true;
  } catch (err) {
    showToast(err.message || "No se pudo agregar la canción.", "error");
    return false;
  }
}

async function removeSongFromPlaylist(song) {
  const playlistItemId = state.playlistItemMap.get(song.id);
  if (!playlistItemId) {
    showToast("Esta canción no está en la playlist.", "error");
    return false;
  }
  try {
    const r = await fetch("/api/remove-from-playlist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ playlistItemId }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || "No se pudo quitar la canción.");

    state.playlistItemMap.delete(song.id);
    // No se elimina de "Mi Playlist" a la vista: solo cambia su botón (manejado por refreshAllAddButtons).
    refreshAllAddButtons();
    renderPlaylistTabCount();
    showToast(`"${song.title}" se quitó de la playlist.`);
    return true;
  } catch (err) {
    showToast(err.message || "No se pudo quitar la canción.", "error");
    return false;
  }
}

// ---------- búsqueda de artistas ----------

els.form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const q = els.input.value.trim();
  if (!q) return;
  if (state.searchMode === "song") await searchSongs(q);
  else await searchArtists(q);
});

const HINT_ARTIST = "Escribe un artista, o pega su Channel ID si el nombre no da con el correcto.";
const HINT_SONG = "Escribe el nombre de una canción (puedes añadir el artista para afinar la búsqueda).";

els.modeButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    state.searchMode = btn.dataset.mode;
    els.modeButtons.forEach((b) => b.classList.toggle("active", b === btn));
    els.input.placeholder =
      state.searchMode === "song"
        ? "Nombre de la canción — ej. Ojitos Lindos Bad Bunny"
        : "Nombre del artista o Channel ID de YouTube (UC…)";
    els.hint.textContent = state.searchMode === "song" ? HINT_SONG : HINT_ARTIST;
    els.input.focus();
  });
});

// Búsqueda de canciones específicas por nombre (sin pasar por la elección de artista).
async function searchSongs(q) {
  state.query = q;
  state.artists = [];
  state.selectedArtist = null;
  state.songsSource = { type: "query", q };
  state.songs = [];
  state.songsNextPageToken = null;
  els.searchBtn.disabled = true;
  els.searchBtn.textContent = "Buscando…";
  els.artistResults.hidden = true;
  els.results.hidden = true;
  els.emptyState.hidden = true;
  els.songList.innerHTML = "";
  els.songSentinel.hidden = true;
  els.songListEnd.hidden = true;
  els.hint.textContent = `Buscando la canción "${q}" en YouTube…`;

  try {
    await loadSongsPage();
  } finally {
    els.searchBtn.disabled = false;
    els.searchBtn.textContent = "Buscar";
  }

  els.backBtn.hidden = true;
  if (state.songs.length === 0) {
    els.results.hidden = true;
    els.emptyState.hidden = false;
    els.hint.textContent = `No encontramos canciones para "${q}". Prueba añadiendo el nombre del artista.`;
  } else {
    els.results.hidden = false;
    els.resultsTitle.textContent = `Canciones: "${q}"`;
    els.hint.textContent = `Mostrando resultados para la canción "${q}".`;
  }
}

async function searchArtists(q) {
  state.query = q;
  els.searchBtn.disabled = true;
  els.searchBtn.textContent = "Buscando…";
  els.hint.textContent = `Buscando "${q}" en YouTube…`;
  els.results.hidden = true;
  els.artistResults.hidden = true;

  try {
    const r = await fetch(`/api/search-artists?q=${encodeURIComponent(q)}`);
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || "Error al buscar.");

    state.artists = data.artists || [];

    if (state.artists.length === 0) {
      els.emptyState.hidden = false;
      els.hint.textContent = `No encontramos ningún canal para "${q}". Prueba con otro nombre o pega su Channel ID.`;
      return;
    }

    if (state.artists.length === 1) {
      await selectArtist(state.artists[0]);
    } else {
      renderArtistList();
      els.hint.textContent = "Elige el canal correcto entre los resultados.";
    }
  } catch (err) {
    showToast(err.message || "Error al buscar.", "error");
    els.hint.textContent = "Ocurrió un error. Intenta de nuevo.";
  } finally {
    els.searchBtn.disabled = false;
    els.searchBtn.textContent = "Buscar";
  }
}

function renderArtistList() {
  els.emptyState.hidden = true;
  els.results.hidden = true;
  els.artistResults.hidden = false;
  els.artistCount.textContent = `${state.artists.length} resultado${state.artists.length === 1 ? "" : "s"}`;

  els.artistList.innerHTML = "";
  for (const artist of state.artists) {
    const node = els.artistCardTemplate.content.firstElementChild.cloneNode(true);
    node.querySelector(".artist-avatar").src = artist.thumbnail || "";
    node.querySelector(".artist-avatar").alt = artist.title;
    node.querySelector(".artist-title").textContent = artist.title;
    node.querySelector(".artist-sub").textContent = artist.subscriberCount
      ? formatSubs(artist.subscriberCount)
      : stripHtml(artist.description).slice(0, 60) || "Canal de YouTube";

    const activate = () => selectArtist(artist);
    node.addEventListener("click", activate);
    node.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        activate();
      }
    });

    els.artistList.appendChild(node);
  }
}

els.backBtn.addEventListener("click", () => {
  if (state.artists.length > 1) {
    renderArtistList();
    els.hint.textContent = "Elige el canal correcto entre los resultados.";
  } else {
    els.results.hidden = true;
    els.artistResults.hidden = true;
    els.emptyState.hidden = false;
    els.hint.textContent = "Escribe un artista, o pega su Channel ID si el nombre no da con el correcto.";
  }
});

// ---------- canciones del artista elegido (infinite scroll) ----------

async function selectArtist(artist) {
  state.selectedArtist = artist;
  state.songsSource = { type: "channel", channelId: artist.id };
  state.songs = [];
  state.songsNextPageToken = null;
  els.artistResults.hidden = true;
  els.emptyState.hidden = true;
  els.songList.innerHTML = "";
  els.songSentinel.hidden = true;
  els.songListEnd.hidden = true;
  els.hint.textContent = `Buscando canciones de "${artist.title}"…`;

  await loadSongsPage();

  els.backBtn.hidden = state.artists.length <= 1;

  if (state.songs.length === 0) {
    els.results.hidden = true;
    els.emptyState.hidden = false;
    els.hint.textContent = `No encontramos canciones de música para "${artist.title}".`;
  } else {
    els.results.hidden = false;
    els.resultsTitle.textContent = artist.title;
    els.hint.textContent = `Mostrando canciones de "${artist.title}". Escribe otro artista para una nueva búsqueda.`;
  }
}

async function loadSongsPage() {
  if (!state.songsSource) return;
  const source = state.songsSource;
  // El candado es por búsqueda: una carga vieja no debe bloquear una búsqueda nueva.
  if (state.loadingMoreSongs && state.loadingSource === source) return;
  state.loadingMoreSongs = true;
  state.loadingSource = source;
  els.songSentinel.hidden = false;
  let keepLoading = false;

  try {
    const params = new URLSearchParams();
    let endpoint;
    if (source.type === "channel") {
      params.set("channelId", source.channelId);
      endpoint = "/api/channel-songs";
    } else {
      params.set("q", source.q);
      endpoint = "/api/search-songs";
    }
    if (state.songsNextPageToken) params.set("pageToken", state.songsNextPageToken);

    const r = await fetch(`${endpoint}?${params.toString()}`);
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || "No se pudieron cargar las canciones.");

    // Si el usuario lanzó otra búsqueda mientras esta página cargaba, descartamos el resultado viejo.
    if (state.songsSource !== source) return;

    const startIndex = state.songs.length;
    const newSongs = data.songs || [];
    state.songs.push(...newSongs);
    state.songsNextPageToken = data.nextPageToken || null;

    newSongs.forEach((song, i) => {
      els.songList.appendChild(buildSongRow(song, startIndex + i, "search"));
    });
    refreshNowPlayingUI();

    els.resultsCount.textContent = `${state.songs.length} canción${state.songs.length === 1 ? "" : "es"}`;
    els.songSentinel.hidden = !state.songsNextPageToken;
    els.songListEnd.hidden = !!state.songsNextPageToken || state.songs.length === 0;
    keepLoading = !!state.songsNextPageToken;
  } catch (err) {
    showToast(err.message || "No se pudieron cargar más canciones.", "error");
    els.songSentinel.hidden = true;
  } finally {
    if (state.loadingSource === source) {
      state.loadingMoreSongs = false;
      state.loadingSource = null;
    }
  }

  // IntersectionObserver solo avisa cuando el marcador CAMBIA de visibilidad. Si tras agregar
  // esta página sigue a la vista (lista corta o pantalla alta), nunca pediría la siguiente.
  // Volver a observarlo fuerza una nueva comprobación y reanuda la carga.
  if (keepLoading && state.songsSource === source) {
    songObserver.unobserve(els.songSentinel);
    songObserver.observe(els.songSentinel);
  }
}

// Dispara loadSongsPage() automáticamente cuando el marcador de "fin de lista" entra en pantalla.
const songObserver = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting && state.songsNextPageToken && !state.loadingMoreSongs) {
        loadSongsPage();
      }
    }
  },
  { rootMargin: "600px" }
);
songObserver.observe(els.songSentinel);

function discardSong(id, node) {
  if (state.activeSongId === id) stopPlayback();
  node.classList.add("leaving");
  node.addEventListener(
    "transitionend",
    () => {
      state.songs = state.songs.filter((s) => s.id !== id);
      node.remove();
      els.resultsCount.textContent = `${state.songs.length} canción${state.songs.length === 1 ? "" : "es"}`;
      if (state.songs.length === 0 && !state.songsNextPageToken) {
        els.results.hidden = true;
        els.emptyState.hidden = false;
      }
    },
    { once: true }
  );
}

// ---------- vista "Mi Playlist" ----------

function showPlaylistState(mode) {
  els.playlistFilterEmpty.hidden = true;
  els.playlistNoSelection.hidden = mode !== "no-selection";
  els.playlistLoading.hidden = mode !== "loading";
  els.playlistEmpty.hidden = mode !== "empty";
  if (mode !== "groups") els.playlistGroups.innerHTML = "";
}

function onEnterPlaylistView() {
  if (!state.selectedPlaylistId) {
    showPlaylistState("no-selection");
    return;
  }
  if (!state.playlistSongsLoaded) {
    showPlaylistState("loading");
    return; // el handler del <select> ya está trayendo los datos y renderizará al terminar
  }
  if (state.playlistSongs.length === 0) {
    showPlaylistState("empty");
    return;
  }
  showPlaylistState("groups");
  renderPlaylistView();
}

// Quita sufijos tipo "(Live)", "[Official Video]", "feat. X", etc. para agrupar versiones/nombres similares.
function normalizeTitleKey(title) {
  let t = (title || "").toLowerCase();
  t = t.replace(/[\(\[][^\)\]]*[\)\]]/g, " ");
  t = t.replace(/\b(feat\.?|ft\.?|featuring)\b.*$/i, " ");
  t = t.replace(/[^a-z0-9áéíóúñü\s]/gi, " ");
  t = t.replace(/\s+/g, " ").trim();
  return t || (title || "").toLowerCase().trim();
}

// ---------- detección de canciones "no originales" ----------
// Heurísticas sobre título y canal (YouTube no dice quién es el artista original):
//  - "Video de letra":  título con letra / lyrics / lyric video
//  - "Versión alterada": cover, karaoke, slowed, reverb, nightcore, sped up, 8D
//  - "Canal de discográfica": el canal parece un sello (Records, Music Group, Sony, Universal…)
//  - "Canal distinto al artista": el título es "Artista - Canción" pero el canal no coincide con ninguna parte

const LYRIC_RE = /\b(letra|letras|lyrics?|lyric video|con letra)\b/i;
const ALTERED_RE = /\b(cover|karaoke|slowed|reverb|nightcore|sped up|8d)\b/i;
const LABEL_RE =
  /\b(records?|recordings?|discos|discogr[aá]fica|music( group| latino| publishing)?|entertainment|label|sony|universal|warner|emi|bmg|rimas|lyrics?|letras?)\b/i;
const NOISE_G_RE =
  /\b(letra|letras|lyrics?|lyric video|con letra|video oficial|audio oficial|official video|official audio|official|oficial|visualizer|video|audio|hd|4k|cover|karaoke|slowed|reverb|nightcore|sped up|8d)\b/gi;

function normalizeForMatch(text) {
  return (text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const squash = (text) => normalizeForMatch(text).replace(/\s+/g, "");

function cleanChannelName(name) {
  return (name || "").replace(/\s*-\s*topic$/i, "").replace(/vevo$/i, "").trim();
}

// Quita palabras de relleno ("Letra", "Video Oficial"…) y paréntesis que queden vacíos.
// Ej.: "Bad Bunny - Titi Me Preguntó (Letra)" -> "Bad Bunny - Titi Me Preguntó"
//      "[Ojitos Lindos - Letra]"               -> "Ojitos Lindos"
function cleanSongTitle(title) {
  let t = (title || "").trim();
  t = t.replace(/^[\[\(]([^\[\]\(\)]*)[\]\)]$/, "$1"); // título entero entre corchetes: lo desenvolvemos
  t = t.replace(NOISE_G_RE, " ");
  t = t.replace(/[\(\[]\s*[-–—|:+&,]*\s*[\)\]]/g, " "); // paréntesis que quedaron vacíos
  t = t.replace(/^[\s\-–—|:+&,]+|[\s\-–—|:+&,]+$/g, "");
  return t.replace(/\s+/g, " ").trim();
}

const analysisCache = new WeakMap();

function analyzeSong(song) {
  if (analysisCache.has(song)) return analysisCache.get(song);

  const title = song.title || "";
  const channel = song.artist || "";
  const reasons = [];

  if (LYRIC_RE.test(title)) reasons.push("Video de letra");
  if (ALTERED_RE.test(title)) reasons.push("Versión alterada");

  if (LABEL_RE.test(channel)) {
    reasons.push("Canal de discográfica");
  } else {
    const m = title.match(/^(.+?)\s[-–—|]\s(.+)$/);
    if (m) {
      const ch = squash(cleanChannelName(channel));
      const parts = [squash(cleanSongTitle(m[1])), squash(cleanSongTitle(m[2]))];
      const matches = ch && parts.some((p) => p && (p.includes(ch) || ch.includes(p)));
      if (ch && !matches) reasons.push("Canal distinto al artista");
    }
  }

  const result = { flagged: reasons.length > 0, reasons, cleanTitle: cleanSongTitle(title) };
  analysisCache.set(song, result);
  return result;
}

// ---------- sugerencia de la canción original ----------

async function toggleSuggestions(song) {
  if (state.suggestions.has(song.id)) {
    state.suggestions.delete(song.id);
    updateSuggestionUI(song.id);
    return;
  }

  state.suggestions.set(song.id, { status: "loading", items: [] });
  updateSuggestionUI(song.id);

  // Si el título no trae al artista ("Nombre - Letra") y el canal no es un sello, lo agregamos a la consulta.
  const cleaned = analyzeSong(song).cleanTitle;
  let q = cleaned;
  if (!/[-–—|]/.test(cleaned) && !LABEL_RE.test(song.artist)) {
    q = `${cleanChannelName(song.artist)} ${cleaned}`.trim();
  }

  try {
    const r = await fetch(
      `/api/suggest-original?q=${encodeURIComponent(q)}&excludeId=${encodeURIComponent(song.id)}`
    );
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || "No se pudieron buscar sugerencias.");
    if (!state.suggestions.has(song.id)) return; // el usuario cerró el panel mientras cargaba
    state.suggestions.set(song.id, { status: "done", items: data.suggestions || [] });
  } catch (err) {
    showToast(err.message || "No se pudieron buscar sugerencias.", "error");
    if (!state.suggestions.has(song.id)) return;
    state.suggestions.set(song.id, { status: "error", items: [] });
  }
  updateSuggestionUI(song.id);
}

// Re-dibuja solo el panel de sugerencias de una fila (sin re-renderizar toda la playlist).
function updateSuggestionUI(songId) {
  const row = document.querySelector(
    `.song-row[data-context="playlist"][data-id="${CSS.escape(songId)}"]`
  );
  if (!row) return;

  const next = row.nextElementSibling;
  if (next && next.classList.contains("suggestion-panel") && next.dataset.for === songId) next.remove();

  const open = state.suggestions.has(songId);
  const btn = row.querySelector(".btn-suggest");
  if (btn) {
    btn.setAttribute("aria-expanded", String(open));
    btn.textContent = open ? "Ocultar sugerencias" : "Buscar original";
  }

  if (open) {
    const original = state.playlistSongs.find((s) => s.id === songId);
    if (original) row.after(buildSuggestionPanel(original));
  }
  refreshNowPlayingUI();
}

function buildSuggestionPanel(original) {
  const entry = state.suggestions.get(original.id);
  const panel = document.createElement("li");
  panel.className = "suggestion-panel";
  panel.dataset.for = original.id;

  const title = document.createElement("p");
  title.className = "suggestion-title";
  title.textContent = "Posibles versiones originales";
  panel.appendChild(title);

  const status = (text) => {
    const p = document.createElement("p");
    p.className = "suggestion-status";
    p.textContent = text;
    panel.appendChild(p);
  };

  if (entry.status === "loading") {
    status("Buscando la canción original…");
  } else if (entry.status === "error") {
    status("No se pudieron cargar las sugerencias. Intenta de nuevo.");
  } else if (entry.items.length === 0) {
    status("No encontramos una versión original distinta a esta.");
  } else {
    const list = document.createElement("ol");
    list.className = "song-list";
    entry.items.forEach((suggestion, i) => {
      const row = buildSongRow(suggestion, i, "suggestion");
      const replaceBtn = document.createElement("button");
      replaceBtn.type = "button";
      replaceBtn.className = "btn btn-replace";
      replaceBtn.textContent = "⇄ Reemplazar";
      replaceBtn.title = "Agrega esta versión y quita la actual de la playlist";
      replaceBtn.addEventListener("click", async () => {
        replaceBtn.disabled = true;
        replaceBtn.textContent = "Reemplazando…";
        await replaceSong(original, suggestion);
        replaceBtn.disabled = false;
        replaceBtn.textContent = "⇄ Reemplazar";
      });
      row.querySelector(".song-actions").prepend(replaceBtn);
      list.appendChild(row);
    });
    panel.appendChild(list);
  }
  return panel;
}

// Agrega la versión sugerida y quita la actual. La actual sigue visible en la lista
// (con su botón "+ Volver a agregar"), igual que cualquier otra canción quitada.
async function replaceSong(original, suggestion) {
  const added = await addSongToPlaylist(suggestion);
  if (!added) return false;
  if (state.playlistItemMap.has(original.id)) await removeSongFromPlaylist(original);
  showToast(`Reemplazada por "${suggestion.title}".`, "success");
  return true;
}

// Buscador de "Mi Playlist": filtra en vivo por nombre o artista (sin tildes, varias palabras en cualquier orden).
let playlistSearchTimer = null;
els.playlistSearch.addEventListener("input", () => {
  clearTimeout(playlistSearchTimer);
  playlistSearchTimer = setTimeout(() => {
    state.playlistQuery = els.playlistSearch.value.trim();
    if (state.activeView === "playlist" && state.playlistSongsLoaded && state.playlistSongs.length > 0) {
      renderPlaylistView();
    }
  }, 120);
});
els.playlistSearch.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    clearPlaylistSearch();
    els.playlistSearch.blur();
    if (state.activeView === "playlist" && state.playlistSongsLoaded && state.playlistSongs.length > 0) {
      renderPlaylistView();
    }
  }
});

els.filterChip.addEventListener("click", () => {
  state.filterNonOriginal = !state.filterNonOriginal;
  els.filterChip.classList.toggle("active", state.filterNonOriginal);
  els.filterChip.setAttribute("aria-pressed", String(state.filterNonOriginal));
  if (state.activeView === "playlist" && state.playlistSongsLoaded && state.playlistSongs.length > 0) {
    renderPlaylistView();
  }
});

function buildSortedGroups() {
  let songs = state.playlistSongs.slice();
  if (state.filterNonOriginal) songs = songs.filter((s) => analyzeSong(s).flagged);
  if (state.playlistQuery) {
    const tokens = normalizeForMatch(state.playlistQuery).split(" ").filter(Boolean);
    songs = songs.filter((s) => {
      const haystack = normalizeForMatch(`${s.title} ${s.artist}`);
      return tokens.every((t) => haystack.includes(t));
    });
  }

  if (state.currentSort === "recent") {
    songs.sort((a, b) => (b.position ?? 0) - (a.position ?? 0));
    return [{ title: null, songs }];
  }

  if (state.currentSort === "title") {
    songs.sort((a, b) => a.title.localeCompare(b.title, "es"));
    return [{ title: null, songs }];
  }

  if (state.currentSort === "artist") {
    const map = new Map();
    for (const s of songs) {
      const key = s.artist || "Artista desconocido";
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(s);
    }
    const keys = [...map.keys()].sort((a, b) => a.localeCompare(b, "es"));
    return keys.map((k) => ({
      title: k,
      songs: map.get(k).sort((a, b) => a.title.localeCompare(b.title, "es")),
    }));
  }

  // "similar": agrupa por título normalizado (sin paréntesis/feat/etc.)
  const map = new Map();
  for (const s of songs) {
    const key = normalizeTitleKey(s.title);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(s);
  }
  const keys = [...map.keys()].sort((a, b) => a.localeCompare(b, "es"));
  return keys.map((k) => {
    const groupSongs = map.get(k).sort((a, b) => a.title.localeCompare(b.title, "es"));
    const label =
      groupSongs.length > 1
        ? `${groupSongs[0].title.split("(")[0].trim()} · ${groupSongs.length} versiones`
        : groupSongs[0].title;
    return { title: label, songs: groupSongs };
  });
}

function renderPlaylistView() {
  const total = state.playlistSongs.length;
  const flaggedTotal = state.playlistSongs.filter((s) => analyzeSong(s).flagged).length;
  els.filterCount.textContent = String(flaggedTotal);

  const groups = buildSortedGroups();
  const shown = groups.reduce((n, g) => n + g.songs.length, 0);
  const filtering = state.filterNonOriginal || !!state.playlistQuery;
  els.playlistViewCount.textContent = filtering
    ? `${shown} de ${total} canciones`
    : `${total} canción${total === 1 ? "" : "es"}`;
  els.playlistFilterEmpty.hidden = !(filtering && total > 0 && shown === 0);
  if (!els.playlistFilterEmpty.hidden) {
    els.playlistFilterEmpty.querySelector("p").textContent = state.playlistQuery
      ? `Ninguna canción de la playlist coincide con "${state.playlistQuery}".`
      : "No encontramos canciones sospechosas de no ser la original. ¡Tu playlist se ve limpia!";
  }

  els.playlistGroups.innerHTML = "";
  state.playlistRenderOrder = [];

  const appendPlaylistRow = (list, song, i) => {
    list.appendChild(buildSongRow(song, i, "playlist"));
    state.playlistRenderOrder.push(song);
    if (state.suggestions.has(song.id)) list.appendChild(buildSuggestionPanel(song));
  };

  for (const group of groups) {
    if (group.title) {
      const groupNode = els.groupTemplate.content.firstElementChild.cloneNode(true);
      groupNode.querySelector(".song-group-title").textContent = group.title;
      const list = groupNode.querySelector(".group-song-list");
      group.songs.forEach((song, i) => appendPlaylistRow(list, song, i));
      els.playlistGroups.appendChild(groupNode);
    } else {
      const list = document.createElement("ol");
      list.className = "song-list";
      group.songs.forEach((song, i) => appendPlaylistRow(list, song, i));
      els.playlistGroups.appendChild(list);
    }
  }

  refreshNowPlayingUI();
}

els.sortButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    els.sortButtons.forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    state.currentSort = btn.dataset.sort;
    if (state.activeView === "playlist" && state.playlistSongsLoaded) renderPlaylistView();
  });
});

// ---------- construcción de filas de canción (compartida entre ambas vistas) ----------

function buildSongRow(song, index, context) {
  const node = els.rowTemplate.content.firstElementChild.cloneNode(true);
  node.dataset.id = song.id;
  node.dataset.context = context;

  node.querySelector(".track-no").textContent = String(index + 1).padStart(2, "0");

  const img = node.querySelector(".artwork");
  img.src = song.thumbnail || "";
  img.alt = `Miniatura de ${song.title}`;

  node.querySelector(".song-title").textContent = song.title;
  node.querySelector(".song-artist").textContent = song.artist;
  node.querySelector(".song-duration").textContent = formatDuration(song.durationMs);

  const addBtn = node.querySelector(".btn-add");
  const discardBtn = node.querySelector(".btn-discard");
  const playBtn = node.querySelector(".play-btn");

  playBtn.querySelector(".play-icon").innerHTML = playPauseIcon(false);
  playBtn.addEventListener("click", () => togglePlayback(song));

  setAddButtonState(addBtn, song.id, context);
  addBtn.addEventListener("click", async () => {
    const inPlaylist = state.playlistItemMap.has(song.id);
    addBtn.disabled = true;
    addBtn.textContent = inPlaylist ? "Quitando…" : "Agregando…";
    if (inPlaylist) await removeSongFromPlaylist(song);
    else await addSongToPlaylist(song);
    addBtn.disabled = false;
  });

  if (context === "search") {
    discardBtn.addEventListener("click", () => discardSong(song.id, node));
  } else {
    discardBtn.remove();
  }

  // En "Mi Playlist": marca por qué parece no ser la original y ofrece buscar la versión del artista.
  if (context === "playlist") {
    const analysis = analyzeSong(song);
    if (analysis.flagged) {
      const badges = document.createElement("div");
      badges.className = "badge-row";
      analysis.reasons.forEach((reason) => {
        const badge = document.createElement("span");
        badge.className = "badge";
        badge.textContent = reason;
        badges.appendChild(badge);
      });
      node.querySelector(".song-meta").appendChild(badges);

      const open = state.suggestions.has(song.id);
      const suggestBtn = document.createElement("button");
      suggestBtn.type = "button";
      suggestBtn.className = "btn btn-suggest";
      suggestBtn.textContent = open ? "Ocultar sugerencias" : "Buscar original";
      suggestBtn.setAttribute("aria-expanded", String(open));
      suggestBtn.addEventListener("click", () => toggleSuggestions(song));
      node.querySelector(".song-actions").prepend(suggestBtn);
    }
  }

  return node;
}

// ---------- reproducción completa vía YouTube IFrame API ----------

let ytPlayer = null;
let ytReady = false;
let progressInterval = null;

window.onYouTubeIframeAPIReady = function () {
  ytPlayer = new YT.Player("yt-player-target", {
    height: "2",
    width: "2",
    playerVars: { autoplay: 0, controls: 0, disablekb: 1, playsinline: 1 },
    events: {
      onReady: onPlayerReady,
      onStateChange: onPlayerStateChange,
    },
  });
};

function onPlayerReady() {
  ytReady = true;
  if (state.pendingSong) {
    const song = state.pendingSong;
    state.pendingSong = null;
    loadAndPlay(song);
  }
}

function onPlayerStateChange(event) {
  const playing = event.data === YT.PlayerState.PLAYING;
  refreshNowPlayingUI();

  if (playing) startProgressPolling();
  else stopProgressPolling();

  if (event.data === YT.PlayerState.ENDED) {
    if (mini.seek) mini.seek.value = "0";
    if (mini.timeCurrent) mini.timeCurrent.textContent = "0:00";
  }
}

function startProgressPolling() {
  stopProgressPolling();
  progressInterval = setInterval(() => {
    if (isDraggingSeek || !ytPlayer || typeof ytPlayer.getCurrentTime !== "function") return;
    const duration = ytPlayer.getDuration() || 0;
    const current = ytPlayer.getCurrentTime() || 0;
    if (mini.seek) mini.seek.value = duration ? String((current / duration) * 1000) : "0";
    if (mini.timeCurrent) mini.timeCurrent.textContent = formatTime(current);
    if (mini.timeTotal) mini.timeTotal.textContent = formatTime(duration);

    if (state.previewMode && current >= state.previewEnd) {
      ytPlayer.pauseVideo();
    }
  }, 400);
}

function stopProgressPolling() {
  if (progressInterval) clearInterval(progressInterval);
  progressInterval = null;
}

// Aproxima el "highlight" de 30s: YouTube no expone dónde está el hook real de
// la canción, así que saltamos un cuarto de la duración (para evitar la intro)
// y reproducimos 30 segundos desde ahí. Es una heurística, no un dato exacto.
function calcPreviewWindow(durationMs) {
  const durationSec = (durationMs || 0) / 1000;
  if (!durationSec || durationSec <= 40) {
    return { start: 0, end: durationSec || 30 };
  }
  const start = Math.min(Math.max(Math.round(durationSec * 0.25), 8), durationSec - 35);
  return { start, end: Math.min(start + 30, durationSec) };
}

function playPauseIcon(playing) {
  return playing
    ? '<svg viewBox="0 0 20 20" width="16" height="16"><rect x="4" y="3" width="4" height="14" fill="currentColor"/><rect x="12" y="3" width="4" height="14" fill="currentColor"/></svg>'
    : '<svg viewBox="0 0 20 20" width="16" height="16"><polygon points="5,3 17,10 5,17" fill="currentColor"/></svg>';
}

// Refleja el estado real de reproducción en TODAS las filas visibles (ambas vistas)
// y en el mini-reproductor. Reemplaza el viejo esquema de "guardar el botón activo",
// que se rompía al cambiar de vista.
function refreshNowPlayingUI() {
  const activeId = state.activeSongId;
  const playing = !!(
    ytReady &&
    ytPlayer &&
    ytPlayer.getPlayerState &&
    ytPlayer.getPlayerState() === YT.PlayerState.PLAYING
  );

  document.querySelectorAll(".song-row").forEach((row) => {
    const isActive = row.dataset.id === activeId;
    row.classList.toggle("now-playing", isActive && playing);
    const btn = row.querySelector(".play-btn");
    if (!btn) return;
    btn.classList.toggle("loaded", isActive);
    btn.classList.toggle("playing", isActive && playing);
    const icon = btn.querySelector(".play-icon");
    if (icon) icon.innerHTML = playPauseIcon(isActive && playing);
  });

  if (mini.artIcon) mini.artIcon.innerHTML = playPauseIcon(playing);
  if (mini.card) mini.card.classList.toggle("is-playing", playing);
  setPlayerCollapsedIcon(playing);
}

function formatTime(seconds) {
  if (!isFinite(seconds) || seconds < 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60)
    .toString()
    .padStart(2, "0");
  return `${m}:${s}`;
}

function stopPlayback() {
  if (ytPlayer && typeof ytPlayer.stopVideo === "function") ytPlayer.stopVideo();
  stopProgressPolling();
  state.activeSongId = null;
  state.pendingSong = null;
  state.previewMode = false;
  refreshNowPlayingUI();
  if (mini.dock) mini.dock.hidden = true;
}

function loadAndPlay(song) {
  state.activeSongId = song.id;

  const { start, end } = calcPreviewWindow(song.durationMs);
  state.previewMode = true;
  state.previewStart = start;
  state.previewEnd = end;

  if (!ytReady) {
    state.pendingSong = song;
    showMiniPlayer(song);
    refreshNowPlayingUI();
    return;
  }

  ytPlayer.loadVideoById({ videoId: song.id, startSeconds: start });
  showMiniPlayer(song);
  refreshNowPlayingUI();
}

function togglePlayback(song) {
  if (state.activeSongId === song.id) {
    if (!ytReady || !ytPlayer) return;
    const playerState = ytPlayer.getPlayerState ? ytPlayer.getPlayerState() : -1;
    if (playerState === YT.PlayerState.PLAYING) ytPlayer.pauseVideo();
    else ytPlayer.playVideo();
    return;
  }
  loadAndPlay(song);
}

// Reproduce la canción siguiente/anterior según el orden visible en la vista activa.
// Si estamos en la búsqueda y no quedan más cargadas pero hay más páginas, las trae primero.
async function playRelative(offset) {
  const list = state.activeView === "playlist" ? state.playlistRenderOrder : state.songs;
  if (list.length === 0) {
    showToast("No hay canciones en esta lista todavía.");
    return;
  }

  let idx = list.findIndex((s) => s.id === state.activeSongId);
  if (idx === -1) idx = offset > 0 ? -1 : 0;
  const nextIdx = idx + offset;

  if (nextIdx < 0) {
    showToast("Ya estás en la primera canción.");
    return;
  }

  if (nextIdx >= list.length) {
    if (state.activeView === "search" && state.songsNextPageToken && !state.loadingMoreSongs) {
      await loadSongsPage();
      return playRelative(offset);
    }
    showToast("No hay más canciones para reproducir.");
    return;
  }

  loadAndPlay(list[nextIdx]);
}

// ---------- mini-reproductor (panel lateral, se puede ocultar sin detener el audio) ----------

const mini = {
  dock: document.getElementById("player-dock"),
  card: document.getElementById("player-card"),
  fab: document.getElementById("player-fab"),
  fabIcon: document.getElementById("player-fab-icon"),
  art: document.getElementById("player-art"),
  artBtn: document.getElementById("player-art-btn"),
  artIcon: document.getElementById("player-art-icon"),
  title: document.getElementById("player-title"),
  artist: document.getElementById("player-artist"),
  seek: document.getElementById("player-seek"),
  timeCurrent: document.getElementById("player-time-current"),
  timeTotal: document.getElementById("player-time-total"),
  volume: document.getElementById("player-volume"),
  hideBtn: document.getElementById("player-hide-btn"),
  previewRow: document.getElementById("player-preview-row"),
  previewLabel: document.getElementById("player-preview-label"),
  fullBtn: document.getElementById("player-full-btn"),
};

function showMiniPlayer(song) {
  mini.dock.hidden = false;
  mini.card.hidden = false;
  mini.fab.hidden = true;
  mini.art.src = song.thumbnail || "";
  mini.art.alt = `Miniatura de ${song.title}`;
  mini.title.textContent = song.title;
  mini.artist.textContent = song.artist;
  updatePreviewUI();
}

function updatePreviewUI() {
  if (!mini.previewRow) return;
  mini.previewRow.hidden = !state.previewMode;
  if (state.previewMode && mini.previewLabel) {
    mini.previewLabel.textContent = `Vista previa · ${formatTime(state.previewStart)}–${formatTime(state.previewEnd)}`;
  }
}

if (mini.fullBtn) {
  mini.fullBtn.addEventListener("click", () => {
    state.previewMode = false;
    updatePreviewUI();
    if (ytReady && ytPlayer.getPlayerState && ytPlayer.getPlayerState() !== YT.PlayerState.PLAYING) {
      ytPlayer.playVideo();
    }
  });
}

function setPlayerCollapsed(collapsed) {
  mini.card.hidden = collapsed;
  mini.fab.hidden = !collapsed;
  if (collapsed) {
    const playing = ytReady && ytPlayer.getPlayerState && ytPlayer.getPlayerState() === YT.PlayerState.PLAYING;
    setPlayerCollapsedIcon(playing);
  }
}

function setPlayerCollapsedIcon(playing) {
  if (mini.fabIcon && !mini.fab.hidden) mini.fabIcon.innerHTML = playPauseIcon(playing);
}

if (mini.artBtn) {
  mini.artBtn.addEventListener("click", () => {
    if (!state.activeSongId || !ytReady) return;
    const playerState = ytPlayer.getPlayerState ? ytPlayer.getPlayerState() : -1;
    if (playerState === YT.PlayerState.PLAYING) ytPlayer.pauseVideo();
    else ytPlayer.playVideo();
  });
}

if (mini.hideBtn) mini.hideBtn.addEventListener("click", () => setPlayerCollapsed(true));
if (mini.fab) mini.fab.addEventListener("click", () => setPlayerCollapsed(false));

let isDraggingSeek = false;

if (mini.seek) {
  mini.seek.addEventListener("input", () => {
    isDraggingSeek = true;
    if (!ytReady) return;
    const duration = ytPlayer.getDuration() || 0;
    mini.timeCurrent.textContent = formatTime((Number(mini.seek.value) / 1000) * duration);
  });
  mini.seek.addEventListener("change", () => {
    if (ytReady) {
      const duration = ytPlayer.getDuration() || 0;
      ytPlayer.seekTo((Number(mini.seek.value) / 1000) * duration, true);
    }
    isDraggingSeek = false;
    if (state.previewMode) {
      state.previewMode = false;
      updatePreviewUI();
    }
  });
}

if (mini.volume) {
  mini.volume.addEventListener("input", () => {
    if (ytReady) ytPlayer.setVolume(Number(mini.volume.value) * 100);
  });
}

// ---------- atajos de teclado ----------
//  Tab            -> siguiente canción (según la vista activa)
//  Shift+Tab       -> canción anterior
//  Espacio         -> pausar/reanudar la canción activa
//  Enter           -> agregar la canción activa a la playlist elegida
//  Backspace       -> quitar la canción activa de la playlist
//  ← / →           -> retroceder / adelantar 5 segundos
//  ↑ / ↓           -> subir / bajar volumen
//  M               -> silenciar / restaurar volumen
//  /               -> (en Mi Playlist) ir al buscador de la playlist
//  Esc             -> ocultar el mini-reproductor (la canción sigue sonando)

function isTypingContext(target) {
  const tag = (target?.tagName || "").toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" || target?.isContentEditable;
}

let mutedVolume = null;

function seekBy(deltaSeconds) {
  if (!ytReady || !state.activeSongId) return;
  const duration = ytPlayer.getDuration() || 0;
  const newTime = Math.min(Math.max((ytPlayer.getCurrentTime() || 0) + deltaSeconds, 0), duration);
  ytPlayer.seekTo(newTime, true);
  if (state.previewMode) {
    state.previewMode = false;
    updatePreviewUI();
  }
}

function changeVolume(delta) {
  if (!mini.volume) return;
  const newVal = Math.min(Math.max(Number(mini.volume.value) + delta, 0), 1);
  mini.volume.value = String(newVal);
  if (ytReady) ytPlayer.setVolume(newVal * 100);
}

function toggleMute() {
  if (!ytReady || !mini.volume) return;
  if (mutedVolume === null) {
    mutedVolume = Number(mini.volume.value);
    mini.volume.value = "0";
    ytPlayer.setVolume(0);
    showToast("Silenciado — presiona M para reactivar el volumen.");
  } else {
    mini.volume.value = String(mutedVolume);
    ytPlayer.setVolume(mutedVolume * 100);
    mutedVolume = null;
  }
}

document.addEventListener("keydown", (e) => {
  if (isTypingContext(e.target)) return;

  switch (e.key) {
    case "Tab":
      e.preventDefault();
      playRelative(e.shiftKey ? -1 : 1);
      break;
    case "Enter": {
      e.preventDefault();
      const song = getSongObjectById(state.activeSongId);
      if (!song) {
        showToast("No hay ninguna canción sonando.", "error");
        break;
      }
      addSongToPlaylist(song);
      break;
    }
    case "Backspace": {
      e.preventDefault();
      const song = getSongObjectById(state.activeSongId);
      if (!song) {
        showToast("No hay ninguna canción sonando.", "error");
        break;
      }
      removeSongFromPlaylist(song);
      break;
    }
    case " ": {
      e.preventDefault();
      const song = getSongObjectById(state.activeSongId);
      if (!song) break;
      togglePlayback(song);
      break;
    }
    case "ArrowRight":
      e.preventDefault();
      seekBy(5);
      break;
    case "ArrowLeft":
      e.preventDefault();
      seekBy(-5);
      break;
    case "ArrowUp":
      e.preventDefault();
      changeVolume(0.05);
      break;
    case "ArrowDown":
      e.preventDefault();
      changeVolume(-0.05);
      break;
    case "m":
    case "M":
      toggleMute();
      break;
    case "/":
      if (state.activeView === "playlist") {
        e.preventDefault();
        els.playlistSearch.focus();
        els.playlistSearch.select();
      }
      break;
    case "Escape":
      if (mini.dock && !mini.dock.hidden && !mini.card.hidden) setPlayerCollapsed(true);
      break;
    default:
      break;
  }
});

// ---------- arranque ----------

handleAuthRedirectParams();
refreshAuthStatus();
