// web/src/api.js
//
// Every backend call in the app goes through here. If the API base URL or
// error-handling convention ever changes, this is the only file that needs
// to change.

const BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:4000';

async function request(path, options = {}) {
  const res = await fetch(`${BASE_URL}${path}`, options);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed: ${res.status}`);
  }
  return res.json();
}

export const api = {
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
    const res = await fetch(`${BASE_URL}/offers/fields/${productId}`);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(body.error || `Request failed: ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return body;
  },
  generateOfferDocx: async ({ productId, customerName, date, qty, fields }) => {
    const res = await fetch(`${BASE_URL}/offers/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productId, customerName, date, qty, fields }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `Request failed: ${res.status}`);
    }
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
  fileUrl: (id) => `${BASE_URL}/catalogue-uploads/${id}/file`,
};
