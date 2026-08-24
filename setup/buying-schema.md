# Buying stage: sheet schema

Intake answers "what did customers ask for." Buying answers "what do we purchase,
from whom, by when." That needs the sheet to be product-shaped and vendor-shaped,
which it currently is not.

Add these tabs. Headers go in row 1, one per cell, spelled exactly - the write
path maps rows to columns by name and rejects unknown keys.

## Products  (build first - everything depends on it)

    product_id | common_name | aliases | category | default_unit |
    stems_per_bunch | shrink_pct | notes

`aliases` is the load-bearing column. Tickets are handwritten free text, and the
same flower arrives as "White Sprays" and "Yellow Spray roses". Grouping is only
as good as this list, so it grows every time intake meets a name it cannot map.

`product_id` is a slug: `garden-rose`, `spray-rose`, `ranunculus`. Colour and
variety are NOT part of it - they vary per order and would multiply the catalog.
They travel alongside as their own dimension.

Known limitation: pricing sometimes IS variety-specific (a named garden rose
costs more than a generic one). If that turns out to matter, variety gets
promoted to its own column here rather than folded into product_id.

`shrink_pct` is the overage bought against breakage, per product. Soft-stemmed
and delicate material needs more than sturdy greenery, so it belongs on the
product, not as one global fudge factor.

## Demand  (generated - stage 1 output)

    digest_id | generated_at | need_by_start | need_by_end | product_id |
    color_variety | total_stems | stems_with_shrink | event_ids |
    line_item_count | unmapped_name | status

One row per product x colour x need-by window. `event_ids` preserves the trail
back to who the flowers are for, which is what lets a consolidated purchase be
allocated to events later.

`unmapped_name` carries the raw ticket text when no product matched. A digest
with unmapped rows is still useful - it just tells you the catalog has a hole.

## Vendors  (stage 3 - defined now, populated later)

    vendor_id | name | contact_name | order_channel | order_email |
    lead_time_days | ship_days | order_cutoff | min_order |
    shipping_cost | free_ship_threshold | preference_rank | notes

`order_channel` is email / phone / portal, because ordering differs per farm.
It determines what stage 3 produces for that vendor: a draft email, a call
sheet, or a keying checklist.

`preference_rank` is the only place your judgment gets written down. It is the
tiebreak when price and availability do not decide.

## Vendor_Prices  (stage 3 - populated later)

    vendor_id | product_id | pack_size | stems_per_pack | price_per_pack |
    currency | available_from | available_to | source | last_updated

`source` records where the number came from - email, portal, or sheet - because
all three are in play and they age at different rates. `last_updated` is not
optional: stale flower pricing produces confidently wrong totals, which is worse
than no totals.
