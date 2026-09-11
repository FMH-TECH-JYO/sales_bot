#!/usr/bin/env python3
"""
Build server/templates/offers/pressure_gauge.docx from the company's own
Format.docx, by putting {{placeholder}} tags where the values go.

Why this script exists rather than a hand-edited file: the template has to be
reproducible. If Format.docx is revised — new terms, new branding, a new
product-family table — this is re-run against the new version and the tags land
in the same places, instead of someone re-doing the edits by hand and quietly
getting one of them wrong.

Two source documents:
  Format.docx  — the official offer shell: letterhead, covering letter, the
                 product-family table and the commercial terms. Layout, fonts,
                 borders and branding all come from here untouched.
  Techno.docx  — a worked techno-commercial offer. Its specification table and
                 its price table are COPIED AS XML into the shell, so the
                 generated offer's tables look exactly like the ones the team
                 already sends, rather than like something python-docx drew.

Tag naming is not arbitrary. server/src/services/generateOffer.js resolves a
tag against product_extra_spec rows by normalising both sides — lowercase,
strip non-alphanumerics, strip a trailing digit. So {{dial_size1}} matches a
catalogue spec labelled "Dial Size", and {{bourdon_socket1}} matches
"Bourdon & Socket". Six tags are filled straight from the products row by
autoFillFromProduct() and must keep exactly these names: model1, range1,
accuracy1, connection1, process_temperature1, qty1 (plus date and
customer_name). Renaming any of those silently stops it auto-filling and the
sales engineer is asked to retype something the catalogue already knows.
"""

import copy
import re
import sys
from pathlib import Path

from docx import Document
from docx.oxml.ns import qn

HERE = Path(__file__).parent
FORMAT_DOCX = HERE / "Format.docx"
TECHNO_DOCX = HERE / "Techno.docx"
OUT = HERE / "pressure_gauge.docx"

# --- letter fields -----------------------------------------------------------
# (marker found in Format.docx, replacement text). Matched on a normalised
# form so the ellipsis characters the original uses ("…...", "………..") do not
# have to be reproduced exactly.
LETTER_REPLACEMENTS = [
    (r"^Offer\s*No.*$",            "Offer No: {{offer_no}}"),
    (r"^Date\s*:.*$",              "Date: {{date}}"),
    # "Customer Name / Address:" and "Name / Designation" are ONE paragraph
    # each in Format.docx, with a line break inside. They are handled by
    # MULTILINE_REPLACEMENTS below, because a single run containing "\n" does
    # not render as a line break in Word — it needs a real <w:br/>.
    (r"^Kind Attn\s*:.*$",         "Kind Attn : {{kind_attn}}"),
    (r"^Sub\s*:\s*OFFER FOR.*$",   "Sub: OFFER FOR {{subject}}"),
    (r"^Enquiry Reference\s*:.*$", "Enquiry Reference: {{enquiry_reference}}"),
]

# --- specification table -----------------------------------------------------
# Label text is the company's own wording, kept verbatim. Only the VALUE column
# becomes a tag.
SPEC_ROWS = [
    ("Model",                            "{{model1}}"),                    # auto
    ("Reference standard",               "{{reference_standard1}}"),
    ("Dial Size",                        "{{dial_size1}}"),
    ("Dial",                             "{{dial1}}"),
    ("Case & Bezel",                     "{{case_bezel1}}"),
    ("Window",                           "{{window1}}"),
    ("Bourdon & Socket (Wetted parts)",  "{{bourdon_socket1}}"),
    ("Movement",                         "{{movement1}}"),
    ("Process Connection Size",          "{{process_connection_size1}}"),
    ("Process Connection",               "{{connection1}}"),               # auto
    ("Mounting",                         "{{mounting1}}"),
    ("Instrument Range",                 "{{range1}}"),                    # auto
    ("Instrument Scale",                 "{{instrument_scale1}}"),
    ("Accuracy",                         "{{accuracy1}}"),                 # auto
    ("Over pressure limit",              "{{over_pressure_limit1}}"),
    ("Pointer",                          "{{pointer1}}"),
    ("Blow out Disc",                    "{{blow_out_disc1}}"),
    ("Case Filling",                     "{{case_filling1}}"),
    ("Gasket",                           "{{gasket1}}"),
    ("Ambient temperature",              "{{ambient_temperature1}}"),
    ("Process temperature",              "{{process_temperature1}}"),      # auto
    ("Certification",                    "{{certification1}}"),
    ("Quantity",                         "As per below table"),
    ("Unit Price",                       "As per below table"),
    ("Total",                            "As per below table"),
]

