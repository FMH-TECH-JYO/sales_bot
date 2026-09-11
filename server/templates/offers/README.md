# Offer templates

`server/src/services/generateOffer.js` reads the `.docx` offer templates from
this directory.

| File | Used for |
|------|----------|
| `pressure_gauge.docx` | **The company-wide fallback.** Every category with no override renders through this. `generateOffer.js` names it `COMMON_TEMPLATE_FILE`. |
| `<category_id>.docx` | Optional per-category override. The filename must match `products.category_id` exactly — `level_gauge.docx`, `smart_dp_transmitter.docx`, and so on. |

## Where `pressure_gauge.docx` came from

It is **your own `Format.docx`**, with `{{placeholder}}` tags put where the
values go. Nothing was redrawn or re-typed:

* The letterhead, the covering letter, the "We Can Also Support You With…"
  product-family table and the whole commercial-terms table are copied from
  `Format.docx` untouched — same fonts, borders, images and wording.
* The specification table and the price table are the ones from
  `Technocommercial offer.docx`, copied **as XML** so they look exactly like
  the tables the team already sends, then emptied of that example's values.

It was built by a script (`build_template.py`, delivered alongside) rather than
edited by hand, so if `Format.docx` is ever revised the script can be re-run
against the new version and the tags land in the same places. The script fails
loudly if a marker it expects has been reworded, because a marker that silently
stops matching means a field a sales engineer then has to type into every
single offer.

**It carries no customer data.** `Format.docx` is a blank shell, and every
value from the worked example — model SP, EN 837-1, 150 mm, the ₹1450 unit
price, the "Please specify" tag rows — was replaced with a tag. This is checked
by `server/test/generateOffer.test.js`.

## How the tags work

`GET /offers/fields/:productId` reads the tag names out of whichever template
file it resolves and reports two lists: what the catalogue can already fill,
and what the sales engineer must supply. Nothing is hardcoded per category —
adding a new product family's offer format means dropping in a new `.docx`,
not writing code.

Tag names are not arbitrary. `matchExtraSpecsToTags()` resolves a tag against
`product_extra_spec` rows by normalising both sides — lowercase, strip
non-alphanumerics, strip a trailing digit — so `{{dial_size1}}` matches a
catalogue spec labelled "Dial Size" and `{{bourdon_socket1}}` matches
"Bourdon & Socket".

**Eight tags are filled straight from the `products` row** by
`autoFillFromProduct()` and must keep exactly these names:

```
date  customer_name  model1  range1  accuracy1  connection1  process_temperature1  qty1
```

Renaming one of those does not break the build — it silently stops
auto-filling, and the engineer is asked to retype something the catalogue
already knows. `server/test/generateOffer.test.js` asserts each one is still
present in the template.

## Known limitation

The tags are numbered for a **single line item** (`model1`, `range1`, `qty1`).
That matches the current API: `POST /offers/generate` takes one `productId`.
An offer covering several different products needs either a docxtemplater loop
(`{{#items}}…{{/items}}`) in the template plus a matching change in
`renderOffer()`, or one document per product. Do not work around it by adding
`model2`, `model3` … — that is the hardcoding this design exists to avoid.

## Before you change the file

An offer template is a customer-facing commercial document. If you edit it
directly in Word rather than re-running the build script, keep each
`{{tag}}` inside a **single run** — Word silently splits a line into runs at
formatting and spell-check boundaries, and a tag split as `{{mod` + `el1}}`
is invisible to docxtemplater and renders as literal braces on the customer's
offer. Retyping a tag in one go, without moving the cursor mid-word, is usually
enough. Then run `npm test` — the offer tests will catch a broken tag.
