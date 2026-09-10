# Offer templates

`server/src/services/generateOffer.js` looks for the `.docx` offer templates in
this directory. **They are not in the repository**, which is why every offer
request currently answers *"No offer template uploaded yet for category X"* —
the last step of the enquiry-to-offer flow cannot run.

## What has to go here

| File | Used for |
|------|----------|
| `pressure_gauge.docx` | **Required.** The company-wide fallback used for every category that has no override. `generateOffer.js` names it `COMMON_TEMPLATE_FILE`. |
| `<category_id>.docx` | Optional per-category override. The name must match `products.category_id` exactly — `level_gauge.docx`, `smart_dp_transmitter.docx`, and so on. |

## Where they come from

The two source documents supplied during development were:

* **Format.docx** — the official Forbes Marshall offer format.
* **Technocommercial offer.docx** — the worked example whose content varies per
  product.

Neither was committed. Turning them into a template means saving a copy with
docxtemplater placeholders in place of the values: `{{model1}}`, `{{range1}}`,
`{{dialsize1}}` and the rest of the tag set. `GET /offers/fields/:productId`
reads the placeholders out of whichever file it finds here and reports which of
them the catalogue can already fill and which the sales engineer must supply —
nothing is hardcoded per category, so adding a template is the whole
integration.

## Why they are not committed yet, and what to check before committing them

An offer template is a customer-facing legal document containing commercial
terms. Before it goes into version control, confirm with whoever owns the
format that the file carries no customer names, no live prices, and no terms
that should not travel with the source code. If it must stay out of git, mount
this directory as a volume in deployment and set the mount path in DEPLOY.md —
but do not leave it empty, because an empty directory here is indistinguishable
at runtime from a missing feature.

This README exists so the directory itself is tracked: the Docker build copies
`server/templates`, and `checkProductionPrerequisites()` in
`server/src/preflight.js` warns loudly at startup when no `.docx` is present.