# Paragraphs that hold two lines separated by a break. Each entry is
# (regex matching the paragraph's first line, [line1, line2]).
MULTILINE_REPLACEMENTS = [
    (r"^Customer Name", ["{{customer_name}}", "{{customer_address}}"]),
    # The paragraph's literal text is "Name\nDesignation" — two lines in one
    # paragraph — so the pattern has to span the break. "^Name$" matched
    # nothing and the field was silently left as the word "Name" on every offer.
    (r"^Name\s*\n\s*Designation", ["{{attn_name}}", "{{attn_designation}}"]),
]

PRICE_HEADER = ["Tag No", "Range", "Unit Price in Rs", "Qty", "Total"]
PRICE_ROW = ["{{tag_no1}}", "{{range1}}", "{{unit_price1}}", "{{qty1}}", "{{line_total1}}"]
PRICE_TOTAL = ["", "", "Total", "{{qty1}}", "{{line_total1}}"]


def set_text_single_run(paragraph, text):
    """Replace a paragraph's text with ONE run, keeping the first run's formatting.

    A single run is not cosmetic here, it is required. Word splits a line into
    runs at every formatting or spell-check boundary, so a hand-typed
    "{{model1}}" can end up as "{{mod" + "el1}}" in the XML. docxtemplater
    matches tags inside a run and would never see it — the tag renders as
    literal braces in the customer's offer. Collapsing to one run makes that
    impossible by construction.
    """
    runs = paragraph.runs
    if runs:
        keep = runs[0]
        keep.text = text
        for r in runs[1:]:
            r._element.getparent().remove(r._element)
    else:
        paragraph.add_run(text)


def set_cell_text(cell, text):
    """Write one paragraph of text into a table cell, formatting preserved."""
    paragraphs = cell.paragraphs
    set_text_single_run(paragraphs[0], text)
    for p in paragraphs[1:]:
        p._element.getparent().remove(p._element)


def set_two_lines(paragraph, first, second):
    """Two tags separated by a real line break, in one paragraph."""
    runs = paragraph.runs
    if runs:
        keep = runs[0]
        keep.text = first
        for r in runs[1:]:
            r._element.getparent().remove(r._element)
    else:
        keep = paragraph.add_run(first)
    keep.add_break()
    # Same run object, so the second line inherits the first's formatting.
    keep.add_text(second)


def apply_letter_replacements(doc):
    """Returns the number of markers replaced, so a silent miss is impossible."""
    applied = 0
    for paragraph in doc.paragraphs:
        text = paragraph.text.strip()
        if not text:
            continue

        matched = False
        for pattern, lines in MULTILINE_REPLACEMENTS:
            if re.match(pattern, text, flags=re.IGNORECASE):
                set_two_lines(paragraph, lines[0], lines[1])
                applied += 1
                matched = True
                break
        if matched:
            continue

        for pattern, replacement in LETTER_REPLACEMENTS:
            if re.match(pattern, text, flags=re.IGNORECASE):
                set_text_single_run(paragraph, replacement)
                applied += 1
                break
    return applied


