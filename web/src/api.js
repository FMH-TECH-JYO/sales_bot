// web/src/api.js
//
// Every backend call in the app goes through here. If the API base URL or
// error-handling convention ever changes, this is the only file that needs
// to change.

const BASE_URL = import.meta.env.VITE_API_BASE_URL !== undefined
  ? import.meta.env.VITE_API_BASE_URL          // '' means "same origin" — a valid setting
  : 'http://localhost:4000';                   // dev default when the var isn't set at all

// Every request carries the session cookie, and every request carries
// X-Requested-With.
//
//  * credentials: 'include' is required because the cookie is HttpOnly — the
//    app cannot read it and attach it by hand, which is the point: an XSS
//    payload cannot read it either. In development the API is on :4000 and
//    Vite on :5173, so this is a cross-origin request and fetch omits cookies
//    by default unless asked.
//  * X-Requested-With is the CSRF control. A cross-site form post or <img>
//    cannot set a custom header at all, and a cross-site fetch that tries is
//    forced into a preflight the server's origin allowlist refuses. The server
//    requires this header on every cookie-authenticated write; see
//    server/src/middleware/auth.js.
//
// A 401 anywhere means the session is gone (expired, revoked, or the server
// restarted with a fresh database). onUnauthorized lets AppContext react to
// that centrally — dropping the user back to the login screen — instead of
// each page inventing its own handling.
let onUnauthorized = null;
export function setUnauthorizedHandler(fn) { onUnauthorized = fn; }

function withCredentials(options = {}) {
  return {
    ...options,
    credentials: 'include',
    headers: { 'X-Requested-With': 'fetch', ...(options.headers || {}) },
  };
}

async function handle(res) {
  if (res.ok) return res;

  const body = await res.json().catch(() => ({}));

  // Only the auth guard's own 401 means "your session ended". A controller can
  // answer 401 for its own reasons — /auth/password does, for a wrong CURRENT
  // password — and treating that as session loss would eject someone from the
  // app for a typo. The server stamps code: 'UNAUTHENTICATED' on the one that
  // actually means sign in again.
  if (res.status === 401 && body.code === 'UNAUTHENTICATED' && onUnauthorized) onUnauthorized();

  const err = new Error(body.error || `Request failed: ${res.status}`);
  err.status = res.status;
  err.code = body.code;
  throw err;
}

async function request(path, options = {}) {
  const res = await handle(await fetch(`${BASE_URL}${path}`, withCredentials(options)));
  return res.json();
}

export const api = {
  // --- authentication ---
  // The server sets an HttpOnly cookie; the token in the response body is for
  // non-browser clients and is deliberately ignored here. Putting it in
  // localStorage would hand it to any XSS payload and undo HttpOnly.
  login: (email, password) =>
    request('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    }),
  logout: () => request('/auth/logout', { method: 'POST' }),
  me: () => request('/auth/me'),
  changePassword: (currentPassword, newPassword) =>
    request('/auth/password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword, newPassword }),
    }),
  listUsers: () => request('/auth/users'),
  createUser: (payload) =>
    request('/auth/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  updateUser: (id, payload) =>
    request(`/auth/users/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),

  // --- enquiry history (persisted since migration 004) ---
  getEnquiries: (limit = 50, offset = 0) => request(`/enquiries?limit=${limit}&offset=${offset}`),
  getEnquiry: (id) => request(`/enquiries/${id}`),
  getOffers: (limit = 50) => request(`/offers?limit=${limit}`),

  getCategories: () => request('/categories'),
  createCategory: (payload) =>
    request('/categories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),

  getProducts: (category) => request(`/products${category ? `?category=${category}` : ''}`),
  getProduct: (id) => request(`/products/${id}`),
  catalogueUrl: (productId) => `${BASE_URL}/products/${productId}/catalogue`,

  // The real matching pipeline: server fetches the relevant category's
  // published catalogue products and asks the LLM (Ollama) to score them
  // against the enquiry text. No client-side matching logic anymore.
  //
  // A single call can return MULTIPLE enquiries' worth of results — the
  // server splits an uploaded Excel/PDF (or a typed multi-item message)
  // into one match set per enquiry it finds. Response shape:
  // { text, items: [...], itemCount, splitMethod, fileWarning? }
  //
  // `file`, when given, is the one attachment whose CONTENT drives matching
  // (a File object — PDF or Excel). Other attachments are still listed by
  // name only via attachmentNames, same as before.
  matchEnquiry: (text, attachmentNames, file) => {
    if (file) {
      const form = new FormData();
      form.append('text', text || '');
      form.append('file', file);
      if (attachmentNames?.length) form.append('attachmentNames', JSON.stringify(attachmentNames));
      return request('/enquiries/match', { method: 'POST', body: form });
    }
    return request('/enquiries/match', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, attachmentNames }),
    });
  },

  // Offer generation — fills the real .docx template for the product's
  // category. getOfferFields tells the frontend which placeholders that
  // specific template needs (nothing hardcoded per category); generateOfferDocx
  // returns the actual rendered file as a Blob for direct download.
  getOfferFields: async (productId) => {
    // Not routed through request(): a 404 here is expected and meaningful
    // ("no offer template for this category"), so the caller needs the parsed
    // body on failure, which handle() does not hand back.
    const res = await fetch(`${BASE_URL}/offers/fields/${productId}`, withCredentials());
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 401 && body.code === 'UNAUTHENTICATED' && onUnauthorized) onUnauthorized();
      const err = new Error(body.error || `Request failed: ${res.status}`);
      err.status = res.status;
      err.code = body.code;
      throw err;
    }
    return body;
  },
  generateOfferDocx: async ({ productId, customerName, date, qty, fields }) => {
    const res = await handle(await fetch(`${BASE_URL}/offers/generate`, withCredentials({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productId, customerName, date, qty, fields }),
    })));
    const blob = await res.blob();
    const disposition = res.headers.get('Content-Disposition') || '';
    const match = /filename="?([^"]+)"?/.exec(disposition);
    return { blob, filename: match ? match[1] : 'Offer.docx' };
  },

  getUploads: (status) => request(`/catalogue-uploads${status ? `?status=${status}` : ''}`),
  getUpload: (id) => request(`/catalogue-uploads/${id}`),
  uploadFile: (file, categoryId) => {
    const form = new FormData();
    form.append('file', file);
    if (categoryId) form.append('category_id', categoryId);
    return request('/catalogue-uploads', { method: 'POST', body: form });
  },
  updateDraft: (id, payload) =>
    request(`/catalogue-uploads/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  retryDraft: (id, categoryId) =>
    request(`/catalogue-uploads/${id}/retry-draft`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(categoryId ? { category_id: categoryId } : {}),
    }),
  publish: (id) =>
    request(`/catalogue-uploads/${id}/publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }),
  reject: (id) =>
    request(`/catalogue-uploads/${id}/reject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }),
  reopen: (id) =>
    request(`/catalogue-uploads/${id}/reopen`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }),
  fileUrl: (id) => `${BASE_URL}/catalogue-uploads/${id}/file`,
};