def build_spec_table(source_table):
    """Copy the worked spec table's XML and rewrite it to tags."""
    new_tbl = copy.deepcopy(source_table._tbl)
    from docx.table import Table
    table = Table(new_tbl, source_table._parent)

    # Row 0 is the merged product banner.
    set_cell_text(table.rows[0].cells[0], "{{product_title}}")

    for index, (label, tag) in enumerate(SPEC_ROWS, start=1):
        if index >= len(table.rows):
            raise SystemExit(
                f"The source spec table has {len(table.rows)} rows but "
                f"{len(SPEC_ROWS) + 1} are needed. Techno.docx has changed shape; "
                "update SPEC_ROWS or pick a different source table."
            )
        row = table.rows[index]
        set_cell_text(row.cells[0], label)
        set_cell_text(row.cells[1], "-")
        set_cell_text(row.cells[2], tag)

    # Drop any rows the worked example had that this template does not use,
    # rather than leaving someone else's leftover values in the file.
    for row in list(table.rows[len(SPEC_ROWS) + 1:]):
        row._tr.getparent().remove(row._tr)

    return new_tbl


def build_price_table(source_table):
    new_tbl = copy.deepcopy(source_table._tbl)
    from docx.table import Table
    table = Table(new_tbl, source_table._parent)

    wanted = [PRICE_HEADER, PRICE_ROW, PRICE_TOTAL]
    for index, values in enumerate(wanted):
        row = table.rows[index]
        for cell, value in zip(row.cells, values):
            set_cell_text(cell, value)

    for row in list(table.rows[len(wanted):]):
        row._tr.getparent().remove(row._tr)

    return new_tbl


def main():
    if not FORMAT_DOCX.exists() or not TECHNO_DOCX.exists():
        sys.exit(f"Need both {FORMAT_DOCX.name} and {TECHNO_DOCX.name} in {HERE}")

    shell = Document(FORMAT_DOCX)
    worked = Document(TECHNO_DOCX)

    applied = apply_letter_replacements(shell)
    expected = len(LETTER_REPLACEMENTS) + len(MULTILINE_REPLACEMENTS)
    if applied < expected:
        # Loud, not silent: a marker that stopped matching means a field the
        # sales engineer will have to type by hand into every offer, and the
        # only symptom is a literal "Offer No…..." on a customer document.
        sys.exit(
            f"Only {applied}/{expected} letter markers matched. Format.docx has "
            "changed wording — update LETTER_REPLACEMENTS before shipping this template."
        )

    spec_tbl = build_spec_table(worked.tables[1])
    price_tbl = build_price_table(worked.tables[2])

    # Insert both tables directly after the "TECHNO-COMMERCIAL BID" heading.
    anchor = None
    for paragraph in shell.paragraphs:
        if paragraph.text.strip().upper().startswith("TECHNO-COMMERCIAL BID"):
            anchor = paragraph
            break
    if anchor is None:
        sys.exit("Could not find the TECHNO-COMMERCIAL BID heading in Format.docx.")

    anchor._p.addnext(price_tbl)
    anchor._p.addnext(spec_tbl)

    # Format.docx leaves ~29 empty paragraphs after that heading as the space
    # the tables were meant to occupy. Left in place they push the commercial
    # terms three pages down. Removed here, AFTER the insert, so the tables
    # land in the right position first.
    body_children = list(shell.element.body.iterchildren())
    seen_price_table = False
    removed = 0
    for child in body_children:
        if child is price_tbl:
            seen_price_table = True
            continue
        if not seen_price_table:
            continue
        if child.tag == qn("w:p"):
            from docx.text.paragraph import Paragraph
            if Paragraph(child, shell).text.strip() == "":
                child.getparent().remove(child)
                removed += 1
                if removed >= 25:
                    break
            else:
                break
        else:
            break

    shell.save(OUT)
    print(f"Wrote {OUT}")
    print(f"  letter markers replaced : {applied}")
    print(f"  spec rows               : {len(SPEC_ROWS)}")
    print(f"  blank paragraphs removed: {removed}")


if __name__ == "__main__":
    main()
